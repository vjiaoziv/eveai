import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TradingPipeline } from '../../src/trading/trading-pipeline.js';
import { runMigrations } from '../../src/db/migrations.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);

  db.exec(`
    INSERT INTO sde_types (type_id, name, group_id, data_json)
    VALUES (6675, 'Small Focused Modulated Pulse Energy Beam I', 53, '{"volume":5.0,"portionSize":1,"mass":10000,"basePrice":300000,"name":{"en":"Small Focused Modulated Pulse Energy Beam I","zh":"小型聚焦调幅脉冲激光器 I"}}'),
           (34, 'Tritanium', 18, '{"volume":0.01,"portionSize":1,"mass":0,"basePrice":2,"name":{"en":"Tritanium","zh":"三钛合金"}}');

    INSERT INTO sde_groups (group_id, name, category_id, data_json)
    VALUES (53, 'Energy Weapon', 7, '{"name":{"en":"Energy Weapon","zh":"能量武器"}}'),
           (18, 'Mineral', 4, '{"name":{"en":"Mineral","zh":"矿物"}}');

    INSERT INTO sde_categories (category_id, name, data_json)
    VALUES (7, 'Module', '{"name":{"en":"Module","zh":"装备"}}'),
           (4, 'Material', '{"name":{"en":"Material","zh":"材料"}}');

    INSERT INTO sde_stations (station_id, name, system_id, data_json)
    VALUES (60003760, 'Jita IV-4', 30000142, '{"name":{"en":"Jita IV-4","zh":"吉他海四"}}'),
           (60011866, 'Dodixie IX-20', 30002659, '{"name":{"en":"Dodixie IX-20","zh":"杜迪克西"}}');

    INSERT INTO character_wallet (character_id, balance, synced_at)
    VALUES (1001, 100000000, datetime('now'));
  `);

  return db;
}

describe('TradingPipeline Deterministic Verification', () => {
  it('strictly caps quantity by top bid volume and calculates multi-level costs', () => {
    const db = createTestDb();
    const nowIso = new Date().toISOString();

    // Jita sells: 2 @ 274.9k, 1 @ 275k, 5 @ 290k
    // Dodixie buys: ONLY 2 @ 700k, then 10,000 @ 1k
    db.exec(`
      INSERT INTO market_orders (order_id, type_id, region_id, system_id, location_id, is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued)
      VALUES (1, 6675, 10000002, 30000142, 60003760, 0, 274900, 2, 7, 1, 90, 'station', '${nowIso}'),
             (2, 6675, 10000002, 30000142, 60003760, 0, 275000, 1, 1, 1, 90, 'station', '${nowIso}'),
             (3, 6675, 10000002, 30000142, 60003760, 0, 290000, 5, 5, 1, 90, 'station', '${nowIso}'),
             (4, 6675, 10000032, 30002659, 60011866, 1, 700000, 2, 3, 1, 90, 'station', '${nowIso}'),
             (5, 6675, 10000032, 30002659, 60011866, 1, 1006, 9992, 10000, 1, 90, 'station', '${nowIso}');
    `);

    const result = TradingPipeline.evaluateCandidate(db, {
      typeId: 6675,
      strategy: 'regional_hauling',
      originStationId: 60003760,
      originRegionId: 10000002,
      originStationName: 'Jita IV-4',
      destStationId: 60011866,
      destRegionId: 10000032,
      destStationName: 'Dodixie IX-20',
      requestedQty: 29, // Requested 29, but top bid is only 2
      characterId: 1001,
    });

    // The pipeline MUST cap suggestedQuantity to 2 (top bid depth)
    expect(result.opportunity.suggestedQuantity).toBe(2);
    expect(result.opportunity.suggestedBuyPrice).toBe(274900);
    expect(result.opportunity.suggestedSellPrice).toBe(700000);

    // Stress test must be present
    expect(result.opportunity.stressTest).toBeDefined();
    expect(result.opportunity.stressTest?.priceDrop5Pct.netProfit).toBeGreaterThan(0);
    // When bid evaporates, price falls back to 1006 ISK, creating huge loss
    expect(result.opportunity.stressTest?.bidEvaporation.netProfit).toBeLessThan(0);
  });

  it('vetoes candidate with D rating when timestamp skew exceeds threshold', () => {
    const db = createTestDb();
    const staleTime = new Date(Date.now() - 3600 * 1000 * 5).toISOString(); // 5 hours ago
    const freshTime = new Date().toISOString();

    db.exec(`
      INSERT INTO market_orders (order_id, type_id, region_id, system_id, location_id, is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued)
      VALUES (1, 34, 10000002, 30000142, 60003760, 0, 3.50, 10000, 10000, 1, 90, 'station', '${staleTime}'),
             (2, 34, 10000032, 30002659, 60011866, 1, 5.00, 10000, 10000, 1, 90, 'station', '${freshTime}');
    `);

    const result = TradingPipeline.evaluateCandidate(db, {
      typeId: 34,
      strategy: 'regional_hauling',
      originStationId: 60003760,
      originRegionId: 10000002,
      originStationName: 'Jita IV-4',
      destStationId: 60011866,
      destRegionId: 10000032,
      destStationName: 'Dodixie IX-20',
      requestedQty: 1000,
      characterId: 1001,
    });

    expect(result.rating).toBe('D');
    expect(result.isExecutable).toBe(false);
    expect(result.vetoReason).toContain('时间差过大');
    // Draft must NOT be created for D rating
    expect(result.draft).toBeUndefined();
  });
});
