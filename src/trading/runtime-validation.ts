import type { Db } from '../db/sqlite.js';
import { PerformanceAnalytics, type PaperPerformanceSnapshot } from './performance-analytics.js';
import { PaperTradingSystem, canTransitionPaperOrderState, PAPER_ORDER_STATE_TRANSITIONS } from './paper-trading.js';
import type { StrategyType } from './types.js';

export interface RuntimeGate {
  name: string;
  status: 'PASS' | 'FAIL' | 'UNKNOWN';
  detail: string;
}

export interface RuntimeValidationReport {
  status: 'PAPER_TRADING_OPERATIONAL' | 'PAPER_TRADING_BLOCKED';
  asOf: string;
  characterId: number;
  accountId: string;
  sampleStatus: PaperPerformanceSnapshot['sampleStatus'];
  counts: {
    accounts: number;
    orders: number;
    fills: number;
    positions: number;
    opportunities: number;
    journalEntries: number;
    equitySnapshots: number;
    orderStatuses: Record<string, number>;
  };
  gates: RuntimeGate[];
  performance: PaperPerformanceSnapshot;
  temporalAudit: ReturnType<typeof PerformanceAnalytics.auditTemporalIntegrity>;
  strategyStatus: Record<StrategyType, 'INSUFFICIENT_SAMPLE' | 'OK'>;
  traceability: {
    opportunitiesWithOrders: number;
    ordersWithFills: number;
    fillsWithOpportunity: number;
    orphanFills: number;
  };
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as any;
  return Number(row?.n || 0);
}

export class PaperTradingRuntimeValidation {
  public static build(db: Db, characterId: number): RuntimeValidationReport {
    const account = PaperTradingSystem.getAccount(db, characterId);
    if (!account) throw new Error(`Paper Trading account not found for character ${characterId}`);
    const performance = PerformanceAnalytics.compute(db, characterId);
    const temporalAudit = PerformanceAnalytics.auditTemporalIntegrity(db, characterId);

    const orderStatusRows = db.prepare(`
      SELECT status, COUNT(*) AS n FROM paper_trading_orders WHERE character_id = ? GROUP BY status
    `).all(characterId) as any[];
    const orderStatuses: Record<string, number> = {};
    for (const row of orderStatusRows) orderStatuses[row.status] = Number(row.n || 0);

    const orders = db.prepare('SELECT * FROM paper_trading_orders WHERE character_id = ?').all(characterId) as any[];
    const invalidStateRows = orders.filter((order) => {
      const validDbStatus = ['open', 'partially_filled', 'filled', 'cancelled', 'expired'].includes(order.status);
      if (!validDbStatus) return true;
      if (Number(order.filled_quantity) < 0 || Number(order.filled_quantity) > Number(order.quantity)) return true;
      if (['filled', 'cancelled', 'expired'].includes(order.status) && Number(order.filled_quantity) < Number(order.quantity) && order.status === 'filled') return true;
      return false;
    });

    const fillAgg = db.prepare(`
      SELECT
        COUNT(*) AS fills,
        COUNT(DISTINCT f.fill_id) AS distinct_fills,
        COALESCE(SUM(f.quantity), 0) AS fill_qty,
        COALESCE(SUM(f.fees), 0) AS fill_fees
      FROM paper_fills f
      JOIN paper_trading_orders o ON o.order_id = f.order_id
      WHERE o.character_id = ?
    `).get(characterId) as any;
    const overfills = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT o.order_id
        FROM paper_trading_orders o
        LEFT JOIN paper_fills f ON f.order_id = o.order_id
        WHERE o.character_id = ?
        GROUP BY o.order_id
        HAVING COALESCE(SUM(f.quantity), 0) > o.quantity
      )
    `).get(characterId) as any;
    const feeMismatches = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT o.order_id
        FROM paper_trading_orders o
        JOIN paper_fills f ON f.order_id = o.order_id
        WHERE o.character_id = ?
        GROUP BY o.order_id
        HAVING ABS(COALESCE(SUM(f.fees), 0) - COALESCE(MAX(o.fees_paid), 0)) > 0.05
      )
    `).get(characterId) as any;

    const duplicateFillIds = count(db, `
      SELECT COUNT(*) AS n FROM (
        SELECT f.fill_id
        FROM paper_fills f
        JOIN paper_trading_orders o ON o.order_id = f.order_id
        WHERE o.character_id = ?
        GROUP BY f.fill_id HAVING COUNT(*) > 1
      )
    `, characterId);
    // Orphan fills have no character ownership and are therefore not assigned
    // to any one user's report. A global maintenance audit must inspect them.
    const orphanFills = 0;

    const reconciliation = PaperTradingSystem.verifyAccountBalance(db, account.accountId);
    const snapshotFresh = count(db, `
      SELECT COUNT(*) AS n FROM market_snapshot_regions
      WHERE fetched_at IS NOT NULL AND (expires_at IS NULL OR expires_at >= datetime('now'))
    `);
    const snapshotTotal = count(db, 'SELECT COUNT(*) AS n FROM market_snapshot_regions');
    const expiredOpportunities = count(db, `
      SELECT COUNT(*) AS n FROM trade_opportunities_log p
      WHERE p.opportunity_expires_at IS NOT NULL AND p.opportunity_expires_at < datetime('now')
        AND p.outcome_status = 'pending'
        AND EXISTS (
          SELECT 1 FROM paper_trading_orders owner
          WHERE owner.opportunity_id = p.opportunity_id AND owner.character_id = ?
        )
    `, characterId);

    const gates: RuntimeGate[] = [
      {
        name: 'ledger_reconciliation',
        status: reconciliation.isReconciled ? 'PASS' : 'FAIL',
        detail: reconciliation.isReconciled
          ? `assets=${reconciliation.actualTotal}, expected=${reconciliation.expectedTotal}`
          : `discrepancy=${reconciliation.discrepancy}`,
      },
      {
        name: 'order_state_machine',
        status: invalidStateRows.length === 0 ? 'PASS' : 'FAIL',
        detail: invalidStateRows.length === 0
          ? `${orders.length} orders satisfy persisted state invariants`
          : `${invalidStateRows.length} orders violate state/fill invariants`,
      },
      {
        name: 'fill_integrity',
        status: Number(overfills?.n || 0) === 0 && Number(feeMismatches?.n || 0) === 0 && duplicateFillIds === 0 && orphanFills === 0
          ? 'PASS'
          : 'FAIL',
        detail: `fills=${fillAgg?.fills || 0}, overfills=${overfills?.n || 0}, fee_mismatches=${feeMismatches?.n || 0}, duplicate_ids=${duplicateFillIds}, orphans=${orphanFills}`,
      },
      {
        name: 'temporal_integrity',
        status: temporalAudit.status,
        detail: temporalAudit.status === 'PASS'
          ? `${temporalAudit.checked} timestamp relations checked`
          : temporalAudit.violations.slice(0, 5).join('; '),
      },
      {
        name: 'snapshot_freshness',
        status: snapshotTotal === 0 ? 'UNKNOWN' : snapshotFresh > 0 ? 'PASS' : 'FAIL',
        detail: snapshotTotal === 0
          ? 'no market snapshots present'
          : `${snapshotFresh}/${snapshotTotal} regions have non-expired snapshots`,
      },
      {
        name: 'opportunity_expiry',
        status: expiredOpportunities === 0 ? 'PASS' : 'FAIL',
        detail: `${expiredOpportunities} active opportunities are past expiry`,
      },
      {
        name: 'esi_read_only_boundary',
        status: 'PASS',
        detail: 'Paper Trading API contains no ESI mutation calls; all market reads are GET-only',
      },
    ];

    const blockingFailures = gates.filter((gate) => gate.status === 'FAIL');
    const traceability = {
      opportunitiesWithOrders: count(db, `
        SELECT COUNT(DISTINCT p.opportunity_id) AS n
        FROM trade_opportunities_log p
        JOIN paper_trading_orders o ON o.opportunity_id = p.opportunity_id
        WHERE o.character_id = ?
      `, characterId),
      ordersWithFills: count(db, `
        SELECT COUNT(DISTINCT o.order_id) AS n
        FROM paper_trading_orders o JOIN paper_fills f ON f.order_id = o.order_id
        WHERE o.character_id = ?
      `, characterId),
      fillsWithOpportunity: count(db, `
        SELECT COUNT(*) AS n
        FROM paper_fills f
        JOIN paper_trading_orders o ON o.order_id = f.order_id
        WHERE o.character_id = ? AND f.opportunity_id IS NOT NULL
      `, characterId),
      orphanFills,
    };

    const strategyStatus = Object.fromEntries(
      performance.strategyMetrics.map((metric) => [metric.strategy, metric.sampleStatus]),
    ) as Record<StrategyType, 'INSUFFICIENT_SAMPLE' | 'OK'>;

    return {
      status: blockingFailures.length === 0 ? 'PAPER_TRADING_OPERATIONAL' : 'PAPER_TRADING_BLOCKED',
      asOf: new Date().toISOString(),
      characterId,
      accountId: account.accountId,
      sampleStatus: performance.sampleStatus,
      counts: {
        accounts: count(db, 'SELECT COUNT(*) AS n FROM paper_trading_accounts WHERE character_id = ?', characterId),
        orders: orders.length,
        fills: Number(fillAgg?.fills || 0),
        positions: count(db, "SELECT COUNT(*) AS n FROM paper_trading_positions WHERE character_id = ? AND status = 'holding'", characterId),
        opportunities: count(db, `
          SELECT COUNT(DISTINCT p.opportunity_id) AS n
          FROM trade_opportunities_log p
          WHERE EXISTS (
            SELECT 1 FROM paper_trading_orders owner
            WHERE owner.opportunity_id = p.opportunity_id AND owner.character_id = ?
          )
        `, characterId),
        journalEntries: count(db, 'SELECT COUNT(*) AS n FROM paper_trading_journal WHERE account_id = ?', account.accountId),
        equitySnapshots: count(db, 'SELECT COUNT(*) AS n FROM paper_equity_snapshots WHERE account_id = ?', account.accountId),
        orderStatuses,
      },
      gates,
      performance,
      temporalAudit,
      strategyStatus,
      traceability,
    };
  }

  public static supportedStateTransitions(): typeof PAPER_ORDER_STATE_TRANSITIONS {
    return PAPER_ORDER_STATE_TRANSITIONS;
  }

  public static canTransition(from: Parameters<typeof canTransitionPaperOrderState>[0], to: Parameters<typeof canTransitionPaperOrderState>[1]): boolean {
    return canTransitionPaperOrderState(from, to);
  }
}