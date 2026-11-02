import type { Db } from '../../db/sqlite.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS } from '../fee-engine.js';
import { DataCenter } from '../data-center.js';
import type { FeeContext, TradeOpportunity } from '../types.js';

export interface RegionalHaulingRoute {
  originStationId: number;
  originRegionId: number;
  originName: string;
  destStationId: number;
  destRegionId: number;
  destName: string;
  highSecJumps: number;
}

export const STANDARD_HIGHSEC_ROUTES: RegionalHaulingRoute[] = [
  {
    originStationId: 60003760, // Jita IV-4
    originRegionId: 10000002,
    originName: 'Jita IV-4 (吉他)',
    destStationId: 60011866,   // Dodixie IX-20
    destRegionId: 10000032,
    destName: 'Dodixie IX-20 (杜迪克西)',
    highSecJumps: 15,
  },
  {
    originStationId: 60003760, // Jita IV-4
    originRegionId: 10000002,
    originName: 'Jita IV-4 (吉他)',
    destStationId: 60005686,   // Hek VIII-12
    destRegionId: 10000042,
    destName: 'Hek VIII-12 (赫克)',
    highSecJumps: 19,
  },
  {
    originStationId: 60003760, // Jita IV-4
    originRegionId: 10000002,
    originName: 'Jita IV-4 (吉他)',
    destStationId: 60004588,   // Rens VI-8
    destRegionId: 10000030,
    destName: 'Rens VI-8 (勒斯)',
    highSecJumps: 25,
  },
];

export interface RegionalHaulingOptions {
  route: RegionalHaulingRoute;
  mode: 'instant_fill' | 'listed_sell' | 'all';
  maxCapital?: number;       // default 50_000_000 ISK (Alpha safe cargo limit)
  maxCargoM3?: number;       // default 5_000 m³ (T1 Badger)
  minNetMarginPct?: number;  // default 8% for instant, 20% for listed
  minNetProfit?: number;
  feeContext?: FeeContext;
}

export class RegionalHaulingStrategy {
  public static scan(db: Db, opts: RegionalHaulingOptions): TradeOpportunity[] {
    const route = opts.route;
    const maxCapital = opts.maxCapital ?? 50_000_000;
    const maxCargoM3 = opts.maxCargoM3 ?? 5_000;
    const feeCtx: FeeContext = opts.feeContext ?? {
      clone: 'alpha',
      skills: ALPHA_DEFAULT_SKILLS,
      facility: 'npc_station',
    };

    // 1. Get Origin Sell Orders (Buy from Origin lowest sell)
    const originSells = db.prepare(`
      SELECT type_id, min(price) as best_sell, sum(volume_remain) as sell_vol
      FROM market_orders
      WHERE location_id = ? AND is_buy_order = 0
      GROUP BY type_id
      HAVING best_sell BETWEEN 0.01 AND 50000000 AND sell_vol >= 5
    `).all(route.originStationId) as any[];

    const originMap = new Map();
    for (const s of originSells) originMap.set(s.type_id, s);

    // 2. Get Dest Orders (Buy orders for instant fill, Sell orders for listing)
    const destOrders = db.prepare(`
      SELECT type_id,
             max(CASE WHEN is_buy_order = 1 THEN price END) as best_buy,
             sum(CASE WHEN is_buy_order = 1 THEN volume_remain END) as buy_vol,
             min(CASE WHEN is_buy_order = 0 THEN price END) as best_sell,
             sum(CASE WHEN is_buy_order = 0 THEN volume_remain END) as sell_vol
      FROM market_orders
      WHERE location_id = ?
      GROUP BY type_id
    `).all(route.destStationId) as any[];

    const opportunities: TradeOpportunity[] = [];

    for (const d of destOrders) {
      const orig = originMap.get(d.type_id);
      if (!orig) continue;

      const meta = DataCenter.getItemMetadata(db, d.type_id);
      if (!meta) continue;

      const unitM3 = meta.volume || 1;
      const unitBuyPrice = orig.best_sell; // Buy from Jita lowest sell

      // Check Mode 1: Instant Fill (Eat Dest Buy Order)
      if (opts.mode === 'instant_fill' || opts.mode === 'all') {
        if (d.best_buy && d.best_buy > unitBuyPrice * 1.06) {
          const unitSellPrice = d.best_buy;
          // Determine safe quantity
          const maxUnitsByCap = Math.floor(maxCapital / unitBuyPrice);
          const maxUnitsByM3 = Math.floor(maxCargoM3 / unitM3);
          const targetQty = Math.max(1, Math.min(maxUnitsByCap, maxUnitsByM3, orig.sell_vol, d.buy_vol));

          const trade = FeeEngine.calculateTrade({
            buyType: 'immediate_buy', // Eat Jita sell: 0 broker fee
            sellType: 'immediate_sell', // Eat Dest buy: 0 broker fee, pays sales tax
            buyUnitPrice: unitBuyPrice,
            sellUnitPrice: unitSellPrice,
            quantity: targetQty,
            buyCtx: feeCtx,
            sellCtx: feeCtx,
            haulingCost: 0,
          });

          const minMargin = opts.minNetMarginPct ?? 6.0;
          const minProfit = opts.minNetProfit ?? 200_000;
          if (trade.netMarginPct >= minMargin && trade.netProfit >= minProfit) {
            opportunities.push({
              typeId: d.type_id,
              typeName: meta.en_name,
              zhName: meta.zh_name || undefined,
              groupName: meta.group_name || undefined,
              volumeM3: unitM3,
              strategy: 'regional_hauling',
              buyStationId: route.originStationId,
              buyStationName: route.originName,
              sellStationId: route.destStationId,
              sellStationName: route.destName,
              suggestedBuyPrice: unitBuyPrice,
              suggestedSellPrice: unitSellPrice,
              suggestedQuantity: targetQty,
              capitalRequired: trade.netCost,
              estimatedFees: trade.totalFees,
              haulingCost: 0,
              expectedNetProfit: trade.netProfit,
              expectedRoiPct: trade.roiPct,
              dailyVolumeDest: d.buy_vol,
              turnoverDays: 0, // Instant execution upon arrival
              liquidityRating: d.buy_vol >= 50 ? 'A' : 'B',
              riskScore: 1, // High-sec instant fill is lowest trading risk
              rationale: `【即时秒变现】在 ${route.originName} 按卖价吃进 ${targetQty} 件，高安 ${route.highSecJumps} 跳运至 ${route.destName}，直接右键出售吃买单。零压货风险，单趟净利 +${trade.netProfit.toLocaleString()} ISK (+${trade.netMarginPct.toFixed(1)}%)，货舱占用 ${(unitM3 * targetQty).toFixed(1)} m³。`,
            });
          }
        }
      }

      // Check Mode 2: Listed Sell (List on Dest Sell Order)
      if (opts.mode === 'listed_sell' || opts.mode === 'all') {
        if (d.best_sell && d.best_sell > unitBuyPrice * 1.25) {
          const unitSellPrice = d.best_sell;
          const maxUnitsByCap = Math.floor(maxCapital / unitBuyPrice);
          const maxUnitsByM3 = Math.floor(maxCargoM3 / unitM3);
          // Limit to at most 20% of dest active stock to avoid saturating market
          const safeSupplyQty = Math.max(1, Math.floor((d.sell_vol || 10) * 0.2));
          const targetQty = Math.max(1, Math.min(maxUnitsByCap, maxUnitsByM3, orig.sell_vol, safeSupplyQty));

          const trade = FeeEngine.calculateTrade({
            buyType: 'immediate_buy', // Eat Jita sell: 0 broker fee
            sellType: 'place_sell_order', // Place Dest sell: pays broker fee + sales tax
            buyUnitPrice: unitBuyPrice,
            sellUnitPrice: unitSellPrice,
            quantity: targetQty,
            buyCtx: feeCtx,
            sellCtx: feeCtx,
            haulingCost: 0,
          });

          const minMargin = opts.minNetMarginPct ?? 18.0;
          const minProfit = opts.minNetProfit ?? 300_000;
          if (trade.netMarginPct >= minMargin && trade.netProfit >= minProfit && unitM3 <= 50) {
            opportunities.push({
              typeId: d.type_id,
              typeName: meta.en_name,
              zhName: meta.zh_name || undefined,
              groupName: meta.group_name || undefined,
              volumeM3: unitM3,
              strategy: 'regional_hauling',
              buyStationId: route.originStationId,
              buyStationName: route.originName,
              sellStationId: route.destStationId,
              sellStationName: route.destName,
              suggestedBuyPrice: unitBuyPrice,
              suggestedSellPrice: unitSellPrice,
              suggestedQuantity: targetQty,
              capitalRequired: trade.netCost,
              estimatedFees: trade.totalFees,
              haulingCost: 0,
              expectedNetProfit: trade.netProfit,
              expectedRoiPct: trade.roiPct,
              dailyVolumeDest: d.sell_vol,
              turnoverDays: Math.round((targetQty / Math.max(1, d.sell_vol)) * 5 * 10) / 10,
              liquidityRating: d.sell_vol >= 20 ? 'B' : 'C',
              riskScore: 2, // Requires market order listing
              rationale: `【挂单高毛利】在 ${route.originName} 采购 ${targetQty} 件，高安 ${route.highSecJumps} 跳运至 ${route.destName} 设立卖单出货。扣除两地税费后净利 +${trade.netProfit.toLocaleString()} ISK (+${trade.netMarginPct.toFixed(1)}%)，体积 ${(unitM3 * targetQty).toFixed(1)} m³。`,
            });
          }
        }
      }
    }

    opportunities.sort((a, b) => b.expectedNetProfit - a.expectedNetProfit);
    return opportunities;
  }
}