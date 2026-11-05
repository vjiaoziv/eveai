import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    eve: {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      callbackUrl: 'http://localhost:3000/auth/eve/callback',
      requestTimeoutMs: 5000,
    },
    esi: {
      baseUrl: 'https://esi.evetech.net/latest/',
      specUrl: 'https://esi.evetech.net/latest/swagger.json',
      catalogCachePath: './data/cache/esi-swagger.json',
      compatibilityDate: '2026-03-15',
      userAgent: 'EVEAI/4.0 (+https://github.com/example/eveai; contact=operator@example.com)',
      maxPages: 5,
      backoffMaxSeconds: 1,
      requestTimeoutMs: 5000,
      retryMaxAttempts: 1,
    },
    characterSync: {
      maxPages: 50,
      fallbackTtlSeconds: 3600,
      errorRetrySeconds: 120,
    },
    assetSync: {
      enabled: true,
      intervalMinutes: 30,
      staleJobMinutes: 30,
    },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720 },
  },
}));

import { RealAssetSyncService } from '../../src/assets/asset-sync-service.js';
import { AssetLocationResolver, type AssetItemRegistry } from '../../src/assets/location-resolver.js';
import type { Db } from '../../src/db/sqlite.js';

const CHARACTER_ID = 90000001;
const OTHER_CHARACTER_ID = 90000002;
const USER_ID = 1;
const CHAT_ID = 100;
const ASSET_SCOPES = ['esi-assets.read_assets.v1', 'esi-wallet.read_character_wallet.v1'];

let db: Database.Database;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3600_000).toUTCString(),
      ...headers,
    },
  });
}

function linkCharacter(characterId = CHARACTER_ID, chatId = CHAT_ID): void {
  db.prepare('INSERT OR IGNORE INTO users (display_name, active_character_id) VALUES (?, ?)')
    .run('pilot', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(chatId, 'pilot', characterId);
  db.prepare(`
    INSERT OR IGNORE INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, ?, 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?)
  `).run(characterId, `Pilot ${characterId}`, JSON.stringify(ASSET_SCOPES), USER_ID);
  db.prepare('INSERT OR IGNORE INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(chatId, characterId, USER_ID);
}

function seedSde(): void {
  db.exec(`
    INSERT INTO sde_regions (region_id, name, data_json)
    VALUES (10000002, 'The Forge', '{}'), (10000043, 'Domain', '{}');
    INSERT INTO sde_constellations (constellation_id, name, region_id, data_json)
    VALUES (20000001, 'Kimotoro', 10000002, '{}'), (20000002, 'Aridia', 10000043, '{}');
    INSERT INTO sde_systems (system_id, name, constellation_id, data_json)
    VALUES (30000142, 'Jita', 20000001, '{}'), (30000218, 'Amarr', 20000002, '{}');
    INSERT INTO sde_stations (station_id, name, system_id, data_json)
    VALUES (60003760, 'Jita Trade Hub', 30000142, '{}');
  `);
}

type AssetFixture = Array<Record<string, unknown>>;

function clearEsiCache(): void {
  // ESI GETs are cached with Expires; between rounds the tests must force the
  // mock to actually run (the dedupe assertion itself is hash-based).
  db.prepare('DELETE FROM esi_cache').run();
}

function baseAssets(): AssetFixture {
  return [
    { item_id: 1, type_id: 34, location_id: 60003760, location_type: 'station', location_flag: 'Hangar', quantity: 100, is_singleton: false },
    { item_id: 2, type_id: 587, location_id: 60003760, location_type: 'station', location_flag: 'Hangar', quantity: 5, is_singleton: true },
    // Nested: item 3 lives inside ship item 4, which sits in the station.
    { item_id: 4, type_id: 587, location_id: 60003760, location_type: 'station', location_flag: 'Hangar', quantity: 1, is_singleton: true },
    { item_id: 3, type_id: 34, location_id: 4, location_type: 'item', location_flag: 'Cargo', quantity: 42, is_singleton: false },
  ];
}

function mockAssetsResponse(pages: AssetFixture[][], opts: { failPage?: number } = {}): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/assets/')) {
      const match = url.match(/[?&]page=(\d+)/);
      const page = match ? Number(match[1]) : 1;
      if (opts.failPage === page) {
        return new Response(JSON.stringify({ error: 'upstream broken' }), { status: 500 });
      }
      return jsonResponse(pages[page - 1] ?? [], { 'X-Pages': String(pages.length) });
    }
    return jsonResponse([]);
  });
}

beforeEach(() => {
  vi.useRealTimers();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  seedSde();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  db.close();
});

const CTX = { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID };

describe('real asset sync (P9.2.1)', () => {
  it('commits a complete paginated sync as an immutable snapshot', async () => {
    linkCharacter();
    mockAssetsResponse([baseAssets().slice(0, 2), baseAssets().slice(2)]);

    const result = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');

    expect(result.job.status).toBe('COMPLETED');
    expect(result.job.pagesTotal).toBe(2);
    expect(result.job.pagesFetched).toBe(2);
    expect(result.itemsFetched).toBe(4);
    expect(result.itemsCommitted).toBe(4);
    expect(result.deduped).toBe(false);

    const snapshot = db.prepare(
      "SELECT * FROM real_asset_snapshots WHERE character_id = ? AND is_latest = 1",
    ).get(CHARACTER_ID) as any;
    expect(snapshot.status).toBe('COMPLETED');
    expect(snapshot.total_items).toBe(4);
    expect(snapshot.total_unique_types).toBe(2);
    expect(snapshot.total_locations).toBe(2);
    expect(snapshot.total_quantity).toBe(148);
    expect(snapshot.data_hash).toMatch(/^[0-9a-f]{64}$/);

    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 4 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshot_items WHERE snapshot_id = ?').get(snapshot.snapshot_id))
      .toEqual({ n: 4 });
    // First snapshot records no changes.
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_changes WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 0 });
    // Location cache resolved the station and the nested parent chain.
    const station = db.prepare('SELECT * FROM real_asset_locations WHERE location_id = 60003760').get() as any;
    expect(station.resolution_status).toBe('RESOLVED');
    expect(station.location_type).toBe('STATION');
    expect(station.solar_system_name).toBe('Jita');
    const nested = db.prepare('SELECT parent_item_id FROM real_asset_snapshot_items WHERE snapshot_id = ? AND item_id = 3')
      .get(snapshot.snapshot_id) as any;
    expect(nested.parent_item_id).toBe(4);
  });

  it('dedupes an identical resync instead of copying the snapshot again', async () => {
    linkCharacter();
    mockAssetsResponse([baseAssets()]);
    await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');
    clearEsiCache();
    const second = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'auto');

    expect(second.deduped).toBe(true);
    expect(second.itemsCommitted).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 1 });
    expect(second.job.status).toBe('COMPLETED');
  });

  it('keeps the previous snapshot and current set when a later page fails', async () => {
    linkCharacter();
    mockAssetsResponse([baseAssets()]);
    const first = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');
    expect(first.itemsCommitted).toBe(4);

    clearEsiCache();
    mockAssetsResponse([baseAssets().slice(0, 2), baseAssets().slice(2)], { failPage: 2 });
    await expect(RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow();

    const job = RealAssetSyncService.latestJob(db as Db, CHARACTER_ID)!;
    expect(job.status).toBe('FAILED');
    expect(job.lastError).toBeTruthy();
    // Current set and latest snapshot untouched by the failed run.
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 4 });
    const latest = db.prepare(
      "SELECT snapshot_id FROM real_asset_snapshots WHERE character_id = ? AND is_latest = 1",
    ).get(CHARACTER_ID) as any;
    expect(latest.snapshot_id).toBe(first.snapshotId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 1 });
  });

  it('rejects malformed rows instead of committing a partial normalisation', async () => {
    linkCharacter();
    mockAssetsResponse([baseAssets()]);
    await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');

    clearEsiCache();
    mockAssetsResponse([[{ item_id: 9, type_id: 34, quantity: 1 }]]); // no location_id
    await expect(RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/location_id/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 4 });
    expect(RealAssetSyncService.latestJob(db as Db, CHARACTER_ID)!.status).toBe('FAILED');
  });

  it('P9.3.3.8: verifies the actual persisted snapshot item set before COMPLETED', async () => {
    linkCharacter();
    mockAssetsResponse([baseAssets()]);
    const first = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');

    clearEsiCache();
    mockAssetsResponse([[{ item_id: 9, type_id: 34, location_id: 60003760, location_type: 'station', location_flag: 'Hangar', quantity: 1, is_singleton: false }]]);
    db.exec(`
      CREATE TRIGGER p9338_drop_snapshot_item_after_insert
      AFTER INSERT ON real_asset_snapshot_items
      WHEN NEW.item_id = 9
      BEGIN
        DELETE FROM real_asset_snapshot_items WHERE snapshot_id = NEW.snapshot_id AND item_id = NEW.item_id;
      END;
    `);

    await expect(RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/持久化回读校验失败/);

    const latest = db.prepare(
      "SELECT snapshot_id, status FROM real_asset_snapshots WHERE character_id = ? AND is_latest = 1",
    ).get(CHARACTER_ID) as { snapshot_id: string; status: string };
    expect(latest).toEqual({ snapshot_id: first.snapshotId, status: 'COMPLETED' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(CHARACTER_ID)).toEqual({ n: 4 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?').get(CHARACTER_ID)).toEqual({ n: 1 });
    expect(RealAssetSyncService.latestJob(db as Db, CHARACTER_ID)!.status).toBe('FAILED');
  });

  it('P9.3.3.8: rejects duplicate ESI item ids and preserves the previous complete set', async () => {
    linkCharacter();
    mockAssetsResponse([baseAssets()]);
    const first = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');

    clearEsiCache();
    const duplicate = baseAssets()[0];
    mockAssetsResponse([[duplicate, { ...duplicate, quantity: 99 }]]);
    await expect(RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/item_id .*重复/);

    expect(db.prepare("SELECT snapshot_id, status FROM real_asset_snapshots WHERE character_id = ? AND is_latest = 1")
      .get(CHARACTER_ID)).toEqual({ snapshot_id: first.snapshotId, status: 'COMPLETED' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 4 });
    expect(RealAssetSyncService.latestJob(db as Db, CHARACTER_ID)!.status).toBe('FAILED');
  });

  it('P9.3.3.8: invalidates dedupe when canonical hash algorithm or version changes', async () => {
    linkCharacter();
    mockAssetsResponse([baseAssets()]);
    const first = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');

    db.prepare('UPDATE real_asset_snapshots SET canonical_version = canonical_version + 1 WHERE snapshot_id = ?')
      .run(first.snapshotId);
    clearEsiCache();
    mockAssetsResponse([baseAssets()]);
    const versionChanged = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');
    expect(versionChanged.deduped).toBe(false);
    expect(versionChanged.snapshotId).not.toBe(first.snapshotId);

    db.prepare("UPDATE real_asset_snapshots SET hash_algorithm = 'sha512' WHERE snapshot_id = ?")
      .run(versionChanged.snapshotId);
    clearEsiCache();
    mockAssetsResponse([baseAssets()]);
    const algorithmChanged = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');
    expect(algorithmChanged.deduped).toBe(false);
    expect(algorithmChanged.snapshotId).not.toBe(versionChanged.snapshotId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 3 });
  });

  it('P9.3.3.8: treats persisted null and false blueprint flags as different asset facts', async () => {
    linkCharacter();
    const unknownBlueprint: AssetFixture = [{
      item_id: 9100,
      type_id: 34,
      location_id: 60003760,
      location_type: 'station',
      location_flag: 'Hangar',
      quantity: 1,
      is_singleton: false,
    }];
    mockAssetsResponse([unknownBlueprint]);
    const first = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');
    expect(db.prepare(
      'SELECT is_blueprint_copy FROM real_asset_snapshot_items WHERE snapshot_id = ? AND item_id = 9100',
    ).get(first.snapshotId)).toEqual({ is_blueprint_copy: null });

    clearEsiCache();
    mockAssetsResponse([[{ ...unknownBlueprint[0], is_blueprint_copy: false }]]);
    const knownFalse = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');
    expect(knownFalse.deduped).toBe(false);
    expect(db.prepare(
      'SELECT is_blueprint_copy FROM real_asset_snapshot_items WHERE snapshot_id = ? AND item_id = 9100',
    ).get(knownFalse.snapshotId)).toEqual({ is_blueprint_copy: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 2 });
  });

  it('records observed quantity/location changes between complete snapshots', async () => {
    linkCharacter();
    mockAssetsResponse([baseAssets()]);
    await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');

    const changed: AssetFixture = [
      { item_id: 1, type_id: 34, location_id: 60003760, location_type: 'station', location_flag: 'Hangar', quantity: 250, is_singleton: false },
      { item_id: 2, type_id: 587, location_id: 30000142, location_type: 'solar_system', location_flag: 'Hangar', quantity: 5, is_singleton: true },
      { item_id: 4, type_id: 587, location_id: 60003760, location_type: 'station', location_flag: 'Hangar', quantity: 1, is_singleton: true },
      { item_id: 3, type_id: 34, location_id: 4, location_type: 'item', location_flag: 'Cargo', quantity: 42, is_singleton: false },
      { item_id: 7, type_id: 34, location_id: 60003760, location_type: 'station', location_flag: 'Hangar', quantity: 1, is_singleton: false },
    ];
    clearEsiCache();
    mockAssetsResponse([changed]);
    const second = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');
    expect(second.deduped).toBe(false);
    expect(second.changesRecorded).toBeGreaterThanOrEqual(3);

    const changes = db.prepare(
      'SELECT change_type, prev_quantity, new_quantity, source_class FROM real_asset_changes WHERE character_id = ? ORDER BY change_type',
    ).all(CHARACTER_ID) as Array<{ change_type: string; prev_quantity: number | null; new_quantity: number | null; source_class: string }>;
    const byType = new Map(changes.map((row) => [row.change_type, row]));
    expect(byType.get('QTY_INCREASED')).toMatchObject({ prev_quantity: 100, new_quantity: 250, source_class: 'OBSERVED_CHANGE' });
    expect(byType.get('MOVED')).toBeTruthy();
    expect(byType.get('ADDED')).toMatchObject({ prev_quantity: null, new_quantity: 1 });
    // item 2 moved to the system; item 1 stayed: no false REMOVED for kept items.
    expect(byType.has('REMOVED')).toBe(false);
  });

  it('blocks a second concurrent sync for the same character and reclaims stale jobs', async () => {
    linkCharacter();
    db.prepare(`
      INSERT INTO real_asset_sync_jobs (job_id, character_id, trigger, status, phase, started_at)
      VALUES ('ASSETJOB-stuck', ?, 'manual', 'RUNNING', 'fetch', datetime('now'))
    `).run(CHARACTER_ID);

    await expect(RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/已有资产同步任务在运行/);
    expect(fetchMock).not.toHaveBeenCalled();

    // Age the RUNNING job past the stale window: it is reclaimed, then sync proceeds.
    db.prepare("UPDATE real_asset_sync_jobs SET started_at = datetime('now', '-2 hours') WHERE job_id = 'ASSETJOB-stuck'")
      .run();
    mockAssetsResponse([baseAssets()]);
    const result = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');
    expect(result.job.status).toBe('COMPLETED');
    const stuck = db.prepare("SELECT status, last_error FROM real_asset_sync_jobs WHERE job_id = 'ASSETJOB-stuck'").get() as any;
    expect(stuck.status).toBe('FAILED');
    expect(stuck.last_error).toContain('stale');
  });

  it('keeps two linked characters fully isolated', async () => {
    linkCharacter(CHARACTER_ID, CHAT_ID);
    linkCharacter(OTHER_CHARACTER_ID, CHAT_ID + 1);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const charMatch = url.match(/\/characters\/(\d+)\/assets\//);
      const characterId = charMatch ? Number(charMatch[1]) : 0;
      const payload = characterId === OTHER_CHARACTER_ID
        ? [{ item_id: 50, type_id: 34, location_id: 30000142, location_type: 'solar_system', location_flag: 'Cargo', quantity: 7, is_singleton: false }]
        : baseAssets();
      return jsonResponse(payload, { 'X-Pages': '1' });
    });

    await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');
    await RealAssetSyncService.syncCharacter(
      db as Db, OTHER_CHARACTER_ID,
      { userId: USER_ID, chatId: CHAT_ID + 1, characterId: OTHER_CHARACTER_ID },
      'manual',
    );

    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 4 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(OTHER_CHARACTER_ID))
      .toEqual({ n: 1 });
    const snapshots = db.prepare(
      'SELECT character_id, COUNT(*) AS n FROM real_asset_snapshots GROUP BY character_id ORDER BY character_id',
    ).all() as Array<{ character_id: number; n: number }>;
    expect(snapshots).toEqual([
      { character_id: CHARACTER_ID, n: 1 },
      { character_id: OTHER_CHARACTER_ID, n: 1 },
    ]);
  });
});

describe('asset location resolver (P9.2.2)', () => {
  it('resolves stations, systems, nested parents, structures and unknown ids', () => {
    const registry: AssetItemRegistry = new Map([
      [4, { typeId: 587, locationId: 60003760 }],
      [3, { typeId: 34, locationId: 4 }],
      [9, { typeId: 34, locationId: 999_999 }], // self-referential guard case
    ]);

    const station = AssetLocationResolver.resolve(db as Db, 60003760, registry);
    expect(station).toMatchObject({
      locationType: 'STATION',
      resolutionStatus: 'RESOLVED',
      solarSystemName: 'Jita',
      regionName: 'The Forge',
      resolutionSource: 'sde_stations',
    });

    const system = AssetLocationResolver.resolve(db as Db, 30000142, registry);
    expect(system).toMatchObject({ locationType: 'SOLAR_SYSTEM', resolutionStatus: 'RESOLVED' });

    // Item hosted inside ship 4 -> climbs to the station terminal.
    const nested = AssetLocationResolver.resolve(db as Db, 3, registry, 'item');
    expect(nested.parentLocationId).toBe(4);
    expect(nested.locationType).toBe('CONTAINER');
    expect(nested.resolutionStatus).toBe('RESOLVED');
    expect(nested.solarSystemName).toBe('Jita');
    expect(nested.resolutionSource).toContain('snapshot_parent');

    const structure = AssetLocationResolver.resolve(db as Db, 1030000000000, registry, 'structure');
    expect(structure).toMatchObject({ locationType: 'STRUCTURE', resolutionStatus: 'ACCESS_RESTRICTED' });

    const unknown = AssetLocationResolver.resolve(db as Db, 42424242, registry, null);
    expect(unknown).toMatchObject({ locationType: 'UNKNOWN', resolutionStatus: 'UNKNOWN', locationName: null });
    // Unknown ids keep their raw id and are never invented into a name.
    expect(unknown.locationId).toBe(42424242);

    const cycle = AssetLocationResolver.resolve(db as Db, 9, registry);
    expect(cycle.resolutionStatus).not.toBe('RESOLVED');
  });

  it('bulk-upserts the resolution cache', () => {
    const registry: AssetItemRegistry = new Map();
    const out = AssetLocationResolver.resolveMany(db as Db, [60003760, 30000142, 42424242], registry);
    expect(out.size).toBe(3);
    const rows = db.prepare('SELECT location_id, resolution_status FROM real_asset_locations ORDER BY location_id').all() as any[];
    expect(rows).toEqual([
      { location_id: 30000142, resolution_status: 'RESOLVED' },
      { location_id: 42424242, resolution_status: 'UNKNOWN' },
      { location_id: 60003760, resolution_status: 'RESOLVED' },
    ]);
  });
});
