import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { RealAssetSyncService } from '../../src/assets/asset-sync-service.js';
import { resolveAssetLineage } from '../../src/assets/asset-lineage.js';
import { deleteCharacterData } from '../../src/db/character-datastore.js';
import type { Db } from '../../src/db/sqlite.js';

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
    characterSync: { maxPages: 50, fallbackTtlSeconds: 3600, errorRetrySeconds: 120 },
    assetSync: {
      enabled: true,
      intervalMinutes: 30,
      staleJobMinutes: 30,
      leaseTtlSeconds: 180,
      heartbeatSeconds: 45,
    },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720 },
  },
}));

const USER_A = 9_766_001;
const USER_B = 9_766_002;
const CHARACTER_ID = 9_766_201;
const CHAT_A = 9_766_101;
const CHAT_B = 9_766_102;
const SCOPE = 'esi-assets.read_assets.v1';
const CTX_A = { userId: USER_A, chatId: CHAT_A, characterId: CHARACTER_ID };
const CTX_B = { userId: USER_B, chatId: CHAT_B, characterId: CHARACTER_ID };

let db: Db;

function rows(quantity = 4): unknown[] {
  return [
    {
      item_id: 98_001,
      type_id: 34,
      location_id: 60_003_760,
      location_type: 'station',
      location_flag: 'Hangar',
      quantity,
      is_singleton: false,
      is_blueprint_copy: false,
    },
    {
      item_id: 98_002,
      type_id: 35,
      location_id: 60_003_760,
      location_type: 'station',
      location_flag: 'Hangar',
      quantity: 2,
      is_singleton: false,
      is_blueprint_copy: false,
    },
  ];
}

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      'X-Pages': '1',
    },
  });
}

function linkCharacter(userId: number, chatId: number, ownerHash: string): void {
  db.prepare('INSERT OR IGNORE INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(userId, `binding-user-${userId}`, CHARACTER_ID);
  db.prepare('INSERT OR IGNORE INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(chatId, `binding-chat-${chatId}`, CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'Binding Pilot', 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET
      scopes_json = excluded.scopes_json,
      user_id = excluded.user_id,
      owner_hash = excluded.owner_hash,
      expires_at = excluded.expires_at
  `).run(CHARACTER_ID, JSON.stringify([SCOPE]), userId, ownerHash);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(chatId, CHARACTER_ID, userId);
}

function latestLineageSnapshot(userId: number, chatId: number): { snapshot_id: string; total_quantity: number } {
  const lineage = resolveAssetLineage(db, CHARACTER_ID, userId, chatId);
  return db.prepare(`
    SELECT snapshot_id, total_quantity
    FROM real_asset_snapshots
    WHERE character_id = ? AND is_latest = 1
      AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ? AND binding_digest = ?
  `).get(
    CHARACTER_ID,
    lineage.ownerUserId,
    lineage.ownerChatId,
    lineage.bindingEpoch,
    lineage.bindingDigest,
  ) as { snapshot_id: string; total_quantity: number };
}

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:') as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  linkCharacter(USER_A, CHAT_A, 'owner-a');
});

afterEach(() => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

describe('P9.3.3.6 binding-aware and mirror-aware dedup', () => {
  it('dedupes only when lineage, canonical hash and the complete current mirror and snapshot items agree', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(rows())));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX_A, 'manual');
    const duplicate = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX_A, 'manual');

    expect(first).toMatchObject({ deduped: false, itemsCommitted: 2 });
    expect(duplicate).toMatchObject({ deduped: true, snapshotId: first.snapshotId, itemsCommitted: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshot_items WHERE snapshot_id = ?')
      .get(first.snapshotId)).toEqual({ n: 2 });
  });

  it('forces a rebuild when the current mirror is empty even if the old hash is unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(rows())));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX_A, 'manual');
    db.prepare('DELETE FROM character_assets WHERE character_id = ?').run(CHARACTER_ID);

    const rebuilt = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX_A, 'manual');
    expect(rebuilt).toMatchObject({ deduped: false, itemsCommitted: 2 });
    expect(rebuilt.snapshotId).not.toBe(first.snapshotId);
    expect(latestLineageSnapshot(USER_A, CHAT_A)).toEqual({
      snapshot_id: rebuilt.snapshotId,
      total_quantity: 6,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 2 });
  });

  it('forces a rebuild when the current mirror is partial rather than silently completing a deduped job', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(rows())));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX_A, 'manual');
    db.prepare('DELETE FROM character_assets WHERE character_id = ? AND item_id = ?')
      .run(CHARACTER_ID, 98_002);

    const rebuilt = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX_A, 'manual');
    expect(rebuilt).toMatchObject({ deduped: false, itemsCommitted: 2 });
    expect(rebuilt.snapshotId).not.toBe(first.snapshotId);
    expect(db.prepare('SELECT item_id FROM character_assets WHERE character_id = ? ORDER BY item_id')
      .all(CHARACTER_ID)).toEqual([{ item_id: 98_001 }, { item_id: 98_002 }]);
  });

  it('increments the binding epoch on same-user unlink/rebind and isolates the new snapshot lineage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(rows())));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX_A, 'manual');
    const firstLineage = resolveAssetLineage(db, CHARACTER_ID, USER_A, CHAT_A);
    deleteCharacterData(db, CHARACTER_ID);
    db.prepare('DELETE FROM eve_character_links WHERE chat_id = ? AND character_id = ?')
      .run(CHAT_A, CHARACTER_ID);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(CHAT_A, CHARACTER_ID, USER_A);

    const reboundLineage = resolveAssetLineage(db, CHARACTER_ID, USER_A, CHAT_A);
    const rebound = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX_A, 'manual');
    expect(reboundLineage.bindingEpoch).toBeGreaterThan(firstLineage.bindingEpoch);
    expect(reboundLineage.bindingDigest).not.toBe(firstLineage.bindingDigest);
    expect(rebound).toMatchObject({ deduped: false, itemsCommitted: 2 });
    expect(rebound.snapshotId).not.toBe(first.snapshotId);
    expect(latestLineageSnapshot(USER_A, CHAT_A).snapshot_id).toBe(rebound.snapshotId);
  });

  it('isolates same-hash history and jobs after owner transfer and rebuilds the new owner mirror', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(rows())));
    const oldResult = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX_A, 'manual');
    const oldLineage = resolveAssetLineage(db, CHARACTER_ID, USER_A, CHAT_A);
    deleteCharacterData(db, CHARACTER_ID);
    db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
    linkCharacter(USER_B, CHAT_B, 'owner-b');

    const newResult = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX_B, 'manual');
    const newLineage = resolveAssetLineage(db, CHARACTER_ID, USER_B, CHAT_B);

    const jobs = RealAssetSyncService.listJobs(db, CHARACTER_ID, 50, newLineage);

    expect(newResult).toMatchObject({ deduped: false, itemsCommitted: 2 });
    expect(newResult.snapshotId).not.toBe(oldResult.snapshotId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].snapshotId).toBe(newResult.snapshotId);
    expect(RealAssetSyncService.latestJob(db, CHARACTER_ID, oldLineage)?.snapshotId).toBe(oldResult.snapshotId);
    expect(latestLineageSnapshot(USER_B, CHAT_B).snapshot_id).toBe(newResult.snapshotId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ? AND owner_user_id = ?')
      .get(CHARACTER_ID, USER_A)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ? AND owner_user_id = ?')
      .get(CHARACTER_ID, USER_B)).toEqual({ n: 2 });
  });

  it('rolls back dedup completion failure without changing the prior mirror or latest snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(rows())));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX_A, 'manual');
    db.exec(`
      CREATE TRIGGER p936_fail_dedup_completion
      BEFORE UPDATE OF status ON real_asset_sync_jobs
      WHEN OLD.status = 'RUNNING' AND NEW.status = 'COMPLETED'
      BEGIN SELECT RAISE(ABORT, 'p936 dedup completion failure'); END;
    `);

    await expect(RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX_A, 'manual'))
      .rejects.toThrow(/dedup completion failure/);

    expect(latestLineageSnapshot(USER_A, CHAT_A)).toEqual({
      snapshot_id: first.snapshotId,
      total_quantity: 6,
    });
    expect(db.prepare('SELECT item_id, quantity FROM character_assets WHERE character_id = ? ORDER BY item_id')
      .all(CHARACTER_ID)).toEqual([
        { item_id: 98_001, quantity: 4 },
        { item_id: 98_002, quantity: 2 },
      ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 1 });
    expect(db.prepare(`
      SELECT status, last_error FROM real_asset_sync_jobs
      WHERE character_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).get(CHARACTER_ID)).toEqual({
      status: 'FAILED',
      last_error: expect.stringContaining('dedup completion failure'),
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
  });
});


