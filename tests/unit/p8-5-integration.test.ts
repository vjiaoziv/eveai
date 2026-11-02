import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { DataCenter } from '../../src/trading/data-center.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS } from '../../src/trading/fee-engine.js';
import { OrderBookSimulator } from '../../src/trading/orderbook-simulator.js';
import { TradingPipeline } from '../../src/trading/trading-pipeline.js';
import { PortfolioManager } from '../../src/trading/portfolio-manager.js';
import { DraftSystem } from '../../src/trading/draft-system.js';
import { BacktestingEngine } from '../../src/trading/backtesting/engine.js';
import { runMigrations } from '../../src/db/migrations.js';

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

    INSERT INTO character_wallet (character_id, balance, synced_at)
    VALUES (1001, 100000000, datetime('now'));
  `);

  return db;
}

describe('EVEAI P8.5 Comprehensive Integration Test Suite', () => {
  it('Case A: Orderbook multi-level walk dynamically finds optimal profitable quantity', () => {
    // Jita sells: 2 @ 100, 10 @ 105, 20 @ 120
    // Dodixie buys: 2 @ 150, 5 @ 140, 10 @ 110 (110 * 0.94975 = 104.47 < 105 buy cost -> marginal loss!)
    const jitaSells = [
      { price: 100, volumeRemain: 2 },
      { price: 105, volumeRemain: 10 },
      { price: 120, volumeRemain: 20 },
    ];
    const dodixieBuys = [
      { price: 150, volumeRemain: 2 },
      { price: 140, volumeRemain: 5 },
      { price: 110, volumeRemain: 10 },
    ];

    const feeCtx = {
      clone: 'alpha' as const,
      skills: ALPHA_DEFAULT_SKILLS,
      facility: 'npc_station' as const,
    };

    const res = OrderBookSimulator.findOptimalProfitableQuantity({
      originSells: jitaSells,
      destBuys: dodixieBuys,
      maxAllowedQty: 20,
      feeCtx,
      minNetMarginPct: 5.0,
    });

    // Units 1-2 sell @ 150 (cost 100) -> profitable
    // Units 3-7 sell @ 140 (cost 105) -> profitable (140 * 0.94975 = 132.96 > 105)
    // Units 8+ sell @ 110 (cost 105) -> net 104.47 < 105 -> marginal loss!
    // Therefore, optimal quantity must be exactly 7 (NOT 2 and NOT 20)!
    expect(res.optimalQuantity).toBe(7);
    expect(res.buySim.weightedAvgPrice).toBeCloseTo(103.57, 1);
    expect(res.sellSim.weightedAvgPrice).toBeCloseTo(142.86, 1);
    expect(res.effectiveNetMarginPct).toBeGreaterThan(20);
    expect(res.isDepthConstrained).toBe(true);
  });

  it('Case B: Validates synchronization when order issued differs by 24h but snapshots are synchronized', () => {
    const db = createTestDb();
    const now = new Date();
    const fetchedTimeOrigin = now.toISOString();
    const fetchedTimeDest = new Date(now.getTime() - 60_000).toISOString(); // 1 minute difference

    // Record snapshot regions metadata
    db.exec(`
      INSERT INTO market_snapshot_regions (region_id, pages, rows_loaded, fetched_at, expires_at)
      VALUES (10000002, 100, 10000, '${fetchedTimeOrigin}', datetime('now', '+5 minutes')),
             (10000032, 50, 5000, '${fetchedTimeDest}', datetime('now', '+5 minutes'));
    `);

    const quality = DataCenter.validateTemporalConsistency(db, 10000002, 10000032, 15);
    expect(quality.isStale).toBe(false);
    expect(quality.timestampSkewMinutes).toBeLessThanOrEqual(1);
  });

  it('Case C: Flags data as stale when order issued is identical but snapshot is 2 hours old', () => {
    const db = createTestDb();
    const twoHoursAgo = new Date(Date.now() - 7200_000).toISOString();

    db.exec(`
      INSERT INTO market_snapshot_regions (region_id, pages, rows_loaded, fetched_at, expires_at)
      VALUES (10000002, 100, 10000, '${twoHoursAgo}', datetime('now', '-1 hour')),
             (10000032, 50, 5000, '${twoHoursAgo}', datetime('now', '-1 hour'));
    `);

    const quality = DataCenter.validateTemporalConsistency(db, 10000002, 10000032, 15);
    expect(quality.isStale).toBe(true);
    expect(quality.originSnapshotAgeMinutes).toBeGreaterThanOrEqual(119);
  });

  it('Case D: Backtest strictly enforces time-causality (no lookahead leakage)', () => {
    const db = createTestDb();
    // Seed 25 days of price series
    const baseDate = new Date('2026-10-01');
    for (let i = 0; i < 25; i++) {
      const d = new Date(baseDate.getTime() + i * 86400 * 1000).toISOString().slice(0, 10);
      const price = 100 + Math.sin(i) * 15;
      db.prepare(`
        INSERT INTO market_price_history (region_id, type_id, date, order_count, volume, highest, average, lowest)
        VALUES (10000002, 34, ?, 100, 10000, ?, ?, ?)
      `).run(d, price + 5, price, price - 5);
    }

    const summary = BacktestingEngine.runHistoricalBacktest(db, {
      strategyName: 'causal_momentum_test',
      regionId: 10000002,
      typeIds: [34],
      initialCapital: 10_000_000,
      slippageFriction: 0.015,
    });

    expect(summary.simulationType).toBe('daily_signal_backtest');
    expect(summary.slippageModel).toBe('simplified_1.5pct_friction');

    for (const trade of summary.trades) {
      // Signal date must precede entry date
      expect(new Date(trade.signalDate).getTime()).toBeLessThan(new Date(trade.entryDate).getTime());
      // Entry date must precede exit date
      expect(new Date(trade.entryDate).getTime()).toBeLessThan(new Date(trade.exitDate).getTime());
    }
  });

  it('Case E: Inventory valuation walks discrete buy orders and isolates BPCs', () => {
    const db = createTestDb();
    // Character holds 100 Tritanium in Jita 4-4, plus a BPC
    db.exec(`
      INSERT INTO character_assets (character_id, item_id, type_id, location_id, location_flag, quantity, is_blueprint_copy, data_json, synced_at)
      VALUES (1001, 8801, 34, 60003760, 'Hangar', 100, 0, '{}', datetime('now')),
             (1001, 8802, 6675, 60003760, 'Hangar', 1, 1, '{"is_blueprint_copy":true}', datetime('now'));

      -- Jita buy order has only 10 units @ 5.0 ISK, rest has no buy orders
      INSERT INTO market_orders (order_id, type_id, region_id, system_id, location_id, is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued)
      VALUES (1, 34, 10000002, 30000142, 60003760, 1, 5.0, 10, 10, 1, 90, 'station', datetime('now'));
    `);

    const breakdown = PortfolioManager.getCapitalBreakdown(db, 1001);
    // BPC must be isolated in specialAssetsCount
    expect(breakdown.specialAssetsCount).toBe(1);

    // Liquid inventory: only 10 units can be sold @ 5.0 ISK = 50 ISK gross * (1 - 0.05025) = 47.49 ISK
    expect(breakdown.liquidInventoryValue).toBeCloseTo(47.49, 1);

    // Remaining 90 units have no buy orders, valued at base price 2 ISK = 180 ISK illiquid
    expect(breakdown.illiquidInventoryValue).toBe(180);
  });

  it('Case F: Audit-revoked draft TR-2026-000001 cannot be re-approved or executed in any business layer', () => {
    const db = createTestDb();

    // Seed TR-2026-000001 as audit_revoked
    db.exec(`
      INSERT INTO trade_drafts (draft_id, character_id, type_id, strategy, buy_station_id, sell_station_id, suggested_buy, suggested_qty, suggested_sell, estimated_fees, expected_profit, expected_roi, capital_required, status, expires_at, revoked_reason)
      VALUES ('TR-2026-000001', 1001, 6675, 'regional_hauling', 60003760, 60011866, 274900, 29, 700000, 1088080, 11239820, 140.99, 7972100, 'audit_revoked', datetime('now', '+1 day'), 'Revoked by independent audit: phantom spread');
    `);

    // 1. Re-approval attempt must throw
    expect(() => {
      DraftSystem.updateStatus(db, 'TR-2026-000001', 'approved');
    }).toThrow(/已被第二轮独立审计永久撤销/);

    // 2. Manual execution attempt must throw
    expect(() => {
      DraftSystem.recordManualExecution(db, {
        draftId: 'TR-2026-000001',
        actualBuyPrice: 274900,
        actualSellPrice: 700000,
        actualQuantity: 29,
        actualFees: 100000,
      });
    }).toThrow(/已被独立审计撤销/);

    // 3. Draft listing must not return it under active status
    const activeDrafts = DraftSystem.getDrafts(db, 1001, 'active');
    expect(activeDrafts.find(d => d.draftId === 'TR-2026-000001')).toBeUndefined();
  });
});
