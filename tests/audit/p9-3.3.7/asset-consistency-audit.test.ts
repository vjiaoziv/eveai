import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { RealAssetSyncService } from '../../../src/assets/asset-sync-service.js';
import { resolveAssetLineage } from '../../../src/assets/asset-lineage.js';
import { clearCapabilitySnapshots } from '../../../src/eve/capabilities.js';
import { registerAssetRoutes } from '../../../src/web/asset-routes.js';
import { createWebSession, resetWebSessionCreationGuardForTests, WEB_SESSION_COOKIE } from '../../../src/web/web-session.js';
import type { Db } from '../../../src/db/sqlite.js';

vi.mock('../../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    auth: { secretKey: 'audit-test-secret' },
    eve: {
      clientId: 'test-client', clientSecret: 'test-secret',
      callbackUrl: 'http://localhost:3000/auth/eve/callback', requestTimeoutMs: 5000,
    },
    esi: {
      baseUrl: 'https://esi.evetech.net/latest/', specUrl: 'https://esi.evetech.net/latest/swagger.json',
      catalogCachePath: './data/cache/esi-swagger.json', compatibilityDate: '2026-03-15',
      userAgent: 'EVEAI/4.0 (+https://github.com/example/eveai; contact=operator@example.com)',
      maxPages: 5, backoffMaxSeconds: 1, requestTimeoutMs: 5000, retryMaxAttempts: 1,
    },
    characterSync: { maxPages: 50, fallbackTtlSeconds: 3600, errorRetrySeconds: 120 },
    assetSync: { enabled: true, intervalMinutes: 30, staleJobMinutes: 30, leaseTtlSeconds: 180, heartbeatSeconds: 45 },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' }, sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720, sessionCreationWindowSeconds: 60, maxSessionCreationsPerWindow: 100 },
  },
}));

const CHARACTER_ID = 9_833_702;
const LOCATION_ID = 60_003_760;
const SCOPE = 'esi-assets.read_assets.v1';
const OPEN_APPS: Array<ReturnType<typeof Fastify>> = [];
let db: Db;

function linkState(): { sessionA: ReturnType<typeof createWebSession>; sessionB: ReturnType<typeof createWebSession> } {
  resetWebSessionCreationGuardForTests();
  const sessionA = createWebSession(db);
  const sessionB = createWebSession(db);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'Asset Consistency Pilot', 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?, 'owner-hash')
  `).run(CHARACTER_ID, JSON.stringify([SCOPE]), sessionA.userId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(sessionA.chatId, CHARACTER_ID, sessionA.userId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(sessionB.chatId, CHARACTER_ID, sessionA.userId);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(CHARACTER_ID, sessionA.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id IN (?, ?)')
    .run(CHARACTER_ID, sessionA.chatId, sessionB.chatId);
  return { sessionA, sessionB };
}

function transferCharacterToNewOwner(target: ReturnType<typeof createWebSession>): void {
  const oldOwners = db.prepare('SELECT DISTINCT user_id FROM eve_character_links WHERE character_id = ?')
    .all(CHARACTER_ID) as Array<{ user_id: number | null }>;
  for (const owner of oldOwners) {
    if (owner.user_id) {
      db.prepare('UPDATE users SET active_character_id = NULL WHERE user_id = ?').run(owner.user_id);
    }
  }
  db.prepare('UPDATE telegram_sessions SET active_character_id = NULL WHERE chat_id IN (SELECT chat_id FROM eve_character_links WHERE character_id = ?)')
    .run(CHARACTER_ID);
  db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
  db.prepare('UPDATE eve_accounts SET user_id = ?, owner_hash = ? WHERE character_id = ?')
    .run(target.userId, 'owner-b-p9338', CHARACTER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(target.chatId, CHARACTER_ID, target.userId);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(CHARACTER_ID, target.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?').run(CHARACTER_ID, target.chatId);
}

function assetResponse(itemId: number, typeId: number): Response {
  return new Response(JSON.stringify([{
    item_id: itemId, type_id: typeId, location_id: LOCATION_ID,
    location_type: 'station', location_flag: 'Hangar', quantity: 1,
    is_singleton: false, is_blueprint_copy: false,
  }]), {
    status: 200,
    headers: { 'Content-Type': 'application/json', Expires: new Date(Date.now() + 3_600_000).toUTCString(), 'X-Pages': '1' },
  });
}

function insertSnapshot(lineage: ReturnType<typeof resolveAssetLineage>, snapshotId: string, totalItems: number): void {
  db.prepare(`
    INSERT INTO real_asset_snapshots
      (snapshot_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       started_at, completed_at, status, total_items, total_unique_types, total_locations,
       total_quantity, data_hash, is_latest)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'COMPLETED', ?, 2, 1, 2, ?, 1)
  `).run(
    snapshotId, CHARACTER_ID, lineage.ownerUserId, lineage.ownerChatId,
    lineage.bindingEpoch, lineage.bindingDigest, totalItems, `${snapshotId}-HASH`,
  );
}

function insertMirror(lineage: ReturnType<typeof resolveAssetLineage>, itemId: number, typeId: number): void {
  db.prepare(`
    INSERT INTO character_assets
      (character_id, item_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       type_id, location_id, location_type, location_flag, quantity, is_singleton,
       is_blueprint_copy, data_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'station', 'Hangar', 1, 0, 0, '{}', datetime('now'))
  `).run(
    CHARACTER_ID, itemId, lineage.ownerUserId, lineage.ownerChatId,
    lineage.bindingEpoch, lineage.bindingDigest, typeId, LOCATION_ID,
  );
}

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(async () => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const app of OPEN_APPS.splice(0)) await app.close();
  db.close();
});

describe('P9.3.3.7 asset mirror consistency audit', () => {
  it('F-P9337-02 (FIXED): syncing the same character in a second chat preserves the first chat lineage current mirror', async () => {
    const { sessionA, sessionB } = linkState();
    const ctxA = { userId: sessionA.userId, chatId: sessionA.chatId, characterId: CHARACTER_ID };
    const ctxB = { userId: sessionA.userId, chatId: sessionB.chatId, characterId: CHARACTER_ID };

    vi.stubGlobal('fetch', vi.fn(async () => assetResponse(940_001, 34)));
    await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctxA, 'manual');
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ? AND owner_chat_id = ?')
      .get(CHARACTER_ID, sessionA.chatId)).toEqual({ n: 1 });

    vi.stubGlobal('fetch', vi.fn(async () => assetResponse(940_002, 35)));
    await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctxB, 'manual');

    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ? AND owner_chat_id = ?')
      .get(CHARACTER_ID, sessionA.chatId)).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ? AND owner_chat_id = ?')
      .get(CHARACTER_ID, sessionB.chatId)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ? AND owner_chat_id = ? AND status = 'COMPLETED'")
      .get(CHARACTER_ID, sessionA.chatId)).toEqual({ n: 1 });
  });

  it('F-P9337-03 (FIXED): same aggregate counts from a different item set are reported INCONSISTENT', async () => {
    const { sessionA } = linkState();
    const lineage = resolveAssetLineage(db, CHARACTER_ID, sessionA.userId, sessionA.chatId);
    insertSnapshot(lineage, 'P9337-SNAPSHOT-DIFFERENT-SET', 2);
    db.prepare(`
      INSERT INTO real_asset_snapshot_items (snapshot_id, item_id, type_id, quantity, location_id, raw_json)
      VALUES ('P9337-SNAPSHOT-DIFFERENT-SET', 1, 34, 1, ?, '{}'),
             ('P9337-SNAPSHOT-DIFFERENT-SET', 2, 35, 1, ?, '{}')
    `).run(LOCATION_ID, LOCATION_ID);
    insertMirror(lineage, 1, 34);
    insertMirror(lineage, 2, 36);

    const app = Fastify({ bodyLimit: 64 * 1024 });
    OPEN_APPS.push(app);
    await app.register(fastifyCookie);
    registerAssetRoutes(app, db);
    const response = await app.inject({
      method: 'GET', url: '/api/web/assets/overview',
      headers: { cookie: `${WEB_SESSION_COOKIE}=${sessionA.sessionToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().characters[0]).toMatchObject({
      currentAssetItems: 2,
      currentUniqueTypes: 2,
      dataIntegrity: 'INCONSISTENT',
    });
    expect(db.prepare("SELECT group_concat(type_id, ',') AS types FROM real_asset_snapshot_items WHERE snapshot_id = 'P9337-SNAPSHOT-DIFFERENT-SET'").get())
      .toEqual({ types: '34,35' });
    expect(db.prepare('SELECT group_concat(type_id, \',\') AS types FROM character_assets WHERE character_id = ? ORDER BY item_id').get(CHARACTER_ID))
      .toEqual({ types: '34,36' });
  });

  it('F-P9337-04 (FIXED): snapshot detail paginates large snapshots and reports hasMore/nextOffset', async () => {
    const { sessionA } = linkState();
    const lineage = resolveAssetLineage(db, CHARACTER_ID, sessionA.userId, sessionA.chatId);
    insertSnapshot(lineage, 'P9337-SNAPSHOT-5001', 5001);
    const insert = db.prepare(`INSERT INTO real_asset_snapshot_items
      (snapshot_id, item_id, type_id, quantity, location_id, raw_json)
      VALUES ('P9337-SNAPSHOT-5001', ?, ?, 1, ?, '{}')`);
    const tx = db.transaction(() => {
      for (let i = 1; i <= 5001; i += 1) insert.run(i, 34, LOCATION_ID);
    });
    tx();

    const app = Fastify({ bodyLimit: 64 * 1024 });
    OPEN_APPS.push(app);
    await app.register(fastifyCookie);
    registerAssetRoutes(app, db);
    const response = await app.inject({
      method: 'GET', url: '/api/web/assets/snapshots/P9337-SNAPSHOT-5001',
      headers: { cookie: `${WEB_SESSION_COOKIE}=${sessionA.sessionToken}` },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.snapshot.total_items).toBe(5001);
    expect(payload.items).toHaveLength(500);
    expect(payload.total).toBe(5001);
    expect(payload.limit).toBe(500);
    expect(payload.offset).toBe(0);
    expect(payload.hasMore).toBe(true);
    expect(payload.nextOffset).toBe(500);
    expect(payload.truncated).toBeUndefined();
    expect(payload.totalItems).toBeUndefined();
  });

  it('P9.3.3.8 isolates two owners/lanes for the same character across job, latest, changes and rebind', async () => {
    const { sessionA } = linkState();
    const ownerB = createWebSession(db);
    const ctxA = { userId: sessionA.userId, chatId: sessionA.chatId, characterId: CHARACTER_ID };
    const lineageA = resolveAssetLineage(db, CHARACTER_ID, sessionA.userId, sessionA.chatId);

    vi.stubGlobal('fetch', vi.fn(async () => assetResponse(950_001, 34)));
    const syncA1 = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctxA, 'manual');

    transferCharacterToNewOwner(ownerB);
    const ctxB = { userId: ownerB.userId, chatId: ownerB.chatId, characterId: CHARACTER_ID };
    const lineageB = resolveAssetLineage(db, CHARACTER_ID, ownerB.userId, ownerB.chatId);
    vi.stubGlobal('fetch', vi.fn(async () => assetResponse(950_002, 35)));
    const syncB1 = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctxB, 'manual');

    expect(syncA1.snapshotId).not.toBe(syncB1.snapshotId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ?')
      .get(CHARACTER_ID, lineageA.ownerUserId, lineageA.ownerChatId, lineageA.bindingEpoch)).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ?')
      .get(CHARACTER_ID, lineageB.ownerUserId, lineageB.ownerChatId, lineageB.bindingEpoch)).toEqual({ n: 1 });
    expect(db.prepare('SELECT snapshot_id FROM real_asset_snapshots WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ? AND is_latest = 1')
      .get(CHARACTER_ID, lineageA.ownerUserId, lineageA.ownerChatId, lineageA.bindingEpoch)).toEqual({ snapshot_id: syncA1.snapshotId });
    expect(db.prepare('SELECT snapshot_id FROM real_asset_snapshots WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ? AND is_latest = 1')
      .get(CHARACTER_ID, lineageB.ownerUserId, lineageB.ownerChatId, lineageB.bindingEpoch)).toEqual({ snapshot_id: syncB1.snapshotId });
    expect(RealAssetSyncService.latestJob(db, CHARACTER_ID, lineageA)!.snapshotId).toBe(syncA1.snapshotId);
    expect(RealAssetSyncService.latestJob(db, CHARACTER_ID, lineageB)!.snapshotId).toBe(syncB1.snapshotId);

    vi.stubGlobal('fetch', vi.fn(async () => assetResponse(950_003, 35)));
    const syncB2 = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctxB, 'manual');
    expect(syncB2.changesRecorded).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_changes WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ?')
      .get(CHARACTER_ID, lineageA.ownerUserId, lineageA.ownerChatId, lineageA.bindingEpoch)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_changes WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ?')
      .get(CHARACTER_ID, lineageB.ownerUserId, lineageB.ownerChatId, lineageB.bindingEpoch)).toEqual({ n: 2 });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('P9338 simulated B failure'); }));
    await expect(RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctxB, 'manual')).rejects.toThrow(/P9338 simulated B failure/);
    expect(RealAssetSyncService.latestJob(db, CHARACTER_ID, lineageB)!.status).toBe('FAILED');
    expect(db.prepare('SELECT snapshot_id FROM real_asset_snapshots WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ? AND is_latest = 1')
      .get(CHARACTER_ID, lineageB.ownerUserId, lineageB.ownerChatId, lineageB.bindingEpoch)).toEqual({ snapshot_id: syncB2.snapshotId });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ?')
      .get(CHARACTER_ID, lineageA.ownerUserId, lineageA.ownerChatId, lineageA.bindingEpoch)).toEqual({ n: 1 });

    db.prepare('DELETE FROM eve_character_links WHERE chat_id = ? AND character_id = ?').run(ownerB.chatId, CHARACTER_ID);
    await expect(RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctxB, 'manual')).rejects.toThrow(/解绑/);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(ownerB.chatId, CHARACTER_ID, ownerB.userId);
    const lineageBRebound = resolveAssetLineage(db, CHARACTER_ID, ownerB.userId, ownerB.chatId);
    expect(lineageBRebound.bindingEpoch).toBeGreaterThan(lineageB.bindingEpoch);
    vi.stubGlobal('fetch', vi.fn(async () => assetResponse(950_004, 36)));
    const syncBRebound = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctxB, 'manual');
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ?')
      .get(CHARACTER_ID, lineageBRebound.ownerUserId, lineageBRebound.ownerChatId, lineageBRebound.bindingEpoch)).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ?')
      .get(CHARACTER_ID, lineageB.ownerUserId, lineageB.ownerChatId, lineageB.bindingEpoch)).toEqual({ n: 2 });
    expect(syncBRebound.snapshotId).not.toBe(syncB2.snapshotId);
  });
});
