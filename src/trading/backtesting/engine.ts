import type { Db } from '../../db/sqlite.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS } from '../fee-engine.js';
import type { FeeContext } from '../types.js';

export interface BacktestTrade {
  signalDate: string;
  entryDate: string;
  exitDate: string;
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
  simulationType: 'daily_signal_backtest';
  executionMode?: 'conservative_simulation';
  slippageModel: string;
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
  cvar95Pct: number; // 95% Conditional Value at Risk
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
   * Run historical simulation with strict time-causality:
   * - Signal is computed at close of Day T using historical window [T-14, T].
   * - Trade execution occurs strictly on Day T+1 (Entry Day).
   * - Trade exit occurs on Day T+2 (Exit Day).
   * - Future data from Day T+1 or T+2 CANNOT influence entry decision at Day T.
   */
  public static runHistoricalBacktest(
    db: Db,
    params: {
      strategyName: string;
      regionId: number;
      typeIds: number[];
      initialCapital: number;
      slippageFriction?: number; // default 0.015 (1.5% stylized friction)
      feeContext?: FeeContext;
    },
  ): BacktestSummary {
    const { strategyName, regionId, typeIds, initialCapital, slippageFriction = 0.015, feeContext } = params;
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
      if (series.length < 6) continue;

      // Strict causal loop:
      // Loop index i represents Signal Day T (needs at least 14 days history, and 2 subsequent days for execution)
      for (let i = 14; i < series.length - 2; i++) {
        // Historical window strictly ends at i (Signal Day T)
        const historyWindow = series.slice(Math.max(0, i - 14), i + 1);
        const rollingAvg = historyWindow.reduce((acc, w) => acc + w.average, 0) / historyWindow.length;
        const signalDay = series[i];

        // Signal rule evaluated on closed Day T data
        if (signalDay.average < rollingAvg * 0.95 && signalDay.volume > 10) {
          // Execution Day T+1: buy at Day T+1 market average
          const entryDay = series[i + 1];
          const entryPrice = entryDay.average;

          const maxAllocation = currentCapital * 0.15; // 15% single item cap
          const qty = Math.max(1, Math.floor(maxAllocation / entryPrice));
          const tradeCost = qty * entryPrice;

          if (tradeCost > currentCapital * 0.8) continue; // Respect 20% cash reserve

          // Exit Day T+2: sell on Day T+2 with stylized friction
          const exitDay = series[i + 2];
          const exitPrice = exitDay.average * (1 - slippageFriction);

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
            signalDate: signalDay.date,
            entryDate: entryDay.date,
            exitDate: exitDay.date,
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

          // Fast forward past execution days
          i += 2;
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
      simulationType: 'daily_signal_backtest',
      executionMode: 'conservative_simulation',
      slippageModel: `simplified_${(slippageFriction * 100).toFixed(1)}pct_friction`,
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

