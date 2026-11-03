import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import {
  RealInventoryService,
  BUCKET_LABELS_ZH,
  ASSET_TAG_VALUES,
} from '../../src/assets/inventory-service.js';
import type { Db } from '../../src/db/sqlite.js';

const CHARACTER_ID = 90000011;
const OTHER_CHARACTER_ID = 90000012;

let db: Database.Database;

function seedSdeAndAssets(): void {
  db.exec(`
    INSERT INTO sde_categories (category_id, name, data_json) VALUES
      (4, 'Material', '{}'), (6, 'Ship', '{}'), (7, 'Module', '{}'),
      (8, 'Charge', '{}'), (9, 'Blueprint', '{}'), (10, 'Trading', '{}'),
      (17, 'Commodity', '{}'), (18, 'Drone', '{}'), (20, 'Implant', '{}'),
      (25, 'Asteroid', '{}'), (22, 'Deployable', '{}');
    INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES
      (18, 'Mineral', 4, '{}'),
      (100, 'Frigate', 6, '{}'),
      (200, 'Hybrid Weapon', 7, '{}'),
      (300, 'Projectile Ammo', 8, '{}'),
      (400, 'Blueprint', 9, '{}'),
      (500, 'Empire Insignia Drops', 17, '{}'),
      (600, 'General', 17, '{}'),
      (700, 'Veldspar', 25, '{}'),
      (800, 'Combat Drone', 18, '{}');
    INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES
      (34, 'Tritanium', 18, '{"name":{"en":"Tritanium","zh":"三钛合金"}}'),
      (587, 'Rifter', 100, '{"name":{"en":"Rifter","zh":" rifters"}}'),
      (588, 'Small Laser', 200, '{"name":{"en":"Small Laser","zh":"小型激光器"}}'),
      (589, 'Antimatter Charge', 300, '{"name":{"en":"Antimatter Charge","zh":"反物质弹"}}'),
      (590, 'Rifter Blueprint', 400, '{"name":{"en":"Rifter Blueprint","zh":" rifters蓝图"}}'),
      (591, 'Empire Insignia', 500, '{"name":{"en":"Empire Insignia","zh":"帝国徽章"}}'),
      (592, 'Frozen', 600, '{"name":{"en":"Frozen","zh":"冷冻食品"}}'),
      (593, 'Veldspar', 700, '{"name":{"en":"Veldspar","zh":"凡晶石"}}'),
      (594, 'Hammerhead', 800, '{"name":{"en":"Hammerhead","zh":"铁锤"}}'),
      (595, 'Mystery Box', 999, '{"name":{"en":"Mystery Box","zh":"神秘箱"}}');

    INSERT INTO real_asset_locations
      (location_id, location_type, location_name, solar_system_id, solar_system_name,
       region_id, region_name, parent_location_id, resolution_status, resolution_source, resolved_at)
    VALUES (60003760, 'STATION', 'Jita Trade Hub', 30000142, 'Jita', 10000002, 'The Forge',
            NULL, 'RESOLVED', 'sde_stations', datetime('now'));

    INSERT INTO character_assets
      (character_id, item_id, type_id, location_id, location_type, location_flag,
       quantity, is_singleton, is_blueprint_copy, data_json, synced_at)
    VALUES
      (${CHARACTER_ID}, 1, 34, 60003760, 'station', 'Hangar', 5000, 0, 0, '{}', datetime('now')),
      (${CHARACTER_ID}, 2, 587, 60003760, 'station', 'Hangar', 2, 1, 0, '{}', datetime('now')),
      (${CHARACTER_ID}, 3, 588, 60003760, 'station', 'Hangar', 10, 1, 0, '{}', datetime('now')),
      (${CHARACTER_ID}, 4, 589, 60003760, 'station', 'Hangar', 400, 0, 0, '{}', datetime('now')),
      (${CHARACTER_ID}, 5, 590, 60003760, 'station', 'Hangar', 1, 1, 0, '{}', datetime('now')),
      (${CHARACTER_ID}, 6, 590, 60003760, 'station', 'Hangar', 3, 1, 1, '{}', datetime('now')),
      (${CHARACTER_ID}, 7, 591, 60003760, 'station', 'Hangar', 20, 0, 0, '{}', datetime('now')),
      (${CHARACTER_ID}, 8, 593, 60003760, 'station', 'Hold', 100, 0, 0, '{}', datetime('now')),
      (${CHARACTER_ID}, 9, 594, 60003760, 'station', 'Hangar', 5, 1, 0, '{}', datetime('now')),
      (${CHARACTER_ID}, 10, 595, 60003760, 'station', 'Hangar', 1, 1, 0, '{}', datetime('now')),
      (${CHARACTER_ID}, 11, 592, 60003760, 'station', 'Hangar', 7, 0, 0, '{}', datetime('now')),
      (${OTHER_CHARACTER_ID}, 99, 34, 60003760, 'station', 'Hangar', 1, 0, 0, '{}', datetime('now'));

    INSERT INTO market_orders
      (order_id, type_id, region_id, system_id, station_id, location_id, is_buy_order,
       price, volume_remain, volume_total, min_volume, duration, range, issued)
    VALUES
      (1, 34, 10000002, 30000142, 60003760, 60003760, 1, 5, 100, 100, 1, 90, 'station', datetime('now')),
      (2, 587, 10000002, 30000142, 60003760, 60003760, 0, 1000, 1, 1, 1, 90, 'station', datetime('now'));
  `);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  seedSdeAndAssets();
});

afterEach(() => {
  db.close();
});

describe('inventory classification and management (P9.2.3)', () => {
  it('classifies from SDE category/group and the blueprint-copy flag', () => {
    const summary = RealInventoryService.bucketSummary(db as Db, CHARACTER_ID);
    const byBucket = new Map(summary.map((row) => [row.bucket, row]));
    expect(byBucket.get('ORES_MINERALS')).toMatchObject({ items: 2 }); // tritanium + veldspar
    expect(byBucket.get('SHIPS')).toMatchObject({ items: 1 });
    expect(byBucket.get('SHIP_MODULES')).toMatchObject({ items: 1 });
    expect(byBucket.get('AMMO')).toMatchObject({ items: 1 });
    expect(byBucket.get('BPO')).toMatchObject({ items: 1 });
    expect(byBucket.get('BPC')).toMatchObject({ items: 1 });
    expect(byBucket.get('MISSION')).toMatchObject({ items: 1 }); // Empire Insignia Drops
    expect(byBucket.get('DRONES')).toMatchObject({ items: 1 });
    expect(byBucket.get('UNKNOWN')).toMatchObject({ items: 1 }); // type absent from SDE
    expect(BUCKET_LABELS_ZH.SHIPS).toBe('舰船');
    // Trading bucket keeps plain commodities (Frozen) out of mission/unknown.
    expect(byBucket.get('TRADING_GOODS')).toMatchObject({ items: 1 });
  });

  it('filters, searches, sorts and paginates', () => {
    const all = RealInventoryService.list(db as Db, { characterId: CHARACTER_ID, limit: 100 });
    expect(all.total).toBe(11);

    const search = RealInventoryService.list(db as Db, { characterId: CHARACTER_ID, q: 'trit' });
    expect(search.total).toBe(1);
    expect(search.rows[0].typeNameZh).toBe('三钛合金');

    const region = RealInventoryService.list(db as Db, { characterId: CHARACTER_ID, regionId: 10000002 });
    expect(region.total).toBe(11);
    const wrongRegion = RealInventoryService.list(db as Db, { characterId: CHARACTER_ID, regionId: 999 });
    expect(wrongRegion.total).toBe(0);

    const tradable = RealInventoryService.list(db as Db, { characterId: CHARACTER_ID, tradable: true });
    expect(tradable.rows.map((row) => row.typeId).sort()).toEqual([34, 587]);

    const sorted = RealInventoryService.list(db as Db, {
      characterId: CHARACTER_ID, sort: 'quantity', order: 'desc', limit: 3,
    });
    expect(sorted.rows.map((row) => row.quantity)).toEqual([5000, 400, 100]);
    expect(sorted.total).toBe(11);
    expect(sorted.limit).toBe(3);

    const page2 = RealInventoryService.list(db as Db, {
      characterId: CHARACTER_ID, sort: 'quantity', order: 'desc', limit: 3, offset: 3,
    });
    expect(page2.rows).toHaveLength(3);
    expect(page2.rows[0].quantity).not.toBe(5000);

    const bucketFilter = RealInventoryService.list(db as Db, { characterId: CHARACTER_ID, bucket: 'BPC' });
    expect(bucketFilter.total).toBe(1);
    expect(bucketFilter.rows[0].isBlueprintCopy).toBe(true);
  });

  it('keeps characters isolated in listings and detail lookups', () => {
    const other = RealInventoryService.list(db as Db, { characterId: OTHER_CHARACTER_ID });
    expect(other.total).toBe(1);
    expect(other.rows[0].itemId).toBe(99);

    // Detail for another character's item from THIS character's perspective.
    expect(RealInventoryService.detail(db as Db, CHARACTER_ID, 99)).toBeNull();
    expect(RealInventoryService.detail(db as Db, CHARACTER_ID, 1)).not.toBeNull();
  });

  it('stores local tags only for owned current-set items', () => {
    expect(RealInventoryService.setTag(db as Db, CHARACTER_ID, 2, 'FOR_SALE')).toBe('FOR_SALE');
    expect(RealInventoryService.getTag(db as Db, CHARACTER_ID, 2)).toBe('FOR_SALE');
    const tagged = RealInventoryService.list(db as Db, { characterId: CHARACTER_ID, q: 'rifter' });
    expect(tagged.rows.find((row) => row.itemId === 2)?.tag).toBe('FOR_SALE');

    expect(() => RealInventoryService.setTag(db as Db, CHARACTER_ID, 2, 'NOT_A_TAG')).toThrow(/无效标签/);
    // Item owned by the other character cannot be tagged here.
    expect(() => RealInventoryService.setTag(db as Db, CHARACTER_ID, 99, 'FOR_SALE')).toThrow(/最新资产快照/);
    expect(ASSET_TAG_VALUES).toContain('TRADE_STOCK');

    RealInventoryService.clearTag(db as Db, CHARACTER_ID, 2);
    expect(RealInventoryService.getTag(db as Db, CHARACTER_ID, 2)).toBeNull();
  });

  it('returns detail with change and snapshot history', () => {
    db.prepare(`
      INSERT INTO real_asset_snapshots
        (snapshot_id, character_id, job_id, started_at, completed_at, status,
         total_items, total_unique_types, total_locations, total_quantity, data_hash, source, is_latest)
      VALUES ('SNAP-1', ?, NULL, datetime('now'), datetime('now'), 'COMPLETED', 1, 1, 1, 10, 'abc', 'esi_character_assets', 1)
    `).run(CHARACTER_ID);
    db.prepare(`
      INSERT INTO real_asset_snapshot_items
        (snapshot_id, item_id, type_id, quantity, location_id, raw_json)
      VALUES ('SNAP-1', 1, 34, 10, 60003760, '{}')
    `).run();
    db.prepare(`
      INSERT INTO real_asset_changes
        (change_id, character_id, item_id, type_id, change_type, prev_quantity, new_quantity,
         from_snapshot_id, to_snapshot_id, detected_at)
      VALUES ('CHG-1', ?, 1, 34, 'QTY_INCREASED', 5, 10, NULL, 'SNAP-1', datetime('now'))
    `).run(CHARACTER_ID);

    const detail = RealInventoryService.detail(db as Db, CHARACTER_ID, 1)!;
    expect(detail.bucket).toBe('ORES_MINERALS');
    expect(detail.changeHistory).toHaveLength(1);
    expect(detail.snapshotHistory).toHaveLength(1);
    expect(detail.regionName).toBe('The Forge');
    expect(RealInventoryService.detail(db as Db, CHARACTER_ID, 42424)).toBeNull();
  });
});
