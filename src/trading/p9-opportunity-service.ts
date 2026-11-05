import { createHash, randomUUID } from 'node:crypto';
import { clampNonNegativeInteger, clampPositiveInteger } from '../util/query-bounds.js';
import type { Db } from '../db/sqlite.js';
import { DataCenter } from './data-center.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS, FEE_MODEL_VERSION } from './fee-engine.js';
import { OrderBookSimulator } from './orderbook-simulator.js';
import type { FeeContext, OrderBookLevel } from './types.js';
import { p9LineagePredicate, p9LineageValues, type P9ControlPlaneLineage } from './p9-control-plane-lineage.js';
import {
  canTransitionP9Opportunity,
  canTransitionP9Plan,
  type P9Hub,
  type P9Opportunity,
  type P9OpportunityState,
  type P9PlanStatus,
  type P9ScanSettings,
  type P9TradePlan,
} from './p9-types.js';

export const P9_CALCULATION_VERSION = 'eveai-p9-arbitrage-v1';

export const DEFAULT_P9_HUBS: P9Hub[] = [
  { locationId: 60003760, regionId: 10000002, name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant（吉他）', enabled: true },
  { locationId: 60008494, regionId: 10000043, name: 'Amarr VIII (Oris) - Emperor Family Academy（阿玛）', enabled: true },
  { locationId: 60011866, regionId: 10000032, name: 'Dodixie IX - Moon 20 - Federation Navy Assembly Plant（杜迪克西）', enabled: true },
];

const DEFAULT_FEE_CONTEXT: FeeContext = {
  clone: 'alpha',
  skills: ALPHA_DEFAULT_SKILLS,
  facility: 'npc_station',
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isoNow(): string {
  return new Date().toISOString();
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function minutesBetween(later: string | null | undefined, earlier: string | null | undefined): number | null {
  if (!later || !earlier) return null;
  const a = Date.parse(later.endsWith('Z') ? later : later.replace(' ', 'T') + 'Z');
  const b = Date.parse(earlier.endsWith('Z') ? earlier : earlier.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return round2(Math.abs(a - b) / 60_000);
}

function validHub(hub: unknown): hub is P9Hub {
  if (!hub || typeof hub !== 'object') return false;
  const row = hub as Record<string, unknown>;
  return Number.isSafeInteger(Number(row.locationId))
    && Number(row.locationId) > 0
    && Number.isSafeInteger(Number(row.regionId))
    && Number(row.regionId) > 0
    && typeof row.name === 'string'
    && row.name.trim().length > 0;
}

function observation(db: Db, regionId: number, locationId: number, typeId: number, maxAgeMinutes: number) {
  const book = DataCenter.getOrderBook(db, regionId, typeId, locationId);
  const metaRow = db.prepare(`
    SELECT fetched_at, expires_at, pages, rows_loaded, last_error
    FROM market_snapshot_regions WHERE region_id = ?
  `).get(regionId) as any;
  const snapshotAt = metaRow?.fetched_at || null;
  const snapshotExpiresAt = metaRow?.expires_at || null;
  const now = Date.now();
  const fetchedMs = snapshotAt ? Date.parse(snapshotAt.endsWith('Z') ? snapshotAt : snapshotAt.replace(' ', 'T') + 'Z') : NaN;
  const ageMinutes = Number.isFinite(fetchedMs) ? round2((now - fetchedMs) / 60_000) : null;
  const complete = Boolean(
    metaRow
    && Number(metaRow.pages || 0) > 0
    && Number(metaRow.rows_loaded || 0) > 0
    && !metaRow.last_error
    && book.sells.length + book.buys.length > 0,
  );
  // ESI's Expires header only bounds re-fetching; it does not mean the book is
  // unusable the moment it passes. Freshness is the snapshot's actual age
  // against the user's configured maxMarketAgeMinutes.
  const fresh = complete
    && ageMinutes !== null
    && ageMinutes <= maxAgeMinutes;
  return {
    levels: book,
    snapshotAt,
    snapshotExpiresAt,
    snapshotAgeMinutes: ageMinutes,
    complete,
    fresh,
    lastError: metaRow?.last_error || null,
  };
}

function snapshotId(
  regionId: number,
  locationId: number,
  typeId: number,
  levels: { sells: OrderBookLevel[]; buys: OrderBookLevel[] },
  at: string | null,
): string {
  const payload = JSON.stringify({
    regionId,
    locationId,
    typeId,
    at,
    sells: levels.sells.slice(0, 50),
    buys: levels.buys.slice(0, 50),
  });
  return 'P9SNAP-' + createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

function locationKind(db: Db, locationId: number): 'npc_station' | 'structure_or_unknown' {
  const row = db.prepare('SELECT station_id FROM sde_stations WHERE station_id = ?').get(locationId) as any;
  return row ? 'npc_station' : 'structure_or_unknown';
}
function riskLevel(flags: string[]): P9Opportunity['riskLevel'] {
  if (flags.includes('DATA_INCOMPLETE') || flags.includes('DATA_STALE') || flags.includes('BELOW_MINIMUM')) return 'BLOCKED';
  if (flags.length >= 3 || flags.includes('LOGISTICS_UNKNOWN') || flags.includes('SNAPSHOT_SKEW')) return 'HIGH';
  if (flags.length > 0) return 'MEDIUM';
  return 'LOW';
}

function stateFor(params: {
  flags: string[];
  feeNet: number;
  roiPct: number;
  settings: P9ScanSettings;
  tradePlanComplete: boolean;
}): P9OpportunityState {
  const { flags, feeNet, roiPct, settings, tradePlanComplete } = params;
  if (flags.includes('DATA_INCOMPLETE') || flags.includes('DATA_STALE')) return 'STALE';
  if (feeNet < settings.minNetProfit || roiPct < settings.minRoiPct) return 'REJECTED';
  // A spread that clears the thresholds but has unresolved costs (e.g. unknown
  // inter-hub logistics) is a candidate under observation, not a fully
  // verified executable plan.
  return tradePlanComplete ? 'ACTIONABLE' : 'WATCHING';
}

function hubPairs(hubs: P9Hub[]): Array<[P9Hub, P9Hub]> {
  const pairs: Array<[P9Hub, P9Hub]> = [];
  for (const buy of hubs) {
    for (const sell of hubs) {
      if (buy.locationId !== sell.locationId) pairs.push([buy, sell]);
    }
  }
  return pairs;
}

function stationCandidateTypes(db: Db, hub: P9Hub, limit: number) {
  return db.prepare(`
    WITH asks AS (
      SELECT type_id, MIN(price) AS best_ask, SUM(volume_remain) AS ask_depth
      FROM market_orders
      WHERE region_id = ? AND location_id = ? AND is_buy_order = 0 AND volume_remain > 0
      GROUP BY type_id
    ), bids AS (
      SELECT type_id, MAX(price) AS best_bid, SUM(volume_remain) AS bid_depth
      FROM market_orders
      WHERE region_id = ? AND location_id = ? AND is_buy_order = 1 AND volume_remain > 0
      GROUP BY type_id
    )
    SELECT asks.type_id, asks.best_ask, asks.ask_depth, bids.best_bid, bids.bid_depth
    FROM asks JOIN bids ON bids.type_id = asks.type_id
    WHERE bids.best_bid > asks.best_ask
    ORDER BY (bids.best_bid - asks.best_ask) / asks.best_ask DESC
    LIMIT ?
  `).all(hub.regionId, hub.locationId, hub.regionId, hub.locationId, limit) as any[];
}

function crossCandidateTypes(db: Db, buyHub: P9Hub, sellHub: P9Hub, limit: number) {
  return db.prepare(`
    WITH asks AS (
      SELECT type_id, MIN(price) AS origin_ask, SUM(volume_remain) AS origin_ask_depth
      FROM market_orders
      WHERE region_id = ? AND location_id = ? AND is_buy_order = 0 AND volume_remain > 0
      GROUP BY type_id
    ), bids AS (
      SELECT type_id, MAX(price) AS dest_bid, SUM(volume_remain) AS dest_bid_depth
      FROM market_orders
      WHERE region_id = ? AND location_id = ? AND is_buy_order = 1 AND volume_remain > 0
      GROUP BY type_id
    )
    SELECT asks.type_id, asks.origin_ask, asks.origin_ask_depth, bids.dest_bid, bids.dest_bid_depth
    FROM asks JOIN bids ON bids.type_id = asks.type_id
    WHERE bids.dest_bid > asks.origin_ask * 1.03
    ORDER BY (bids.dest_bid - asks.origin_ask) / asks.origin_ask DESC
    LIMIT ?
  `).all(buyHub.regionId, buyHub.locationId, sellHub.regionId, sellHub.locationId, limit) as any[];
}

function mapOpportunity(row: any): P9Opportunity {
  return {
    opportunityId: row.opportunity_id,
    characterId: row.character_id,
    scanKey: row.scan_key,
    strategy: row.strategy,
    typeId: row.type_id,
    typeNameEn: row.type_name_en || `Type ${row.type_id}`,
    typeNameZh: row.type_name_zh || undefined,
    buyLocationId: row.buy_location_id,
    buyLocationName: row.buy_location_name,
    sellLocationId: row.sell_location_id,
    sellLocationName: row.sell_location_name,
    buyRegionId: row.buy_region_id,
    sellRegionId: row.sell_region_id,
    buyPrice: row.buy_price,
    sellPrice: row.sell_price,
    suggestedQuantity: row.suggested_quantity,
    executableQuantity: row.executable_quantity,
    purchaseAmount: row.purchase_amount,
    salesRevenue: row.sales_revenue,
    brokerFees: row.broker_fees,
    salesTax: row.sales_tax,
    otherFees: row.other_fees,
    theoreticalGrossProfit: row.theoretical_gross_profit,
    executableGrossProfit: row.executable_gross_profit,
    feeNetProfit: row.fee_net_profit,
    comprehensiveNetProfit: row.comprehensive_net_profit,
    comprehensiveStatus: row.comprehensive_status,
    capitalRequired: row.capital_required,
    roiPct: row.roi_pct,
    logisticsCost: row.logistics_cost,
    liquidity: row.liquidity,
    riskLevel: row.risk_level,
    riskFlags: parseJson<string[]>(row.risk_flags_json, []),
    buySnapshotId: row.buy_snapshot_id,
    sellSnapshotId: row.sell_snapshot_id,
    buySnapshotAt: row.buy_snapshot_at,
    sellSnapshotAt: row.sell_snapshot_at,
    buySnapshotAgeMinutes: row.buy_snapshot_age_minutes,
    sellSnapshotAgeMinutes: row.sell_snapshot_age_minutes,
    dataSource: row.data_source,
    dataComplete: Boolean(row.data_complete),
    dataFresh: Boolean(row.data_fresh),
    spreadDetected: Boolean(row.spread_detected),
    marketExecutable: Boolean(row.market_executable),
    profitAfterKnownFees: Boolean(row.profit_after_known_fees),
    logisticsKnown: Boolean(row.logistics_known),
    overallProfitKnown: Boolean(row.overall_profit_known),
    tradePlanComplete: Boolean(row.trade_plan_complete),
    calculationVersion: row.calculation_version,
    originalSnapshot: parseJson<Record<string, unknown>>(row.original_snapshot_json, {}),
    state: row.state,
    detectedAt: row.detected_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}
function buildCandidate(params: {
  db: Db;
  settings: P9ScanSettings;
  strategy: 'station_arbitrage' | 'regional_hauling';
  typeId: number;
  buyHub: P9Hub;
  sellHub: P9Hub;
}): P9Opportunity | null {
  const { db, settings, strategy, typeId, buyHub, sellHub } = params;
  const meta = DataCenter.getItemMetadata(db, typeId);
  if (!meta) return null;
  const buyObs = observation(db, buyHub.regionId, buyHub.locationId, typeId, settings.maxMarketAgeMinutes);
  const sellObs = observation(db, sellHub.regionId, sellHub.locationId, typeId, settings.maxMarketAgeMinutes);
  if (buyObs.levels.sells.length === 0 || sellObs.levels.buys.length === 0) return null;

  const bestAsk = buyObs.levels.sells[0].price;
  const maxByCapital = Math.floor(settings.maxCapital / Math.max(bestAsk, 0.000001));
  const maxAllowedQty = Math.max(0, Math.min(
    maxByCapital,
    buyObs.levels.sells.reduce((sum, level) => sum + level.volumeRemain, 0),
    sellObs.levels.buys.reduce((sum, level) => sum + level.volumeRemain, 0),
    100_000,
  ));
  if (maxAllowedQty <= 0) return null;

  const optimal = OrderBookSimulator.findOptimalProfitableQuantity({
    originSells: buyObs.levels.sells,
    destBuys: sellObs.levels.buys,
    maxAllowedQty,
    feeCtx: DEFAULT_FEE_CONTEXT,
    minNetMarginPct: Math.max(0.01, settings.minRoiPct * 0.2),
  });
  if (optimal.optimalQuantity <= 0 || !optimal.buySim.isComplete || !optimal.sellSim.isComplete) return null;

  const trade = FeeEngine.calculateTrade({
    buyType: 'immediate_buy',
    sellType: 'immediate_sell',
    buyUnitPrice: optimal.buySim.weightedAvgPrice,
    sellUnitPrice: optimal.sellSim.weightedAvgPrice,
    quantity: optimal.optimalQuantity,
    buyCtx: DEFAULT_FEE_CONTEXT,
    sellCtx: DEFAULT_FEE_CONTEXT,
    haulingCost: 0,
  });

  const theoreticalGross = round2((sellObs.levels.buys[0].price - bestAsk) * optimal.optimalQuantity);
  const executableGross = round2(optimal.sellSim.totalGrossIsk - optimal.buySim.totalGrossIsk);
  const feeNet = round2(trade.netProfit);
  const roiPct = round2(trade.roiPct);
  const flags: string[] = [];
  if (!buyObs.complete || !sellObs.complete) flags.push('DATA_INCOMPLETE');
  if (!buyObs.fresh || !sellObs.fresh) flags.push('DATA_STALE');
  const skew = minutesBetween(buyObs.snapshotAt, sellObs.snapshotAt);
  if (skew !== null && skew > 15) flags.push('SNAPSHOT_SKEW');
  if (strategy === 'regional_hauling') flags.push('LOGISTICS_UNKNOWN');
  if (locationKind(db, buyHub.locationId) !== 'npc_station' || locationKind(db, sellHub.locationId) !== 'npc_station') {
    flags.push('STRUCTURE_OR_UNKNOWN_LOCATION');
  }
  if (optimal.isDepthConstrained) flags.push('DEPTH_LIMITED');
  if (feeNet < settings.minNetProfit || roiPct < settings.minRoiPct) flags.push('BELOW_MINIMUM');
  if (trade.totalFees <= 0) flags.push('FEE_INCOMPLETE');
  if (buyObs.lastError || sellObs.lastError) flags.push('SNAPSHOT_LOAD_ERROR');

  // Independent truth values; several can hold at once and none of them alone
  // means "ready to trade".
  const spreadDetected = sellObs.levels.buys[0].price > buyObs.levels.sells[0].price;
  const marketExecutable = optimal.buySim.isComplete && optimal.sellSim.isComplete && optimal.optimalQuantity > 0;
  const profitAfterKnownFees = feeNet > 0;
  const logisticsKnown = strategy === 'station_arbitrage';
  const overallProfitKnown = logisticsKnown && !flags.includes('FEE_INCOMPLETE');
  const dataComplete = buyObs.complete && sellObs.complete;
  const dataFresh = buyObs.fresh && sellObs.fresh;
  const tradePlanComplete = spreadDetected
    && marketExecutable
    && profitAfterKnownFees
    && logisticsKnown
    && overallProfitKnown
    && dataComplete
    && dataFresh;

  const now = Date.parse(isoNow());
  // Validity = snapshot age window (maxMarketAgeMinutes), the same rule that
  // drives DATA_STALE. ESI's cache Expires only gates refetching and must not
  // date an opportunity in the past while the data is still fresh.
  const expiryCandidates = [buyObs.snapshotAt, sellObs.snapshotAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value.endsWith('Z') ? value : value.replace(' ', 'T') + 'Z')
      + settings.maxMarketAgeMinutes * 60_000)
    .filter((value) => Number.isFinite(value));
  const configuredExpiry = now + settings.maxMarketAgeMinutes * 60_000;
  const expiresAt = new Date(expiryCandidates.length > 0
    ? Math.min(configuredExpiry, ...expiryCandidates)
    : configuredExpiry).toISOString();

  const buySnapshotId = snapshotId(buyHub.regionId, buyHub.locationId, typeId, buyObs.levels, buyObs.snapshotAt);
  const sellSnapshotId = snapshotId(sellHub.regionId, sellHub.locationId, typeId, sellObs.levels, sellObs.snapshotAt);
  const scanKey = `${strategy}:${typeId}:${buyHub.locationId}:${sellHub.locationId}`;
  const opportunityId = 'P9OPP-' + createHash('sha256')
    .update(`${settings.characterId}|${scanKey}`)
    .digest('hex')
    .slice(0, 20);
  const state = stateFor({ flags, feeNet, roiPct, settings, tradePlanComplete });
  const liquidity = optimal.optimalQuantity >= 50 ? 'A' : optimal.optimalQuantity >= 10 ? 'B' : 'C';

  return {
    opportunityId,
    characterId: settings.characterId,
    scanKey,
    strategy,
    typeId,
    typeNameEn: meta.en_name,
    typeNameZh: meta.zh_name || undefined,
    buyLocationId: buyHub.locationId,
    buyLocationName: buyHub.name,
    sellLocationId: sellHub.locationId,
    sellLocationName: sellHub.name,
    buyRegionId: buyHub.regionId,
    sellRegionId: sellHub.regionId,
    buyPrice: optimal.buySim.weightedAvgPrice,
    sellPrice: optimal.sellSim.weightedAvgPrice,
    suggestedQuantity: optimal.optimalQuantity,
    executableQuantity: optimal.optimalQuantity,
    purchaseAmount: round2(optimal.buySim.totalGrossIsk),
    salesRevenue: round2(optimal.sellSim.totalGrossIsk),
    brokerFees: round2(trade.buyerBrokerFee),
    salesTax: round2(trade.salesTax + (trade.sccSurcharge || 0)),
    otherFees: round2(Math.max(0, trade.totalFees - trade.buyerBrokerFee - trade.salesTax - (trade.sccSurcharge || 0))),
    theoreticalGrossProfit: theoreticalGross,
    executableGrossProfit: executableGross,
    feeNetProfit: feeNet,
    comprehensiveNetProfit: null,
    comprehensiveStatus: 'UNKNOWN',
    capitalRequired: round2(trade.netCost),
    roiPct,
    logisticsCost: strategy === 'station_arbitrage' ? 0 : null,
    liquidity,
    riskLevel: riskLevel(flags),
    riskFlags: flags,
    buySnapshotId,
    sellSnapshotId,
    buySnapshotAt: buyObs.snapshotAt,
    sellSnapshotAt: sellObs.snapshotAt,
    buySnapshotAgeMinutes: buyObs.snapshotAgeMinutes,
    sellSnapshotAgeMinutes: sellObs.snapshotAgeMinutes,
    dataSource: 'esi_market_orders',
    dataComplete,
    dataFresh,
    spreadDetected,
    marketExecutable,
    profitAfterKnownFees,
    logisticsKnown,
    overallProfitKnown,
    tradePlanComplete,
    calculationVersion: P9_CALCULATION_VERSION,
    originalSnapshot: {
      coverage: 'public ESI regional market orders; contracts, private structures and unobserved orders are not assumed absent',
      feeModelVersion: FEE_MODEL_VERSION,
      buy: {
        hub: buyHub,
        kind: locationKind(db, buyHub.locationId),
        snapshotAt: buyObs.snapshotAt,
        snapshotExpiresAt: buyObs.snapshotExpiresAt,
        lastError: buyObs.lastError,
        bids: buyObs.levels.buys.slice(0, 50),
        asks: buyObs.levels.sells.slice(0, 50),
      },
      sell: {
        hub: sellHub,
        kind: locationKind(db, sellHub.locationId),
        snapshotAt: sellObs.snapshotAt,
        snapshotExpiresAt: sellObs.snapshotExpiresAt,
        lastError: sellObs.lastError,
        bids: sellObs.levels.buys.slice(0, 50),
        asks: sellObs.levels.sells.slice(0, 50),
      },
      calculation: {
        version: P9_CALCULATION_VERSION,
        optimalQuantity: optimal.optimalQuantity,
        buyWeightedPrice: optimal.buySim.weightedAvgPrice,
        sellWeightedPrice: optimal.sellSim.weightedAvgPrice,
        feeBreakdown: {
          buyerBrokerFee: trade.buyerBrokerFee,
          sellerBrokerFee: trade.sellerBrokerFee,
          salesTax: trade.salesTax,
          sccSurcharge: trade.sccSurcharge || 0,
          totalFees: trade.totalFees,
        },
      },
    },
    state,
    detectedAt: isoNow(),
    updatedAt: isoNow(),
    expiresAt,
  };
}
export function defaultP9Settings(characterId: number): P9ScanSettings {
  return {
    characterId,
    hubs: DEFAULT_P9_HUBS.map((hub) => ({ ...hub, enabled: hub.enabled !== false })),
    strategies: ['station_arbitrage', 'regional_hauling'],
    minNetProfit: 100_000,
    minRoiPct: 5,
    maxCapital: 100_000_000,
    maxMarketAgeMinutes: 60,
    maxResults: 100,
    autoScanEnabled: false,
    autoScanIntervalMinutes: 30,
    updatedAt: isoNow(),
  };
}

export class P9OpportunityService {
  public static getSettings(
    db: Db,
    characterId: number,
    lineage?: P9ControlPlaneLineage | null,
  ): P9ScanSettings {
    const owner = p9LineagePredicate(null, lineage);
    const row = db.prepare(`
      SELECT * FROM p9_scan_settings WHERE character_id = ? AND ${owner.sql}
    `).get(characterId, ...owner.params) as any;
    if (!row) return defaultP9Settings(characterId);
    return {
      characterId,
      hubs: parseJson<P9Hub[]>(row.hubs_json, DEFAULT_P9_HUBS).map((hub) => ({ ...hub, enabled: hub.enabled !== false })),
      strategies: parseJson<Array<'station_arbitrage' | 'regional_hauling'>>(row.strategies_json, ['station_arbitrage', 'regional_hauling']),
      minNetProfit: Number(row.min_net_profit),
      minRoiPct: Number(row.min_roi_pct),
      maxCapital: Number(row.max_capital),
      maxMarketAgeMinutes: Number(row.max_market_age_minutes),
      maxResults: Number(row.max_results),
      autoScanEnabled: Boolean(row.auto_scan_enabled),
      autoScanIntervalMinutes: Number(row.auto_scan_interval_minutes),
      updatedAt: row.updated_at,
    };
  }

  public static saveSettings(
    db: Db,
    input: Partial<P9ScanSettings> & { characterId: number },
    lineage?: P9ControlPlaneLineage | null,
  ): P9ScanSettings {
    const current = this.getSettings(db, input.characterId, lineage);
    const hubs = input.hubs ?? current.hubs;
    if (!Array.isArray(hubs) || hubs.length === 0 || hubs.length > 20 || hubs.some((hub) => !validHub(hub))) {
      throw new Error('贸易中心配置无效：需要 1-20 个包含 locationId、regionId、name 的地点。');
    }
    const unique = new Map(hubs.map((hub) => [hub.locationId, hub]));
    if (unique.size !== hubs.length) throw new Error('贸易中心配置包含重复地点。');
    const normalizedHubs = [...unique.values()].map((hub) => ({ ...hub, enabled: hub.enabled !== false }));
    if (!normalizedHubs.some((hub) => hub.enabled)) throw new Error('至少需要启用一个贸易中心。');
    for (const hub of normalizedHubs) {
      const region = db.prepare('SELECT region_id FROM sde_regions WHERE region_id = ?').get(hub.regionId);
      if (!region) throw new Error(`贸易中心区域 ID ${hub.regionId} 不存在于当前 SDE。`);
      const station = db.prepare(`
        SELECT s.station_id, c.region_id
        FROM sde_stations s
        JOIN sde_systems y ON y.system_id = s.system_id
        JOIN sde_constellations c ON c.constellation_id = y.constellation_id
        WHERE s.station_id = ?
      `).get(hub.locationId) as { station_id: number; region_id: number } | undefined;
      if (station && Number(station.region_id) !== hub.regionId) {
        throw new Error(`贸易中心地点 ${hub.locationId} 不属于区域 ${hub.regionId}（SDE 实际区域 ${station.region_id}）。`);
      }
    }
    const strategies = input.strategies ?? current.strategies;
    if (!Array.isArray(strategies) || strategies.some((value) => value !== 'station_arbitrage' && value !== 'regional_hauling')) {
      throw new Error('仅支持站内套利和跨贸易中心套利。');
    }
    const next: P9ScanSettings = {
      ...current,
      hubs: normalizedHubs,
      strategies: [...new Set(strategies)],
      minNetProfit: Math.max(0, Number(input.minNetProfit ?? current.minNetProfit)),
      minRoiPct: Math.max(0, Number(input.minRoiPct ?? current.minRoiPct)),
      maxCapital: Math.max(1, Number(input.maxCapital ?? current.maxCapital)),
      maxMarketAgeMinutes: Math.max(1, Math.min(1440, Number(input.maxMarketAgeMinutes ?? current.maxMarketAgeMinutes))),
      maxResults: Math.max(1, Math.min(500, Number(input.maxResults ?? current.maxResults))),
      autoScanEnabled: Boolean(input.autoScanEnabled ?? current.autoScanEnabled),
      autoScanIntervalMinutes: Math.max(5, Math.min(1440, Number(input.autoScanIntervalMinutes ?? current.autoScanIntervalMinutes))),
      updatedAt: isoNow(),
    };
    const ownerValues = p9LineageValues(lineage);
    db.prepare(`
      INSERT INTO p9_scan_settings
        (character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
         hubs_json, strategies_json, min_net_profit, min_roi_pct, max_capital,
         max_market_age_minutes, max_results, auto_scan_enabled, auto_scan_interval_minutes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(character_id, owner_user_id, owner_chat_id, binding_epoch) DO UPDATE SET
        binding_digest = excluded.binding_digest,
        hubs_json = excluded.hubs_json,
        strategies_json = excluded.strategies_json,
        min_net_profit = excluded.min_net_profit,
        min_roi_pct = excluded.min_roi_pct,
        max_capital = excluded.max_capital,
        max_market_age_minutes = excluded.max_market_age_minutes,
        max_results = excluded.max_results,
        auto_scan_enabled = excluded.auto_scan_enabled,
        auto_scan_interval_minutes = excluded.auto_scan_interval_minutes,
        updated_at = excluded.updated_at
    `).run(
      next.characterId,
      ...ownerValues,
      JSON.stringify(next.hubs),
      JSON.stringify(next.strategies),
      next.minNetProfit,
      next.minRoiPct,
      next.maxCapital,
      next.maxMarketAgeMinutes,
      next.maxResults,
      next.autoScanEnabled ? 1 : 0,
      next.autoScanIntervalMinutes,
      next.updatedAt,
    );
    return next;
  }

  private static scopeOpportunity(
    opportunity: P9Opportunity,
    lineage?: P9ControlPlaneLineage | null,
  ): P9Opportunity {
    if (!lineage) return opportunity;
    const [ownerUserId, ownerChatId, bindingEpoch] = p9LineageValues(lineage);
    const domain = `${ownerUserId}:${ownerChatId}:${bindingEpoch}`;
    const logicalKey = opportunity.scanKey;
    return {
      ...opportunity,
      scanKey: `${domain}|${logicalKey}`,
      opportunityId: 'P9OPP-' + createHash('sha256')
        .update(`${domain}|${opportunity.characterId}|${logicalKey}`)
        .digest('hex')
        .slice(0, 20),
    };
  }

  private static upsert(
    db: Db,
    opportunity: P9Opportunity,
    lineage?: P9ControlPlaneLineage | null,
  ): void {
    const owner = p9LineagePredicate(null, lineage);
    const existing = db.prepare(`
      SELECT state FROM p9_real_opportunities
      WHERE opportunity_id = ? AND ${owner.sql}
    `).get(opportunity.opportunityId, ...owner.params) as any;
    const state = existing?.state === 'ARCHIVED' ? 'ARCHIVED' : opportunity.state;
    const placeholders = Array.from({ length: 58 }, () => '?').join(', ');
    const values = [
      opportunity.opportunityId,
      opportunity.characterId,
      ...p9LineageValues(lineage),
      opportunity.scanKey,
      opportunity.strategy,
      opportunity.typeId,
      opportunity.typeNameEn,
      opportunity.typeNameZh || null,
      opportunity.buyLocationId,
      opportunity.buyLocationName,
      opportunity.sellLocationId,
      opportunity.sellLocationName,
      opportunity.buyRegionId,
      opportunity.sellRegionId,
      opportunity.buyPrice,
      opportunity.sellPrice,
      opportunity.suggestedQuantity,
      opportunity.executableQuantity,
      opportunity.purchaseAmount,
      opportunity.salesRevenue,
      opportunity.brokerFees,
      opportunity.salesTax,
      opportunity.otherFees,
      opportunity.theoreticalGrossProfit,
      opportunity.executableGrossProfit,
      opportunity.feeNetProfit,
      opportunity.comprehensiveNetProfit,
      opportunity.comprehensiveStatus,
      opportunity.capitalRequired,
      opportunity.roiPct,
      opportunity.logisticsCost,
      opportunity.liquidity,
      opportunity.riskLevel,
      JSON.stringify(opportunity.riskFlags),
      opportunity.buySnapshotId,
      opportunity.sellSnapshotId,
      opportunity.buySnapshotAt,
      opportunity.sellSnapshotAt,
      opportunity.buySnapshotAgeMinutes,
      opportunity.sellSnapshotAgeMinutes,
      opportunity.dataSource,
      opportunity.dataComplete ? 1 : 0,
      opportunity.dataFresh ? 1 : 0,
      opportunity.spreadDetected ? 1 : 0,
      opportunity.marketExecutable ? 1 : 0,
      opportunity.profitAfterKnownFees ? 1 : 0,
      opportunity.logisticsKnown ? 1 : 0,
      opportunity.overallProfitKnown ? 1 : 0,
      opportunity.tradePlanComplete ? 1 : 0,
      opportunity.calculationVersion,
      JSON.stringify(opportunity.originalSnapshot),
      state,
      opportunity.detectedAt,
      opportunity.updatedAt,
      opportunity.expiresAt,
    ];
    const sql = `
      INSERT INTO p9_real_opportunities (
        opportunity_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
        scan_key, strategy, type_id, type_name_en, type_name_zh,
        buy_location_id, buy_location_name, sell_location_id, sell_location_name,
        buy_region_id, sell_region_id, buy_price, sell_price, suggested_quantity, executable_quantity,
        purchase_amount, sales_revenue, broker_fees, sales_tax, other_fees,
        theoretical_gross_profit, executable_gross_profit, fee_net_profit, comprehensive_net_profit,
        comprehensive_status, capital_required, roi_pct, logistics_cost, liquidity, risk_level,
        risk_flags_json, buy_snapshot_id, sell_snapshot_id, buy_snapshot_at, sell_snapshot_at,
        buy_snapshot_age_minutes, sell_snapshot_age_minutes, data_source, data_complete, data_fresh,
        spread_detected, market_executable, profit_after_known_fees, logistics_known,
        overall_profit_known, trade_plan_complete,
        calculation_version, original_snapshot_json, state, detected_at, updated_at, expires_at
      ) VALUES (${placeholders})
      ON CONFLICT(character_id, scan_key) DO UPDATE SET
        binding_digest = excluded.binding_digest,
        type_name_en = excluded.type_name_en,
        type_name_zh = excluded.type_name_zh,
        buy_location_name = excluded.buy_location_name,
        sell_location_name = excluded.sell_location_name,
        buy_price = excluded.buy_price,
        sell_price = excluded.sell_price,
        suggested_quantity = excluded.suggested_quantity,
        executable_quantity = excluded.executable_quantity,
        purchase_amount = excluded.purchase_amount,
        sales_revenue = excluded.sales_revenue,
        broker_fees = excluded.broker_fees,
        sales_tax = excluded.sales_tax,
        other_fees = excluded.other_fees,
        theoretical_gross_profit = excluded.theoretical_gross_profit,
        executable_gross_profit = excluded.executable_gross_profit,
        fee_net_profit = excluded.fee_net_profit,
        comprehensive_net_profit = excluded.comprehensive_net_profit,
        comprehensive_status = excluded.comprehensive_status,
        capital_required = excluded.capital_required,
        roi_pct = excluded.roi_pct,
        logistics_cost = excluded.logistics_cost,
        liquidity = excluded.liquidity,
        risk_level = excluded.risk_level,
        risk_flags_json = excluded.risk_flags_json,
        buy_snapshot_id = excluded.buy_snapshot_id,
        sell_snapshot_id = excluded.sell_snapshot_id,
        buy_snapshot_at = excluded.buy_snapshot_at,
        sell_snapshot_at = excluded.sell_snapshot_at,
        buy_snapshot_age_minutes = excluded.buy_snapshot_age_minutes,
        sell_snapshot_age_minutes = excluded.sell_snapshot_age_minutes,
        data_complete = excluded.data_complete,
        data_fresh = excluded.data_fresh,
        spread_detected = excluded.spread_detected,
        market_executable = excluded.market_executable,
        profit_after_known_fees = excluded.profit_after_known_fees,
        logistics_known = excluded.logistics_known,
        overall_profit_known = excluded.overall_profit_known,
        trade_plan_complete = excluded.trade_plan_complete,
        calculation_version = excluded.calculation_version,
        original_snapshot_json = excluded.original_snapshot_json,
        state = CASE WHEN p9_real_opportunities.state = 'ARCHIVED' THEN 'ARCHIVED' ELSE excluded.state END,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `;
    db.prepare(sql).run(...values);
  }
  /**
   * Flip opportunities whose data-validity window has passed to EXPIRED.
   * expires_at is stored as an ISO string (T + Z); comparing it directly with
   * SQLite's datetime('now') ("YYYY-MM-DD HH:MM:SS") never matches because of
   * the separator, so normalize before comparing.
   */
  public static expireDue(
    db: Db,
    characterId: number,
    lineage?: P9ControlPlaneLineage | null,
  ): number {
    const owner = p9LineagePredicate(null, lineage);
    const result = db.prepare(`
      UPDATE p9_real_opportunities
      SET state = CASE WHEN state IN ('NEW', 'WATCHING', 'ACTIONABLE', 'STALE') THEN 'EXPIRED' ELSE state END,
          updated_at = datetime('now')
      WHERE character_id = ? AND ${owner.sql}
        AND datetime(substr(replace(expires_at, 'T', ' '), 1, 19)) < datetime('now')
        AND state NOT IN ('EXPIRED', 'ARCHIVED')
    `).run(characterId, ...owner.params);
    return result.changes;
  }

  public static scan(
    db: Db,
    characterId: number,
    options: { typeIds?: number[] } = {},
    lineage?: P9ControlPlaneLineage | null,
  ): { scanned: number; stored: number; jobRunId: string; errors: string[] } {
    const jobId = 'P9JOB-' + Date.now() + '-' + randomUUID().slice(0, 8);
    const ownerValues = p9LineageValues(lineage);
    db.prepare(`
      INSERT INTO p9_job_runs
        (job_id, job_type, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest, status)
      VALUES (?, 'market_scan', ?, ?, ?, ?, ?, 'running')
    `).run(jobId, characterId, ...ownerValues);
    const errors: string[] = [];
    let stored = 0;
    let scanned = 0;
    try {
      const settings = this.getSettings(db, characterId, lineage);
      const enabledHubs = settings.hubs.filter((hub) => hub.enabled !== false);
      if (enabledHubs.length === 0) throw new Error('没有启用的贸易中心。');
      const requestedTypeIds = [...new Set((options.typeIds || [])
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0))]
        .slice(0, 500);
      const candidates: P9Opportunity[] = [];
      if (settings.strategies.includes('station_arbitrage')) {
        for (const hub of enabledHubs) {
          const types = requestedTypeIds.length > 0
            ? requestedTypeIds.map((typeId) => ({ type_id: typeId }))
            : stationCandidateTypes(db, hub, Math.min(settings.maxResults, 250));
          for (const candidate of types) {
            scanned += 1;
            const built = buildCandidate({ db, settings, strategy: 'station_arbitrage', typeId: candidate.type_id, buyHub: hub, sellHub: hub });
            if (built) candidates.push(built);
          }
        }
      }
      if (settings.strategies.includes('regional_hauling')) {
        for (const [buyHub, sellHub] of hubPairs(enabledHubs)) {
          const types = requestedTypeIds.length > 0
            ? requestedTypeIds.map((typeId) => ({ type_id: typeId }))
            : crossCandidateTypes(db, buyHub, sellHub, Math.min(settings.maxResults, 250));
          for (const candidate of types) {
            scanned += 1;
            const built = buildCandidate({ db, settings, strategy: 'regional_hauling', typeId: candidate.type_id, buyHub, sellHub });
            if (built) candidates.push(built);
          }
        }
      }

      candidates.sort((a, b) => b.feeNetProfit - a.feeNetProfit || b.roiPct - a.roiPct);
      const selected = candidates.slice(0, settings.maxResults);
      const tx = db.transaction(() => {
        for (const opportunity of selected) {
          this.upsert(db, this.scopeOpportunity(opportunity, lineage), lineage);
          stored += 1;
        }
        this.expireDue(db, characterId, lineage);
      });
      tx();
      const summary = { scanned, stored, errors };
      const owner = p9LineagePredicate(null, lineage);
      db.prepare(`
        UPDATE p9_job_runs
        SET status = 'ok', finished_at = datetime('now'), summary_json = ?
        WHERE job_id = ? AND ${owner.sql}
      `).run(JSON.stringify(summary), jobId, ...owner.params);
      return { ...summary, jobRunId: jobId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      const owner = p9LineagePredicate(null, lineage);
      db.prepare(`
        UPDATE p9_job_runs
        SET status = 'error', finished_at = datetime('now'), error = ?
        WHERE job_id = ? AND ${owner.sql}
      `).run(message, jobId, ...owner.params);
      return { scanned, stored, jobRunId: jobId, errors };
    }
  }

  public static list(
    db: Db,
    characterId: number,
    filters: {
      state?: string;
      strategy?: string;
      hubLocationId?: number;
      query?: string;
      sort?: string;
      limit?: number;
      offset?: number;
    } = {},
    lineage?: P9ControlPlaneLineage | null,
  ): { rows: P9Opportunity[]; total: number } {
    const owner = p9LineagePredicate(null, lineage);
    const where: string[] = ['character_id = ?', owner.sql];
    const params: unknown[] = [characterId, ...owner.params];
    if (filters.state) {
      where.push('state = ?');
      params.push(filters.state);
    }
    if (filters.strategy) {
      where.push('strategy = ?');
      params.push(filters.strategy);
    }
    if (filters.hubLocationId) {
      where.push('(buy_location_id = ? OR sell_location_id = ?)');
      params.push(filters.hubLocationId, filters.hubLocationId);
    }
    if (filters.query?.trim()) {
      where.push('(LOWER(type_name_en) LIKE ? OR LOWER(type_name_zh) LIKE ? OR CAST(type_id AS TEXT) = ?)');
      const needle = `%${filters.query.trim().toLowerCase()}%`;
      params.push(needle, needle, filters.query.trim());
    }
    const sortMap: Record<string, string> = {
      net: 'fee_net_profit DESC',
      roi: 'roi_pct DESC',
      capital: 'capital_required ASC',
      liquidity: "CASE liquidity WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 ELSE 4 END ASC",
      risk: "CASE risk_level WHEN 'LOW' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'HIGH' THEN 3 ELSE 4 END ASC",
      updated: 'updated_at DESC',
    };
    const orderBy = sortMap[filters.sort || 'net'] || sortMap.net;
    const limit = clampPositiveInteger(filters.limit, 100, 500);
    const offset = clampNonNegativeInteger(filters.offset);
    const whereSql = where.join(' AND ');
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM p9_real_opportunities WHERE ${whereSql}`).get(...params) as any)?.n || 0);
    const rows = db.prepare(`
      SELECT * FROM p9_real_opportunities
      WHERE ${whereSql}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];
    return { rows: rows.map(mapOpportunity), total };
  }

  public static get(
    db: Db,
    characterId: number,
    opportunityId: string,
    lineage?: P9ControlPlaneLineage | null,
  ): P9Opportunity | null {
    const owner = p9LineagePredicate(null, lineage);
    const row = db.prepare(`
      SELECT * FROM p9_real_opportunities
      WHERE character_id = ? AND opportunity_id = ? AND ${owner.sql}
    `).get(characterId, opportunityId, ...owner.params) as any;
    return row ? mapOpportunity(row) : null;
  }

  public static transition(
    db: Db,
    characterId: number,
    opportunityId: string,
    next: P9OpportunityState,
    reason?: string,
    lineage?: P9ControlPlaneLineage | null,
  ): P9Opportunity {
    const current = this.get(db, characterId, opportunityId, lineage);
    if (!current) throw new Error('机会不存在。');
    if (!canTransitionP9Opportunity(current.state, next)) {
      throw new Error(`机会状态不能从 ${current.state} 转移到 ${next}。`);
    }
    const owner = p9LineagePredicate(null, lineage);
    db.prepare(`
      UPDATE p9_real_opportunities
      SET state = ?, updated_at = datetime('now')
      WHERE opportunity_id = ? AND character_id = ? AND ${owner.sql}
    `).run(next, opportunityId, characterId, ...owner.params);
    db.prepare(`
      INSERT INTO p9_trade_audit_events
        (character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
         plan_id, action, before_json, after_json, actor)
      VALUES (?, ?, ?, ?, ?, NULL, 'opportunity_state', ?, ?, 'user')
    `).run(
      characterId,
      ...p9LineageValues(lineage),
      JSON.stringify({ state: current.state, reason: reason || null }),
      JSON.stringify({ state: next }),
    );
    return this.get(db, characterId, opportunityId, lineage)!;
  }
  public static createPlan(
    db: Db,
    characterId: number,
    opportunityId: string,
    input?: { exitPlan?: string; notes?: string },
    lineage?: P9ControlPlaneLineage | null,
  ): P9TradePlan {
    const opportunity = this.get(db, characterId, opportunityId, lineage);
    if (!opportunity) throw new Error('机会不存在。');
    if (opportunity.state === 'EXPIRED' || opportunity.state === 'REJECTED' || opportunity.state === 'ARCHIVED') {
      throw new Error('该机会当前不可生成交易方案。');
    }
    const owner = p9LineagePredicate(null, lineage);
    const existing = db.prepare(`
      SELECT * FROM p9_trade_plans WHERE opportunity_id = ? AND ${owner.sql}
    `).get(opportunityId, ...owner.params) as any;
    if (existing) return mapPlan(existing);
    const planId = 'P9PLAN-' + Date.now() + '-' + randomUUID().slice(0, 8);
    db.prepare(`
      INSERT INTO p9_trade_plans (
        plan_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
        opportunity_id, strategy, type_id, buy_location_id, sell_location_id,
        quantity, buy_price, sell_price, estimated_buy_cost, estimated_sell_revenue, estimated_fees,
        estimated_fee_net_profit, estimated_comprehensive_profit, comprehensive_status,
        capital_required, risk_flags_json, valid_until, exit_plan, notes, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PLANNED')
    `).run(
      planId, characterId, ...p9LineageValues(lineage), opportunityId, opportunity.strategy, opportunity.typeId,
      opportunity.buyLocationId, opportunity.sellLocationId, opportunity.suggestedQuantity,
      opportunity.buyPrice, opportunity.sellPrice, opportunity.purchaseAmount, opportunity.salesRevenue,
      round2(opportunity.brokerFees + opportunity.salesTax + opportunity.otherFees),
      opportunity.feeNetProfit, opportunity.comprehensiveNetProfit, opportunity.comprehensiveStatus,
      opportunity.capitalRequired, JSON.stringify(opportunity.riskFlags), opportunity.expiresAt,
      input?.exitPlan || '人工在 EVE 客户端执行；成交后回填真实记录。',
      input?.notes || null,
    );
    db.prepare(`
      INSERT INTO p9_trade_audit_events
        (character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
         plan_id, action, after_json, actor)
      VALUES (?, ?, ?, ?, ?, ?, 'plan_created', ?, 'user')
    `).run(characterId, ...p9LineageValues(lineage), planId, JSON.stringify({ opportunityId, status: 'PLANNED' }));
    return mapPlan(db.prepare(`
      SELECT * FROM p9_trade_plans WHERE plan_id = ? AND ${owner.sql}
    `).get(planId, ...owner.params) as any);
  }

  public static getPlanByOpportunity(
    db: Db,
    characterId: number,
    opportunityId: string,
    lineage?: P9ControlPlaneLineage | null,
  ): P9TradePlan | null {
    const owner = p9LineagePredicate(null, lineage);
    const row = db.prepare(`
      SELECT * FROM p9_trade_plans
      WHERE character_id = ? AND opportunity_id = ? AND ${owner.sql}
    `).get(characterId, opportunityId, ...owner.params) as any;
    return row ? mapPlan(row) : null;
  }

  public static listPlans(
    db: Db,
    characterId: number,
    status?: string,
    lineage?: P9ControlPlaneLineage | null,
  ): P9TradePlan[] {
    const owner = p9LineagePredicate(null, lineage);
    const params: unknown[] = [characterId, ...owner.params];
    let sql = `SELECT * FROM p9_trade_plans WHERE character_id = ? AND ${owner.sql}`;
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY updated_at DESC LIMIT 500';
    return (db.prepare(sql).all(...params) as any[]).map(mapPlan);
  }

  public static transitionPlan(
    db: Db,
    characterId: number,
    planId: string,
    next: P9PlanStatus,
    note?: string,
    lineage?: P9ControlPlaneLineage | null,
  ): P9TradePlan {
    const owner = p9LineagePredicate(null, lineage);
    const row = db.prepare(`
      SELECT * FROM p9_trade_plans
      WHERE plan_id = ? AND character_id = ? AND ${owner.sql}
    `).get(planId, characterId, ...owner.params) as any;
    if (!row) throw new Error('交易方案不存在。');
    if (!canTransitionP9Plan(row.status, next)) throw new Error(`交易方案状态不能从 ${row.status} 转移到 ${next}。`);
    db.prepare(`
      UPDATE p9_trade_plans
      SET status = ?, notes = COALESCE(?, notes), updated_at = datetime('now')
      WHERE plan_id = ? AND ${owner.sql}
    `).run(next, note || null, planId, ...owner.params);
    db.prepare(`
      INSERT INTO p9_trade_audit_events
        (character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
         plan_id, action, before_json, after_json, actor)
      VALUES (?, ?, ?, ?, ?, ?, 'plan_status', ?, ?, 'user')
    `).run(
      characterId,
      ...p9LineageValues(lineage),
      planId,
      JSON.stringify({ status: row.status }),
      JSON.stringify({ status: next, note: note || null }),
    );
    return mapPlan(db.prepare(`
      SELECT * FROM p9_trade_plans WHERE plan_id = ? AND ${owner.sql}
    `).get(planId, ...owner.params) as any);
  }
}

function mapPlan(row: any): P9TradePlan {
  return {
    planId: row.plan_id,
    characterId: row.character_id,
    opportunityId: row.opportunity_id,
    strategy: row.strategy,
    typeId: row.type_id,
    buyLocationId: row.buy_location_id,
    sellLocationId: row.sell_location_id,
    quantity: row.quantity,
    buyPrice: row.buy_price,
    sellPrice: row.sell_price,
    estimatedBuyCost: row.estimated_buy_cost,
    estimatedSellRevenue: row.estimated_sell_revenue,
    estimatedFees: row.estimated_fees,
    estimatedFeeNetProfit: row.estimated_fee_net_profit,
    estimatedComprehensiveProfit: row.estimated_comprehensive_profit,
    comprehensiveStatus: row.comprehensive_status,
    capitalRequired: row.capital_required,
    riskFlags: parseJson<string[]>(row.risk_flags_json, []),
    validUntil: row.valid_until,
    exitPlan: row.exit_plan || undefined,
    notes: row.notes || undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { mapOpportunity as mapP9OpportunityRow, mapPlan as mapP9PlanRow };