import type { Db } from '../db/sqlite.js';

/**
 * P9.2.3 inventory classification, filtering and local tags.
 *
 * Buckets are derived from EVE SDE category/group rows (never from hardcoded
 * item names): the SQL CASE below is the single source of truth and the label
 * map only translates bucket keys to the Chinese UI. Blueprint originals vs
 * copies are separated by the ESI is_blueprint_copy flag, not by name.
 */

export const INVENTORY_BUCKETS = [
  'SHIPS', 'SHIP_MODULES', 'DRONES', 'AMMO', 'ORES_MINERALS', 'MANUFACTURING',
  'BPO', 'BPC', 'MISSION', 'IMPLANTS', 'CONSUMABLES', 'TRADING_GOODS', 'OTHER', 'UNKNOWN',
] as const;
export type InventoryBucket = (typeof INVENTORY_BUCKETS)[number];

export const BUCKET_LABELS_ZH: Record<InventoryBucket, string> = {
  SHIPS: '舰船',
  SHIP_MODULES: '舰船装备',
  DRONES: '无人机',
  AMMO: '弹药',
  ORES_MINERALS: '矿石与矿物',
  MANUFACTURING: '制造材料',
  BPO: '蓝图原件 BPO',
  BPC: '蓝图复制件 BPC',
  MISSION: '任务物品',
  IMPLANTS: '植入体',
  CONSUMABLES: '消耗品',
  TRADING_GOODS: '贸易商品',
  OTHER: '其他物品',
  UNKNOWN: '未知分类',
};

export const ASSET_TAG_VALUES = [
  'SELF_USE', 'FOR_SALE', 'PRODUCTION', 'MISSION', 'SPARE', 'TRADE_STOCK', 'HOLD',
] as const;
export type AssetTag = (typeof ASSET_TAG_VALUES)[number];

export const ASSET_TAG_LABELS_ZH: Record<AssetTag, string> = {
  SELF_USE: '自用',
  FOR_SALE: '待出售',
  PRODUCTION: '生产材料',
  MISSION: '任务用途',
  SPARE: '备用装备',
  TRADE_STOCK: '交易库存',
  HOLD: '暂不处理',
};

/** Single source of truth for bucket derivation (mirrored in the SQL CASE). */
export const BUCKET_SQL_CASE = `
  CASE
    WHEN c.name IS NULL THEN 'UNKNOWN'
    WHEN c.name = 'Blueprint' AND COALESCE(a.is_blueprint_copy, 0) = 1 THEN 'BPC'
    WHEN c.name = 'Blueprint' THEN 'BPO'
    WHEN c.name = 'Ship' THEN 'SHIPS'
    WHEN c.name IN ('Module', 'Subsystem', 'Structure Module') THEN 'SHIP_MODULES'
    WHEN c.name IN ('Drone', 'Fighter') THEN 'DRONES'
    WHEN c.name = 'Charge' THEN 'AMMO'
    WHEN c.name = 'Asteroid' OR (c.name = 'Material' AND g.name = 'Mineral') THEN 'ORES_MINERALS'
    WHEN c.name IN ('Material', 'Reaction', 'Planetary Resources', 'Planetary Commodities',
                    'Colony Resources', 'Infrastructure Upgrades') THEN 'MANUFACTURING'
    WHEN c.name = 'Implant' THEN 'IMPLANTS'
    WHEN c.name = 'Deployable' THEN 'CONSUMABLES'
    WHEN c.name = 'Trading' THEN 'TRADING_GOODS'
    WHEN c.name = 'Commodity' AND (g.name LIKE '%Insignia%' OR g.name LIKE '%Mission%') THEN 'MISSION'
    WHEN c.name = 'Commodity' THEN 'TRADING_GOODS'
    ELSE 'OTHER'
  END
`;

export type InventoryQuery = {
  characterId: number;
  regionId?: number;
  solarSystemId?: number;
  locationId?: number;
  bucket?: string;
  resolutionStatus?: string;
  q?: string;
  tradable?: boolean;
  sort?: 'quantity' | 'name' | 'type';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
};

export type InventoryRow = {
  itemId: number;
  typeId: number;
  quantity: number;
  locationId: number;
  locationType: string | null;
  locationFlag: string | null;
  isBlueprintCopy: boolean | null;
  typeName: string;
  typeNameZh: string | null;
  groupName: string | null;
  categoryName: string | null;
  bucket: InventoryBucket;
  bucketLabelZh: string;
  resolvedType: string | null;
  resolvedName: string | null;
  solarSystemName: string | null;
  regionName: string | null;
  resolutionStatus: string | null;
  hasMarket: boolean;
  tag: AssetTag | null;
  marketReferenceValue: number | null;
  bidLiquidationNet: number | null;
  valuationStatuses: string[];
};

const SORT_COLUMNS: Record<string, string> = {
  quantity: 'a.quantity',
  name: 'LOWER(COALESCE(json_extract(t.data_json, \'$.name.zh\'), t.name))',
  type: 'a.type_id',
};

function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

export class RealInventoryService {
  static list(db: Db, query: InventoryQuery): { rows: InventoryRow[]; total: number; limit: number; offset: number } {
    const limit = clampLimit(query.limit, 100, 500);
    const offset = Math.max(0, Number(query.offset) || 0);
    const where: string[] = ['a.character_id = ?'];
    const params: unknown[] = [query.characterId];

    if (query.regionId) {
      where.push('loc.region_id = ?');
      params.push(query.regionId);
    }
    if (query.solarSystemId) {
      where.push('loc.solar_system_id = ?');
      params.push(query.solarSystemId);
    }
    if (query.locationId) {
      where.push('a.location_id = ?');
      params.push(query.locationId);
    }
    if (query.resolutionStatus) {
      where.push('loc.resolution_status = ?');
      params.push(query.resolutionStatus);
    }
    if (query.bucket && INVENTORY_BUCKETS.includes(query.bucket as InventoryBucket)) {
      where.push(`${BUCKET_SQL_CASE} = ?`);
      params.push(query.bucket);
    }
    if (query.q && query.q.trim()) {
      where.push(`(
        LOWER(COALESCE(json_extract(t.data_json, '$.name.zh'), t.name)) LIKE ?
        OR LOWER(t.name) LIKE ?
        OR CAST(a.type_id AS TEXT) = ?
      )`);
      const needle = `%${query.q.trim().toLowerCase()}%`;
      params.push(needle, needle, query.q.trim());
    }
    if (query.tradable !== undefined) {
      where.push(query.tradable
        ? 'EXISTS (SELECT 1 FROM market_orders mo WHERE mo.type_id = a.type_id AND mo.volume_remain > 0)'
        : 'NOT EXISTS (SELECT 1 FROM market_orders mo WHERE mo.type_id = a.type_id AND mo.volume_remain > 0)');
    }

    const sortColumn = SORT_COLUMNS[query.sort ?? 'quantity'] ?? SORT_COLUMNS.quantity;
    const direction = query.order === 'asc' ? 'ASC' : 'DESC';
    const whereSql = where.join(' AND ');

    const totalRow = db.prepare(`
      SELECT COUNT(*) AS n
      FROM character_assets a
      LEFT JOIN sde_types t ON t.type_id = a.type_id
      LEFT JOIN sde_groups g ON g.group_id = t.group_id
      LEFT JOIN sde_categories c ON c.category_id = g.category_id
      LEFT JOIN real_asset_locations loc ON loc.location_id = a.location_id
      WHERE ${whereSql}
    `).get(...params) as { n: number };

    const rows = db.prepare(`
      SELECT a.item_id, a.type_id, a.quantity, a.location_id, a.location_type, a.location_flag,
             a.is_blueprint_copy,
             t.name AS type_name,
             COALESCE(json_extract(t.data_json, '$.name.zh'), t.name) AS type_name_zh,
             g.name AS group_name,
             c.name AS category_name,
             ${BUCKET_SQL_CASE} AS bucket,
             loc.location_type AS resolved_type,
             loc.location_name AS resolved_name,
             loc.solar_system_name,
             loc.region_name,
             loc.resolution_status,
             EXISTS (SELECT 1 FROM market_orders mo WHERE mo.type_id = a.type_id AND mo.volume_remain > 0) AS has_market,
             (SELECT tag FROM real_asset_tags tg WHERE tg.character_id = a.character_id AND tg.item_id = a.item_id) AS tag,
             (SELECT vi.market_reference_value FROM real_asset_valuation_items vi
               WHERE vi.valuation_id = (
                 SELECT v.valuation_id FROM real_asset_valuations v
                 WHERE v.character_id = a.character_id AND v.status = 'COMPLETED'
                 ORDER BY v.created_at DESC LIMIT 1
               ) AND vi.item_id = a.item_id) AS market_reference_value,
             (SELECT vi.bid_liquidation_net FROM real_asset_valuation_items vi
               WHERE vi.valuation_id = (
                 SELECT v.valuation_id FROM real_asset_valuations v
                 WHERE v.character_id = a.character_id AND v.status = 'COMPLETED'
                 ORDER BY v.created_at DESC LIMIT 1
               ) AND vi.item_id = a.item_id) AS bid_liquidation_net,
             (SELECT vi.statuses_json FROM real_asset_valuation_items vi
               WHERE vi.valuation_id = (
                 SELECT v.valuation_id FROM real_asset_valuations v
                 WHERE v.character_id = a.character_id AND v.status = 'COMPLETED'
                 ORDER BY v.created_at DESC LIMIT 1
               ) AND vi.item_id = a.item_id) AS valuation_statuses_json
      FROM character_assets a
      LEFT JOIN sde_types t ON t.type_id = a.type_id
      LEFT JOIN sde_groups g ON g.group_id = t.group_id
      LEFT JOIN sde_categories c ON c.category_id = g.category_id
      LEFT JOIN real_asset_locations loc ON loc.location_id = a.location_id
      WHERE ${whereSql}
      ORDER BY ${sortColumn} ${direction}, a.item_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];

    return {
      rows: rows.map(mapRow),
      total: Number(totalRow.n),
      limit,
      offset,
    };
  }

  static detail(db: Db, characterId: number, itemId: number): (InventoryRow & {
    changeHistory: unknown[];
    snapshotHistory: unknown[];
    latestValuation: Record<string, unknown> | null;
  }) | null {
    const base = db.prepare(`
      SELECT a.item_id, a.type_id, a.quantity, a.location_id, a.location_type, a.location_flag,
             a.is_blueprint_copy,
             t.name AS type_name,
             COALESCE(json_extract(t.data_json, '$.name.zh'), t.name) AS type_name_zh,
             g.name AS group_name,
             c.name AS category_name,
             ${BUCKET_SQL_CASE} AS bucket,
             loc.location_type AS resolved_type,
             loc.location_name AS resolved_name,
             loc.solar_system_name,
             loc.region_name,
             loc.resolution_status,
             EXISTS (SELECT 1 FROM market_orders mo WHERE mo.type_id = a.type_id AND mo.volume_remain > 0) AS has_market,
             (SELECT tag FROM real_asset_tags tg WHERE tg.character_id = a.character_id AND tg.item_id = a.item_id) AS tag,
             (SELECT vi.market_reference_value FROM real_asset_valuation_items vi
               WHERE vi.valuation_id = (
                 SELECT v.valuation_id FROM real_asset_valuations v
                 WHERE v.character_id = a.character_id AND v.status = 'COMPLETED'
                 ORDER BY v.created_at DESC LIMIT 1
               ) AND vi.item_id = a.item_id) AS market_reference_value,
             (SELECT vi.bid_liquidation_net FROM real_asset_valuation_items vi
               WHERE vi.valuation_id = (
                 SELECT v.valuation_id FROM real_asset_valuations v
                 WHERE v.character_id = a.character_id AND v.status = 'COMPLETED'
                 ORDER BY v.created_at DESC LIMIT 1
               ) AND vi.item_id = a.item_id) AS bid_liquidation_net,
             (SELECT vi.statuses_json FROM real_asset_valuation_items vi
               WHERE vi.valuation_id = (
                 SELECT v.valuation_id FROM real_asset_valuations v
                 WHERE v.character_id = a.character_id AND v.status = 'COMPLETED'
                 ORDER BY v.created_at DESC LIMIT 1
               ) AND vi.item_id = a.item_id) AS valuation_statuses_json
      FROM character_assets a
      LEFT JOIN sde_types t ON t.type_id = a.type_id
      LEFT JOIN sde_groups g ON g.group_id = t.group_id
      LEFT JOIN sde_categories c ON c.category_id = g.category_id
      LEFT JOIN real_asset_locations loc ON loc.location_id = a.location_id
      WHERE a.character_id = ? AND a.item_id = ?
    `).get(characterId, itemId) as any;
    if (!base) return null;

    const changeHistory = db.prepare(`
      SELECT change_id, change_type, prev_quantity, new_quantity,
             prev_location_id, new_location_id, source_class, confidence,
             from_snapshot_id, to_snapshot_id, detected_at
      FROM real_asset_changes
      WHERE character_id = ? AND item_id = ?
      ORDER BY detected_at DESC LIMIT 100
    `).all(characterId, itemId);

    const snapshotHistory = db.prepare(`
      SELECT si.snapshot_id, s.completed_at, s.status, si.quantity, si.location_id, si.parent_item_id
      FROM real_asset_snapshot_items si
      JOIN real_asset_snapshots s ON s.snapshot_id = si.snapshot_id
      WHERE s.character_id = ? AND si.item_id = ?
      ORDER BY s.completed_at DESC LIMIT 50
    `).all(characterId, itemId);

    const valuationHeader = db.prepare(`
      SELECT valuation_id, snapshot_id, hub_location_id, hub_region_id,
             market_snapshot_at, fee_model_version, created_at, completed_at
      FROM real_asset_valuations
      WHERE character_id = ? AND status = 'COMPLETED'
      ORDER BY created_at DESC LIMIT 1
    `).get(characterId) as any;
    const valuationItem = valuationHeader
      ? db.prepare(`
          SELECT market_reference_value, bid_liquidation_gross, bid_liquidation_net,
                 fillable_quantity, unfillable_quantity, ask_replacement_gross,
                 ask_replacement_net, statuses_json, flags_json, price_source
          FROM real_asset_valuation_items
          WHERE valuation_id = ? AND item_id = ?
        `).get(valuationHeader.valuation_id, itemId) as any
      : undefined;
    const latestValuation = valuationHeader
      ? {
          ...valuationHeader,
          item: valuationItem
            ? {
                ...valuationItem,
                statuses: JSON.parse(valuationItem.statuses_json || '[]'),
                flags: JSON.parse(valuationItem.flags_json || '[]'),
              }
            : null,
          feeAssumptions: {
            note: '角色技能/声望/设施未知时采用默认 Alpha 技能 / NPC 空间站假设；不得视为该角色真实费用。',
          },
        }
      : null;
    return { ...mapRow(base), changeHistory, snapshotHistory, latestValuation };
  }

  static getTag(db: Db, characterId: number, itemId: number): AssetTag | null {
    const row = db.prepare(
      'SELECT tag FROM real_asset_tags WHERE character_id = ? AND item_id = ?',
    ).get(characterId, itemId) as { tag: string } | undefined;
    return (row?.tag as AssetTag) ?? null;
  }

  /** Local-only label: never reaches EVE. Rejects items outside the current set. */
  static setTag(db: Db, characterId: number, itemId: number, tag: string): AssetTag {
    if (!ASSET_TAG_VALUES.includes(tag as AssetTag)) {
      throw new Error(`无效标签：${tag}。允许值：${ASSET_TAG_VALUES.join(', ')}`);
    }
    const owned = db.prepare(
      'SELECT 1 FROM character_assets WHERE character_id = ? AND item_id = ?',
    ).get(characterId, itemId);
    if (!owned) throw new Error('该物品不在当前角色的最新资产快照中，无法打标签。');
    db.prepare(`
      INSERT INTO real_asset_tags (character_id, item_id, tag, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(character_id, item_id) DO UPDATE SET
        tag = excluded.tag, updated_at = excluded.updated_at
    `).run(characterId, itemId, tag);
    return tag as AssetTag;
  }

  static clearTag(db: Db, characterId: number, itemId: number): void {
    db.prepare('DELETE FROM real_asset_tags WHERE character_id = ? AND item_id = ?')
      .run(characterId, itemId);
  }

  /** Category summary for the overview page (deterministic, no valuation). */
  static bucketSummary(db: Db, characterId: number): Array<{ bucket: InventoryBucket; labelZh: string; items: number; quantity: number }> {
    const rows = db.prepare(`
      SELECT ${BUCKET_SQL_CASE} AS bucket, COUNT(*) AS items, COALESCE(SUM(a.quantity), 0) AS quantity
      FROM character_assets a
      LEFT JOIN sde_types t ON t.type_id = a.type_id
      LEFT JOIN sde_groups g ON g.group_id = t.group_id
      LEFT JOIN sde_categories c ON c.category_id = g.category_id
      WHERE a.character_id = ?
      GROUP BY bucket
      ORDER BY items DESC
    `).all(characterId) as Array<{ bucket: InventoryBucket; items: number; quantity: number }>;
    return rows.map((row) => ({ ...row, labelZh: BUCKET_LABELS_ZH[row.bucket] ?? row.bucket }));
  }
}

function mapRow(row: any): InventoryRow {
  const bucket = (INVENTORY_BUCKETS as readonly string[]).includes(row.bucket)
    ? row.bucket as InventoryBucket
    : 'UNKNOWN';
  return {
    itemId: row.item_id,
    typeId: row.type_id,
    quantity: Number(row.quantity ?? 0),
    locationId: row.location_id,
    locationType: row.location_type ?? null,
    locationFlag: row.location_flag ?? null,
    isBlueprintCopy: row.is_blueprint_copy === null || row.is_blueprint_copy === undefined
      ? null : Boolean(row.is_blueprint_copy),
    typeName: row.type_name ?? `Type ${row.type_id}`,
    typeNameZh: row.type_name_zh ?? null,
    groupName: row.group_name ?? null,
    categoryName: row.category_name ?? null,
    bucket,
    bucketLabelZh: BUCKET_LABELS_ZH[bucket],
    resolvedType: row.resolved_type ?? null,
    resolvedName: row.resolved_name ?? null,
    solarSystemName: row.solar_system_name ?? null,
    regionName: row.region_name ?? null,
    resolutionStatus: row.resolution_status ?? null,
    hasMarket: Boolean(row.has_market),
    tag: (row.tag as AssetTag) ?? null,
    marketReferenceValue: row.market_reference_value ?? null,
    bidLiquidationNet: row.bid_liquidation_net ?? null,
    valuationStatuses: (() => {
      try { return JSON.parse(row.valuation_statuses_json || '[]') as string[]; }
      catch { return []; }
    })(),
  };
}
