import type { Db } from '../../db/sqlite.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS } from '../fee-engine.js';
import { DataCenter } from '../data-center.js';
import { OrderBookSimulator } from '../orderbook-simulator.js';
import type { FeeContext, OpportunityRating, TradeOpportunity } from '../types.js';

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
  minNetMarginPct?: number;  // default 6% for instant, 18% for listed
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

    // 1. Initial Candidate Filter (Top-of-book heuristic)
    const originSellCandidates = db.prepare(`
      SELECT type_id, min(price) as best_sell, sum(volume_remain) as sell_vol
      FROM market_orders
      WHERE location_id = ? AND is_buy_order = 0
      GROUP BY type_id
      HAVING best_sell BETWEEN 0.01 AND 50000000 AND sell_vol >= 1
    `).all(route.originStationId) as any[];

    const originMap = new Map<number, any>();
    for (const s of originSellCandidates) originMap.set(s.type_id, s);

    const destCandidates = db.prepare(`
      SELECT type_id,
             max(CASE WHEN is_buy_order = 1 THEN price END) as best_buy,
             min(CASE WHEN is_buy_order = 0 THEN price END) as best_sell
      FROM market_orders
      WHERE location_id = ?
      GROUP BY type_id
    `).all(route.destStationId) as any[];

    const opportunities: TradeOpportunity[] = [];

    // Check temporal consistency using authoritative region snapshot records
    const dataQuality = DataCenter.validateTemporalConsistency(db, route.originRegionId, route.destRegionId);

    for (const d of destCandidates) {
      const orig = originMap.get(d.type_id);
      if (!orig) continue;

      const meta = DataCenter.getItemMetadata(db, d.type_id);
      if (!meta) continue;

      const unitM3 = meta.volume || 1;

      // Pull full discrete orderbook for rigorous multi-level simulation
      const originBook = DataCenter.getOrderBook(db, route.originRegionId, d.type_id, route.originStationId);
      const destBook = DataCenter.getOrderBook(db, route.destRegionId, d.type_id, route.destStationId);

      // Mode 1: Instant Fill (Eat Dest Buy Order)
      if (opts.mode === 'instant_fill' || opts.mode === 'all') {
        if (d.best_buy && d.best_buy > orig.best_sell * 1.05 && destBook.buys.length > 0) {
          const maxUnitsByCap = Math.max(1, Math.floor(maxCapital / orig.best_sell));
          const maxUnitsByM3 = Math.max(1, Math.floor(maxCargoM3 / unitM3));
          const maxAllowedQty = Math.min(maxUnitsByCap, maxUnitsByM3);

          // Find optimal profitable quantity across all orderbook levels without phantom spread
          const { optimalQuantity, buySim, sellSim } = OrderBookSimulator.findOptimalProfitableQuantity({
            originSells: originBook.sells,
            destBuys: destBook.buys,
            maxAllowedQty,
            feeCtx,
            minNetMarginPct: opts.minNetMarginPct ?? 5.0,
          });

          if (optimalQuantity > 0 && buySim.isComplete && sellSim.isComplete) {
            const actualQty = optimalQuantity;

            const trade = FeeEngine.calculateTrade({
              buyType: 'immediate_buy',
              sellType: 'immediate_sell',
              buyUnitPrice: buySim.weightedAvgPrice,
              sellUnitPrice: sellSim.weightedAvgPrice,
              quantity: actualQty,
              buyCtx: feeCtx,
              sellCtx: feeCtx,
              haulingCost: 0,
            });

            const stress = OrderBookSimulator.runStressTest({
              buyOrders: destBook.buys,
              quantity: actualQty,
              netCostIsk: trade.netCost,
              effectiveSalesTaxRate: FeeEngine.calculateRates(feeCtx).salesTaxRate,
              baseSellPrice: sellSim.weightedAvgPrice,
            });

            let opportunityRating: OpportunityRating = 'B';
            let riskVetoReason: string | undefined;

            if (dataQuality.isStale) {
              opportunityRating = 'D';
              riskVetoReason = `两地数据时间差过大 (${dataQuality.timestampSkewMinutes} 分钟) 或快照过期`;
            } else if (trade.netProfit < (opts.minNetProfit ?? 100_000) || trade.netMarginPct < (opts.minNetMarginPct ?? 5.0)) {
              opportunityRating = 'D';
              riskVetoReason = '扣除税费后净利润过低';
            } else if (stress.priceDrop10Pct.netProfit < 0) {
              opportunityRating = 'C';
            } else if (trade.netMarginPct >= 12.0 && dataQuality.timestampSkewMinutes <= 15) {
              opportunityRating = 'A';
            }

            opportunities.push({
              typeId: d.type_id,
              typeName: meta.en_name,
              zhName: meta.zh_name || undefined,
              groupName: meta.group_name || undefined,
              categoryId: meta.category_id || undefined,
              volumeM3: unitM3,
              strategy: 'regional_hauling',
              buyStationId: route.originStationId,
              buyStationName: route.originName,
              sellStationId: route.destStationId,
              sellStationName: route.destName,
              suggestedBuyPrice: buySim.weightedAvgPrice,
              suggestedSellPrice: sellSim.weightedAvgPrice,
              suggestedQuantity: actualQty,
              capitalRequired: trade.netCost,
              estimatedFees: trade.totalFees,
              haulingCost: 0,
              expectedNetProfit: trade.netProfit,
              expectedRoiPct: trade.roiPct,
              dailyVolumeDest: destBook.buys[0].volumeRemain,
              turnoverDays: 0,
              liquidityRating: actualQty >= 20 ? 'A' : 'B',
              riskScore: opportunityRating === 'D' ? 4 : (opportunityRating === 'C' ? 3 : 1),
              opportunityRating,
              riskVetoReason,
              stressTest: stress,
              dataQuality,
              rationale: `【即时秒变现】在 ${route.originName} 按卖盘加权价(${buySim.weightedAvgPrice.toLocaleString()} ISK)吃进 ${actualQty} 件，高安 ${route.highSecJumps} 跳运至 ${route.destName}，以买盘加权价(${sellSim.weightedAvgPrice.toLocaleString()} ISK)直接变现。扣税后净利 +${trade.netProfit.toLocaleString()} ISK (+${trade.netMarginPct.toFixed(1)}%)，货舱占用 ${(unitM3 * actualQty).toFixed(1)} m³。`,
            });
          }
        }
      }
    }

    opportunities.sort((a, b) => b.expectedNetProfit - a.expectedNetProfit);
    return opportunities;
  }
}
