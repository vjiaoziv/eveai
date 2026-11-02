import type { Db } from '../../db/sqlite.js';

export interface TrendAnalysisResult {
  typeId: number;
  regionId: number;
  daysAnalyzed: number;
  currentPrice: number;
  ma7: number | null;
  ma14: number | null;
  ma30: number | null;
  ma90: number | null;
  momentum7d: number | null;   // (Current - MA7) / MA7 * 100
  momentum30d: number | null;  // (Current - MA30) / MA30 * 100
  volatilityLogReturn: number | null; // Log-return standard deviation %
  meanDailyVolume: number | null;
  pricePercentile: number | null; // Percentile rank of current price over period (0-100)
  signal: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';
  signalReason: string;
}

export class TrendAnalysisStrategy {
  /**
   * Analyze price trend, moving averages, momentum and volatility from market_price_history
   */
  public static analyzeTrend(
    db: Db,
    typeId: number,
    regionId = 10000002, // Default The Forge
  ): TrendAnalysisResult | null {
    const points = db.prepare(`
      SELECT date, order_count, volume, highest, average, lowest
      FROM market_price_history
      WHERE region_id = ? AND type_id = ?
      ORDER BY date ASC
    `).all(regionId, typeId) as Array<{
      date: string;
      order_count: number;
      volume: number;
      highest: number;
      average: number;
      lowest: number;
    }>;

    if (points.length === 0) return null;

    const currentPoint = points[points.length - 1];
    const currentPrice = currentPoint.average;

    const calcMa = (days: number): number | null => {
      if (points.length < Math.min(days, 3)) return null;
      const slice = points.slice(-days);
      const sum = slice.reduce((acc, p) => acc + p.average, 0);
      return Math.round((sum / slice.length) * 100) / 100;
    };

    const ma7 = calcMa(7);
    const ma14 = calcMa(14);
    const ma30 = calcMa(30);
    const ma90 = calcMa(90);

    const momentum7d = ma7 ? Math.round(((currentPrice - ma7) / ma7) * 10_000) / 100 : null;
    const momentum30d = ma30 ? Math.round(((currentPrice - ma30) / ma30) * 10_000) / 100 : null;

    // Volatility calculation (daily log return standard deviation)
    const logReturns: number[] = [];
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1].average;
      const curr = points[i].average;
      if (prev > 0 && curr > 0) {
        logReturns.push(Math.log(curr / prev));
      }
    }

    let volatilityLogReturn: number | null = null;
    if (logReturns.length >= 3) {
      const mean = logReturns.reduce((sum, r) => sum + r, 0) / logReturns.length;
      const variance = logReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / logReturns.length;
      volatilityLogReturn = Math.round(Math.sqrt(variance) * 100 * 100) / 100;
    }

    // Mean daily volume
    const meanDailyVolume = Math.round(
      points.reduce((sum, p) => sum + p.volume, 0) / points.length,
    );

    // Percentile rank of current price over historical distribution
    const allAverages = points.map(p => p.average).sort((a, b) => a - b);
    const countBelow = allAverages.filter(p => p < currentPrice).length;
    const pricePercentile = Math.round((countBelow / allAverages.length) * 100);

    // Trend signal generation
    let signal: TrendAnalysisResult['signal'] = 'neutral';
    let signalReason = '价格位于历史均值区间，趋势平稳。';

    if (ma7 && ma30) {
      if (currentPrice < ma30 * 0.90 && pricePercentile <= 15) {
        signal = 'strong_buy';
        signalReason = `均值回归超跌买点：当前价格处于历史 ${pricePercentile}% 低分位，低于 30 日均线 ${Math.abs(momentum30d || 0)}%，具备高胜率估值修复潜力。`;
      } else if (currentPrice < ma14! * 0.95 && momentum7d! > -5 && pricePercentile <= 35) {
        signal = 'buy';
        signalReason = `逢低吸纳信号：价格偏离短期均线，且处于 35% 以下安全分位。`;
      } else if (currentPrice > ma30 * 1.25 && pricePercentile >= 85) {
        signal = 'strong_sell';
        signalReason = `超买止盈预警：当前价格处于历史 ${pricePercentile}% 高分位，高于 30 日均线 ${momentum30d}%，回调回撤风险极大。`;
      } else if (currentPrice > ma14! * 1.10 && pricePercentile >= 75) {
        signal = 'sell';
        signalReason = `高位止盈信号：近期涨幅累积，面临均线阻力位。`;
      }
    }

    return {
      typeId,
      regionId,
      daysAnalyzed: points.length,
      currentPrice,
      ma7,
      ma14,
      ma30,
      ma90,
      momentum7d,
      momentum30d,
      volatilityLogReturn,
      meanDailyVolume,
      pricePercentile,
      signal,
      signalReason,
    };
  }
}