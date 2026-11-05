import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { RealValuationService } from '../../src/assets/valuation-service.js';
import { FEE_MODEL_VERSION } from '../../src/trading/fee-engine.js';
import type { Db } from '../../src/db/sqlite.js';
import { testAssetLineage } from '../helpers/asset-lineage.js';

const CHARACTER_ID = 90000021;
const JITA_STATION = 60003760;
const JITA_REGION = 10000002;
const LINEAGE = testAssetLineage(CHARACTER_ID);

let db: Database.Database;

function seed(): void {
  db.exec(`
    INSERT INTO sde_categories (category_id, name, data_json) VALUES
      (4, 'Material', '{}'), (7, 'Module', '{}'), (9, 'Blueprint', '{}'), (17, 'Commodity', '{}');
    INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES
      (18, 'Mineral', 4, '{}'), (200, 'Hybrid Weapon', 7, '{}'),
      (400, 'Blueprint', 9, '{}'), (500, 'Empire Insignia Drops', 17, '{}');
    INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES
      (100, 'Local Module', 200, '{"name":{"en":"Local Module","zh":"本地模块"}}'),
      (200, 'Region Module', 200, '{"name":{"en":"Region Module","zh":"区域模块"}}'),
      (300, 'Lost Artifact', 400, '{"name":{"en":"Lost Artifact","zh":"迷失 artifact"}}'),
      (400, 'Mission Insignia', 500, '{"name":{"en":"Mission Insignia","zh":"任务徽章"}}'),
      (500, 'Thin Market Module', 200, '{"name":{"en":"Thin Market Module","zh":"薄市场模块"}}');

    INSERT INTO real_asset_locations
      (location_id, location_type, location_name, solar_system_id, solar_system_name,
       region_id, region_name, parent_location_id, resolution_status, resolution_source, resolved_at)
    VALUES (${JITA_STATION}, 'STATION', 'Jita Trade Hub', 30000142, 'Jita',
            ${JITA_REGION}, 'The Forge', NULL, 'RESOLVED', 'sde_stations', datetime('now'));

    INSERT INTO real_asset_snapshots
      (snapshot_id, character_id, job_id, started_at, completed_at, status,
       total_items, total_unique_types, total_locations, total_quantity, data_hash, source, is_latest,
       owner_user_id, owner_chat_id, binding_epoch, binding_digest)
    VALUES ('SNAP-VAL-1', ${CHARACTER_ID}, NULL, datetime('now'), datetime('now'),
            'COMPLETED', 6, 5, 2, 266, 'hash1', 'esi_character_assets', 1,
            ${LINEAGE.ownerUserId}, ${LINEAGE.ownerChatId}, ${LINEAGE.bindingEpoch}, '${LINEAGE.bindingDigest}');

    INSERT INTO real_asset_snapshot_items
      (snapshot_id, item_id, type_id, quantity, location_id, location_type, location_flag,
       is_singleton, is_blueprint_copy, parent_item_id, raw_json)
    VALUES
      ('SNAP-VAL-1', 1, 100, 100, ${JITA_STATION}, 'station', 'Hangar', 1, 0, NULL, '{}'),
      ('SNAP-VAL-1', 2, 200, 50, ${JITA_STATION}, 'station', 'Hangar', 1, 0, NULL, '{}'),
      ('SNAP-VAL-1', 3, 300, 10, 999999, 'item', 'Cargo', 1, 0, NULL, '{}'),
      ('SNAP-VAL-1', 4, 400, 5, ${JITA_STATION}, 'station', 'Hangar', 0, 0, NULL, '{}'),
      ('SNAP-VAL-1', 5, 500, 1, ${JITA_STATION}, 'station', 'Hangar', 1, 0, NULL, '{}'),
      ('SNAP-VAL-1', 6, 500, 100, ${JITA_STATION}, 'station', 'Hangar', 0, 0, NULL, '{}');

    INSERT INTO market_snapshot_regions (region_id, pages, rows_loaded, fetched_at, expires_at)
    VALUES (${JITA_REGION}, 1, 10, datetime('now'), datetime('now', '+5 minutes'));

    INSERT INTO market_orders
      (order_id, type_id, region_id, system_id, station_id, location_id, is_buy_order,
       price, volume_remain, volume_total, min_volume, duration, range, issued)
    VALUES
      -- type 100 local two-level bids + one ask at Jita
      (1, 100, ${JITA_REGION}, 30000142, ${JITA_STATION}, ${JITA_STATION}, 1, 10, 60, 60, 1, 90, 'station', datetime('now')),
      (2, 100, ${JITA_REGION}, 30000142, ${JITA_STATION}, ${JITA_STATION}, 1, 9, 100, 100, 1, 90, 'station', datetime('now')),
      (3, 100, ${JITA_REGION}, 30000142, ${JITA_STATION}, ${JITA_STATION}, 0, 12, 200, 200, 1, 90, 'station', datetime('now')),
      -- type 200: ask only at ANOTHER station in the same region (reference A),
      -- no local bids/asks at Jita (B/C => NO_MARKET_DATA)
      (4, 200, ${JITA_REGION}, 30000143, 60003761, 60003761, 0, 15, 80, 80, 1, 90, 'station', datetime('now')),
      -- type 500: thin local bids (30 of 100 fillable)
      (5, 500, ${JITA_REGION}, 30000142, ${JITA_STATION}, ${JITA_STATION}, 1, 5, 30, 30, 1, 90, 'station', datetime('now'));
  `);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  seed();
});

afterEach(() => {
  db.close();
});

describe('multi-perspective asset valuation (P9.2.4)', () => {
  it('values depth-walked liquidation and replacement with fees, never summing perspectives', () => {
    const run = RealValuationService.run(db as Db, CHARACTER_ID, LINEAGE);
    expect(run.status).toBe('COMPLETED');
    expect(run.itemsTotal).toBe(6);

    const byItem = new Map(run.items.map((item) => [item.itemId, item]));

    // item1: local two-level bid walk 60@10 + 40@9 = 960 gross; Accounting III tax 5.025% => 911.76 net.
    const local = byItem.get(1)!;
    expect(local.bidLiquidationGross).toBe(960);
    expect(local.bidLiquidationNet).toBe(911.76);
    expect(local.fillableQuantity).toBe(100);
    expect(local.unfillableQuantity).toBe(0);
    expect(local.askReplacementGross).toBe(1200); // 12 x 100 local ask
    // A: region top-of-book ask 12 x 100 = 1200 reference (independent of B/C).
    expect(local.marketReferenceValue).toBe(1200);
    expect(local.statuses).toContain('VALUED');
    expect(local.statuses).not.toContain('INSUFFICIENT_DEPTH');

    // item2: region reference exists, but no local bids/asks => partial, not zeroed.
    const regionOnly = byItem.get(2)!;
    expect(regionOnly.marketReferenceValue).toBe(750); // 15 x 50 (other station)
    expect(regionOnly.bidLiquidationNet).toBeNull();
    expect(regionOnly.askReplacementGross).toBeNull();
    expect(regionOnly.statuses).toContain('NO_MARKET_DATA');
    expect(regionOnly.statuses).toContain('PARTIALLY_VALUED');

    // item3: unresolved location => every perspective UNKNOWN (null, never 0).
    const lost = byItem.get(3)!;
    expect(lost.statuses).toContain('LOCATION_UNKNOWN');
    expect(lost.marketReferenceValue).toBeNull();
    expect(lost.bidLiquidationNet).toBeNull();
    expect(lost.askReplacementGross).toBeNull();

    // item4 mission insignia without any orders: UNKNOWN + not marketable, not zero.
    const mission = byItem.get(4)!;
    expect(mission.statuses).toContain('NO_MARKET_DATA');
    expect(mission.statuses).toContain('NOT_MARKETABLE');
    expect(mission.marketReferenceValue).toBeNull();
    expect(mission.bidLiquidationNet).toBeNull();

    // item6 (type500) thin bids: 30 fillable @5 => 150 gross, net 142.46 after 5.025% tax.
    const thin = byItem.get(6)!;
    expect(thin.bidLiquidationGross).toBe(150);
    expect(thin.bidLiquidationNet).toBe(142.46);
    expect(thin.fillableQuantity).toBe(30);
    expect(thin.unfillableQuantity).toBe(70);
    expect(thin.statuses).toContain('INSUFFICIENT_DEPTH');
    expect(thin.statuses).toContain('PARTIALLY_VALUED');

    // E: perspectives stay separate; cost basis is UNKNOWN, never inferred.
    expect(run.totals.costBasis).toBeNull();
    expect(run.totals.marketReferenceValue).not.toBeNull();
    expect(run.totals.bidLiquidationNet).not.toBeNull();
    expect(run.totals.askReplacementGross).not.toBeNull();
    // No single field equals the naive sum of all three perspectives.
    const naiveSum = (run.totals.marketReferenceValue ?? 0)
      + (run.totals.bidLiquidationNet ?? 0) + (run.totals.askReplacementGross ?? 0);
    expect(Object.values(run.totals)).not.toContain(naiveSum);
  });

  it('persists the run with fee model and snapshot provenance and keeps history', () => {
    const first = RealValuationService.run(db as Db, CHARACTER_ID, LINEAGE);
    const second = RealValuationService.run(db as Db, CHARACTER_ID, LINEAGE);

    const runs = RealValuationService.listRuns(db as Db, CHARACTER_ID, LINEAGE);
    expect(runs).toHaveLength(2);
    expect(runs[0].valuation_id).toBe(second.valuationId);
    expect(runs[0].fee_model_version).toBe(FEE_MODEL_VERSION);
    expect(runs[0].market_snapshot_at).toBeTruthy();
    expect(runs[0].status).toBe('COMPLETED');

    const detail = RealValuationService.getRun(db as Db, CHARACTER_ID, first.valuationId, LINEAGE)!;
    expect(detail.items).toHaveLength(6);
    expect(detail.items[0].statuses).toContain('VALUED');
    expect(detail.items[0].flags).toBeInstanceOf(Array);

    const totals = RealValuationService.latestTotals(db as Db, CHARACTER_ID, LINEAGE)!;
    expect(totals.valuationId).toBe(second.valuationId);
    expect(totals.costBasis).toBeNull();
    expect(totals.costBasisStatus).toBe('UNKNOWN_PENDING_P9_3');
    expect(totals.items).toBe(6);
  });

  it('rejects valuation without a complete snapshot and records the failure', () => {
    db.prepare("UPDATE real_asset_snapshots SET status = 'FAILED' WHERE snapshot_id = 'SNAP-VAL-1'").run();
    expect(() => RealValuationService.run(db as Db, CHARACTER_ID, LINEAGE)).toThrow(/完整资产快照/);
    // A FAILED header row is not created when no snapshot exists at all.
    expect(RealValuationService.listRuns(db as Db, CHARACTER_ID, LINEAGE)).toHaveLength(0);
  });
});
