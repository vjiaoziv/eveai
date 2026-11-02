import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { PaperTradingSystem } from '../../src/trading/paper-trading.js';
import { PerformanceAnalytics } from '../../src/trading/performance-analytics.js';
import { PaperTradingRuntimeValidation } from '../../src/trading/runtime-validation.js';
import type { TradeOpportunity } from '../../src/trading/types.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

const baseOpportunity: TradeOpportunity = {
  opportunityId: 'OPP-P87-PERF-1',
  typeId: 34,
  typeName: 'Tritanium',
  volumeM3: 0.01,
  strategy: 'station_arbitrage',
  buyStationId: 60003760,
  buyStationName: 'Jita',
  sellStationId: 60003760,
  sellStationName: 'Jita',
  buyRegionId: 10000002,
  sellRegionId: 10000002,
  buySnapshotId: 'MSNAP-BUY-1',
  sellSnapshotId: 'MSNAP-SELL-1',
  buySnapshotTimestamp: '2026-11-02T00:00:00.000Z',
  sellSnapshotTimestamp: '2026-11-02T00:01:00.000Z',
  feeModelVersion: 'eveai-fee-v1',
  detectedAt: '2026-11-02T00:02:00.000Z',
  expiresAt: '2026-11-03T01:00:00.000Z',
  suggestedBuyPrice: 10,
  suggestedSellPrice: 12,
  suggestedQuantity: 100,
  executableQuantity: 80,
  capitalRequired: 1_000_000,
  estimatedFees: 106_500,
  haulingCost: 0,
  expectedNetProfit: 93_500,
  expectedRoiPct: 9.35,
  theoreticalGrossProfit: 200_000,
  executableGrossProfit: 160_000,
  feeNetProfit: 93_500,
  comprehensiveNetProfit: null,
  comprehensiveNetProfitStatus: 'UNKNOWN',
  unknownCosts: ['capital_carry', 'inventory_carry'],
  dailyVolumeDest: 100,
  turnoverDays: 1,
  liquidityRating: 'A',
  riskScore: 1,
  opportunityRating: 'A',
  rationale: 'test',
};

describe('P8.7 unified opportunity and independent performance accounting', () => {
  it('persists both snapshots and four profit layers without inventing comprehensive profit', () => {
    const db = createDb();
    const id = PaperTradingSystem.logOpportunity(db, baseOpportunity);
    expect(id).toBe('OPP-P87-PERF-1');

    const row = db.prepare('SELECT * FROM trade_opportunities_log WHERE opportunity_id = ?').get(id) as any;
    expect(row.buy_location_id).toBe(60003760);
    expect(row.sell_location_id).toBe(60003760);
    expect(row.buy_snapshot_id).toBe('MSNAP-BUY-1');
    expect(row.sell_snapshot_id).toBe('MSNAP-SELL-1');
    expect(row.executable_quantity).toBe(80);
    expect(row.theoretical_gross_profit).toBe(200_000);
    expect(row.executable_gross_profit).toBe(160_000);
    expect(row.fee_net_profit).toBe(93_500);
    expect(row.comprehensive_net_profit).toBeNull();
    expect(row.comprehensive_net_profit_status).toBe('UNKNOWN');
    expect(row.capital_required).toBe(1_000_000);
    expect(row.logistics_cost).toBe(0);

    const layers = JSON.parse(row.profit_layers_json);
    expect(layers.unknownCosts).toEqual(['capital_carry', 'inventory_carry']);
    db.close();
  });

  it('independently recomputes buy/sell ledger, FIFO exits and depth-limited valuation', () => {
    const db = createDb();
    PaperTradingSystem.getOrCreateAccount(db, 9001, 10_000_000);
    PaperTradingSystem.logOpportunity(db, baseOpportunity);

    const buy = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 9001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 10,
      quantity: 100,
      opportunityId: baseOpportunity.opportunityId,
      snapshotId: 'MSNAP-BUY-1',
    });
    expect(buy.success).toBe(true);
    const buyFill = PaperTradingSystem.executeVirtualOrderAgainstBook(db, buy.orderId!, [
      { price: 10, volumeRemain: 100 },
    ]);
    expect(buyFill.status).toBe('filled');

    // Depth is intentionally insufficient for the whole position: 50 @ 10, 50 @ 9.
    db.prepare(`
      INSERT INTO market_orders
        (order_id, type_id, region_id, system_id, station_id, location_id, is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued)
      VALUES (900101, 34, 10000002, 30000142, 60003760, 60003760, 1, 10, 50, 50, 1, 90, 'station', datetime('now')),
             (900102, 34, 10000002, 30000142, 60003760, 60003760, 1, 9, 50, 50, 1, 90, 'station', datetime('now'))
    `).run();

    const preSell = PerformanceAnalytics.compute(db, 9001);
    expect(preSell.inventoryCost).toBe(1_000);
    // 50*10 + 50*9 = 950 gross; haircut 7.125% => 882.3125
    expect(preSell.inventoryMarketValue).toBe(882.31);
    expect(preSell.unrealizedPnl).toBe(-117.69);
    expect(preSell.sampleStatus).toBe('INSUFFICIENT_SAMPLE');
    expect(preSell.fillRatePct).toBe(100);
    expect(preSell.netReturnPct).not.toBeNull();

    const sell = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 9001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'sell',
      price: 12,
      quantity: 100,
      opportunityId: baseOpportunity.opportunityId,
      snapshotId: 'MSNAP-SELL-1',
    });
    expect(sell.success).toBe(true);
    const sellFill = PaperTradingSystem.executeVirtualOrderAgainstBook(db, sell.orderId!, [
      { price: 12, volumeRemain: 100 },
    ]);
    expect(sellFill.status).toBe('filled');

    const exits = db.prepare('SELECT COUNT(*) AS n, SUM(gross_pnl) AS gross FROM paper_position_exits').get() as any;
    expect(exits.n).toBe(1);
    expect(exits.gross).toBe(200);

    const reconciliation = PaperTradingSystem.verifyAccountBalance(db, 'PT-ACC-9001');
    expect(reconciliation.isReconciled).toBe(true);
    expect(reconciliation.discrepancy).toBe(0);

    const performance = PerformanceAnalytics.compute(db, 9001);
    expect(performance.realizedGrossPnl).toBe(200);
    expect(performance.feesPaid).toBe(106.5);
    expect(performance.realizedNetPnl).toBe(93.5);
    expect(performance.unrealizedPnl).toBe(0);
    expect(performance.inventoryCost).toBe(0);
    expect(performance.equitySeries.length).toBeGreaterThanOrEqual(2);
    expect(performance.maxDrawdownPct).not.toBeNull();

    const validation = PaperTradingRuntimeValidation.build(db, 9001);
    expect(validation.status).toBe('PAPER_TRADING_OPERATIONAL');
    expect(validation.sampleStatus).toBe('INSUFFICIENT_SAMPLE');
    expect(validation.strategyStatus.station_arbitrage).toBe('INSUFFICIENT_SAMPLE');
    expect(validation.traceability.fillsWithOpportunity).toBeGreaterThan(0);
    expect(validation.gates.find((gate) => gate.name === 'ledger_reconciliation')?.status).toBe('PASS');
    db.close();
  });

  it('rejects persisted backtest trades whose signal uses future entry data', () => {
    const db = createDb();
    db.prepare(`
      INSERT INTO backtest_runs
        (run_id, strategy_name, time_horizon, initial_capital, final_capital, total_roi_pct, max_drawdown_pct, win_rate_pct, trade_count, fee_drag_pct, metrics_json)
      VALUES ('BT-BAD', 'trend', 'daily', 1000, 1000, 0, 0, 0, 1, 0, '{"trades":[{"signalDate":"2026-01-02","entryDate":"2026-01-01","exitDate":"2026-01-03"}]}')
    `).run();
    const audit = PerformanceAnalytics.auditTemporalIntegrity(db);
    expect(audit.status).toBe('FAIL');
    expect(audit.violations.join(' ')).toContain('signal is not strictly before entry');
    db.close();
  });

  it('returns N/A (null) instead of fake zero rates and detects timestamp travel', () => {
    const db = createDb();
    PaperTradingSystem.getOrCreateAccount(db, 9002, 10_000_000);
    const empty = PerformanceAnalytics.compute(db, 9002);
    expect(empty.fillRatePct).toBeNull();
    expect(empty.opportunityRealizationRatePct).toBeNull();
    expect(empty.netReturnPct).toBe(0);
    expect(empty.sampleStatus).toBe('INSUFFICIENT_SAMPLE');
    expect(PaperTradingRuntimeValidation.build(db, 9002).status).toBe('PAPER_TRADING_OPERATIONAL');

    const order = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 9002,
      typeId: 34,
      strategyType: 'trend_following',
      orderType: 'buy',
      price: 10,
      quantity: 10,
    });
    PaperTradingSystem.executeVirtualOrderAgainstBook(db, order.orderId!, [{ price: 10, volumeRemain: 10 }]);
    db.prepare(`
      UPDATE paper_fills
      SET filled_at = datetime('now', '-1 hour')
      WHERE order_id = ?
    `).run(order.orderId);

    const audit = PerformanceAnalytics.auditTemporalIntegrity(db);
    expect(audit.status).toBe('FAIL');
    expect(audit.violations.join(' ')).toContain('predates order submission');
    db.close();
  });
});