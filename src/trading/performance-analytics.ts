import type { Db } from '../db/sqlite.js';
import type { StrategyType } from './types.js';

export const STRATEGY_TYPES: StrategyType[] = [
  'station_arbitrage',
  'regional_hauling',
  'market_making',
  'trend_following',
  'event_driven',
  'manufacturing_arbitrage',
];

export const MIN_SUBMITTED_ORDERS = 10;
export const MIN_COMPLETED_TRADES = 5;
export const DEFAULT_LIQUIDATION_HAIRCUT = 0.07125; // 5.025% sales tax + 2.10% broker fee.

export interface EquityPoint {
  at: string;
  equity: number;
  availableCash: number;
  escrowLocked: number;
  inventoryCost: number;
  inventoryValue: number;
  sourceEvent: string;
  sourceId?: string;
}

export interface AccountingReconciliation {
  isReconciled: boolean;
  discrepancy: number;
  assetsAtCostBasis: number;
  expectedEquity: number;
  journalLastBalance: number | null;
  journalLastEscrow: number | null;
  journalBalanceMatches: boolean;
}

export interface StrategyPerformanceMetrics {
  strategy: StrategyType;
  sampleStatus: 'INSUFFICIENT_SAMPLE' | 'OK';
  totalOpportunities: number;
  submittedOrders: number;
  filledOrders: number;
  completedTrades: number;
  partialOrders: number;
  fillRatePct: number | null;
  opportunityRealizationRatePct: number | null;
  grossProfit: number;
  fees: number;
  realizedNetPnl: number;
  netReturnPct: number | null;
  maxDrawdownPct: number | null;
  capitalUtilizationPct: number | null;
  averageHoldingHours: number | null;
  inventoryOverhang: number;
  unfilledRatioPct: number | null;
}

export interface PerformanceAttribution {
  topProfitStrategy: { strategy: StrategyType; realizedNetPnl: number } | null;
  topLossStrategy: { strategy: StrategyType; realizedNetPnl: number } | null;
  topProfitType: { typeId: number; grossPnl: number } | null;
  topProfitLocation: { locationId: number; grossPnl: number } | null;
  totalFees: number;
  feeDragPct: number | null;
  largestPredictionVariance: {
    opportunityId: string;
    expected: number;
    actual: number;
    variance: number;
  } | null;
}

export interface PaperPerformanceSnapshot {
  characterId: string;
  accountId: string;
  asOf: string;
  sampleStatus: 'INSUFFICIENT_SAMPLE' | 'OK';
  initialCapital: number;
  availableCash: number;
  escrowLocked: number;
  inventoryCost: number;
  inventoryMarketValue: number;
  totalAssetsCostBasis: number;
  totalAssetsMarkToMarket: number;
  realizedGrossPnl: number;
  feesPaid: number;
  realizedNetPnl: number;
  unrealizedPnl: number;
  netPnl: number;
  netReturnPct: number | null;
  capitalUtilizationPct: number | null;
  fillRatePct: number | null;
  opportunityRealizationRatePct: number | null;
  maxDrawdownPct: number | null;
  equitySeries: EquityPoint[];
  equitySeriesBasis: 'equity_snapshots' | 'journal_reconstructed_cost_basis' | 'current_state_fallback';
  accounting: AccountingReconciliation;
  strategyMetrics: StrategyPerformanceMetrics[];
  attribution: PerformanceAttribution;
  riskFlags: string[];
}

export interface TemporalAuditResult {
  status: 'PASS' | 'FAIL';
  checked: number;
  violations: string[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function pct(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || denominator === 0) return null;
  return round2((numerator / denominator) * 100);
}

function maxDrawdownFromSeries(series: number[]): number | null {
  if (series.length < 2) return null;
  let peak = series[0];
  let maxDd = 0;
  for (const value of series) {
    if (value > peak) peak = value;
    if (peak > 0) {
      const dd = ((peak - value) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return round2(maxDd);
}

function liquidationEstimate(db: Db, characterId: number): { cost: number; marketValue: number; unrealized: number } {
  const rows = db.prepare(`
    SELECT type_id, location_id, quantity, cost_price
    FROM paper_trading_positions
    WHERE character_id = ? AND status = 'holding' AND quantity > 0
  `).all(characterId) as any[];
  let cost = 0;
  let marketValue = 0;
  for (const row of rows) {
    let remaining = Number(row.quantity);
    let gross = 0;
    const bids = db.prepare(`
      SELECT price, volume_remain FROM market_orders
      WHERE type_id = ? AND location_id = ? AND is_buy_order = 1
      ORDER BY price DESC
    `).all(row.type_id, row.location_id) as any[];
    for (const bid of bids) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(bid.volume_remain));
      gross += take * Number(bid.price);
      remaining -= take;
    }
    if (remaining > 0) gross += remaining * Number(row.cost_price);
    cost += Number(row.quantity) * Number(row.cost_price);
    marketValue += gross * (1 - DEFAULT_LIQUIDATION_HAIRCUT);
  }
  return { cost: round2(cost), marketValue: round2(marketValue), unrealized: round2(marketValue - cost) };
}

function buildEquitySeries(db: Db, account: any): { points: EquityPoint[]; basis: PaperPerformanceSnapshot['equitySeriesBasis'] } {
  const snapshots = db.prepare(`
    SELECT * FROM paper_equity_snapshots
    WHERE account_id = ?
    ORDER BY snapshot_at, snapshot_id
  `).all(account.account_id) as any[];

  if (snapshots.length > 0) {
    const points: EquityPoint[] = [];
    const hasInitial = snapshots.some((row: any) => row.source_event === 'account_created');
    if (!hasInitial) {
      points.push({
        at: account.created_at,
        equity: Number(account.initial_cash),
        availableCash: Number(account.initial_cash),
        escrowLocked: 0,
        inventoryCost: 0,
        inventoryValue: 0,
        sourceEvent: 'initial_capital',
      });
    }
    for (const row of snapshots) {
      points.push({
        at: row.snapshot_at,
        equity: Number(row.total_equity),
        availableCash: Number(row.available_cash),
        escrowLocked: Number(row.escrow_locked),
        inventoryCost: Number(row.inventory_cost),
        inventoryValue: Number(row.inventory_value),
        sourceEvent: row.source_event,
        sourceId: row.source_id || undefined,
      });
    }
    return { points, basis: 'equity_snapshots' };
  }

  const journal = db.prepare(`
    SELECT * FROM paper_trading_journal
    WHERE account_id = ?
    ORDER BY created_at, journal_id
  `).all(account.account_id) as any[];
  if (journal.length === 0) {
    return {
      points: [{
        at: account.updated_at || account.created_at,
        equity: Number(account.available_cash) + Number(account.escrow_locked),
        availableCash: Number(account.available_cash),
        escrowLocked: Number(account.escrow_locked),
        inventoryCost: 0,
        inventoryValue: 0,
        sourceEvent: 'current_state_fallback',
      }],
      basis: 'current_state_fallback',
    };
  }

  let inventoryCost = 0;
  const points: EquityPoint[] = [{
    at: account.created_at,
    equity: Number(account.initial_cash),
    availableCash: Number(account.initial_cash),
    escrowLocked: 0,
    inventoryCost: 0,
    inventoryValue: 0,
    sourceEvent: 'initial_capital',
  }];
  for (const row of journal) {
    const cash = Number(row.balance_after);
    const escrow = Number(row.escrow_after);
    if (row.entry_type === 'order_spend') inventoryCost += Number(row.amount);
    if (row.entry_type === 'order_revenue' && row.order_id) {
      const exitCost = db.prepare(`
        SELECT COALESCE(SUM(quantity * cost_price), 0) AS cost
        FROM paper_position_exits WHERE order_id = ?
      `).get(row.order_id) as any;
      inventoryCost = Math.max(0, inventoryCost - Number(exitCost?.cost || 0));
    }
    points.push({
      at: row.created_at,
      equity: round2(cash + escrow + inventoryCost),
      availableCash: cash,
      escrowLocked: escrow,
      inventoryCost: round2(inventoryCost),
      inventoryValue: round2(inventoryCost),
      sourceEvent: row.entry_type,
      sourceId: row.order_id || undefined,
    });
  }
  return { points, basis: 'journal_reconstructed_cost_basis' };
}

export class PerformanceAnalytics {
  public static compute(db: Db, characterId: number): PaperPerformanceSnapshot {
    const account = db.prepare('SELECT * FROM paper_trading_accounts WHERE character_id = ?').get(characterId) as any;
    if (!account) throw new Error(`Paper Trading account not found for character ${characterId}`);

    const liquidation = liquidationEstimate(db, characterId);
    const realizedGross = Number(account.total_realized_pnl || 0);
    const feesPaid = Number(account.total_fees_paid || 0);
    const realizedNet = round2(realizedGross - feesPaid);
    const netPnl = round2(realizedNet + liquidation.unrealized);
    const equity = buildEquitySeries(db, account);
    const maxDrawdown = maxDrawdownFromSeries(equity.points.map((point) => point.equity));

    const orderStats = db.prepare(`
      SELECT
        COUNT(*) AS submitted,
        SUM(CASE WHEN status = 'filled' THEN 1 ELSE 0 END) AS filled,
        SUM(CASE WHEN status = 'partially_filled' THEN 1 ELSE 0 END) AS partial,
        SUM(CASE WHEN status IN ('open', 'partially_filled') THEN quantity - filled_quantity ELSE 0 END) AS unfilled_qty,
        SUM(CASE WHEN status IN ('open', 'partially_filled') THEN quantity ELSE 0 END) AS open_qty
      FROM paper_trading_orders WHERE character_id = ?
    `).get(characterId) as any;
    const opportunityStats = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN EXISTS (
               SELECT 1 FROM paper_trading_orders o WHERE o.opportunity_id = trade_opportunities_log.opportunity_id
             ) THEN 1 ELSE 0 END) AS realized
      FROM trade_opportunities_log
    `).get() as any;

    const fillRate = pct(Number(orderStats?.filled || 0), Number(orderStats?.submitted || 0));
    const realizationRate = pct(Number(opportunityStats?.realized || 0), Number(opportunityStats?.total || 0));
    const deployedNow = Number(account.escrow_locked || 0) + liquidation.cost;
    const snapshotDeployed = equity.points.length > 0
      ? equity.points.reduce((sum, point) => sum + point.escrowLocked + point.inventoryCost, 0) / equity.points.length
      : deployedNow;
    const capitalUtilization = pct(snapshotDeployed, Number(account.initial_cash));

    const completedTrades = db.prepare(`
      SELECT COUNT(*) AS n FROM paper_trading_orders
      WHERE character_id = ? AND order_type = 'sell' AND status = 'filled'
    `).get(characterId) as any;
    const sampleStatus: PaperPerformanceSnapshot['sampleStatus'] =
      Number(orderStats?.submitted || 0) >= MIN_SUBMITTED_ORDERS
      && Number(completedTrades?.n || 0) >= MIN_COMPLETED_TRADES
        ? 'OK'
        : 'INSUFFICIENT_SAMPLE';

    const strategyMetrics: StrategyPerformanceMetrics[] = STRATEGY_TYPES.map((strategy) => {
      const opp = db.prepare('SELECT COUNT(*) AS n FROM trade_opportunities_log WHERE strategy_type = ?').get(strategy) as any;
      const orders = db.prepare(`
        SELECT
          COUNT(*) AS submitted,
          SUM(CASE WHEN status = 'filled' THEN 1 ELSE 0 END) AS filled,
          SUM(CASE WHEN status = 'partially_filled' THEN 1 ELSE 0 END) AS partial,
          SUM(CASE WHEN status = 'filled' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN status IN ('open', 'partially_filled') THEN quantity - filled_quantity ELSE 0 END) AS unfilled_qty,
          SUM(CASE WHEN status IN ('open', 'partially_filled') THEN quantity ELSE 0 END) AS open_qty,
          COALESCE(SUM(fees_paid), 0) AS fees
        FROM paper_trading_orders WHERE strategy_type = ?
      `).get(strategy) as any;
      const exits = db.prepare(`
        SELECT COALESCE(SUM(e.gross_pnl), 0) AS gross
        FROM paper_position_exits e
        JOIN paper_trading_orders o ON o.order_id = e.order_id
        WHERE o.strategy_type = ?
      `).get(strategy) as any;
      const inventory = db.prepare(`
        SELECT COALESCE(SUM(quantity * cost_price), 0) AS cost
        FROM paper_trading_positions
        WHERE strategy_type = ? AND status = 'holding'
      `).get(strategy) as any;
      const holding = db.prepare(`
        SELECT AVG((julianday(sold_at) - julianday(created_at)) * 24) AS hours
        FROM paper_trading_positions
        WHERE strategy_type = ? AND status = 'sold' AND sold_at IS NOT NULL
      `).get(strategy) as any;
      const submitted = Number(orders?.submitted || 0);
      const filled = Number(orders?.filled || 0);
      const completed = Number(orders?.completed || 0);
      const gross = Number(exits?.gross || 0);
      const fees = Number(orders?.fees || 0);
      const realizedNet = round2(gross - fees);
      const strategyEvents = db.prepare(`
        SELECT o.updated_at AS at,
               COALESCE(SUM(e.gross_pnl), 0) - COALESCE(o.fees_paid, 0) AS net
        FROM paper_trading_orders o
        LEFT JOIN paper_position_exits e ON e.order_id = o.order_id
        WHERE o.strategy_type = ? AND o.order_type = 'sell' AND o.status = 'filled'
        GROUP BY o.order_id
        ORDER BY o.updated_at
      `).all(strategy) as any[];
      let peak = 0;
      let strategyDrawdown = 0;
      for (const event of strategyEvents) {
        peak = Math.max(peak, Number(event.net || 0));
        strategyDrawdown = Math.max(strategyDrawdown, peak - Number(event.net || 0));
      }
      const unfilledRatio = Number(orders?.open_qty || 0) > 0
        ? pct(Number(orders?.unfilled_qty || 0), Number(orders?.open_qty || 0))
        : null;
      return {
        strategy,
        sampleStatus: submitted >= MIN_SUBMITTED_ORDERS && completed >= MIN_COMPLETED_TRADES ? 'OK' : 'INSUFFICIENT_SAMPLE',
        totalOpportunities: Number(opp?.n || 0),
        submittedOrders: submitted,
        filledOrders: filled,
        completedTrades: completed,
        partialOrders: Number(orders?.partial || 0),
        fillRatePct: pct(filled, submitted),
        opportunityRealizationRatePct: pct(
          ((db.prepare('SELECT COUNT(DISTINCT opportunity_id) AS n FROM paper_trading_orders WHERE strategy_type = ? AND opportunity_id IS NOT NULL').get(strategy) as any)?.n || 0),
          Number(opp?.n || 0),
        ),
        grossProfit: round2(gross),
        fees: round2(fees),
        realizedNetPnl: realizedNet,
        netReturnPct: pct(realizedNet, Number(account.initial_cash)),
        maxDrawdownPct: strategyEvents.length >= 2 ? pct(strategyDrawdown, Number(account.initial_cash)) : null,
        capitalUtilizationPct: pct(Number(account.escrow_locked || 0) + Number(inventory?.cost || 0), Number(account.initial_cash)),
        averageHoldingHours: holding?.hours == null ? null : round2(Number(holding.hours)),
        inventoryOverhang: round2(Number(inventory?.cost || 0)),
        unfilledRatioPct: unfilledRatio,
      };
    });

    const reconciledActual = round2(Number(account.available_cash) + Number(account.escrow_locked) + liquidation.cost);
    const reconciledExpected = round2(Number(account.initial_cash) + realizedGross - feesPaid);
    const lastJournal = db.prepare(`
      SELECT balance_after, escrow_after FROM paper_trading_journal
      WHERE account_id = ? ORDER BY created_at, journal_id DESC LIMIT 1
    `).get(account.account_id) as any;
    const journalBalanceMatches = !lastJournal
      || (Math.abs(Number(lastJournal.balance_after) - Number(account.available_cash)) < 0.05
        && Math.abs(Number(lastJournal.escrow_after) - Number(account.escrow_locked)) < 0.05);

    const topProfitStrategy = [...strategyMetrics].sort((a, b) => b.realizedNetPnl - a.realizedNetPnl)[0];
    const topLossStrategy = [...strategyMetrics].sort((a, b) => a.realizedNetPnl - b.realizedNetPnl)[0];
    const topType = db.prepare(`
      SELECT type_id, SUM(gross_pnl) AS gross FROM paper_position_exits GROUP BY type_id ORDER BY gross DESC LIMIT 1
    `).get() as any;
    const topLocation = db.prepare(`
      SELECT p.location_id, SUM(e.gross_pnl) AS gross
      FROM paper_position_exits e
      JOIN paper_trading_positions p ON p.paper_id = e.paper_id
      GROUP BY p.location_id ORDER BY gross DESC LIMIT 1
    `).get() as any;
    const variance = db.prepare(`
      SELECT opportunity_id, expected_net_profit, actual_simulated_pnl, prediction_variance
      FROM trade_opportunities_log
      WHERE actual_simulated_pnl IS NOT NULL AND prediction_variance IS NOT NULL
      ORDER BY ABS(prediction_variance) DESC LIMIT 1
    `).get() as any;

    const riskFlags: string[] = [];
    if (sampleStatus === 'INSUFFICIENT_SAMPLE') riskFlags.push('INSUFFICIENT_SAMPLE');
    if (!journalBalanceMatches) riskFlags.push('JOURNAL_BALANCE_MISMATCH');
    if (Math.abs(reconciledActual - reconciledExpected) >= 0.05) riskFlags.push('LEDGER_DISCREPANCY');
    if (Number(orderStats?.partial || 0) > 0) riskFlags.push('PARTIAL_FILLS_PRESENT');
    if (Number(orderStats?.unfilled_qty || 0) > 0) riskFlags.push('UNFILLED_ORDERS_PRESENT');
    if (db.prepare("SELECT COUNT(*) AS n FROM trade_opportunities_log WHERE opportunity_expires_at IS NOT NULL AND opportunity_expires_at < datetime('now')").get() as any) {
      const expired = db.prepare("SELECT COUNT(*) AS n FROM trade_opportunities_log WHERE opportunity_expires_at IS NOT NULL AND opportunity_expires_at < datetime('now')").get() as any;
      if (Number(expired?.n || 0) > 0) riskFlags.push('EXPIRED_OPPORTUNITIES_PRESENT');
    }

    return {
      characterId: String(characterId),
      accountId: account.account_id,
      asOf: new Date().toISOString(),
      sampleStatus,
      initialCapital: Number(account.initial_cash),
      availableCash: Number(account.available_cash),
      escrowLocked: Number(account.escrow_locked),
      inventoryCost: liquidation.cost,
      inventoryMarketValue: liquidation.marketValue,
      totalAssetsCostBasis: reconciledActual,
      totalAssetsMarkToMarket: round2(Number(account.available_cash) + Number(account.escrow_locked) + liquidation.marketValue),
      realizedGrossPnl: round2(realizedGross),
      feesPaid: round2(feesPaid),
      realizedNetPnl: realizedNet,
      unrealizedPnl: liquidation.unrealized,
      netPnl,
      netReturnPct: pct(netPnl, Number(account.initial_cash)),
      capitalUtilizationPct: capitalUtilization,
      fillRatePct: fillRate,
      opportunityRealizationRatePct: realizationRate,
      maxDrawdownPct: maxDrawdown,
      equitySeries: equity.points,
      equitySeriesBasis: equity.basis,
      accounting: {
        isReconciled: Math.abs(reconciledActual - reconciledExpected) < 0.05 && journalBalanceMatches,
        discrepancy: round2(reconciledActual - reconciledExpected),
        assetsAtCostBasis: reconciledActual,
        expectedEquity: reconciledExpected,
        journalLastBalance: lastJournal ? Number(lastJournal.balance_after) : null,
        journalLastEscrow: lastJournal ? Number(lastJournal.escrow_after) : null,
        journalBalanceMatches,
      },
      strategyMetrics,
      attribution: {
        topProfitStrategy: topProfitStrategy && topProfitStrategy.realizedNetPnl !== 0
          ? { strategy: topProfitStrategy.strategy, realizedNetPnl: topProfitStrategy.realizedNetPnl }
          : null,
        topLossStrategy: topLossStrategy && topLossStrategy.realizedNetPnl < 0
          ? { strategy: topLossStrategy.strategy, realizedNetPnl: topLossStrategy.realizedNetPnl }
          : null,
        topProfitType: topType ? { typeId: Number(topType.type_id), grossPnl: round2(Number(topType.gross)) } : null,
        topProfitLocation: topLocation ? { locationId: Number(topLocation.location_id), grossPnl: round2(Number(topLocation.gross)) } : null,
        totalFees: round2(feesPaid),
        feeDragPct: pct(feesPaid, Math.max(0, realizedGross + feesPaid)),
        largestPredictionVariance: variance
          ? {
            opportunityId: String(variance.opportunity_id),
            expected: Number(variance.expected_net_profit || 0),
            actual: Number(variance.actual_simulated_pnl || 0),
            variance: Number(variance.prediction_variance || 0),
          }
          : null,
      },
      riskFlags,
    };
  }

  /**
   * Causal-order audit for Paper Trading and persisted backtests.
   * This function only reads timestamps; it never generates expected returns.
   */
  public static auditTemporalIntegrity(db: Db): TemporalAuditResult {
    const violations: string[] = [];
    let checked = 0;
    const timestamp = (value: unknown): number | null => {
      if (value == null || value === '') return null;
      const raw = String(value);
      const parsed = Date.parse(raw.endsWith('Z') || raw.includes('+') ? raw : raw.replace(' ', 'T') + 'Z');
      return Number.isFinite(parsed) ? parsed : null;
    };

    const fills = db.prepare(`
      SELECT f.fill_id, f.filled_at, o.created_at, o.submitted_at
      FROM paper_fills f
      JOIN paper_trading_orders o ON o.order_id = f.order_id
    `).all() as any[];
    for (const row of fills) {
      checked += 1;
      const submittedAt = timestamp(row.submitted_at || row.created_at);
      const filledAt = timestamp(row.filled_at);
      if (submittedAt != null && filledAt != null && filledAt < submittedAt) {
        violations.push(`fill ${row.fill_id} predates order submission`);
      }
    }

    const linkedOrders = db.prepare(`
      SELECT o.order_id, o.created_at, p.detected_at, p.buy_snapshot_timestamp, p.sell_snapshot_timestamp
      FROM paper_trading_orders o
      JOIN trade_opportunities_log p ON p.opportunity_id = o.opportunity_id
    `).all() as any[];
    for (const row of linkedOrders) {
      checked += 1;
      const detectedAt = timestamp(row.detected_at);
      const createdAt = timestamp(row.created_at);
      if (detectedAt != null && createdAt != null && detectedAt > createdAt) {
        violations.push(`order ${row.order_id} created before opportunity detection`);
      }
      for (const stamp of [row.buy_snapshot_timestamp, row.sell_snapshot_timestamp]) {
        const snapshotAt = timestamp(stamp);
        if (snapshotAt != null && detectedAt != null && snapshotAt > detectedAt) {
          violations.push(`order ${row.order_id} uses a snapshot newer than detection time`);
        }
      }
    }

    const backtests = db.prepare('SELECT run_id, metrics_json FROM backtest_runs').all() as any[];
    for (const run of backtests) {
      checked += 1;
      try {
        const parsed = JSON.parse(run.metrics_json || '{}');
        const trades = Array.isArray(parsed.trades) ? parsed.trades : [];
        for (const trade of trades) {
          if (trade.signalDate && trade.entryDate && trade.signalDate >= trade.entryDate) {
            violations.push(`backtest ${run.run_id} signal is not strictly before entry`);
          }
          if (trade.entryDate && trade.exitDate && trade.entryDate >= trade.exitDate) {
            violations.push(`backtest ${run.run_id} entry is not strictly before exit`);
          }
        }
      } catch {
        violations.push(`backtest ${run.run_id} metrics_json is not parseable`);
      }
    }

    return { status: violations.length === 0 ? 'PASS' : 'FAIL', checked, violations };
  }
}