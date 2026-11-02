import type { Db } from '../../db/sqlite.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS } from '../fee-engine.js';
import { DataCenter } from '../data-center.js';
import type { FeeContext, TradeOpportunity } from '../types.js';

export interface StationArbitrageOptions {
  stationId: number;
  regionId: number;
  minNetMarginPct?: number; // e.g. 10.0 (%)
  minNetProfit?: number;
  maxCapitalPerItem?: number; // e.g. 20_000_000 ISK
  feeContext?: FeeContext;
}

export class StationArbitrageStrategy {
  public static scan(db: Db, opts: StationArbitrageOptions): TradeOpportunity[] {
    const minMargin = opts.minNetMarginPct ?? 10.0;
    const minProfit = opts.minNetProfit ?? 50_000;
    const maxCapital = opts.maxCapitalPerItem ?? 25_000_000;
    const feeCtx: FeeContext = opts.feeContext ?? {
      clone: 'alpha',
      skills: ALPHA_DEFAULT_SKILLS,
      facility: 'npc_station',
    };

    const stationRow = db.prepare("SELECT name, json_extract(data_json, '$.name.zh') as zh_name FROM sde_stations WHERE station_id = ?").get(opts.stationId) as any;
    const stationName = stationRow?.zh_name || stationRow?.name || `Station ${opts.stationId}`;

    // Query distinct types that have both buy and sell orders at this station
    const candidates = db.prepare(`
      WITH buy_agg AS (
        SELECT type_id, max(price) as best_buy, sum(volume_remain) as buy_vol, count(*) as buy_orders
        FROM market_orders
        WHERE location_id = ? AND is_buy_order = 1
        GROUP BY type_id
      ),
      sell_agg AS (
        SELECT type_id, min(price) as best_sell, sum(volume_remain) as sell_vol, count(*) as sell_orders
        FROM market_orders
        WHERE location_id = ? AND is_buy_order = 0
        GROUP BY type_id
      )
      SELECT b.type_id, b.best_buy, s.best_sell, b.buy_vol, s.sell_vol, b.buy_orders, s.sell_orders
      FROM buy_agg b
      JOIN sell_agg s ON b.type_id = s.type_id
      WHERE b.best_buy > 0.01
        AND s.best_sell > b.best_buy * 1.12
        AND b.buy_vol >= 5
        AND s.sell_vol >= 5
    `).all(opts.stationId, opts.stationId) as any[];

    const opportunities: TradeOpportunity[] = [];

    for (const c of candidates) {
      const meta = DataCenter.getItemMetadata(db, c.type_id);
      if (!meta) continue;

      // Decide target quantity based on max capital
      const unitBuyPrice = c.best_buy;
      const unitSellPrice = c.best_sell;
      const maxUnitsByCapital = Math.floor(maxCapital / unitBuyPrice);
      const targetQty = Math.max(1, Math.min(maxUnitsByCapital, c.buy_vol, c.sell_vol, 500));

      // Calculate fees with FeeEngine
      const trade = FeeEngine.calculateTrade({
        buyType: 'place_buy_order',
        sellType: 'place_sell_order',
        buyUnitPrice: unitBuyPrice,
        sellUnitPrice: unitSellPrice,
        quantity: targetQty,
        buyCtx: feeCtx,
        sellCtx: feeCtx,
        haulingCost: 0,
      });

      if (trade.netMarginPct < minMargin || trade.netProfit < minProfit) {
        continue;
      }

      // Liquidity rating
      let liquidityRating: 'A' | 'B' | 'C' = 'C';
      if (c.buy_vol >= 50 && c.sell_vol >= 50 && c.buy_orders >= 5 && c.sell_orders >= 5) {
        liquidityRating = 'A';
      } else if (c.buy_vol >= 15 && c.sell_vol >= 15) {
        liquidityRating = 'B';
      }

      // Risk score: based on liquidity, capital, and margin buffer
      let riskScore = 3;
      if (liquidityRating === 'A' && trade.netMarginPct > 15) riskScore = 1;
      else if (liquidityRating === 'B') riskScore = 2;

      opportunities.push({
        typeId: c.type_id,
        typeName: meta.en_name,
        zhName: meta.zh_name || undefined,
        groupName: meta.group_name || undefined,
        volumeM3: meta.volume || 1,
        strategy: 'station_arbitrage',
        buyStationId: opts.stationId,
        buyStationName: stationName,
        sellStationId: opts.stationId,
        sellStationName: stationName,
        suggestedBuyPrice: unitBuyPrice,
        suggestedSellPrice: unitSellPrice,
        suggestedQuantity: targetQty,
        capitalRequired: trade.netCost,
        estimatedFees: trade.totalFees,
        haulingCost: 0,
        expectedNetProfit: trade.netProfit,
        expectedRoiPct: trade.roiPct,
        dailyVolumeDest: c.sell_vol,
        turnoverDays: Math.round((targetQty / Math.max(1, c.sell_vol)) * 7 * 10) / 10,
        liquidityRating,
        riskScore,
        rationale: `在 ${stationName} 挂买单(${unitBuyPrice.toLocaleString()} ISK)吃进，就地挂卖单(${unitSellPrice.toLocaleString()} ISK)出货。扣除双方经纪人费与销售税后净利 +${trade.netProfit.toLocaleString()} ISK (+${trade.netMarginPct.toFixed(1)}%)。`,
      });
    }

    // Sort by expected net profit descending
    opportunities.sort((a, b) => b.expectedNetProfit - a.expectedNetProfit);
    return opportunities;
  }
}