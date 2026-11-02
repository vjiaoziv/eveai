import type { Db } from '../db/sqlite.js';
import type { DataQualityMetrics, OrderBookLevel } from './types.js';

export interface DataSourceRecord {
  source_id: string;
  status: 'ok' | 'degraded' | 'offline';
  last_success_at: string | null;
  last_error: string | null;
  error_count_1h: number;
  updated_at: string;
}

export class DataCenter {
  /**
   * Record data source health in data_source_status table
   */
  public static recordStatus(
    db: Db,
    sourceId: string,
    status: 'ok' | 'degraded' | 'offline',
    error?: string,
  ): void {
    const errorCountInc = status === 'ok' ? 0 : 1;
    db.prepare(`
      INSERT INTO data_source_status (source_id, status, last_success_at, last_error, error_count_1h, updated_at)
      VALUES (?, ?, CASE WHEN ? = 'ok' THEN datetime('now') ELSE NULL END, ?, ?, datetime('now'))
      ON CONFLICT(source_id) DO UPDATE SET
        status = excluded.status,
        last_success_at = CASE WHEN excluded.status = 'ok' THEN datetime('now') ELSE data_source_status.last_success_at END,
        last_error = excluded.last_error,
        error_count_1h = CASE WHEN excluded.status = 'ok' THEN 0 ELSE data_source_status.error_count_1h + 1 END,
        updated_at = datetime('now')
    `).run(sourceId, status, status, error || null, errorCountInc);
  }

  /**
   * Retrieve status list for all registered data sources
   */
  public static getAllStatuses(db: Db): DataSourceRecord[] {
    return db.prepare('SELECT * FROM data_source_status ORDER BY source_id').all() as DataSourceRecord[];
  }

  /**
   * Fetch item metadata from SDE
   */
  public static getItemMetadata(db: Db, typeId: number) {
    return db.prepare(`
      SELECT t.type_id, t.name as en_name,
             COALESCE(json_extract(t.data_json, '$.name.zh'), t.name) as zh_name,
             g.group_id,
             COALESCE(json_extract(g.data_json, '$.name.zh'), g.name) as group_name,
             c.category_id,
             COALESCE(json_extract(c.data_json, '$.name.zh'), c.name) as category_name,
             json_extract(t.data_json, '$.volume') as volume,
             json_extract(t.data_json, '$.portionSize') as portion_size,
             json_extract(t.data_json, '$.mass') as mass,
             json_extract(t.data_json, '$.basePrice') as base_price
      FROM sde_types t
      LEFT JOIN sde_groups g ON t.group_id = g.group_id
      LEFT JOIN sde_categories c ON g.category_id = c.category_id
      WHERE t.type_id = ?
    `).get(typeId) as {
      type_id: number;
      en_name: string;
      zh_name: string | null;
      group_id: number | null;
      group_name: string | null;
      category_id: number | null;
      category_name: string | null;
      volume: number | null;
      portion_size: number | null;
      mass: number | null;
      base_price: number | null;
    } | undefined;
  }

  /**
   * Query current active orders for a type in a region, optionally scoped to a station.
   * Includes issued timestamp for temporal validation.
   */
  public static getOrderBook(
    db: Db,
    regionId: number,
    typeId: number,
    stationId?: number,
  ): { sells: OrderBookLevel[]; buys: OrderBookLevel[] } {
    let sellSql = `
      SELECT price, volume_remain as volumeRemain, order_id as orderId, location_id as locationId, issued
      FROM market_orders
      WHERE region_id = ? AND type_id = ? AND is_buy_order = 0
    `;
    let buySql = `
      SELECT price, volume_remain as volumeRemain, order_id as orderId, location_id as locationId, issued
      FROM market_orders
      WHERE region_id = ? AND type_id = ? AND is_buy_order = 1
    `;
    const params: any[] = [regionId, typeId];
    if (stationId) {
      sellSql += ' AND location_id = ?';
      buySql += ' AND location_id = ?';
      params.push(stationId);
    }
    sellSql += ' ORDER BY price ASC';
    buySql += ' ORDER BY price DESC';

    const sells = db.prepare(sellSql).all(...params) as OrderBookLevel[];
    const buys = db.prepare(buySql).all(...params) as OrderBookLevel[];
    return { sells, buys };
  }

  /**
   * Validate temporal consistency between two market datasets (e.g. cross-region hauling)
   */
  public static validateTemporalConsistency(
    originOrders: OrderBookLevel[],
    destOrders: OrderBookLevel[],
    maxAllowedSkewMinutes = 15,
  ): DataQualityMetrics {
    const now = Date.now();
    const getNewestTime = (orders: OrderBookLevel[]) => {
      let maxTs = 0;
      for (const o of orders) {
        if (o.issued) {
          const ts = new Date(o.issued.endsWith('Z') ? o.issued : o.issued + 'Z').getTime();
          if (ts > maxTs) maxTs = ts;
        }
      }
      return maxTs;
    };

    const originTs = getNewestTime(originOrders) || now;
    const destTs = getNewestTime(destOrders) || now;

    const originAgeMin = Math.round(Math.abs(now - originTs) / 60000);
    const destAgeMin = Math.round(Math.abs(now - destTs) / 60000);
    const skewMin = Math.round(Math.abs(originTs - destTs) / 60000);

    return {
      originSnapshotAgeMinutes: originAgeMin,
      destSnapshotAgeMinutes: destAgeMin,
      timestampSkewMinutes: skewMin,
      isStale: originAgeMin > 60 || destAgeMin > 60 || skewMin > maxAllowedSkewMinutes,
      hasDepthMismatch: false, // Populated during simulation
    };
  }

  /**
   * Fetch daily history from ESI for a type and region, saving to market_price_history
   */
  public static async syncDailyHistoryFromEsi(
    db: Db,
    regionId: number,
    typeId: number,
  ): Promise<boolean> {
    const url = `https://esi.evetech.net/latest/markets/${regionId}/history/?datasource=tranquility&type_id=${typeId}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'EVEAI/4.1.0 (contact=jiaozi@local)' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.recordStatus(db, 'ccp_esi_history', 'degraded', `HTTP ${res.status}`);
        return false;
      }
      const points = (await res.json()) as Array<{
        date: string;
        order_count: number;
        volume: number;
        highest: number;
        average: number;
        lowest: number;
      }>;

      const insert = db.prepare(`
        INSERT INTO market_price_history (region_id, type_id, date, order_count, volume, highest, average, lowest, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(region_id, type_id, date) DO UPDATE SET
          order_count = excluded.order_count,
          volume = excluded.volume,
          highest = excluded.highest,
          average = excluded.average,
          lowest = excluded.lowest,
          synced_at = datetime('now')
      `);

      const tx = db.transaction(() => {
        for (const p of points) {
          insert.run(regionId, typeId, p.date, p.order_count, p.volume, p.highest, p.average, p.lowest);
        }
      });
      tx();

      this.recordStatus(db, 'ccp_esi_history', 'ok');
      return true;
    } catch (err) {
      this.recordStatus(db, 'ccp_esi_history', 'offline', (err as Error).message);
      return false;
    }
  }
}
