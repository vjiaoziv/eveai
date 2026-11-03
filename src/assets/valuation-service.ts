import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import { DataCenter } from '../trading/data-center.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS, FEE_MODEL_VERSION } from '../trading/fee-engine.js';
import type { FeeContext, OrderBookLevel } from '../trading/types.js';
import { BUCKET_SQL_CASE, type InventoryBucket } from './inventory-service.js';

/**
 * P9.2.4 multi-perspective asset valuation.
 *
 * Five perspectives never summed into one fake "total":
 *  A. market_reference  - region top-of-book ASK x qty (reference only)
 *  B. bid liquidation   - depth-walked local BIDS at the item's own location,
 *                         net of the immediate-sale sales tax (executable model)
 *  C. ask replacement   - depth-walked local ASKS at the item's own location
 *  D. cost basis        - UNKNOWN unless a future P9.3 record provides it
 *  E. the four above shown side by side, never added together.
 *
 * Every missing perspective stays null with independent status flags; UNKNOWN
 * is never coerced to zero (task book 7.1/7.3/7.4).
 */

export type ValuationStatus =
  | 'VALUED'
  | 'PARTIALLY_VALUED'
  | 'NO_MARKET_DATA'
  | 'INSUFFICIENT_DEPTH'
  | 'FEE_UNKNOWN'
  | 'LOCATION_UNKNOWN'
  | 'STALE_MARKET_DATA'
  | 'NOT_MARKETABLE'
  | 'VALUATION_ERROR';

export type ValuationItemResult = {
  itemId: number;
  typeId: number;
  quantity: number;
  bucket: InventoryBucket;
  locationId: number;
  regionId: number | null;
  marketReferenceValue: number | null;
  bidLiquidationGross: number | null;
  bidLiquidationNet: number | null;
  fillableQuantity: number | null;
  unfillableQuantity: number | null;
  askReplacementGross: number | null;
  askReplacementNet: number | null;
  statuses: ValuationStatus[];
  flags: string[];
  priceSource: string | null;
};

export type ValuationRunResult = {
  valuationId: string;
  characterId: number;
  snapshotId: string;
  hubLocationId: number;
  hubRegionId: number;
  status: 'COMPLETED' | 'FAILED';
  itemsValued: number;
  itemsUnknown: number;
  itemsTotal: number;
  totals: {
    marketReferenceValue: number | null;
    bidLiquidationNet: number | null;
    askReplacementGross: number | null;
    costBasis: null;
  };
  coverage: { valued: number; unknown: number; partial: number };
  items: ValuationItemResult[];
  lastError: string | null;
  feeAssumptions: Record<string, unknown>;
};

const DEFAULT_FEE_CONTEXT: FeeContext = {
  clone: 'alpha',
  skills: ALPHA_DEFAULT_SKILLS,
  facility: 'npc_station',
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Sum only non-null values; a fully unknown perspective stays null, never 0. */
function sumOrNull(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (present.length === 0) return null;
  return round2(present.reduce((sum, value) => sum + value, 0));
}

function walkBids(levels: OrderBookLevel[], quantity: number): { gross: number; fillable: number } {
  let remaining = quantity;
  let gross = 0;
  let fillable = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.volumeRemain);
    if (take <= 0) continue;
    gross += take * level.price;
    fillable += take;
    remaining -= take;
  }
  return { gross: round2(gross), fillable };
}

function walkAsks(levels: OrderBookLevel[], quantity: number): { gross: number; fillable: number } {
  // Asks are sorted ascending by DataCenter; same depth walk for replacement cost.
  return walkBids(levels, quantity);
}

export class RealValuationService {
  /**
   * Value the latest COMPLETE snapshot (or an explicit one) at one trade hub.
   * Runs entirely on local SDE + the local market snapshot: no ESI calls.
   */
  static run(
    db: Db,
    characterId: number,
    options: { snapshotId?: string; hubLocationId?: number; hubRegionId?: number } = {},
  ): ValuationRunResult {
    const snapshot = options.snapshotId
      ? db.prepare("SELECT * FROM real_asset_snapshots WHERE snapshot_id = ? AND character_id = ? AND status = 'COMPLETED'")
        .get(options.snapshotId, characterId) as any
      : db.prepare("SELECT * FROM real_asset_snapshots WHERE character_id = ? AND status = 'COMPLETED' AND is_latest = 1 LIMIT 1")
        .get(characterId) as any;
    if (!snapshot) throw new Error('没有可用的完整资产快照，无法估值。');

    const hubLocationId = options.hubLocationId ?? 60003760;   // Jita trade hub (SDE-verified in P9.1)
    const hubRegionId = options.hubRegionId ?? 10000002;
    const valuationId = `ASSETVAL-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO real_asset_valuations
        (valuation_id, character_id, snapshot_id, hub_location_id, hub_region_id,
         market_snapshot_at, fee_model_version, status, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, 'RUNNING', ?)
    `).run(valuationId, characterId, snapshot.snapshot_id, hubLocationId, hubRegionId,
      FEE_MODEL_VERSION, createdAt);

    try {
      const assetRows = db.prepare(`
        SELECT a.item_id, a.type_id, a.quantity, a.location_id,
               ${BUCKET_SQL_CASE} AS bucket,
               loc.region_id AS region_id,
               loc.resolution_status AS resolution_status
        FROM real_asset_snapshot_items a
        LEFT JOIN sde_types t ON t.type_id = a.type_id
        LEFT JOIN sde_groups g ON g.group_id = t.group_id
        LEFT JOIN sde_categories c ON c.category_id = g.category_id
        LEFT JOIN real_asset_locations loc ON loc.location_id = a.location_id
        WHERE a.snapshot_id = ?
      `).all(snapshot.snapshot_id) as Array<{
        item_id: number; type_id: number; quantity: number; location_id: number;
        bucket: InventoryBucket; region_id: number | null; resolution_status: string | null;
      }>;

      const rates = FeeEngine.calculateRates(DEFAULT_FEE_CONTEXT);
      const marketTypeIds = new Set<number>((db.prepare(
        'SELECT DISTINCT type_id FROM market_orders WHERE volume_remain > 0',
      ).all() as Array<{ type_id: number }>).map((row) => row.type_id));
      const items: ValuationItemResult[] = [];
      // Batch lookups: one book per distinct (type, location) / (type, region).
      const bidCache = new Map<string, OrderBookLevel[]>();
      const askCache = new Map<string, OrderBookLevel[]>();
      const regionAskCache = new Map<string, OrderBookLevel[]>();

      // Location-scoped books still need the asset's region: getOrderBook
      // filters region_id AND location_id together.
      const bidsAt = (typeId: number, locationId: number, regionId: number): OrderBookLevel[] => {
        const key = `${typeId}:${locationId}:${regionId}`;
        if (!bidCache.has(key)) bidCache.set(key, DataCenter.getOrderBook(db, regionId, typeId, locationId).buys);
        return bidCache.get(key)!;
      };
      const asksAt = (typeId: number, locationId: number, regionId: number): OrderBookLevel[] => {
        const key = `${typeId}:${locationId}:${regionId}`;
        if (!askCache.has(key)) askCache.set(key, DataCenter.getOrderBook(db, regionId, typeId, locationId).sells);
        return askCache.get(key)!;
      };
      const regionAsks = (typeId: number, regionId: number): OrderBookLevel[] => {
        const key = `${typeId}:${regionId}`;
        if (!regionAskCache.has(key)) regionAskCache.set(key, DataCenter.getOrderBook(db, regionId, typeId).sells);
        return regionAskCache.get(key)!;
      };

      let marketSnapshotAt: string | null = null;
      const seenRegions = new Set<number>();

      for (const row of assetRows) {
        try {
          const statuses = new Set<ValuationStatus>();
          const flags: string[] = [];
          const locationKnown = row.resolution_status === 'RESOLVED' || row.resolution_status === 'PARTIALLY_RESOLVED';

          if (!locationKnown) {
            statuses.add('LOCATION_UNKNOWN');
          }
          if (row.region_id !== null && !seenRegions.has(row.region_id)) {
            seenRegions.add(row.region_id);
            const meta = DataCenter.getRegionSnapshotMeta(db, row.region_id);
            if (meta?.fetchedAt && (!marketSnapshotAt || meta.fetchedAt < marketSnapshotAt)) {
              marketSnapshotAt = meta.fetchedAt;
            }
          }

          const sdeMeta = DataCenter.getItemMetadata(db, row.type_id);
          const anyOrders = marketTypeIds.has(row.type_id);

          // A. market reference: region top-of-book ask (reference only).
          let marketReferenceValue: number | null = null;
          if (locationKnown && row.region_id !== null) {
            const regionAsk = regionAsks(row.type_id, row.region_id);
            if (regionAsk.length > 0) {
              marketReferenceValue = round2(regionAsk[0].price * row.quantity);
            } else {
              statuses.add('NO_MARKET_DATA');
              if (!anyOrders && (row.bucket === 'MISSION' || row.bucket === 'UNKNOWN' || row.bucket === 'BPO')) {
                statuses.add('NOT_MARKETABLE');
              }
            }
          }

          // B/C only make sense at a resolved location.
          let bidGross: number | null = null;
          let bidNet: number | null = null;
          let fillable: number | null = null;
          let unfillable: number | null = null;
          let askGross: number | null = null;
          let askNet: number | null = null;
          let priceSource: string | null = null;

          if (locationKnown && row.region_id !== null) {
            const localBids = bidsAt(row.type_id, row.location_id, row.region_id);
            const localAsks = asksAt(row.type_id, row.location_id, row.region_id);

            if (localBids.length > 0) {
              const walked = walkBids(localBids, row.quantity);
              bidGross = walked.gross;
              fillable = walked.fillable;
              unfillable = row.quantity - walked.fillable;
              // Immediate sale: sales tax only (no buyer/seller broker fee).
              bidNet = round2(bidGross * (1 - rates.salesTaxRate));
              priceSource = 'local_bids';
              if (unfillable > 0) {
                statuses.add('INSUFFICIENT_DEPTH');
                flags.push('BID_DEPTH_SHORTFALL');
              }
            } else {
              statuses.add('NO_MARKET_DATA');
            }

            if (localAsks.length > 0) {
              const walked = walkAsks(localAsks, row.quantity);
              askGross = walked.gross;
              askNet = round2(askGross); // replacement cost is a cost, no sale fees
              priceSource = priceSource ? `${priceSource}+local_asks` : 'local_asks';
              if (walked.fillable < row.quantity) {
                statuses.add('INSUFFICIENT_DEPTH');
                flags.push('ASK_DEPTH_SHORTFALL');
              }
            } else if (!statuses.has('NO_MARKET_DATA')) {
              statuses.add('NO_MARKET_DATA');
            }
          }

          if (locationKnown && row.region_id === null) {
            statuses.add('LOCATION_UNKNOWN');
            flags.push('REGION_UNKNOWN');
          }

          // Blueprints / mission loot without orders are never valued at zero.
          if (!sdeMeta && marketReferenceValue === null && bidNet === null) {
            statuses.add('NO_MARKET_DATA');
          }
          if (bidNet !== null && askGross !== null) statuses.add('VALUED');
          else if (marketReferenceValue !== null || bidNet !== null || askGross !== null) statuses.add('PARTIALLY_VALUED');

          items.push({
            itemId: row.item_id,
            typeId: row.type_id,
            quantity: row.quantity,
            bucket: row.bucket,
            locationId: row.location_id,
            regionId: row.region_id,
            marketReferenceValue,
            bidLiquidationGross: bidGross,
            bidLiquidationNet: bidNet,
            fillableQuantity: fillable,
            unfillableQuantity: unfillable,
            askReplacementGross: askGross,
            askReplacementNet: askNet,
            statuses: [...statuses],
            flags,
            priceSource,
          });
        } catch (error) {
          items.push({
            itemId: row.item_id,
            typeId: row.type_id,
            quantity: row.quantity,
            bucket: row.bucket,
            locationId: row.location_id,
            regionId: row.region_id,
            marketReferenceValue: null,
            bidLiquidationGross: null,
            bidLiquidationNet: null,
            fillableQuantity: null,
            unfillableQuantity: null,
            askReplacementGross: null,
            askReplacementNet: null,
            statuses: ['VALUATION_ERROR'],
            flags: [error instanceof Error ? error.message.slice(0, 200) : 'VALUATION_ERROR'],
            priceSource: null,
          });
        }
      }

      const valued = items.filter((item) => item.statuses.includes('VALUED')).length;
      const partial = items.filter((item) => item.statuses.includes('PARTIALLY_VALUED')).length;
      const unknown = items.length - valued - partial;

      const totals = {
        marketReferenceValue: sumOrNull(items.map((item) => item.marketReferenceValue)),
        bidLiquidationNet: sumOrNull(items.map((item) => item.bidLiquidationNet)),
        askReplacementGross: sumOrNull(items.map((item) => item.askReplacementGross)),
        costBasis: null as null,
      };

      const insertItem = db.prepare(`
        INSERT INTO real_asset_valuation_items
          (valuation_id, item_id, type_id, quantity, market_reference_value,
           bid_liquidation_gross, bid_liquidation_net, fillable_quantity, unfillable_quantity,
           ask_replacement_gross, ask_replacement_net, statuses_json, flags_json, price_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const tx = db.transaction(() => {
        for (const item of items) {
          insertItem.run(
            valuationId, item.itemId, item.typeId, item.quantity, item.marketReferenceValue,
            item.bidLiquidationGross, item.bidLiquidationNet, item.fillableQuantity, item.unfillableQuantity,
            item.askReplacementGross, item.askReplacementNet,
            JSON.stringify(item.statuses), JSON.stringify(item.flags), item.priceSource,
          );
        }
        db.prepare(`
          UPDATE real_asset_valuations
          SET status = 'COMPLETED', completed_at = ?, market_snapshot_at = ?,
              items_valued = ?, items_unknown = ?
          WHERE valuation_id = ?
        `).run(new Date().toISOString(), marketSnapshotAt, valued, unknown, valuationId);
      });
      tx();

      return {
        valuationId,
        characterId,
        snapshotId: snapshot.snapshot_id,
        hubLocationId,
        hubRegionId,
        status: 'COMPLETED',
        itemsValued: valued,
        itemsUnknown: unknown,
        itemsTotal: items.length,
        totals,
        coverage: { valued, unknown, partial },
        items,
        lastError: null,
        feeAssumptions: {
          clone: DEFAULT_FEE_CONTEXT.clone,
          skills: DEFAULT_FEE_CONTEXT.skills,
          facility: DEFAULT_FEE_CONTEXT.facility,
          note: '角色技能/声望/设施未知时采用的默认假设；不得视为该角色真实费用。',
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.prepare(`
        UPDATE real_asset_valuations
        SET status = 'FAILED', completed_at = ?, last_error = ?
        WHERE valuation_id = ?
      `).run(new Date().toISOString(), message.slice(0, 500), valuationId);
      throw Object.assign(new Error(message), { valuationId });
    }
  }

  static listRuns(db: Db, characterId: number, limit = 20): any[] {
    return db.prepare(`
      SELECT * FROM real_asset_valuations
      WHERE character_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(characterId, Math.max(1, Math.min(200, limit)));
  }

  static getRun(db: Db, characterId: number, valuationId: string): { header: any; items: any[] } | null {
    const header = db.prepare(
      'SELECT * FROM real_asset_valuations WHERE valuation_id = ? AND character_id = ?',
    ).get(valuationId, characterId) as any;
    if (!header) return null;
    const items = db.prepare(`
      SELECT * FROM real_asset_valuation_items WHERE valuation_id = ?
      ORDER BY item_id LIMIT 5000
    `).all(valuationId) as any[];
    return { header, items: items.map((row) => ({
      ...row,
      statuses: JSON.parse(row.statuses_json || '[]'),
      flags: JSON.parse(row.flags_json || '[]'),
    })) };
  }

  /** Overview aggregates from the latest COMPLETED run (null stays null). */
  static latestTotals(db: Db, characterId: number): Record<string, unknown> | null {
    const header = db.prepare(`
      SELECT * FROM real_asset_valuations
      WHERE character_id = ? AND status = 'COMPLETED'
      ORDER BY created_at DESC LIMIT 1
    `).get(characterId) as any;
    if (!header) return null;
    const sums = db.prepare(`
      SELECT
        COUNT(*) AS items,
        SUM(CASE WHEN market_reference_value IS NOT NULL THEN 1 ELSE 0 END) AS reference_counted,
        SUM(CASE WHEN bid_liquidation_net IS NOT NULL THEN 1 ELSE 0 END) AS liquidation_counted,
        SUM(market_reference_value) AS market_reference_value,
        SUM(bid_liquidation_net) AS bid_liquidation_net,
        SUM(ask_replacement_gross) AS ask_replacement_gross
      FROM real_asset_valuation_items WHERE valuation_id = ?
    `).get(header.valuation_id) as any;
    return {
      valuationId: header.valuation_id,
      snapshotId: header.snapshot_id,
      hubLocationId: header.hub_location_id,
      hubRegionId: header.hub_region_id,
      marketSnapshotAt: header.market_snapshot_at,
      feeModelVersion: header.fee_model_version,
      createdAt: header.created_at,
      items: Number(sums.items || 0),
      itemsWithReference: Number(sums.reference_counted || 0),
      itemsWithLiquidation: Number(sums.liquidation_counted || 0),
      // Sums over non-null rows only; perspectives are reported separately and
      // NEVER added together into one "total net worth".
      marketReferenceValue: sums.market_reference_value == null ? null : round2(sums.market_reference_value),
      bidLiquidationNet: sums.bid_liquidation_net == null ? null : round2(sums.bid_liquidation_net),
      askReplacementGross: sums.ask_replacement_gross == null ? null : round2(sums.ask_replacement_gross),
      costBasis: null,
      costBasisStatus: 'UNKNOWN_PENDING_P9_3',
      feeAssumptions: {
        clone: DEFAULT_FEE_CONTEXT.clone,
        skills: DEFAULT_FEE_CONTEXT.skills,
        facility: DEFAULT_FEE_CONTEXT.facility,
        note: '角色技能/声望/设施未知时采用的默认假设；不得视为该角色真实费用。',
      },
    };
  }
  /** Category and hub summaries for the valuation analysis page. */
  static summaries(db: Db, characterId: number): {
    latest: Record<string, unknown> | null;
    buckets: any[];
    hubs: any[];
  } {
    const latest = this.latestTotals(db, characterId);
    const latestHeader = latest
      ? db.prepare('SELECT valuation_id FROM real_asset_valuations WHERE valuation_id = ?')
        .get(latest.valuationId) as { valuation_id: string } | undefined
      : undefined;
    const buckets = latestHeader
      ? db.prepare(`
          SELECT ${BUCKET_SQL_CASE} AS bucket,
                 COUNT(*) AS items,
                 COALESCE(SUM(a.quantity), 0) AS quantity,
                 SUM(CASE WHEN vi.market_reference_value IS NOT NULL THEN 1 ELSE 0 END) AS reference_counted,
                 SUM(CASE WHEN vi.bid_liquidation_net IS NOT NULL THEN 1 ELSE 0 END) AS liquidation_counted,
                 SUM(CASE WHEN vi.statuses_json LIKE '%INSUFFICIENT_DEPTH%' THEN 1 ELSE 0 END) AS depth_short,
                 SUM(CASE WHEN vi.statuses_json LIKE '%NO_MARKET_DATA%'
                             OR vi.statuses_json LIKE '%LOCATION_UNKNOWN%'
                             OR vi.statuses_json LIKE '%NOT_MARKETABLE%' THEN 1 ELSE 0 END) AS unknown_count,
                 SUM(vi.market_reference_value) AS market_reference_value,
                 SUM(vi.bid_liquidation_net) AS bid_liquidation_net,
                 SUM(vi.ask_replacement_gross) AS ask_replacement_gross
          FROM real_asset_snapshot_items a
          JOIN real_asset_valuation_items vi
            ON vi.item_id = a.item_id AND vi.valuation_id = ?
          LEFT JOIN sde_types t ON t.type_id = a.type_id
          LEFT JOIN sde_groups g ON g.group_id = t.group_id
          LEFT JOIN sde_categories c ON c.category_id = g.category_id
          GROUP BY bucket
          ORDER BY items DESC
        `).all(latestHeader.valuation_id) as any[]
      : [];
    const hubs = db.prepare(`
      SELECT v.valuation_id, v.hub_location_id, v.hub_region_id, v.created_at,
             v.market_snapshot_at, v.fee_model_version,
             COUNT(vi.item_id) AS items,
             SUM(CASE WHEN vi.market_reference_value IS NOT NULL THEN 1 ELSE 0 END) AS reference_counted,
             SUM(CASE WHEN vi.bid_liquidation_net IS NOT NULL THEN 1 ELSE 0 END) AS liquidation_counted,
             SUM(vi.market_reference_value) AS market_reference_value,
             SUM(vi.bid_liquidation_net) AS bid_liquidation_net,
             SUM(vi.ask_replacement_gross) AS ask_replacement_gross
      FROM real_asset_valuations v
      LEFT JOIN real_asset_valuation_items vi ON vi.valuation_id = v.valuation_id
      WHERE v.character_id = ? AND v.status = 'COMPLETED'
      GROUP BY v.valuation_id
      ORDER BY v.created_at DESC
      LIMIT 50
    `).all(characterId) as any[];
    return {
      latest,
      buckets: buckets.map((row) => ({
        ...row,
        marketReferenceValue: row.market_reference_value == null ? null : round2(row.market_reference_value),
        bidLiquidationNet: row.bid_liquidation_net == null ? null : round2(row.bid_liquidation_net),
        askReplacementGross: row.ask_replacement_gross == null ? null : round2(row.ask_replacement_gross),
      })),
      hubs: hubs.map((row) => ({
        ...row,
        marketReferenceValue: row.market_reference_value == null ? null : round2(row.market_reference_value),
        bidLiquidationNet: row.bid_liquidation_net == null ? null : round2(row.bid_liquidation_net),
        askReplacementGross: row.ask_replacement_gross == null ? null : round2(row.ask_replacement_gross),
      })),
    };
  }
}
