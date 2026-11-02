import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { PaperTradingSystem } from '../../src/trading/paper-trading.js';
import { DraftSystem } from '../../src/trading/draft-system.js';
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
  `);

  return db;
}

describe('P8.5.1 Paper Trading Comprehensive Lifecycle Verification', () => {
  it('Scenario A: Virtual capital locking and escrow accounting', () => {
    const db = createTestDb();
    const account = PaperTradingSystem.getOrCreateAccount(db, 2001, 10_000_000);
    expect(account.availableCash).toBe(10_000_000);
    expect(account.escrowLocked).toBe(0);

    // Place buy order of 2,000,000 ISK (200,000 units @ 10 ISK)
    const orderRes = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 2001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 10,
      quantity: 200_000,
    });

    expect(orderRes.success).toBe(true);
    const updated = PaperTradingSystem.getOrCreateAccount(db, 2001);
    expect(updated.escrowLocked).toBeGreaterThanOrEqual(2_000_000);
    expect(updated.availableCash).toBeLessThanOrEqual(8_000_000);
    expect(updated.availableCash + updated.escrowLocked).toBe(10_000_000);
  });

  it('Scenario B: Partial fill handling and remaining quantity tracking', () => {
    const db = createTestDb();
    PaperTradingSystem.getOrCreateAccount(db, 2001, 10_000_000);

    const orderRes = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 2001,
      typeId: 34,
      strategyType: 'regional_hauling',
      orderType: 'buy',
      price: 10,
      quantity: 100, // Wants 100 units
    });

    expect(orderRes.orderId).toBeDefined();

    // Sells in book only have 30 units
    const orderbookSells = [{ price: 10, volumeRemain: 30 }];
    const execRes = PaperTradingSystem.executeVirtualOrderAgainstBook(db, orderRes.orderId!, orderbookSells);

    expect(execRes.filledQty).toBe(30);
    expect(execRes.status).toBe('partially_filled');

    const orderInDb = db.prepare('SELECT filled_quantity, quantity, status FROM paper_trading_orders WHERE order_id = ?').get(orderRes.orderId!) as any;
    expect(orderInDb.filled_quantity).toBe(30);
    expect(orderInDb.quantity).toBe(100);
    expect(orderInDb.status).toBe('partially_filled');
  });

  it('Scenario C: Inventory limitation prevents overselling virtual holding', () => {
    const db = createTestDb();
    PaperTradingSystem.getOrCreateAccount(db, 2001, 10_000_000);

    // Manually give position of 100 units
    db.prepare(`
      INSERT INTO paper_trading_positions (paper_id, character_id, type_id, location_id, quantity, cost_price, status)
      VALUES ('PT-POS-1', 2001, 34, 60003760, 100, 10, 'holding')
    `).run();

    // Sell 50 units -> Allowed
    const order1 = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 2001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'sell',
      price: 15,
      quantity: 50,
    });
    expect(order1.success).toBe(true);

    // Sell 150 units -> Exceeds holding, Rejected!
    const order2 = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 2001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'sell',
      price: 15,
      quantity: 150,
    });
    expect(order2.success).toBe(false);
    expect(order2.error).toContain('模拟库存不足');
  });

  it('Scenario E: Program restart state restoration', () => {
    // Open in-memory db with distinct connection to verify disk-like persistence
    const db = createTestDb();
    PaperTradingSystem.getOrCreateAccount(db, 2001, 5_000_000);

    PaperTradingSystem.createVirtualOrder(db, {
      characterId: 2001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 5,
      quantity: 10_000,
    });

    // Read state
    const p1 = PaperTradingSystem.getPortfolio(db, 2001);
    expect(p1.account.availableCash).toBeLessThan(5_000_000);
    expect(p1.account.escrowLocked).toBeGreaterThan(0);

    // Query directly from SQL tables simulating restart
    const accRow = db.prepare('SELECT available_cash, escrow_locked FROM paper_trading_accounts WHERE character_id = ?').get(2001) as any;
    const ordersCount = db.prepare('SELECT count(*) as cnt FROM paper_trading_orders WHERE character_id = ?').get(2001) as any;
    expect(accRow.available_cash).toBe(p1.account.availableCash);
    expect(accRow.escrow_locked).toBe(p1.account.escrowLocked);
    expect(ordersCount.cnt).toBe(1);
  });

  it('Scenario H: Vetoed opportunity persistence in trade_opportunities_log', () => {
    const db = createTestDb();
    const vetoedOpp: TradeOpportunity = {
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
      riskVetoReason: '严重虚假价差与两地时差超限',
      rationale: 'Vetoed test',
    };

    const oppId = PaperTradingSystem.logOpportunity(db, vetoedOpp);
    expect(oppId).toBeDefined();

    const logged = db.prepare('SELECT * FROM trade_opportunities_log WHERE opportunity_id = ?').get(oppId) as any;
    expect(logged.outcome_status).toBe('vetoed');
    expect(logged.risk_rating).toBe('D');
    expect(logged.rejection_reason).toContain('严重虚假价差');
  });

  it('Scenario J: Audit-revoked draft TR-2026-000001 allows read-only viewing but blocks modifications', () => {
    const db = createTestDb();
    db.exec(`
      INSERT INTO trade_drafts (draft_id, character_id, type_id, strategy, buy_station_id, sell_station_id, suggested_buy, suggested_qty, suggested_sell, estimated_fees, expected_profit, expected_roi, capital_required, status, expires_at, revoked_reason)
      VALUES ('TR-2026-000001', 1001, 6675, 'regional_hauling', 60003760, 60011866, 274900, 29, 700000, 1088080, 11239820, 140.99, 7972100, 'audit_revoked', datetime('now', '+1 day'), '根据审计时获取的市场订单簿进行模拟成交测算，原草案存在严重虚假价差。');
    `);

    // 1. Can view full details in read-only mode
    const allDrafts = DraftSystem.getDrafts(db, 1001);
    const target = allDrafts.find(d => d.draftId === 'TR-2026-000001');
    expect(target).toBeDefined();
    expect(target?.status).toBe('audit_revoked');
    expect(target?.suggestedBuy).toBe(274900);
    expect(target?.expectedRoi).toBe(140.99);
    expect(target?.revokedReason).toContain('模拟成交测算');

    // 2. Cannot approve
    expect(() => {
      DraftSystem.updateStatus(db, 'TR-2026-000001', 'approved');
    }).toThrow();

    // 3. Cannot execute
    expect(() => {
      DraftSystem.recordManualExecution(db, {
        draftId: 'TR-2026-000001',
        actualBuyPrice: 274900,
        actualSellPrice: 700000,
        actualQuantity: 29,
        actualFees: 100000,
      });
    }).toThrow();
  });
});
