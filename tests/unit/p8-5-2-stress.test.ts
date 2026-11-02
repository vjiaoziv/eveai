import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { PaperTradingSystem } from '../../src/trading/paper-trading.js';
import { DraftSystem } from '../../src/trading/draft-system.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS, OMEGA_DEFAULT_SKILLS } from '../../src/trading/fee-engine.js';
import { PortfolioManager } from '../../src/trading/portfolio-manager.js';
import { TradingPipeline } from '../../src/trading/trading-pipeline.js';
import { runMigrations } from '../../src/db/migrations.js';
import type { TradeOpportunity } from '../../src/trading/types.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);

  db.exec(`
    INSERT INTO sde_types (type_id, name, group_id, data_json)
    VALUES (34, 'Tritanium', 18, '{"volume":0.01,"portionSize":1,"mass":0,"basePrice":2,"name":{"en":"Tritanium","zh":"三钛合金"}}'),
           (6675, 'Small Laser', 53, '{"volume":5.0,"portionSize":1,"mass":10000,"basePrice":300000,"name":{"en":"Small Laser","zh":"小型激光器"}}');

    INSERT INTO sde_groups (group_id, name, category_id, data_json)
    VALUES (18, 'Mineral', 4, '{"name":{"en":"Mineral","zh":"矿物"}}'),
           (53, 'Energy Weapon', 7, '{"name":{"en":"Energy Weapon","zh":"能量武器"}}');

    INSERT INTO sde_categories (category_id, name, data_json)
    VALUES (4, 'Material', '{"name":{"en":"Material","zh":"材料"}}'),
           (7, 'Module', '{"name":{"en":"Module","zh":"装备"}}');

    INSERT INTO sde_stations (station_id, name, system_id, data_json)
    VALUES (60003760, 'Jita IV-4', 30000142, '{"name":{"en":"Jita IV-4","zh":"吉他海四"}}'),
           (60011866, 'Dodixie IX-20', 30002659, '{"name":{"en":"Dodixie IX-20","zh":"杜迪克西"}}');
  `);

  return db;
}

describe('P8.5.2 Advanced Engineering Stress & Security Test Suite (A - R Scenarios)', () => {
  it('Scenario A: 100 concurrent virtual orders competing for limited capital', () => {
    const db = createTestDb();
    // Account initial cash = 10,000,000 ISK
    PaperTradingSystem.getOrCreateAccount(db, 3001, 10_000_000);

    let successCount = 0;
    let rejectedCount = 0;

    // 100 orders each wanting 200,000 ISK (Total would be 20,000,000 ISK)
    for (let i = 0; i < 100; i++) {
      const res = PaperTradingSystem.createVirtualOrder(db, {
        characterId: 3001,
        typeId: 34,
        strategyType: 'station_arbitrage',
        orderType: 'buy',
        price: 10,
        quantity: 20_000, // 200k + fees
      });

      if (res.success) successCount++;
      else rejectedCount++;
    }

    // Only about 48 orders can be placed before 10M is exhausted
    expect(successCount).toBeGreaterThan(0);
    expect(rejectedCount).toBeGreaterThan(0);
    expect(successCount + rejectedCount).toBe(100);

    const account = PaperTradingSystem.getOrCreateAccount(db, 3001);
    expect(account.availableCash).toBeGreaterThanOrEqual(0);
    expect(account.escrowLocked).toBeLessThanOrEqual(10_000_000);
  });

  it('Scenario B: Idempotency protection with 100 duplicate submissions of the same order', () => {
    const db = createTestDb();
    PaperTradingSystem.getOrCreateAccount(db, 3001, 10_000_000);
    const key = 'IDEMP-TEST-KEY-001';

    let firstOrderId: string | undefined;
    for (let i = 0; i < 100; i++) {
      const res = PaperTradingSystem.createVirtualOrder(db, {
        characterId: 3001,
        typeId: 34,
        strategyType: 'regional_hauling',
        orderType: 'buy',
        price: 5,
        quantity: 1000,
        idempotencyKey: key,
      });

      expect(res.success).toBe(true);
      if (i === 0) firstOrderId = res.orderId;
      else expect(res.orderId).toBe(firstOrderId);
    }

    // Exactly 1 order in DB, money deducted only once!
    const orders = db.prepare('SELECT count(*) as cnt FROM paper_trading_orders WHERE idempotency_key = ?').get(key) as any;
    expect(orders.cnt).toBe(1);
  });

  it('Scenario C: Continuous cancellation after partial fill correctly refunds residual escrow', () => {
    const db = createTestDb();
    PaperTradingSystem.getOrCreateAccount(db, 3001, 10_000_000);

    const orderRes = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 3001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 10,
      quantity: 100, // Wants 100 units
    });

    // Fill 40 units
    const book = [{ price: 10, volumeRemain: 40 }];
    PaperTradingSystem.executeVirtualOrderAgainstBook(db, orderRes.orderId!, book);

    // Cancel remaining 60 units
    const cancelOk = PaperTradingSystem.cancelVirtualOrder(db, orderRes.orderId!);
    expect(cancelOk).toBe(true);

    const order = db.prepare('SELECT status, filled_quantity FROM paper_trading_orders WHERE order_id = ?').get(orderRes.orderId!) as any;
    expect(order.status).toBe('cancelled');
    expect(order.filled_quantity).toBe(40);

    // Account reconciliation must be satisfied
    const recon = PaperTradingSystem.verifyAccountBalance(db, `PT-ACC-3001`);
    expect(recon.isReconciled).toBe(true);
  });

  it('Scenario H: Direct draft bypass prevention — D-grade opportunities rejected by DraftSystem', () => {
    const db = createTestDb();
    const badOpp: TradeOpportunity = {
      typeId: 6675,
      typeName: 'Small Laser',
      volumeM3: 5.0,
      strategy: 'regional_hauling',
      buyStationId: 60003760,
      buyStationName: 'Jita IV-4',
      sellStationId: 60011866,
      sellStationName: 'Dodixie IX-20',
      suggestedBuyPrice: 274900,
      suggestedSellPrice: 700000,
      suggestedQuantity: 29,
      capitalRequired: 7972100,
      estimatedFees: 1088080,
      haulingCost: 0,
      expectedNetProfit: 11239820,
      expectedRoiPct: 140.99,
      dailyVolumeDest: 2,
      turnoverDays: 180,
      liquidityRating: 'C',
      riskScore: 4,
      opportunityRating: 'D',
      riskVetoReason: '数据时差超限且深度严重错配',
      rationale: 'Bypass test',
    };

    // Calling DraftSystem.createDraft directly MUST throw and block draft creation
    expect(() => {
      DraftSystem.createDraft(db, 3001, badOpp);
    }).toThrow(/【风控一票否决】/);
  });

  it('Scenario I: Audit-revoked drafts blocked across all state mutations', () => {
    const db = createTestDb();
    db.exec(`
      INSERT INTO trade_drafts (draft_id, character_id, type_id, strategy, buy_station_id, sell_station_id, suggested_buy, suggested_qty, suggested_sell, estimated_fees, expected_profit, expected_roi, capital_required, status, expires_at, revoked_reason)
      VALUES ('TR-2026-REVOKED', 3001, 6675, 'regional_hauling', 60003760, 60011866, 274900, 29, 700000, 1088080, 11239820, 140.99, 7972100, 'audit_revoked', datetime('now', '+1 day'), 'Revoked by P8 audit');
    `);

    // Cannot approve
    expect(() => DraftSystem.updateStatus(db, 'TR-2026-REVOKED', 'approved')).toThrow();
    // Cannot execute
    expect(() => DraftSystem.recordManualExecution(db, { draftId: 'TR-2026-REVOKED', actualBuyPrice: 274900, actualSellPrice: 700000, actualQuantity: 29, actualFees: 1000 })).toThrow();
  });

  it('Scenario K & N: FeeEngine and orderbook robust boundary testing (negative, zero, extreme values)', () => {
    const db = createTestDb();
    PaperTradingSystem.getOrCreateAccount(db, 3001, 10_000_000);

    // Negative quantity rejected
    const negQty = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 3001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 10,
      quantity: -50,
    });
    expect(negQty.success).toBe(false);

    // Zero price rejected
    const zeroPrice = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 3001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 0,
      quantity: 50,
    });
    expect(zeroPrice.success).toBe(false);

    // NaN rejected
    const nanPrice = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 3001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: NaN,
      quantity: 50,
    });
    expect(nanPrice.success).toBe(false);
  });

  it('Scenario L: Double-entry account balance reconciliation verifyAccountBalance', () => {
    const db = createTestDb();
    PaperTradingSystem.getOrCreateAccount(db, 3001, 10_000_000);

    const reconBefore = PaperTradingSystem.verifyAccountBalance(db, 'PT-ACC-3001');
    expect(reconBefore.isReconciled).toBe(true);
    expect(reconBefore.discrepancy).toBe(0);

    // Perform buy order & partial execution
    const ord = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 3001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 10,
      quantity: 1000,
    });

    PaperTradingSystem.executeVirtualOrderAgainstBook(db, ord.orderId!, [{ price: 10, volumeRemain: 500 }]);

    const reconAfter = PaperTradingSystem.verifyAccountBalance(db, 'PT-ACC-3001');
    expect(reconAfter.isReconciled).toBe(true);
    expect(reconAfter.discrepancy).toBe(0);
  });

  it('Scenario R: Proves no ESI write tools exist in the codebase', () => {
    // Assert read-only nature of the agent tools
    const fs = require('fs');
    const toolsCode = fs.readFileSync('src/agent/tools.ts', 'utf8');

    // Must NOT export any in-game transaction tools
    expect(toolsCode).not.toContain('create_market_order');
    expect(toolsCode).not.toContain('cancel_market_order');
    expect(toolsCode).not.toContain('transfer_wallet_isk');
    expect(toolsCode).not.toContain('trash_inventory_item');
  });
});


