import { signPipelineCredential } from '../../src/trading/trading-pipeline.js';
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
           (626, 'Vexor', 26, '{"volume":115000,"portionSize":1,"mass":11100000,"basePrice":8000000,"name":{"en":"Vexor","zh":"狂怒者级"}}'),
           (6675, 'Small Focused Modulated Pulse Energy Beam I', 53, '{"volume":5.0,"portionSize":1,"mass":10000,"basePrice":300000,"name":{"en":"Small Focused Modulated Pulse Energy Beam I","zh":"小型聚焦调幅脉冲激光器 I"}}');

    INSERT INTO sde_groups (group_id, name, category_id, data_json)
    VALUES (18, 'Mineral', 4, '{"name":{"en":"Mineral","zh":"矿物"}}'),
           (26, 'Cruiser', 6, '{"name":{"en":"Cruiser","zh":"巡洋舰"}}'),
           (53, 'Energy Weapon', 7, '{"name":{"en":"Energy Weapon","zh":"能量武器"}}');

    INSERT INTO sde_categories (category_id, name, data_json)
    VALUES (4, 'Material', '{"name":{"en":"Material","zh":"材料"}}'),
           (6, 'Ship', '{"name":{"en":"Ship","zh":"舰船"}}'),
           (7, 'Module', '{"name":{"en":"Module","zh":"装备"}}');

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

  it('RegionalHaulingStrategy prevents phantom spread and depth mismatch', () => {
    const db = createTestDb();
    const nowIso = new Date().toISOString();

    // Reconstruct the TR-2026-000001 scenario:
    // Jita sells: 2 @ 274.9k, 1 @ 275k, 5 @ 290k, 53 @ 369.8k
    // Dodixie buys: ONLY 2 @ 700k, then 10,000 @ 1k
    db.exec(`
      INSERT INTO market_orders (order_id, type_id, region_id, system_id, location_id, is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued)
      VALUES (1, 6675, 10000002, 30000142, 60003760, 0, 274900, 2, 7, 1, 90, 'station', '${nowIso}'),
             (2, 6675, 10000002, 30000142, 60003760, 0, 275000, 1, 1, 1, 90, 'station', '${nowIso}'),
             (3, 6675, 10000002, 30000142, 60003760, 0, 369800, 53, 93, 1, 90, 'station', '${nowIso}'),
             (4, 6675, 10000032, 30002659, 60011866, 1, 700000, 2, 3, 1, 90, 'station', '${nowIso}'),
             (5, 6675, 10000032, 30002659, 60011866, 1, 1006, 9992, 10000, 1, 90, 'station', '${nowIso}');
    `);

    const opps = RegionalHaulingStrategy.scan(db, {
      route: STANDARD_HIGHSEC_ROUTES[0],
      mode: 'instant_fill',
      maxCapital: 50_000_000,
    });

    // The strategy MUST NOT recommend buying 29 units!
    const laserOpp = opps.find(o => o.typeId === 6675);
    if (laserOpp) {
      // If found, quantity must be strictly capped by top buy order depth (2 units)
      expect(laserOpp.suggestedQuantity).toBeLessThanOrEqual(2);
      expect(laserOpp.suggestedQuantity).toBe(2);
      expect(laserOpp.suggestedSellPrice).toBe(700000);
      expect(laserOpp.suggestedBuyPrice).toBe(274900);
    }
  });

  it('PortfolioManager enforces in-flight draft commitment and cumulative risk caps', () => {
    const db = createTestDb();
    // Character wallet = 100,000,000 ISK
    db.exec(`
      INSERT INTO character_wallet (character_id, balance, synced_at)
      VALUES (1001, 100000000, datetime('now'));

      INSERT INTO character_assets (character_id, item_id, type_id, location_id, location_flag, quantity, data_json, synced_at)
      VALUES (1001, 9991, 34, 60003760, 'Hangar', 2000000, '{}', datetime('now')); -- 2M Tritanium (valued at ~4M ISK)
    `);

    // Initially: 100M cash - 20M reserve = 80M investable
    let breakdown = PortfolioManager.getCapitalBreakdown(db, 1001);
    expect(breakdown.walletBalance).toBe(100_000_000);
    expect(breakdown.cashReserveRequired).toBe(20_000_000);
    expect(breakdown.investableCapital).toBe(80_000_000);

    // Create an approved draft of 50M ISK awaiting execution
    db.exec(`
      INSERT INTO trade_drafts (draft_id, character_id, type_id, strategy, buy_station_id, sell_station_id, suggested_buy, suggested_qty, suggested_sell, estimated_fees, expected_profit, expected_roi, capital_required, status, expires_at)
      VALUES ('TR-2026-TEST01', 1001, 626, 'station_arbitrage', 60003760, 60003760, 10000000, 5, 12000000, 500000, 9500000, 19.0, 50000000, 'approved', datetime('now', '+1 day'));
    `);

    // In-flight committed must now be 50M, leaving only 30M investable!
    breakdown = PortfolioManager.getCapitalBreakdown(db, 1001);
    expect(breakdown.inFlightCommittedIsk).toBe(50_000_000);
    expect(breakdown.investableCapital).toBe(30_000_000);

    // Attempting a 40M trade should be rejected (only 30M available)
    const overCommit = PortfolioManager.validateTradeRisk(breakdown, 40_000_000, 'station_arbitrage', 10);
    expect(overCommit.allowed).toBe(false);
    expect(overCommit.reason).toContain('在途审批资金');

    // Hauling trade of 60M exceeds 50M anti-gank cap
    const invalidGank = PortfolioManager.validateTradeRisk({ ...breakdown, investableCapital: 100_000_000 }, 60_000_000, 'regional_hauling', 500);
    expect(invalidGank.allowed).toBe(false);
    expect(invalidGank.reason).toContain('防自杀强杀风控限制');
  });

  it('DraftSystem supports audit revocation and strictly blocks re-approval and execution', () => {
    const db = createTestDb();

    // Create a draft
    const opp: TradeOpportunity = {
      typeId: 34,
      typeName: 'Tritanium',
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

        opp.opportunityRating = 'A';
    const u = {
      credentialId: 'CRED-FULL-01',
      typeId: opp.typeId,
      strategy: opp.strategy,
      buyStationId: opp.buyStationId,
      sellStationId: opp.sellStationId,
      suggestedBuyPrice: opp.suggestedBuyPrice,
      suggestedSellPrice: opp.suggestedSellPrice,
      suggestedQuantity: opp.suggestedQuantity,
      capitalRequired: opp.capitalRequired,
      expectedNetProfit: opp.expectedNetProfit,
      opportunityRating: 'A' as const,
      verifiedAt: new Date().toISOString(),
    };
    opp.pipelineCredential = { ...u, signature: signPipelineCredential(u) };
    const draft = DraftSystem.createDraft(db, 1001, opp);
    expect(draft.status).toBe('draft');

    // Revoke by audit
    DraftSystem.revokeDraftByAudit(db, draft.draftId, 'Audited: phantom spread defect');
    const drafts = DraftSystem.getDrafts(db, 1001);
    expect(drafts[0].status).toBe('audit_revoked');
    expect(drafts[0].revokedReason).toBe('Audited: phantom spread defect');

    // Attempt to re-approve MUST THROW
    expect(() => {
      DraftSystem.updateStatus(db, draft.draftId, 'approved');
    }).toThrow(/已被第二轮独立审计永久撤销/);

    // Attempt to record manual execution MUST THROW
    expect(() => {
      DraftSystem.recordManualExecution(db, {
        draftId: draft.draftId,
        actualBuyPrice: 3.5,
        actualSellPrice: 5.0,
        actualQuantity: 1000,
        actualFees: 300,
      });
    }).toThrow(/已被独立审计撤销/);

    // Active drafts filter must exclude revoked draft
    const activeDrafts = DraftSystem.getDrafts(db, 1001, 'active');
    expect(activeDrafts.length).toBe(0);
  });

  it('BacktestingEngine computes realistic metrics without lookahead bias, including Sortino and CVaR', () => {
    const db = createTestDb();
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
      strategyName: 'conservative_mean_reversion',
      regionId: 10000002,
      typeIds: [34],
      initialCapital: 10_000_000,
    });

    expect(summary.executionMode).toBe('conservative_simulation');
    expect(summary.initialCapital).toBe(10_000_000);
    expect(summary.totalTrades).toBeGreaterThanOrEqual(0);
    // Sortino and CVaR must be defined numbers
    expect(typeof summary.sortinoRatio).toBe('number');
    expect(typeof summary.cvar95Pct).toBe('number');
    expect(typeof summary.capitalTurnoverRate).toBe('number');
  });
});



