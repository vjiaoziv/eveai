import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import { clampNonNegativeInteger, clampPositiveInteger } from '../util/query-bounds.js';
import { assetLineagePredicate, type AssetLineage } from './asset-lineage.js';
import { p9LineagePredicate } from '../trading/p9-control-plane-lineage.js';

/**
 * P9.2.6 deterministic linkage between current real inventory and P9.1
 * arbitrage opportunities.
 *
 * The matcher never creates or mutates an opportunity and never computes a
 * financial result. It only answers: how much of this type is held, how much
 * is directly usable at the opportunity's BUY hub, whether transport is
 * required, and whether another active opportunity already reserved the
 * directly usable stock. Paper Trading rows are never consulted.
 */

export type SupportClass = 'SUPPORTED' | 'PARTIAL' | 'NEEDS_PURCHASE' | 'UNAVAILABLE' | 'UNKNOWN';

export type OpportunityMatch = {
  matchId: string;
  characterId: number;
  opportunityId: string;
  typeId: number;
  heldQuantity: number;
  accessibleQuantity: number;
  requiredQuantity: number;
  supportClass: SupportClass;
  supportClassZh: string;
  needsTransport: boolean;
  locations: Array<Record<string, unknown>>;
  snapshotId: string | null;
  computedAt: string;
};

const SUPPORT_LABELS_ZH: Record<SupportClass, string> = {
  SUPPORTED: '库存可支持',
  PARTIAL: '库存部分支持',
  NEEDS_PURCHASE: '需要采购',
  UNAVAILABLE: '库存不可用',
  UNKNOWN: '库存未知',
};

const ACTIVE_STATES = ['ACTIONABLE', 'NEW', 'WATCHING', 'STALE'] as const;

type AssetRow = {
  item_id: number;
  type_id: number;
  quantity: number;
  location_id: number;
};

type OpportunityRow = {
  opportunity_id: string;
  character_id: number;
  strategy: string;
  type_id: number;
  suggested_quantity: number;
  executable_quantity: number;
  buy_location_id: number;
  state: string;
  fee_net_profit: number;
  detected_at: string;
};

function activeOpportunities(db: Db, characterId: number, lineage: AssetLineage): OpportunityRow[] {
  const owner = p9LineagePredicate('o', lineage);
  return db.prepare(`
    SELECT o.opportunity_id, o.character_id, o.strategy, o.type_id, o.suggested_quantity,
           o.executable_quantity, o.buy_location_id, o.state, o.fee_net_profit, o.detected_at
    FROM p9_real_opportunities o
    WHERE o.character_id = ? AND ${owner.sql}
      AND o.state IN ('ACTIONABLE', 'NEW', 'WATCHING', 'STALE')
    ORDER BY CASE state
               WHEN 'ACTIONABLE' THEN 0 WHEN 'NEW' THEN 1
               WHEN 'WATCHING' THEN 2 ELSE 3 END,
             o.fee_net_profit DESC, o.detected_at ASC, o.opportunity_id ASC
  `).all(characterId, ...owner.params) as OpportunityRow[];
}

function terminalLocation(row: AssetRow, registry: Map<number, number>): number {
  let current = row.location_id;
  const seen = new Set<number>();
  while (registry.has(current) && !seen.has(current)) {
    seen.add(current);
    current = registry.get(current)!;
  }
  return current;
}

function latestCompleteSnapshot(db: Db, characterId: number, lineage: AssetLineage): any {
  const ownership = assetLineagePredicate(null, lineage);
  return db.prepare(`
    SELECT * FROM real_asset_snapshots
    WHERE character_id = ? AND status = 'COMPLETED' AND ${ownership.sql}
    ORDER BY is_latest DESC, COALESCE(completed_at, started_at) DESC
    LIMIT 1
  `).get(characterId, ...ownership.params);
}

function currentSetIsConsistent(db: Db, characterId: number, snapshot: any, lineage: AssetLineage): boolean {
  if (!snapshot) return false;
  const ownership = assetLineagePredicate(null, lineage);
  const mirror = db.prepare(`
    SELECT item_id, type_id, quantity, location_id, location_type,
           location_flag, is_singleton, is_blueprint_copy
    FROM character_assets
    WHERE character_id = ? AND ${ownership.sql}
    ORDER BY item_id
  `).all(characterId, ...ownership.params) as Array<{
    item_id: number;
    type_id: number;
    quantity: number;
    location_id: number;
    location_type: string | null;
    location_flag: string | null;
    is_singleton: number;
    is_blueprint_copy: number | null;
  }>;
  const stored = db.prepare(`
    SELECT item_id, type_id, quantity, location_id, location_type,
           location_flag, is_singleton, is_blueprint_copy
    FROM real_asset_snapshot_items
    WHERE snapshot_id = ?
    ORDER BY item_id
  `).all(snapshot.snapshot_id) as typeof mirror;

  // Aggregate counts are not an integrity proof: two different item sets can
  // share item/quantity/type totals. Compare the complete persisted item set
  // field-by-field so opportunity matching cannot consume an inconsistent
  // current mirror under a "consistent snapshot" label.
  if (mirror.length !== stored.length) return false;
  for (let index = 0; index < mirror.length; index += 1) {
    const currentRow = mirror[index];
    const snapshotRow = stored[index];
    if (
      Number(currentRow.item_id) !== Number(snapshotRow.item_id)
      || Number(currentRow.type_id) !== Number(snapshotRow.type_id)
      || Number(currentRow.quantity) !== Number(snapshotRow.quantity)
      || Number(currentRow.location_id) !== Number(snapshotRow.location_id)
      || currentRow.location_type !== snapshotRow.location_type
      || currentRow.location_flag !== snapshotRow.location_flag
      || Number(currentRow.is_singleton) !== Number(snapshotRow.is_singleton)
      || (currentRow.is_blueprint_copy === null ? null : Number(currentRow.is_blueprint_copy))
        !== (snapshotRow.is_blueprint_copy === null ? null : Number(snapshotRow.is_blueprint_copy))
    ) {
      return false;
    }
  }
  return true;
}

function insertMatch(db: Db, match: OpportunityMatch, lineage: AssetLineage): void {
  db.prepare(`
    INSERT INTO real_asset_opportunity_matches
      (match_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       opportunity_id, type_id, held_quantity,
       accessible_quantity, required_quantity, support_class, needs_transport,
       locations_json, snapshot_id, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(character_id, owner_user_id, owner_chat_id, binding_epoch, opportunity_id) DO UPDATE SET
      binding_digest = excluded.binding_digest,
      type_id = excluded.type_id,
      held_quantity = excluded.held_quantity,
      accessible_quantity = excluded.accessible_quantity,
      required_quantity = excluded.required_quantity,
      support_class = excluded.support_class,
      needs_transport = excluded.needs_transport,
      locations_json = excluded.locations_json,
      snapshot_id = excluded.snapshot_id,
      computed_at = excluded.computed_at
  `).run(
    match.matchId,
    match.characterId,
    lineage.ownerUserId,
    lineage.ownerChatId,
    lineage.bindingEpoch,
    lineage.bindingDigest,
    match.opportunityId,
    match.typeId,
    match.heldQuantity, match.accessibleQuantity, match.requiredQuantity,
    match.supportClass, match.needsTransport ? 1 : 0,
    JSON.stringify(match.locations), match.snapshotId, match.computedAt,
  );
}

export class RealOpportunityMatchService {
  /**
   * Recompute matches for every ACTIVE opportunity of one character.
   * Directly usable stock is reserved once, in deterministic priority order,
   * so two opportunities never claim the same units.
   */
  static recompute(db: Db, characterId: number, lineage: AssetLineage): { computed: number; matches: OpportunityMatch[] } {
    const opportunities = activeOpportunities(db, characterId, lineage);
    const snapshot = latestCompleteSnapshot(db, characterId, lineage);
    const consistent = currentSetIsConsistent(db, characterId, snapshot, lineage);
    const mirrorOwnership = assetLineagePredicate(null, lineage);
    const assets = consistent
      ? db.prepare(`
          SELECT item_id, type_id, quantity, location_id
          FROM character_assets WHERE character_id = ? AND ${mirrorOwnership.sql}
        `).all(characterId, ...mirrorOwnership.params) as AssetRow[]
      : [];
    const registry = new Map<number, number>(assets.map((row) => [row.item_id, row.location_id]));
    const locationCache = new Map<number, any>((db.prepare(
      'SELECT * FROM real_asset_locations',
    ).all() as any[]).map((row) => [Number(row.location_id), row]));

    const byType = new Map<number, AssetRow[]>();
    for (const row of assets) {
      const list = byType.get(row.type_id) ?? [];
      list.push(row);
      byType.set(row.type_id, list);
    }

    // Available directly usable units per (type, BUY hub). Only ACTIVE
    // opportunities reserve; the key is the exact hub, never "same region".
    const pools = new Map<string, number>();
    const rowsByKey = new Map<string, Array<{ quantity: number; terminal: number }>>();
    for (const [typeId, rows] of byType) {
      for (const row of rows) {
        const terminal = terminalLocation(row, registry);
        const key = `${typeId}:${terminal}`;
        const list = rowsByKey.get(key) ?? [];
        list.push({ quantity: Number(row.quantity), terminal });
        rowsByKey.set(key, list);
      }
    }
    for (const [key, rows] of rowsByKey) {
      pools.set(key, rows.reduce((sum, row) => sum + row.quantity, 0));
    }

    const now = new Date().toISOString();
    const matches: OpportunityMatch[] = [];
    const tx = db.transaction(() => {
      // Remove stale/terminal matches so the UI never shows linkage for an
      // opportunity that is no longer eligible for planning.
      const matchOwnership = assetLineagePredicate(null, lineage);
      const opportunityOwnership = p9LineagePredicate('o', lineage);
      db.prepare(`
        DELETE FROM real_asset_opportunity_matches
        WHERE character_id = ? AND ${matchOwnership.sql}
          AND opportunity_id NOT IN (
            SELECT o.opportunity_id FROM p9_real_opportunities o
            WHERE o.character_id = ? AND ${opportunityOwnership.sql}
              AND o.state IN ('ACTIONABLE', 'NEW', 'WATCHING', 'STALE')
          )
      `).run(characterId, ...matchOwnership.params, characterId, ...opportunityOwnership.params);

      for (const opportunity of opportunities) {
        const required = Math.max(
          1,
          Number(opportunity.suggested_quantity) || Number(opportunity.executable_quantity) || 1,
        );
        const rows = byType.get(opportunity.type_id) ?? [];
        const held = rows.reduce((sum, row) => sum + Number(row.quantity), 0);
        const poolKey = `${opportunity.type_id}:${opportunity.buy_location_id}`;
        const rawAccessible = rowsByKey.get(poolKey)?.reduce((sum, row) => sum + row.quantity, 0) ?? 0;
        const poolRemainingBefore = Math.max(0, pools.get(poolKey) ?? 0);
        const marketTradable = db.prepare(`
          SELECT 1 FROM market_orders
          WHERE type_id = ? AND volume_remain > 0 LIMIT 1
        `).get(opportunity.type_id) !== undefined;

        const locations: Array<Record<string, unknown>> = [];
        const grouped = new Map<number, { quantity: number; rawLocationIds: number[] }>();
        let unknownQuantity = 0;
        for (const row of rows) {
          const terminal = terminalLocation(row, registry);
          const cache = locationCache.get(terminal);
          const known = cache && ['RESOLVED', 'PARTIALLY_RESOLVED'].includes(cache.resolution_status);
          if (!known) unknownQuantity += Number(row.quantity);
          const group = grouped.get(terminal) ?? { quantity: 0, rawLocationIds: [] };
          group.quantity += Number(row.quantity);
          group.rawLocationIds.push(Number(row.location_id));
          grouped.set(terminal, group);
        }
        for (const [terminal, group] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
          const cache = locationCache.get(terminal);
          locations.push({
            terminalLocationId: terminal,
            locationName: cache?.location_name ?? null,
            solarSystemName: cache?.solar_system_name ?? null,
            regionName: cache?.region_name ?? null,
            resolutionStatus: cache?.resolution_status ?? 'UNKNOWN',
            quantity: group.quantity,
            rawLocationIds: group.rawLocationIds,
            atBuyHub: terminal === opportunity.buy_location_id,
          });
        }

        let allocated = 0;
        let supportClass: SupportClass;

        if (!consistent) {
          supportClass = 'UNKNOWN';
        } else if (!marketTradable && held > 0) {
          supportClass = 'UNAVAILABLE';
        } else if (held === 0) {
          supportClass = 'NEEDS_PURCHASE';
        } else {
          // Reserve only units that are actually at this exact BUY hub. Units
          // elsewhere never become "accessible" merely because the type matches.
          allocated = Math.min(poolRemainingBefore, required);
          if (unknownQuantity > 0 && allocated < required) {
            // Known units are reserved, but unknown locations could change the
            // final answer; never coerce the unknown remainder to zero.
            supportClass = 'UNKNOWN';
          } else if (allocated >= required) {
            supportClass = 'SUPPORTED';
          } else if (allocated > 0) {
            supportClass = 'PARTIAL';
          } else {
            supportClass = 'UNAVAILABLE';
          }
        }

        if (allocated > 0 && ACTIVE_STATES.includes(opportunity.state as any)) {
          pools.set(poolKey, Math.max(0, poolRemainingBefore - allocated));
        }

        const needsTransport = opportunity.strategy === 'regional_hauling'
          || (held > 0 && (rawAccessible < held || unknownQuantity > 0));

        const match: OpportunityMatch = {
          matchId: `ASSETMATCH-${Date.now()}-${randomUUID().slice(0, 8)}`,
          characterId,
          opportunityId: opportunity.opportunity_id,
          typeId: opportunity.type_id,
          heldQuantity: held,
          accessibleQuantity: allocated,
          requiredQuantity: required,
          supportClass,
          supportClassZh: SUPPORT_LABELS_ZH[supportClass],
          needsTransport,
          locations: [
            ...locations,
            {
              reservation: {
                rawAccessibleAtBuyHub: rawAccessible,
                remainingBeforeThisOpportunity: poolRemainingBefore,
                reservedByEarlierOpportunities: Math.max(0, rawAccessible - poolRemainingBefore),
                allocatedToThisOpportunity: allocated,
                remainingAfterThisOpportunity: Math.max(0, poolRemainingBefore - allocated),
              },
            },
            {
              dataQuality: {
                consistentCurrentSnapshot: consistent,
                snapshotId: snapshot?.snapshot_id ?? null,
                unknownLocationQuantity: unknownQuantity,
                marketTradable,
              },
            },
          ],
          snapshotId: consistent ? snapshot.snapshot_id : null,
          computedAt: now,
        };
        insertMatch(db, match, lineage);
        matches.push(match);
      }
    });
    tx();
    return { computed: matches.length, matches };
  }

  static list(db: Db, characterId: number, lineage: AssetLineage, filters: { supportClass?: string; state?: string; limit?: number; offset?: number } = {}): {
    rows: any[];
    total: number;
    limit: number;
    offset: number;
  } {
    const limit = clampPositiveInteger(filters.limit, 100, 500);
    const offset = clampNonNegativeInteger(filters.offset);
    const ownership = assetLineagePredicate('m', lineage);
    const opportunityOwnership = p9LineagePredicate('o', lineage);
    const where = ['m.character_id = ?', ownership.sql, opportunityOwnership.sql];
    const params: unknown[] = [characterId, ...ownership.params, ...opportunityOwnership.params];
    if (filters.supportClass) {
      where.push('m.support_class = ?');
      params.push(filters.supportClass);
    }
    if (filters.state) {
      where.push('o.state = ?');
      params.push(filters.state);
    }
    const whereSql = where.join(' AND ');
    const total = Number((db.prepare(`
      SELECT COUNT(*) AS n
      FROM real_asset_opportunity_matches m
      JOIN p9_real_opportunities o
        ON o.opportunity_id = m.opportunity_id AND o.character_id = m.character_id
      WHERE ${whereSql}
    `).get(...params) as any)?.n || 0);
    const rows = db.prepare(`
      SELECT m.*,
             o.strategy, o.type_name_en, o.type_name_zh, o.buy_location_id,
             o.buy_location_name, o.sell_location_id, o.sell_location_name,
             o.suggested_quantity, o.executable_quantity, o.fee_net_profit,
             o.comprehensive_net_profit, o.comprehensive_status, o.logistics_known,
             o.risk_level, o.state, o.expires_at,
             COALESCE(json_extract(t.data_json, '$.name.zh'), t.name) AS type_name
      FROM real_asset_opportunity_matches m
      JOIN p9_real_opportunities o
        ON o.opportunity_id = m.opportunity_id AND o.character_id = m.character_id
      LEFT JOIN sde_types t ON t.type_id = m.type_id
      WHERE ${whereSql}
      ORDER BY CASE o.state
                 WHEN 'ACTIONABLE' THEN 0 WHEN 'NEW' THEN 1
                 WHEN 'WATCHING' THEN 2 ELSE 3 END,
               o.fee_net_profit DESC, m.computed_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];
    return {
      rows: rows.map((row) => ({
        ...row,
        needs_transport: Boolean(row.needs_transport),
        locations: JSON.parse(row.locations_json || '[]'),
        supportClassZh: SUPPORT_LABELS_ZH[row.support_class as SupportClass] ?? row.support_class,
        locations_json: undefined,
      })),
      total,
      limit,
      offset,
    };
  }
}
