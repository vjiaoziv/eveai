import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import { clampNonNegativeInteger, clampPositiveInteger } from '../util/query-bounds.js';

/**
 * P9.2.5 immutable snapshot history and observed-change queries.
 *
 * Snapshot comparison is a deterministic full outer join over two COMPLETE
 * snapshots. It reports what changed, never why: every computed row keeps
 * source_class=OBSERVED_CHANGE so later evidence can be correlated without
 * rewriting the original observation.
 */

export type HistoryChangeQuery = {
  characterId: number;
  changeType?: string;
  itemId?: number;
  typeId?: number;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

export type SnapshotQuery = {
  characterId: number;
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

function isoDate(value: string | undefined, endOfDay = false): string | null {
  if (!value || !value.trim()) return null;
  const trimmed = value.trim();
  const hasTime = trimmed.includes('T') || trimmed.includes(' ');
  const normalized = hasTime ? trimmed : `${trimmed}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`;
  const parsed = Date.parse(normalized.includes('Z') || /[+-]\d{2}:\d{2}$/.test(normalized)
    ? normalized
    : `${normalized}Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function changeLabel(changeType: string): string {
  const labels: Record<string, string> = {
    ADDED: '新增',
    QTY_INCREASED: '数量增加',
    QTY_DECREASED: '数量减少',
    MOVED: '位置变化',
    REMOVED: '消失',
    REAPPEARED: '重新出现',
    CONTAINER_CHANGED: '容器变化',
  };
  return labels[changeType] ?? changeType;
}

export class RealAssetHistoryService {
  static listSnapshots(db: Db, query: SnapshotQuery): { rows: any[]; total: number; limit: number; offset: number } {
    const limit = clampPositiveInteger(query.limit, 50, 200);
    const offset = clampNonNegativeInteger(query.offset);
    const where = ['character_id = ?'];
    const params: unknown[] = [query.characterId];
    if (query.status) {
      where.push('status = ?');
      params.push(query.status);
    }
    const from = isoDate(query.from);
    const to = isoDate(query.to, true);
    if (from) {
      where.push('COALESCE(completed_at, started_at) >= ?');
      params.push(from);
    }
    if (to) {
      where.push('COALESCE(completed_at, started_at) <= ?');
      params.push(to);
    }
    const whereSql = where.join(' AND ');
    const total = Number((db.prepare(
      `SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE ${whereSql}`,
    ).get(...params) as any)?.n || 0);
    const rows = db.prepare(`
      SELECT snapshot_id, character_id, job_id, started_at, completed_at, status,
             total_items, total_unique_types, total_locations, total_quantity,
             data_hash, source, error_summary, is_latest
      FROM real_asset_snapshots
      WHERE ${whereSql}
      ORDER BY COALESCE(completed_at, started_at) DESC, snapshot_id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    return { rows, total, limit, offset };
  }

  static listChanges(db: Db, query: HistoryChangeQuery): { rows: any[]; total: number; limit: number; offset: number } {
    const limit = clampPositiveInteger(query.limit, 100, 500);
    const offset = clampNonNegativeInteger(query.offset);
    const where = ['c.character_id = ?'];
    const params: unknown[] = [query.characterId];
    if (query.changeType) {
      where.push('c.change_type = ?');
      params.push(query.changeType);
    }
    if (query.itemId) {
      where.push('c.item_id = ?');
      params.push(query.itemId);
    }
    if (query.typeId) {
      where.push('c.type_id = ?');
      params.push(query.typeId);
    }
    const from = isoDate(query.from);
    const to = isoDate(query.to, true);
    if (from) {
      where.push('c.detected_at >= ?');
      params.push(from);
    }
    if (to) {
      where.push('c.detected_at <= ?');
      params.push(to);
    }
    const whereSql = where.join(' AND ');
    const total = Number((db.prepare(
      `SELECT COUNT(*) AS n FROM real_asset_changes c WHERE ${whereSql}`,
    ).get(...params) as any)?.n || 0);
    const rows = db.prepare(`
      SELECT c.change_id, c.character_id, c.item_id, c.type_id, c.change_type,
             c.prev_quantity, c.new_quantity, c.prev_location_id, c.new_location_id,
             c.source_class, c.confidence, c.from_snapshot_id, c.to_snapshot_id,
             c.detected_at,
             COALESCE(json_extract(t.data_json, '$.name.zh'), t.name) AS type_name,
             prev_loc.location_name AS prev_location_name,
             new_loc.location_name AS new_location_name,
             prev_loc.solar_system_name AS prev_system_name,
             new_loc.solar_system_name AS new_system_name
      FROM real_asset_changes c
      LEFT JOIN sde_types t ON t.type_id = c.type_id
      LEFT JOIN real_asset_locations prev_loc ON prev_loc.location_id = c.prev_location_id
      LEFT JOIN real_asset_locations new_loc ON new_loc.location_id = c.new_location_id
      WHERE ${whereSql}
      ORDER BY c.detected_at DESC, c.change_id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];
    return {
      rows: rows.map((row) => ({ ...row, changeLabelZh: changeLabel(row.change_type) })),
      total,
      limit,
      offset,
    };
  }

  static itemHistory(db: Db, characterId: number, itemId: number): {
    changes: any[];
    snapshots: any[];
    currentQuantity: number | null;
    currentLocationId: number | null;
  } {
    const current = db.prepare(`
      SELECT quantity, location_id FROM character_assets
      WHERE character_id = ? AND item_id = ?
    `).get(characterId, itemId) as { quantity: number; location_id: number } | undefined;
    const changes = db.prepare(`
      SELECT * FROM real_asset_changes
      WHERE character_id = ? AND item_id = ?
      ORDER BY detected_at DESC, change_id DESC LIMIT 500
    `).all(characterId, itemId) as any[];
    const snapshots = db.prepare(`
      SELECT si.snapshot_id, s.completed_at, s.status, si.quantity, si.location_id,
             si.parent_item_id, loc.location_name, loc.solar_system_name, loc.region_name
      FROM real_asset_snapshot_items si
      JOIN real_asset_snapshots s ON s.snapshot_id = si.snapshot_id
      LEFT JOIN real_asset_locations loc ON loc.location_id = si.location_id
      WHERE s.character_id = ? AND si.item_id = ?
      ORDER BY COALESCE(s.completed_at, s.started_at) DESC, si.snapshot_id DESC
      LIMIT 500
    `).all(characterId, itemId) as any[];
    return {
      changes: changes.map((row) => ({ ...row, changeLabelZh: changeLabel(row.change_type) })),
      snapshots,
      currentQuantity: current?.quantity ?? null,
      currentLocationId: current?.location_id ?? null,
    };
  }

  /** Character asset totals over COMPLETE snapshots, with deterministic deltas. */
  static totalsHistory(db: Db, characterId: number, limit = 100): any[] {
    const rows = db.prepare(`
      SELECT snapshot_id, completed_at, status, total_items, total_unique_types,
             total_locations, total_quantity, data_hash, is_latest
      FROM real_asset_snapshots
      WHERE character_id = ? AND status = 'COMPLETED'
      ORDER BY COALESCE(completed_at, started_at) ASC, snapshot_id ASC
      LIMIT ?
    `).all(characterId, clampPositiveInteger(limit, 100, 500)) as any[];
    let previous: any = null;
    return rows.map((row) => {
      const enriched = {
        ...row,
        deltaItems: previous ? row.total_items - previous.total_items : null,
        deltaUniqueTypes: previous ? row.total_unique_types - previous.total_unique_types : null,
        deltaLocations: previous ? row.total_locations - previous.total_locations : null,
        deltaQuantity: previous ? row.total_quantity - previous.total_quantity : null,
        previousSnapshotId: previous?.snapshot_id ?? null,
      };
      previous = row;
      return enriched;
    });
  }

  /**
   * Full-outer comparison of two COMPLETE snapshots for one character.
   * Returns each observed difference; no purchase/sale/loss attribution.
   */
  static compare(db: Db, characterId: number, fromSnapshotId: string, toSnapshotId: string): {
    from: any;
    to: any;
    summary: Record<string, number>;
    changes: any[];
  } {
    const from = db.prepare(`
      SELECT * FROM real_asset_snapshots
      WHERE snapshot_id = ? AND character_id = ? AND status = 'COMPLETED'
    `).get(fromSnapshotId, characterId) as any;
    const to = db.prepare(`
      SELECT * FROM real_asset_snapshots
      WHERE snapshot_id = ? AND character_id = ? AND status = 'COMPLETED'
    `).get(toSnapshotId, characterId) as any;
    if (!from || !to) throw new Error('只能对比同一角色的两个完整资产快照。');
    if (from.snapshot_id === to.snapshot_id) throw new Error('不能将同一个快照与自身对比。');

    const fromRows = db.prepare(`
      SELECT item_id, type_id, quantity, location_id, parent_item_id
      FROM real_asset_snapshot_items WHERE snapshot_id = ?
    `).all(fromSnapshotId) as any[];
    const toRows = db.prepare(`
      SELECT item_id, type_id, quantity, location_id, parent_item_id
      FROM real_asset_snapshot_items WHERE snapshot_id = ?
    `).all(toSnapshotId) as any[];
    const before = new Map(fromRows.map((row) => [Number(row.item_id), row]));
    const after = new Map(toRows.map((row) => [Number(row.item_id), row]));
    const olderItemIds = new Set<number>((db.prepare(`
      SELECT DISTINCT si.item_id
      FROM real_asset_snapshot_items si
      JOIN real_asset_snapshots s ON s.snapshot_id = si.snapshot_id
      WHERE s.character_id = ? AND s.status = 'COMPLETED'
        AND s.snapshot_id NOT IN (?, ?)
    `).all(characterId, fromSnapshotId, toSnapshotId) as Array<{ item_id: number }>)
      .map((row) => Number(row.item_id)));

    const out: any[] = [];
    const push = (changeType: string, beforeRow: any, afterRow: any, itemId: number): void => {
      out.push({
        changeId: `ASSETCMP-${randomUUID()}`,
        characterId,
        itemId,
        typeId: Number(afterRow?.type_id ?? beforeRow?.type_id),
        changeType,
        changeLabelZh: changeLabel(changeType),
        prevQuantity: beforeRow?.quantity ?? null,
        newQuantity: afterRow?.quantity ?? null,
        prevLocationId: beforeRow?.location_id ?? null,
        newLocationId: afterRow?.location_id ?? null,
        prevParentItemId: beforeRow?.parent_item_id ?? null,
        newParentItemId: afterRow?.parent_item_id ?? null,
        sourceClass: 'OBSERVED_CHANGE',
        confidence: 'HIGH',
        fromSnapshotId: fromSnapshotId,
        toSnapshotId,
        detectedAt: new Date().toISOString(),
      });
    };

    const itemIds = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
    for (const itemId of itemIds) {
      const beforeRow = before.get(itemId);
      const afterRow = after.get(itemId);
      if (!beforeRow && afterRow) {
        push(olderItemIds.has(itemId) ? 'REAPPEARED' : 'ADDED', beforeRow, afterRow, itemId);
        continue;
      }
      if (beforeRow && !afterRow) {
        push('REMOVED', beforeRow, afterRow, itemId);
        continue;
      }
      if (Number(beforeRow.quantity) !== Number(afterRow.quantity)) {
        push(Number(afterRow.quantity) > Number(beforeRow.quantity) ? 'QTY_INCREASED' : 'QTY_DECREASED', beforeRow, afterRow, itemId);
      }
      if (Number(beforeRow.location_id) !== Number(afterRow.location_id)) {
        push('MOVED', beforeRow, afterRow, itemId);
      }
      if ((beforeRow.parent_item_id ?? null) !== (afterRow.parent_item_id ?? null)) {
        push('CONTAINER_CHANGED', beforeRow, afterRow, itemId);
      }
    }

    const summary: Record<string, number> = {};
    for (const row of out) summary[row.changeType] = (summary[row.changeType] || 0) + 1;
    return { from, to, summary, changes: out };
  }
}