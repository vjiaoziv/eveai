import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { P9OpportunityService } from '../../src/trading/p9-opportunity-service.js';
import { P9RealPortfolioService } from '../../src/trading/p9-real-portfolio.js';
import { P9RealTradeService } from '../../src/trading/p9-real-trades.js';

function seed(db: Database.Database): void {
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
    INSERT INTO sde_regions (region_id, name, data_json)
    VALUES (10000002, 'The Forge', '{"name":{"en":"The Forge","zh":"铸造"}}'),
           (10000043, 'Domain', '{"name":{"en":"Domain","zh":"域"}}'),
           (10000032, 'Sinq Laison', '{"name":{"en":"Sinq Laison","zh":"辛奎莱森"}}');
    INSERT INTO sde_constellations (constellation_id, name, region_id, data_json)
    VALUES (20000001, 'Kimotoro', 10000002, '{}'),
           (20000002, 'Aridia', 10000043, '{}'),
           (20000003, 'Evaulon', 10000032, '{}');
    INSERT INTO sde_systems (system_id, name, constellation_id, data_json)
    VALUES (30000142, 'Jita', 20000001, '{}'),
           (30000218, 'Amarr', 20000002, '{}'),
           (30002659, 'Dodixie', 20000003, '{}');
    INSERT INTO sde_stations (station_id, name, system_id, data_json)
    VALUES (60003760, 'Jita IV-4', 30000142, '{"name":{"en":"Jita","zh":"吉他"}}'),
           (60008494, 'Amarr VIII', 30000218, '{"name":{"en":"Amarr","zh":"阿玛"}}'),
           (60011866, 'Dodixie IX-20', 30002659, '{"name":{"en":"Dodixie","zh":"杜迪克西"}}');

    INSERT INTO market_snapshot_regions (region_id, pages, rows_loaded, fetched_at, expires_at)
    VALUES (10000002, 1, 100, datetime('now'), datetime('now', '+5 minutes')),
           (10000043, 1, 100, datetime('now'), datetime('now', '+5 minutes')),
           (10000032, 1, 100, datetime('now'), datetime('now', '+5 minutes'));

    INSERT INTO market_orders
      (order_id, type_id, region_id, system_id, station_id, location_id, is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued)
    VALUES
      (1, 34, 10000002, 30000142, 60003760, 60003760, 0, 10, 1000, 1000, 1, 90, 'station', datetime('now')),
      (2, 34, 10000002, 30000142, 60003760, 60003760, 1, 11.5, 1000, 1000, 1, 90, 'station', datetime('now')),
      (3, 34, 10000043, 30000218, 60008494, 60008494, 1, 12, 1000, 1000, 1, 90, 'station', datetime('now')),
      (4, 34, 10000043, 30000218, 60008494, 60008494, 0, 13, 1000, 1000, 1, 90, 'station', datetime('now')),
      (5, 34, 10000032, 30002659, 60011866, 60011866, 1, 12.5, 1000, 1000, 1, 90, 'station', datetime('now')),
      (6, 6675, 10000002, 30000142, 60003760, 60003760, 0, 100, 500, 500, 1, 90, 'station', datetime('now')),
      (7, 6675, 10000002, 30000142, 60003760, 60003760, 1, 110, 500, 500, 1, 90, 'station', datetime('now')),
      (8, 6675, 10000043, 30000218, 60008494, 60008494, 1, 120, 500, 500, 1, 90, 'station', datetime('now'));
  `);
}

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  seed(db);
  return db;
}

describe('P9 real-market minimum closed loop', () => {
  it('scans configurable hubs and stores four-layer real opportunities', () => {
    const db = createDb();
    P9OpportunityService.saveSettings(db, {
      characterId: 9001,
      minNetProfit: 10,
      minRoiPct: 0.1,
      maxCapital: 10_000,
      maxResults: 50,
    });
    const scan = P9OpportunityService.scan(db, 9001);
    expect(scan.errors).toEqual([]);
    expect(scan.stored).toBeGreaterThan(0);

    const result = P9OpportunityService.list(db, 9001, { sort: 'net', limit: 50 });
    expect(result.total).toBeGreaterThan(0);
    const station = result.rows.find((row) => row.strategy === 'station_arbitrage');
    const cross = result.rows.find((row) => row.strategy === 'regional_hauling');
    expect(station).toBeDefined();
    expect(cross).toBeDefined();

    // Station arbitrage: every cost is known, so a threshold-clearing spread
    // with complete fresh data is fully actionable.
    expect(station!.state).toBe('ACTIONABLE');
    expect(station!.spreadDetected).toBe(true);
    expect(station!.marketExecutable).toBe(true);
    expect(station!.profitAfterKnownFees).toBe(true);
    expect(station!.logisticsKnown).toBe(true);
    expect(station!.overallProfitKnown).toBe(true);
    expect(station!.tradePlanComplete).toBe(true);
    expect(station!.logisticsCost).toBe(0);

    // Inter-haul: executable and profitable after known fees, but logistics
    // cost is unknown, so it must stay WATCHING and never ACTIONABLE.
    expect(cross!.state).toBe('WATCHING');
    expect(cross!.spreadDetected).toBe(true);
    expect(cross!.marketExecutable).toBe(true);
    expect(cross!.profitAfterKnownFees).toBe(true);
    expect(cross!.logisticsKnown).toBe(false);
    expect(cross!.overallProfitKnown).toBe(false);
    expect(cross!.tradePlanComplete).toBe(false);
    expect(cross!.state).not.toBe('ACTIONABLE');
    expect(cross!.logisticsCost).toBeNull();
    expect(cross!.comprehensiveStatus).toBe('UNKNOWN');
    expect(cross!.comprehensiveNetProfit).toBeNull();
    expect(cross!.riskFlags).toContain('LOGISTICS_UNKNOWN');
    expect(station!.dataComplete).toBe(true);
    expect(station!.buySnapshotId).not.toBe(station!.sellSnapshotId === station!.buySnapshotId && station!.strategy === 'regional_hauling' ? station!.buySnapshotId : 'x');
    expect(JSON.stringify(station!.originalSnapshot)).toContain('public ESI regional market orders');

    const plan = P9OpportunityService.createPlan(db, 9001, station!.opportunityId);
    expect(plan.status).toBe('PLANNED');
    const confirmed = P9OpportunityService.transitionPlan(db, 9001, plan.planId, 'USER_CONFIRMED');
    expect(confirmed.status).toBe('USER_CONFIRMED');
    expect(() => P9OpportunityService.transitionPlan(db, 9001, plan.planId, 'PLANNED')).toThrow();
    db.close();
  });

  it('keeps fresh opportunities valid into the future and expires only past the data window', () => {
    const db = createDb();
    P9OpportunityService.saveSettings(db, {
      characterId: 9008,
      minNetProfit: 10,
      minRoiPct: 0.1,
      maxCapital: 10_000,
      maxMarketAgeMinutes: 60,
    });
    const scan = P9OpportunityService.scan(db, 9008);
    expect(scan.errors).toEqual([]);
    const rows = P9OpportunityService.list(db, 9008, { limit: 500 }).rows;
    expect(rows.length).toBeGreaterThan(0);
    // Fresh snapshot + 60-minute window: every stored validity end is ahead of now
    // (previously ESI's 5-minute cache Expires dated them in the past).
    expect(rows.every((row) => Date.parse(row.expiresAt) > Date.now())).toBe(true);

    const victim = rows.find((row) => row.state === 'WATCHING');
    expect(victim).toBeDefined();
    db.prepare("UPDATE p9_real_opportunities SET expires_at = '2020-01-01T00:00:00.000Z' WHERE opportunity_id = ?")
      .run(victim!.opportunityId);
    const changed = P9OpportunityService.expireDue(db, 9008);
    expect(changed).toBe(1);
    expect(P9OpportunityService.get(db, 9008, victim!.opportunityId)!.state).toBe('EXPIRED');
    // Re-running on untouched rows must be a no-op.
    expect(P9OpportunityService.expireDue(db, 9008)).toBe(0);
    db.close();
  });

  it('records idempotent real trades and rebuilds FIFO profit with unknown cost preserved', () => {
    const db = createDb();
    P9RealPortfolioService.upsertManualLot(db, 9002, {
      typeId: 34,
      locationId: 60003760,
      quantity: 50,
      costPerUnit: 9,
      acquiredAt: '2026-11-01T00:00:00.000Z',
      notes: '人工确认成本',
    });

    const buy = P9RealTradeService.recordManual(db, 9002, {
      clientKey: 'manual-buy-1',
      direction: 'buy',
      typeId: 34,
      locationId: 60003760,
      quantity: 100,
      price: 10,
      fee: 21,
      tradeTime: '2026-11-01T01:00:00.000Z',
    });
    const duplicate = P9RealTradeService.recordManual(db, 9002, {
      clientKey: 'manual-buy-1',
      direction: 'buy',
      typeId: 34,
      locationId: 60003760,
      quantity: 100,
      price: 10,
      fee: 21,
      tradeTime: '2026-11-01T01:00:00.000Z',
    });
    expect(duplicate.tradeId).toBe(buy.tradeId);
    expect(P9RealTradeService.list(db, 9002).total).toBe(1);

    const sell = P9RealTradeService.recordManual(db, 9002, {
      clientKey: 'manual-sell-1',
      direction: 'sell',
      typeId: 34,
      locationId: 60003760,
      quantity: 100,
      price: 12,
      fee: 85.5,
      tradeTime: '2026-11-01T02:00:00.000Z',
    });
    expect(sell.pnlStatus).toBe('CALCULATED');
    // manual: (12-9)*50 - 42.75 = 107.25
    // derived buy lot: cost=(1000+21)/100=10.21; (12-10.21)*50 - 42.75 = 46.75
    expect(sell.realizedPnl).toBeCloseTo(154, 6);

    const moves = db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN pnl_status = 'UNKNOWN_COST' THEN 1 ELSE 0 END) AS unknown FROM p9_inventory_moves WHERE character_id = ?").get(9002) as any;
    expect(moves.n).toBe(2);
    expect(moves.unknown).toBe(0);

    P9RealPortfolioService.upsertManualLot(db, 9002, {
      typeId: 34,
      locationId: 60003760,
      quantity: 10,
      costPerUnit: null,
      acquiredAt: '2026-11-01T03:00:00.000Z',
      notes: '成本未知',
    });
    const unknownSell = P9RealTradeService.recordManual(db, 9002, {
      clientKey: 'manual-sell-unknown',
      direction: 'sell',
      typeId: 34,
      locationId: 60003760,
      quantity: 60,
      price: 12,
      fee: 51.3,
      tradeTime: '2026-11-01T04:00:00.000Z',
    });
    expect(unknownSell.pnlStatus).toBe('UNKNOWN_COST');
    expect(unknownSell.realizedPnl).toBeNull();

    const summary = P9RealTradeService.summary(db, 9002);
    expect(summary.realizedNetPnl).toBeCloseTo(154, 6);
    expect(summary.unknownCostMoveCount).toBeGreaterThan(0);
    db.close();
  });

  it('keeps real and paper data isolated and reports UNKNOWN instead of zero', () => {
    const db = createDb();
    P9RealPortfolioService.upsertManualLot(db, 9003, {
      typeId: 34,
      locationId: 60003760,
      quantity: 10,
      costPerUnit: null,
    });
    const overview = P9RealPortfolioService.overview(db, 9003);
    expect(overview.inventory.unknownLotCount).toBe(1);
    expect(overview.performance.realizedNetPnl).toBe(0);
    expect(overview.funding.otherUnknown).toBeNull();
    expect(overview.wallet.balance).toBeNull();
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND (name LIKE 'paper_%' OR name LIKE 'p9_%')
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tables.some((row) => row.name === 'paper_trading_accounts')).toBe(true);
    expect(tables.some((row) => row.name === 'p9_real_trades')).toBe(true);
    expect(tables.some((row) => row.name === 'p9_inventory_lots')).toBe(true);
    db.close();
  });

  it('validates hub IDs against SDE and requires at least one enabled hub', () => {
    const db = createDb();
    expect(() => P9OpportunityService.saveSettings(db, {
      characterId: 9004,
      hubs: [{ locationId: 60003760, regionId: 10000043, name: '错误区域' }],
    })).toThrow(/不属于区域/);
    expect(() => P9OpportunityService.saveSettings(db, {
      characterId: 9004,
      hubs: [{ locationId: 60003760, regionId: 99999999, name: '不存在区域' }],
    })).toThrow(/不存在于当前 SDE/);
    expect(() => P9OpportunityService.saveSettings(db, {
      characterId: 9004,
      hubs: [{ locationId: 60003760, regionId: 10000002, name: 'Jita', enabled: false }],
    })).toThrow(/至少需要启用一个/);
    const saved = P9OpportunityService.saveSettings(db, {
      characterId: 9004,
      hubs: [
        { locationId: 60003760, regionId: 10000002, name: 'Jita', enabled: true },
        { locationId: 60008494, regionId: 10000043, name: 'Amarr', enabled: false },
      ],
    });
    expect(saved.hubs.filter((hub) => hub.enabled !== false)).toHaveLength(1);
    const scan = P9OpportunityService.scan(db, 9004);
    expect(scan.errors).toEqual([]);
    expect(scan.stored).toBeGreaterThan(0);
    db.close();
  });

  it('can restrict a scan to explicit type IDs', () => {
    const db = createDb();
    P9OpportunityService.saveSettings(db, { characterId: 9005, minNetProfit: 10, minRoiPct: 0.1, maxCapital: 10_000 });
    const auto = P9OpportunityService.scan(db, 9005);
    expect(auto.errors).toEqual([]);
    const autoTypes = new Set(P9OpportunityService.list(db, 9005, { limit: 500 }).rows.map((row) => row.typeId));
    expect(autoTypes.has(34)).toBe(true);
    expect(autoTypes.has(6675)).toBe(true);

    db.prepare('DELETE FROM p9_real_opportunities WHERE character_id = ?').run(9005);
    const explicit = P9OpportunityService.scan(db, 9005, { typeIds: [34] });
    expect(explicit.errors).toEqual([]);
    const rows = P9OpportunityService.list(db, 9005, { limit: 500 }).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.typeId === 34)).toBe(true);
    db.close();
  });

  it('treats a snapshot as fresh by its actual age, not by the ESI cache Expires header', () => {
    const db = createDb();
    db.prepare(`
      UPDATE market_snapshot_regions
      SET fetched_at = datetime('now', '-10 minutes'),
          expires_at = datetime('now', '-5 minutes')
    `).run();
    P9OpportunityService.saveSettings(db, {
      characterId: 9006,
      minNetProfit: 10,
      minRoiPct: 0.1,
      maxCapital: 10_000,
      maxMarketAgeMinutes: 60,
    });
    const scan = P9OpportunityService.scan(db, 9006);
    expect(scan.errors).toEqual([]);
    expect(scan.stored).toBeGreaterThan(0);
    const rows = P9OpportunityService.list(db, 9006, { limit: 200 }).rows;
    expect(rows.some((row) => row.state === 'ACTIONABLE')).toBe(true);
    expect(rows.every((row) => !row.riskFlags.includes('DATA_STALE'))).toBe(true);
    db.close();
  });
});
