import type { Db } from '../../db/sqlite.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS } from '../fee-engine.js';
import type { FeeContext } from '../types.js';

export interface BacktestTrade {
  date: string;
  typeId: number;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  holdingDays: number;
  isWin: boolean;
  returnPct: number;
}

export interface BacktestSummary {
  runId: string;
  strategyName: string;
  executionMode: 'conservative_simulation' | 'price_signal_only';
  startDate: string;
  endDate: string;
  initialCapital: number;
  finalCapital: number;
  totalPnlIsk: number;
  totalRoiPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  profitFactor: number;
  sharpeRatio: number;
  sortinoRatio: number;
  cvar95Pct: number; // 95% Conditional Value at Risk (Expected Shortfall)
  capitalTurnoverRate: number; // Total volume transacted / initial capital
  totalTrades: number;
  profitableTrades: number;
  losingTrades: number;
  totalFeesPaid: number;
  feeDragPct: number;
  trades: BacktestTrade[];
}

export class BacktestingEngine {
  /**
   * Run historical simulation on daily points without lookahead bias.
   * Eliminates "lowest price buy" and "next day average sell" lookahead bugs.
   */
  public static runHistoricalBacktest(
    db: Db,
    params: {
      strategyName: string;
      regionId: number;
      typeIds: number[];
      initialCapital: number;
      minDaysRequired?: number;
      feeContext?: FeeContext;
    },
  ): BacktestSummary {
    const { strategyName, regionId, typeIds, initialCapital, feeContext } = params;
    const runId = `BT-${Date.now()}`;

    const feeCtx: FeeContext = feeContext ?? {
      clone: 'alpha',
      skills: ALPHA_DEFAULT_SKILLS,
      facility: 'npc_station',
    };

    // Read all daily history points for the given types in chronological order
    const points = db.prepare(`
      SELECT region_id, type_id, date, order_count, volume, highest, average, lowest
      FROM market_price_history
      WHERE region_id = ? AND type_id IN (${typeIds.map(() => '?').join(',')})
      ORDER BY date ASC
    `).all(regionId, ...typeIds) as any[];

    let currentCapital = initialCapital;
    let peakCapital = initialCapital;
    let maxDrawdownIsk = 0;
    const trades: BacktestTrade[] = [];
    const returns: number[] = [];
    let totalGrossVolumeTransacted = 0;
    let totalFeesPaid = 0;

    // Group by type_id to trace price series
    const typeSeries = new Map<number, any[]>();
    for (const p of points) {
      if (!typeSeries.has(p.type_id)) typeSeries.set(p.type_id, []);
      typeSeries.get(p.type_id)!.push(p);
    }

    for (const [typeId, series] of typeSeries.entries()) {
      if (series.length < 5) continue;

      // Anti-lookahead trading simulation:
      // Signal generated at day i using strictly historical data (window ending at i - 1)
      for (let i = 4; i < series.length - 1; i++) {
        const historyWindow = series.slice(Math.max(0, i - 14), i);
        const rollingAvg = historyWindow.reduce((acc, w) => acc + w.average, 0) / historyWindow.length;
        const current = series[i];
        const next = series[i + 1];

        // Signal: price dip below historical rolling average by > 5% with volume support
        if (current.average < rollingAvg * 0.95 && current.volume > 10) {
          // Conservative Entry Price: Conservative execution at daily average (not impossible lowest)
          const entryPrice = current.average;
          const maxAllocation = currentCapital * 0.15; // 15% single item cap
          const qty = Math.max(1, Math.floor(maxAllocation / entryPrice));
          const tradeCost = qty * entryPrice;

          if (tradeCost > currentCapital * 0.8) continue; // Respect 20% cash reserve

          // Conservative Exit Price: Exit on next day with 1.5% execution friction below next average
          const exitPrice = next.average * 0.985;

          // Compute exact fees through FeeEngine
          const tradeCalc = FeeEngine.calculateTrade({
            buyType: 'place_buy_order',
            sellType: 'place_sell_order',
            buyUnitPrice: entryPrice,
            sellUnitPrice: exitPrice,
            quantity: qty,
            buyCtx: feeCtx,
            sellCtx: feeCtx,
          });

          const grossPnl = tradeCalc.grossRevenue - tradeCalc.grossCost;
          const fees = tradeCalc.totalFees;
          const netPnl = tradeCalc.netProfit;

          totalFeesPaid += fees;
          totalGrossVolumeTransacted += (tradeCalc.grossCost + tradeCalc.grossRevenue);
          currentCapital += netPnl;
          if (currentCapital > peakCapital) peakCapital = currentCapital;
          const dd = peakCapital - currentCapital;
          if (dd > maxDrawdownIsk) maxDrawdownIsk = dd;

          const tradeReturnPct = tradeCost > 0 ? (netPnl / tradeCost) * 100 : 0;
          returns.push(tradeReturnPct / 100);

          trades.push({
            date: current.date,
            typeId,
            quantity: qty,
            entryPrice: Math.round(entryPrice * 100) / 100,
            exitPrice: Math.round(exitPrice * 100) / 100,
            grossPnl: Math.round(grossPnl * 100) / 100,
            fees: Math.round(fees * 100) / 100,
            netPnl: Math.round(netPnl * 100) / 100,
            holdingDays: 1,
            isWin: netPnl > 0,
            returnPct: Math.round(tradeReturnPct * 100) / 100,
          });

          // Move forward
          i += 1;
        }
      }
    }

    const totalTrades = trades.length;
    const profitableTrades = trades.filter(t => t.isWin).length;
    const losingTrades = totalTrades - profitableTrades;
    const winRatePct = totalTrades > 0 ? (profitableTrades / totalTrades) * 100 : 0;
    const totalPnlIsk = currentCapital - initialCapital;
    const totalRoiPct = initialCapital > 0 ? (totalPnlIsk / initialCapital) * 100 : 0;
    const maxDrawdownPct = peakCapital > 0 ? (maxDrawdownIsk / peakCapital) * 100 : 0;

    const totalGain = trades.filter(t => t.netPnl > 0).reduce((sum, t) => sum + t.netPnl, 0);
    const totalLoss = Math.abs(trades.filter(t => t.netPnl < 0).reduce((sum, t) => sum + t.netPnl, 0));
    const profitFactor = totalLoss > 0 ? totalGain / totalLoss : (totalGain > 0 ? 99.0 : 0);

    // Annualized Sharpe Ratio approximation (0% risk-free rate)
    let sharpeRatio = 0;
    let sortinoRatio = 0;
    let cvar95Pct = 0;

    if (returns.length > 1) {
      const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / returns.length;
      const stdDev = Math.sqrt(variance);
      if (stdDev > 0) {
        sharpeRatio = (meanReturn / stdDev) * Math.sqrt(252);
      }

      // Sortino: downside standard deviation
      const downsideVariance = returns.reduce((sum, r) => sum + (Math.min(0, r)) ** 2, 0) / returns.length;
      const downsideStdDev = Math.sqrt(downsideVariance);
      if (downsideStdDev > 0) {
        sortinoRatio = (meanReturn / downsideStdDev) * Math.sqrt(252);
      }

      // CVaR at 95% confidence (expected shortfall of worst 5% returns)
      const sortedReturns = [...returns].sort((a, b) => a - b);
      const cutoffIdx = Math.max(1, Math.floor(sortedReturns.length * 0.05));
      const worstReturns = sortedReturns.slice(0, cutoffIdx);
      const avgWorstLoss = worstReturns.reduce((sum, r) => sum + r, 0) / worstReturns.length;
      cvar95Pct = Math.round(Math.abs(avgWorstLoss) * 100 * 100) / 100;
    }

    const capitalTurnoverRate = initialCapital > 0 ? Math.round((totalGrossVolumeTransacted / initialCapital) * 100) / 100 : 0;
    const feeDragPct = (totalPnlIsk + totalFeesPaid) > 0 ? (totalFeesPaid / (totalPnlIsk + totalFeesPaid)) * 100 : 0;

    const startDate = points[0]?.date || 'N/A';
    const endDate = points[points.length - 1]?.date || 'N/A';

    return {
      runId,
      strategyName,
      executionMode: 'conservative_simulation',
      startDate,
      endDate,
      initialCapital,
      finalCapital: Math.round(currentCapital * 100) / 100,
      totalPnlIsk: Math.round(totalPnlIsk * 100) / 100,
      totalRoiPct: Math.round(totalRoiPct * 100) / 100,
      maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
      winRatePct: Math.round(winRatePct * 100) / 100,
      profitFactor: Math.round(profitFactor * 100) / 100,
      sharpeRatio: Math.round(sharpeRatio * 100) / 100,
      sortinoRatio: Math.round(sortinoRatio * 100) / 100,
      cvar95Pct,
      capitalTurnoverRate,
      totalTrades,
      profitableTrades,
      losingTrades,
      totalFeesPaid: Math.round(totalFeesPaid * 100) / 100,
      feeDragPct: Math.round(feeDragPct * 100) / 100,
      trades,
    };
  }
}
