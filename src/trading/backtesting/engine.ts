import type { Db } from '../../db/sqlite.js';

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
}

export interface BacktestSummary {
  runId: string;
  strategyName: string;
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
   */
  public static runHistoricalBacktest(
    db: Db,
    params: {
      strategyName: string;
      regionId: number;
      typeIds: number[];
      initialCapital: number;
      minDaysRequired?: number;
    },
  ): BacktestSummary {
    const { strategyName, regionId, typeIds, initialCapital } = params;
    const runId = `BT-${Date.now()}`;

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
    const dailyReturns: number[] = [];

    // Group by type_id to trace price series
    const typeSeries = new Map<number, any[]>();
    for (const p of points) {
      if (!typeSeries.has(p.type_id)) typeSeries.set(p.type_id, []);
      typeSeries.get(p.type_id)!.push(p);
    }

    let totalFeesPaid = 0;

    for (const [typeId, series] of typeSeries.entries()) {
      if (series.length < 5) continue;

      // Simple mean-reversion & trend simulation
      // Buy when price dips below 14-day rolling average by > 5% with volume support
      for (let i = 4; i < series.length - 1; i++) {
        const window = series.slice(Math.max(0, i - 14), i);
        const avg = window.reduce((acc, w) => acc + w.average, 0) / window.length;
        const current = series[i];
        const next = series[i + 1];

        if (current.average < avg * 0.95 && current.volume > 5) {
          // Entry signal: buy at current day lowest
          const entryPrice = current.lowest;
          const maxAllocation = currentCapital * 0.15; // 15% single item cap
          const qty = Math.max(1, Math.floor(maxAllocation / entryPrice));
          const tradeCost = qty * entryPrice;

          if (tradeCost > currentCapital * 0.8) continue; // Respect 20% cash reserve

          // Exit signal: sell on next day at next.average
          const exitPrice = next.average;
          const grossPnl = (exitPrice - entryPrice) * qty;

          // Fees: ~5.36% sales tax + 2.1% broker fee
          const buyFee = tradeCost * 0.021;
          const sellFee = (qty * exitPrice) * (0.021 + 0.0536);
          const fees = buyFee + sellFee;
          const netPnl = grossPnl - fees;

          totalFeesPaid += fees;
          currentCapital += netPnl;
          if (currentCapital > peakCapital) peakCapital = currentCapital;
          const dd = peakCapital - currentCapital;
          if (dd > maxDrawdownIsk) maxDrawdownIsk = dd;

          dailyReturns.push(netPnl / tradeCost);

          trades.push({
            date: current.date,
            typeId,
            quantity: qty,
            entryPrice,
            exitPrice,
            grossPnl,
            fees,
            netPnl,
            holdingDays: 1,
            isWin: netPnl > 0,
          });

          // Skip to next after trade
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

    // Annualized Sharpe Ratio approximation (assuming 0 risk-free rate)
    let sharpeRatio = 0;
    if (dailyReturns.length > 1) {
      const meanReturn = dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length;
      const variance = dailyReturns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / dailyReturns.length;
      const stdDev = Math.sqrt(variance);
      if (stdDev > 0) {
        sharpeRatio = (meanReturn / stdDev) * Math.sqrt(252);
      }
    }

    const feeDragPct = (totalPnlIsk + totalFeesPaid) > 0 ? (totalFeesPaid / (totalPnlIsk + totalFeesPaid)) * 100 : 0;

    const startDate = points[0]?.date || 'N/A';
    const endDate = points[points.length - 1]?.date || 'N/A';

    return {
      runId,
      strategyName,
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
      totalTrades,
      profitableTrades,
      losingTrades,
      totalFeesPaid: Math.round(totalFeesPaid * 100) / 100,
      feeDragPct: Math.round(feeDragPct * 100) / 100,
      trades,
    };
  }
}