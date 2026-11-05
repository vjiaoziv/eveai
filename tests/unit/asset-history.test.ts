import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { RealAssetHistoryService } from '../../src/assets/history-service.js';
import type { Db } from '../../src/db/sqlite.js';
import { testAssetLineage } from '../helpers/asset-lineage.js';

const CHARACTER_ID = 90000031;
const OTHER_CHARACTER_ID = 90000032;
const JITA = 60003760;
const AMARR = 60008494;
const LINEAGE = testAssetLineage(CHARACTER_ID);
const OTHER_LINEAGE = testAssetLineage(OTHER_CHARACTER_ID);

let db: Database.Database;

function insertSnapshot(
  snapshotId: string,
  characterId: number,
  completedAt: string,
  isLatest = false,
  status = 'COMPLETED',
): void {
  db.prepare(`
    INSERT INTO real_asset_snapshots
      (snapshot_id, character_id, job_id, started_at, completed_at, status,
       total_items, total_unique_types, total_locations, total_quantity,
       data_hash, source, is_latest, owner_user_id, owner_chat_id, binding_epoch, binding_digest)
    VALUES (?, ?, NULL, ?, ?, ?, 0, 0, 0, 0, ?, 'esi_character_assets', ?, ?, ?, ?, ?)
  `).run(
    snapshotId, characterId, completedAt, completedAt, status, `hash-${snapshotId}`, isLatest ? 1 : 0,
    LINEAGE.ownerUserId, LINEAGE.ownerChatId, LINEAGE.bindingEpoch, LINEAGE.bindingDigest,
  );
}

function insertItem(
  snapshotId: string,
  itemId: number,
  typeId: number,
  quantity: number,
  locationId: number,
  parentItemId: number | null = null,
): void {
  db.prepare(`
    INSERT INTO real_asset_snapshot_items
      (snapshot_id, item_id, type_id, quantity, location_id, location_type,
       location_flag, is_singleton, is_blueprint_copy, parent_item_id, raw_json)
    VALUES (?, ?, ?, ?, ?, 'station', 'Hangar', 0, 0, ?, '{}')
  `).run(snapshotId, itemId, typeId, quantity, locationId, parentItemId);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.exec(`
    INSERT INTO sde_types (type_id, name, group_id, data_json)
    VALUES (34, 'Tritanium', NULL, '{"name":{"en":"Tritanium","zh":"三钛合金"}}'),
           (587, 'Rifter', NULL, '{"name":{"en":"Rifter","zh":"穿梭机"}}');
    INSERT INTO real_asset_locations
      (location_id, location_type, location_name, solar_system_id, solar_system_name,
       region_id, region_name, parent_location_id, resolution_status, resolution_source, resolved_at)
    VALUES (${JITA}, 'STATION', 'Jita Trade Hub', 30000142, 'Jita', 10000002, 'The Forge',
            NULL, 'RESOLVED', 'sde_stations', datetime('now')),
           (${AMARR}, 'STATION', 'Amarr Trade Hub', 30000218, 'Amarr', 10000043, 'Domain',
            NULL, 'RESOLVED', 'sde_stations', datetime('now'));

    INSERT INTO real_asset_snapshots
      (snapshot_id, character_id, job_id, started_at, completed_at, status,
       total_items, total_unique_types, total_locations, total_quantity, data_hash, source, is_latest,
       owner_user_id, owner_chat_id, binding_epoch, binding_digest)
    VALUES
      ('SNAP-H-1', ${CHARACTER_ID}, NULL, '2026-11-03T01:00:00.000Z', '2026-11-03T01:00:10.000Z',
       'COMPLETED', 2, 2, 1, 110, 'hash-1', 'esi_character_assets', 0,
       ${LINEAGE.ownerUserId}, ${LINEAGE.ownerChatId}, ${LINEAGE.bindingEpoch}, '${LINEAGE.bindingDigest}'),
      ('SNAP-H-2', ${CHARACTER_ID}, NULL, '2026-11-03T02:00:00.000Z', '2026-11-03T02:00:10.000Z',
       'COMPLETED', 3, 3, 2, 155, 'hash-2', 'esi_character_assets', 1,
       ${LINEAGE.ownerUserId}, ${LINEAGE.ownerChatId}, ${LINEAGE.bindingEpoch}, '${LINEAGE.bindingDigest}'),
      ('SNAP-H-FAIL', ${CHARACTER_ID}, NULL, '2026-11-03T03:00:00.000Z', '2026-11-03T03:00:10.000Z',
       'FAILED', 0, 0, 0, 0, 'hash-fail', 'esi_character_assets', 0,
       ${LINEAGE.ownerUserId}, ${LINEAGE.ownerChatId}, ${LINEAGE.bindingEpoch}, '${LINEAGE.bindingDigest}'),
      ('SNAP-H-OTHER', ${OTHER_CHARACTER_ID}, NULL, '2026-11-03T01:00:00.000Z', '2026-11-03T01:00:10.000Z',
       'COMPLETED', 1, 1, 1, 1, 'hash-other', 'esi_character_assets', 1,
       ${OTHER_LINEAGE.ownerUserId}, ${OTHER_LINEAGE.ownerChatId}, ${OTHER_LINEAGE.bindingEpoch}, '${OTHER_LINEAGE.bindingDigest}');

    INSERT INTO real_asset_snapshot_items (snapshot_id, item_id, type_id, quantity, location_id,
      location_type, location_flag, is_singleton, is_blueprint_copy, parent_item_id, raw_json)
    VALUES
      ('SNAP-H-1', 1, 34, 100, ${JITA}, 'station', 'Hangar', 0, 0, NULL, '{}'),
      ('SNAP-H-1', 2, 587, 10, ${JITA}, 'station', 'Hangar', 1, 0, NULL, '{}'),
      ('SNAP-H-1', 4, 587, 1, ${JITA}, 'station', 'Hangar', 1, 0, NULL, '{}'),
      ('SNAP-H-2', 1, 34, 145, ${AMARR}, 'station', 'Hangar', 0, 0, NULL, '{}'),
      ('SNAP-H-2', 2, 587, 10, ${JITA}, 'station', 'Hangar', 1, 0, NULL, '{}'),
      ('SNAP-H-2', 3, 587, 1, ${JITA}, 'station', 'Hangar', 1, 0, 2, '{}'),
      ('SNAP-H-2', 4, 587, 1, ${JITA}, 'station', 'Hangar', 1, 0, 2, '{}'),
      ('SNAP-H-OTHER', 99, 34, 1, ${JITA}, 'station', 'Hangar', 0, 0, NULL, '{}');

    INSERT INTO real_asset_changes
      (change_id, character_id, item_id, type_id, change_type, prev_quantity, new_quantity,
       prev_location_id, new_location_id, source_class, confidence,
       from_snapshot_id, to_snapshot_id, detected_at,
       owner_user_id, owner_chat_id, binding_epoch, binding_digest)
    VALUES
      ('CHG-H-1', ${CHARACTER_ID}, 1, 34, 'QTY_INCREASED', 100, 145, ${JITA}, ${JITA},
       'OBSERVED_CHANGE', 'HIGH', 'SNAP-H-1', 'SNAP-H-2', '2026-11-03T02:00:10.000Z',
       ${LINEAGE.ownerUserId}, ${LINEAGE.ownerChatId}, ${LINEAGE.bindingEpoch}, '${LINEAGE.bindingDigest}'),
      ('CHG-H-2', ${CHARACTER_ID}, 1, 34, 'MOVED', 145, 145, ${JITA}, ${AMARR},
       'OBSERVED_CHANGE', 'HIGH', 'SNAP-H-1', 'SNAP-H-2', '2026-11-03T02:00:10.000Z',
       ${LINEAGE.ownerUserId}, ${LINEAGE.ownerChatId}, ${LINEAGE.bindingEpoch}, '${LINEAGE.bindingDigest}'),
      ('CHG-H-OTHER', ${OTHER_CHARACTER_ID}, 99, 34, 'ADDED', NULL, 1, NULL, ${JITA},
       'OBSERVED_CHANGE', 'HIGH', NULL, 'SNAP-H-OTHER', '2026-11-03T01:00:10.000Z',
       ${OTHER_LINEAGE.ownerUserId}, ${OTHER_LINEAGE.ownerChatId}, ${OTHER_LINEAGE.bindingEpoch}, '${OTHER_LINEAGE.bindingDigest}');
  `);
});

afterEach(() => {
  db.close();
});

describe('asset snapshot history (P9.2.5)', () => {
  it('filters snapshots by character, status and date without exposing failed runs as valid history', () => {
    const completed = RealAssetHistoryService.listSnapshots(db as Db, {
      characterId: CHARACTER_ID,
      status: 'COMPLETED',
      from: '2026-11-03',
      to: '2026-11-03',
    }, LINEAGE);
    expect(completed.total).toBe(2);
    expect(completed.rows.map((row) => row.snapshot_id)).toEqual(['SNAP-H-2', 'SNAP-H-1']);

    const all = RealAssetHistoryService.listSnapshots(db as Db, { characterId: CHARACTER_ID }, LINEAGE);
    expect(all.total).toBe(3);
    expect(all.rows.map((row) => row.snapshot_id)).toContain('SNAP-H-FAIL');
  });

  it('clamps pagination inputs before they reach SQLite', () => {
    const snapshots = RealAssetHistoryService.listSnapshots(db as Db, {
      characterId: CHARACTER_ID,
      limit: Number.NaN,
      offset: Number.POSITIVE_INFINITY,
    }, LINEAGE);
    expect(snapshots.limit).toBe(50);
    expect(snapshots.offset).toBe(0);

    const changes = RealAssetHistoryService.listChanges(db as Db, {
      characterId: CHARACTER_ID,
      limit: 1,
      offset: 2_000_000,
    }, LINEAGE);
    expect(changes.limit).toBe(1);
    expect(changes.offset).toBe(1_000_000);
  });

  it('lists persisted observed changes with Chinese labels and strict character scoping', () => {
    const result = RealAssetHistoryService.listChanges(db as Db, {
      characterId: CHARACTER_ID,
      changeType: 'MOVED',
    }, LINEAGE);
    expect(result.total).toBe(1);
    expect(result.rows[0]).toMatchObject({
      change_id: 'CHG-H-2',
      changeLabelZh: '位置变化',
      source_class: 'OBSERVED_CHANGE',
      prev_location_name: 'Jita Trade Hub',
      new_location_name: 'Amarr Trade Hub',
    });

    const other = RealAssetHistoryService.listChanges(db as Db, { characterId: OTHER_CHARACTER_ID }, OTHER_LINEAGE);
    expect(other.total).toBe(1);
    expect(other.rows[0].change_id).toBe('CHG-H-OTHER');
  });

  it('compares two complete snapshots and reports each observed difference without causal attribution', () => {
    const result = RealAssetHistoryService.compare(db as Db, CHARACTER_ID, 'SNAP-H-1', 'SNAP-H-2', LINEAGE);
    expect(result.summary).toEqual({
      QTY_INCREASED: 1,
      MOVED: 1,
      ADDED: 1,
      CONTAINER_CHANGED: 1,
    });
    expect(result.changes.every((row) => row.sourceClass === 'OBSERVED_CHANGE')).toBe(true);
    expect(result.changes.some((row) => row.changeType === 'REMOVED')).toBe(false);
    expect(() => RealAssetHistoryService.compare(db as Db, CHARACTER_ID, 'SNAP-H-1', 'SNAP-H-FAIL', LINEAGE))
      .toThrow(/完整资产快照/);
    expect(() => RealAssetHistoryService.compare(db as Db, CHARACTER_ID, 'SNAP-H-1', 'SNAP-H-1', LINEAGE))
      .toThrow(/自身/);
  });

  it('returns item history and complete-snapshot totals with deterministic deltas', () => {
    const item = RealAssetHistoryService.itemHistory(db as Db, CHARACTER_ID, 1, LINEAGE);
    expect(item.currentQuantity).toBeNull(); // current set is not seeded in this focused test
    expect(item.snapshots.map((row) => row.snapshot_id)).toEqual(['SNAP-H-2', 'SNAP-H-1']);
    expect(item.changes.map((row) => row.change_id)).toEqual(['CHG-H-2', 'CHG-H-1']);

    const totals = RealAssetHistoryService.totalsHistory(db as Db, CHARACTER_ID, LINEAGE);
    expect(totals).toHaveLength(2);
    expect(totals[0]).toMatchObject({ snapshot_id: 'SNAP-H-1', deltaQuantity: null });
    expect(totals[1]).toMatchObject({
      snapshot_id: 'SNAP-H-2',
      deltaItems: 1,
      deltaQuantity: 45,
      previousSnapshotId: 'SNAP-H-1',
    });
  });
});
