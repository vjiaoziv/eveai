import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { PerformanceAnalytics } from '../../src/trading/performance-analytics.js';
import { PaperTradingSystem } from '../../src/trading/paper-trading.js';
import { PaperTradingRuntimeValidation } from '../../src/trading/runtime-validation.js';

const OWN = 910001;
const OTHER = 910002;

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedTwoRoles(db: Database.Database): void {
  const account = db.prepare(`
    INSERT INTO paper_trading_accounts
      (account_id, character_id, initial_cash, available_cash, escrow_locked, total_realized_pnl, total_fees_paid, status)
    VALUES (?, ?, ?, ?, 0, ?, ?, 'active')
  `);
  account.run(`PT-ACC-${OWN}`, OWN, 1_000, 900, 100, 10);
  account.run(`PT-ACC-${OTHER}`, OTHER, 10_000, 4_000, 5_000, 1_000);

  const opportunity = db.prepare(`
    INSERT INTO trade_opportunities_log
      (opportunity_id, strategy_type, type_id, region_id, detected_at,
       expected_buy_price, expected_sell_price, proposed_quantity, expected_fees,
       expected_net_profit, expected_roi, risk_rating, outcome_status,
       actual_simulated_pnl, prediction_variance, opportunity_expires_at)
    VALUES (?, ?, ?, 10000002, '2026-01-01 00:00:00',
            10, 12, 10, 1, 9, 1, 'A', 'simulated_filled', ?, ?, ?)
  `);
  opportunity.run('OPP-OWN', 'station_arbitrage', 34, 100, 10, '2099-01-01 00:00:00');
  opportunity.run('OPP-OTHER', 'trend_following', 35, 5_000, 9_999, '2020-01-01 00:00:00');
  opportunity.run('OPP-UNLINKED', 'market_making', 36, null, null, '2020-01-01 00:00:00');

  const order = db.prepare(`
    INSERT INTO paper_trading_orders
      (order_id, account_id, opportunity_id, character_id, type_id, strategy_type,
       order_type, price, quantity, filled_quantity, status, fees_paid, submitted_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'sell', 12, 10, 10, 'filled', ?, ?, ?, ?)
  `);
  order.run('ORDER-OWN', `PT-ACC-${OWN}`, 'OPP-OWN', OWN, 34, 'station_arbitrage', 10,
    '2026-01-02 00:00:00', '2026-01-02 00:00:00', '2026-01-02 02:00:00');
  order.run('ORDER-OTHER', `PT-ACC-${OTHER}`, 'OPP-OTHER', OTHER, 35, 'trend_following', 1_000,
    '2026-01-02 00:00:00', '2026-01-02 00:00:00', '2026-01-02 02:00:00');

  const fill = db.prepare(`
    INSERT INTO paper_fills
      (fill_id, order_id, opportunity_id, filled_at, price, quantity, fees, remaining_quantity, basis, model_version)
    VALUES (?, ?, ?, ?, 12, 10, ?, 0, 'test', 'test')
  `);
  fill.run('FILL-OWN', 'ORDER-OWN', 'OPP-OWN', '2026-01-02 01:00:00', 10);
  // This bad timestamp belongs to the other role and must not fail OWN's audit.
  fill.run('FILL-OTHER', 'ORDER-OTHER', 'OPP-OTHER', '2026-01-01 01:00:00', 1_000);

  const position = db.prepare(`
    INSERT INTO paper_trading_positions
      (paper_id, character_id, type_id, location_id, quantity, cost_price, status, strategy_type)
    VALUES (?, ?, ?, ?, 10, 100, 'holding', ?)
  `);
  position.run('POS-OWN', OWN, 34, 60003760, 'station_arbitrage');
  position.run('POS-OTHER', OTHER, 35, 60011866, 'trend_following');

  const exit = db.prepare(`
    INSERT INTO paper_position_exits
      (order_id, paper_id, character_id, type_id, quantity, cost_price, exit_price, gross_pnl)
    VALUES (?, ?, ?, ?, 10, 100, 120, ?)
  `);
  exit.run('ORDER-OWN', 'POS-OWN', OWN, 34, 100);
  exit.run('ORDER-OTHER', 'POS-OTHER', OTHER, 35, 5_000);
}

describe('Paper performance role isolation', () => {
  it('does not mix another character into performance, attribution, or runtime counts', () => {
    const db = createDb();
    seedTwoRoles(db);

    const own = PerformanceAnalytics.compute(db, OWN);
    expect(own.realizedGrossPnl).toBe(100);
    expect(own.feesPaid).toBe(10);
    expect(own.inventoryCost).toBe(1_000);
    expect(own.opportunityRealizationRatePct).toBe(100);
    expect(own.strategyMetrics.find((row) => row.strategy === 'station_arbitrage')).toMatchObject({
      totalOpportunities: 1,
      submittedOrders: 1,
      grossProfit: 100,
      fees: 10,
      inventoryOverhang: 1_000,
    });
    expect(own.strategyMetrics.find((row) => row.strategy === 'trend_following')).toMatchObject({
      totalOpportunities: 0,
      submittedOrders: 0,
      grossProfit: 0,
      inventoryOverhang: 0,
    });
    expect(own.attribution.topProfitType).toEqual({ typeId: 34, grossPnl: 100 });
    expect(own.attribution.topProfitLocation).toEqual({ locationId: 60003760, grossPnl: 100 });
    expect(own.attribution.largestPredictionVariance).toMatchObject({ opportunityId: 'OPP-OWN', variance: 10 });
    expect(own.riskFlags).not.toContain('EXPIRED_OPPORTUNITIES_PRESENT');

    const portfolio = PaperTradingSystem.getPortfolio(db, OWN);
    expect(portfolio.strategyBreakdown.find((row) => row.strategy === 'station_arbitrage')).toMatchObject({
      totalOpportunities: 1,
      executedTrades: 1,
    });
    expect(portfolio.strategyBreakdown.find((row) => row.strategy === 'trend_following')).toMatchObject({
      totalOpportunities: 0,
      executedTrades: 0,
    });

    const validation = PaperTradingRuntimeValidation.build(db, OWN);
    expect(validation.counts.opportunities).toBe(1);
    expect(validation.traceability).toMatchObject({
      opportunitiesWithOrders: 1,
      ordersWithFills: 1,
      fillsWithOpportunity: 1,
      orphanFills: 0,
    });
    expect(validation.temporalAudit.status).toBe('PASS');
    db.close();
  });

  it('does not create a paper account during a read', () => {
    const db = createDb();
    expect(() => PaperTradingSystem.getPortfolio(db, 910003)).toThrow('Paper Trading account not found');
    expect(db.prepare('SELECT COUNT(*) AS n FROM paper_trading_accounts WHERE character_id = ?').get(910003)).toEqual({ n: 0 });
    db.close();
  });
});
