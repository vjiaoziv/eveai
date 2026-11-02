import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { DataCenter } from '../../src/trading/data-center.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS } from '../../src/trading/fee-engine.js';
import { OrderBookSimulator } from '../../src/trading/orderbook-simulator.js';
import { StationArbitrageStrategy } from '../../src/trading/strategies/station-arbitrage.js';
import { RegionalHaulingStrategy, STANDARD_HIGHSEC_ROUTES } from '../../src/trading/strategies/regional-hauling.js';
import { ManufacturingArbitrageStrategy } from '../../src/trading/strategies/manufacturing-arbitrage.js';
import { PortfolioManager } from '../../src/trading/portfolio-manager.js';
import { DraftSystem } from '../../src/trading/draft-system.js';
import { BacktestingEngine } from '../../src/trading/backtesting/engine.js';
import { runMigrations } from '../../src/db/migrations.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);

  // Seed sample SDE
  db.exec(`
    INSERT INTO sde_types (type_id, name, group_id, data_json)
    VALUES (34, 'Tritanium', 18, '{"volume":0.01,"portionSize":1,"mass":0,"basePrice":2,"name":{"en":"Tritanium","zh":"三钛合金"}}'),
           (626, 'Vexor', 26, '{"volume":115000,"portionSize":1,"mass":11100000,"basePrice":8000000,"name":{"en":"Vexor","zh":"狂怒者级"}}');

    INSERT INTO sde_groups (group_id, name, category_id, data_json)
    VALUES (18, 'Mineral', 4, '{"name":{"en":"Mineral","zh":"矿物"}}'),
           (26, 'Cruiser', 6, '{"name":{"en":"Cruiser","zh":"巡洋舰"}}');

    INSERT INTO sde_categories (category_id, name, data_json)
    VALUES (4, 'Material', '{"name":{"en":"Material","zh":"材料"}}'),
           (6, 'Ship', '{"name":{"en":"Ship","zh":"舰船"}}');

    INSERT INTO sde_stations (station_id, name, system_id, data_json)
    VALUES (60003760, 'Jita IV-4', 30000142, '{"name":{"en":"Jita IV-4","zh":"吉他海四"}}'),
           (60011866, 'Dodixie IX-20', 30002659, '{"name":{"en":"Dodixie IX-20","zh":"杜迪克西"}}');

    INSERT INTO sde_type_materials (type_id, name, data_json)
    VALUES (626, 'Vexor', '{"materials":[{"materialTypeID":34,"quantity":400000}]}');
  `);

  return db;
}

describe('Trading System Comprehensive Verification', () => {
  it('DataCenter tracks data source status and SDE metadata', () => {
    const db = createTestDb();
    DataCenter.recordStatus(db, 'ccp_esi', 'ok');
    DataCenter.recordStatus(db, 'fuzzwork', 'degraded', 'Slow response');

    const statuses = DataCenter.getAllStatuses(db);
    expect(statuses.length).toBe(2);
    expect(statuses.find(s => s.source_id === 'ccp_esi')?.status).toBe('ok');
    expect(statuses.find(s => s.source_id === 'fuzzwork')?.status).toBe('degraded');

    const meta = DataCenter.getItemMetadata(db, 34);
    expect(meta?.en_name).toBe('Tritanium');
    expect(meta?.zh_name).toBe('三钛合金');
    expect(meta?.group_name).toBe('矿物');
  });

  it('StationArbitrageStrategy finds profitable spreads and assigns ratings', () => {
    const db = createTestDb();
    // Seed buy and sell orders for Tritanium at Jita 4-4
    db.exec(`
      INSERT INTO market_orders (order_id, type_id, region_id, system_id, location_id, is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued)
      VALUES (1, 34, 10000002, 30000142, 60003760, 1, 3.50, 100000, 100000, 1, 90, 'station', '2026-11-01'),
             (2, 34, 10000002, 30000142, 60003760, 0, 5.00, 100000, 100000, 1, 90, 'station', '2026-11-01');
    `);

    const opps = StationArbitrageStrategy.scan(db, {
      stationId: 60003760,
      regionId: 10000002,
      minNetMarginPct: 5.0,
      minNetProfit: 100,
      maxCapitalPerItem: 10_000_000,
    });

    expect(opps.length).toBe(1);
    const op = opps[0];
    expect(op.typeId).toBe(34);
    expect(op.suggestedBuyPrice).toBe(3.50);
    expect(op.suggestedSellPrice).toBe(5.00);
    expect(op.expectedNetProfit).toBeGreaterThan(0);
    expect(op.liquidityRating).toBe('B');
  });

  it('RegionalHaulingStrategy identifies instant and listed opportunities', () => {
    const db = createTestDb();
    // Seed Jita sell at 10 ISK, Dodixie buy at 15 ISK (Instant profit!)
    db.exec(`
      INSERT INTO market_orders (order_id, type_id, region_id, system_id, location_id, is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued)
      VALUES (1, 34, 10000002, 30000142, 60003760, 0, 10.0, 5000, 5000, 1, 90, 'station', '2026-11-01'),
             (2, 34, 10000032, 30002659, 60011866, 1, 15.0, 2000, 2000, 1, 90, 'station', '2026-11-01');
    `);

    const opps = RegionalHaulingStrategy.scan(db, {
      route: STANDARD_HIGHSEC_ROUTES[0], // Jita -> Dodixie
      mode: 'instant_fill',
      minNetMarginPct: 5.0,
      minNetProfit: 100,
      maxCapital: 50_000_000,
    });

    expect(opps.length).toBe(1);
    const op = opps[0];
    expect(op.strategy).toBe('regional_hauling');
    expect(op.suggestedQuantity).toBe(2000); // Capped by Dodixie buy order depth
    expect(op.suggestedBuyPrice).toBe(10.0);
    expect(op.suggestedSellPrice).toBe(15.0);
    expect(op.turnoverDays).toBe(0); // Instant fill upon arrival
  });

  it('ManufacturingArbitrageStrategy evaluates reprocessing mineral yield', () => {
    const db = createTestDb();
    // Vexor buy price 2M in Jita, Tritanium buy price 10 ISK
    // Reprocessing Vexor gives 400,000 * 50% = 200,000 Tritanium * 10 = 2,000,000 ISK
    db.exec(`
      INSERT INTO market_orders (order_id, type_id, region_id, system_id, location_id, is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued)
      VALUES (1, 626, 10000002, 30000142, 60003760, 1, 1500000, 1, 1, 1, 90, 'station', '2026-11-01'),
             (2, 34, 10000002, 30000142, 60003760, 1, 10, 500000, 500000, 1, 90, 'station', '2026-11-01');
    `);

    const res = ManufacturingArbitrageStrategy.analyzeReprocessing(db, 626);
    expect(res).not.toBeNull();
    expect(res?.recommendation).toBe('reprocess');
    expect(res?.totalMineralValue).toBe(2000000);
    expect(res?.netDifferenceIsk).toBeGreaterThan(0);
  });

  it('PortfolioManager enforces 20% cash reserve and 15% single item cap', () => {
    const db = createTestDb();
    // Character wallet = 100,000,000 ISK
    db.exec(`
      INSERT INTO character_wallet (character_id, balance, synced_at)
      VALUES (1001, 100000000, datetime('now'));
    `);

    const breakdown = PortfolioManager.getCapitalBreakdown(db, 1001);
    expect(breakdown.walletBalance).toBe(100_000_000);
    // 20% cash reserve
    expect(breakdown.cashReserveRequired).toBe(20_000_000);
    // Investable capital = 80M
    expect(breakdown.investableCapital).toBe(80_000_000);
    // 15% single item cap = 12M
    expect(breakdown.singleItemCapIsk).toBe(12_000_000);

    // Trade of 10M is allowed
    const valid = PortfolioManager.validateTradeRisk(breakdown, 10_000_000, 'station_arbitrage', 10);
    expect(valid.allowed).toBe(true);

    // Trade of 15M exceeds 15% single item cap
    const invalidItem = PortfolioManager.validateTradeRisk(breakdown, 15_000_000, 'station_arbitrage', 10);
    expect(invalidItem.allowed).toBe(false);
    expect(invalidItem.reason).toContain('单一物品持仓风控线');

    // Hauling trade of 60M exceeds 50M anti-gank cap
    const invalidGank = PortfolioManager.validateTradeRisk(breakdown, 60_000_000, 'regional_hauling', 500);
    expect(invalidGank.allowed).toBe(false);
    expect(invalidGank.reason).toContain('防自杀强杀风控限制');
  });

  it('DraftSystem generates sequential TR IDs and manages lifecycle', () => {
    const db = createTestDb();
    const id1 = DraftSystem.generateDraftId(db);
    expect(id1).toMatch(/^TR-\d{4}-000001$/);

    const opp: TradeOpportunity = {
      typeId: 34,
      typeName: 'Tritanium',
      zhName: '三钛合金',
      volumeM3: 0.01,
      strategy: 'station_arbitrage',
      buyStationId: 60003760,
      buyStationName: 'Jita IV-4',
      sellStationId: 60003760,
      sellStationName: 'Jita IV-4',
      suggestedBuyPrice: 3.5,
      suggestedSellPrice: 5.0,
      suggestedQuantity: 1000,
      capitalRequired: 3500,
      estimatedFees: 300,
      haulingCost: 0,
      expectedNetProfit: 1200,
      expectedRoiPct: 34.2,
      dailyVolumeDest: 10000,
      turnoverDays: 0.5,
      liquidityRating: 'A',
      riskScore: 1,
      rationale: 'Test',
    };

    const draft = DraftSystem.createDraft(db, 1001, opp);
    expect(draft.draftId).toBe(id1);
    expect(draft.status).toBe('draft');

    // Approve draft
    DraftSystem.updateStatus(db, draft.draftId, 'approved');
    let drafts = DraftSystem.getDrafts(db, 1001);
    expect(drafts[0].status).toBe('approved');

    // Record manual execution
    DraftSystem.recordManualExecution(db, {
      draftId: draft.draftId,
      actualBuyPrice: 3.45,
      actualSellPrice: 4.95,
      actualQuantity: 1000,
      actualFees: 280,
      notes: 'Executed in game',
    });

    drafts = DraftSystem.getDrafts(db, 1001);
    expect(drafts[0].status).toBe('executed_manually');
    expect(drafts[0].actualBuyPrice).toBe(3.45);
    expect(drafts[0].actualProfit).toBe(1220); // (4.95 - 3.45) * 1000 - 280 = 1220

    // Next ID advances sequence
    const id2 = DraftSystem.generateDraftId(db);
    expect(id2).toMatch(/^TR-\d{4}-000002$/);
  });

  it('BacktestingEngine computes win rate, profit factor and max drawdown', () => {
    const db = createTestDb();
    // Seed 10 days of historical data for Tritanium (type 34)
    const baseDate = new Date('2026-10-01');
    for (let i = 0; i < 20; i++) {
      const d = new Date(baseDate.getTime() + i * 86400 * 1000).toISOString().slice(0, 10);
      // Simulate fluctuating prices with mean around 100
      const price = 100 + Math.sin(i) * 15;
      db.prepare(`
        INSERT INTO market_price_history (region_id, type_id, date, order_count, volume, highest, average, lowest)
        VALUES (10000002, 34, ?, 100, 10000, ?, ?, ?)
      `).run(d, price + 5, price, price - 5);
    }

    const summary = BacktestingEngine.runHistoricalBacktest(db, {
      strategyName: 'mean_reversion_test',
      regionId: 10000002,
      typeIds: [34],
      initialCapital: 10_000_000,
    });

    expect(summary.initialCapital).toBe(10_000_000);
    expect(summary.totalTrades).toBeGreaterThan(0);
    expect(summary.finalCapital).toBeGreaterThan(0);
    expect(summary.maxDrawdownPct).toBeGreaterThanOrEqual(0);
  });
});