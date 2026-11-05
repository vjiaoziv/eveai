import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { RealAssetSyncService } from '../../../src/assets/asset-sync-service.js';
import { resolveAssetLineage } from '../../../src/assets/asset-lineage.js';
import { clearCapabilitySnapshots } from '../../../src/eve/capabilities.js';
import { registerAssetRoutes } from '../../../src/web/asset-routes.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
  type CreatedWebSession,
} from '../../../src/web/web-session.js';
import type { Db } from '../../../src/db/sqlite.js';

vi.mock('../../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    auth: { secretKey: 'p9338-snapshot-pagination-secret' },
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

const CHARACTER_ID = 9_838_801;
const LOCATION_ID = 60_003_760;
const SCOPE = 'esi-assets.read_assets.v1';
const OPEN_APPS: Array<ReturnType<typeof Fastify>> = [];
let db: Db;
let session: CreatedWebSession;

function assetRow(itemId: number, typeId: number, quantity = 1) {
  return {
    item_id: itemId,
    type_id: typeId,
    location_id: LOCATION_ID,
    location_type: 'station',
    location_flag: 'Hangar',
    quantity,
    is_singleton: false,
    is_blueprint_copy: false,
  };
}

function assetResponse(payload: unknown[]): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      'X-Pages': '1',
    },
  });
}

function linkSession(): void {
  resetWebSessionCreationGuardForTests();
  session = createWebSession(db);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'Snapshot Pagination Pilot', 'access-token', 'refresh-token',
            datetime('now', '+1 hour'), ?, ?, 'owner-hash')
  `).run(CHARACTER_ID, JSON.stringify([SCOPE]), session.userId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(session.chatId, CHARACTER_ID, session.userId);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?')
    .run(CHARACTER_ID, session.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
    .run(CHARACTER_ID, session.chatId);
}

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  linkSession();
});

afterEach(async () => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const app of OPEN_APPS.splice(0)) await app.close();
  db.close();
});

describe('P9.3.3.8 historical snapshot pagination', () => {
  it('pages an older 5001-item generation after a newer latest snapshot replaces it', async () => {
    const ctx = { userId: session.userId, chatId: session.chatId, characterId: CHARACTER_ID };
    const oldRows = Array.from({ length: 5001 }, (_, index) => assetRow(1_000_000 + index, 34));
    vi.stubGlobal('fetch', vi.fn(async () => assetResponse(oldRows)));
    const oldSync = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx, 'manual');

    vi.stubGlobal('fetch', vi.fn(async () => assetResponse([assetRow(2_000_001, 35, 2)])));
    const newSync = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx, 'manual');
    expect(newSync.snapshotId).not.toBe(oldSync.snapshotId);

    const app = Fastify({ bodyLimit: 64 * 1024 });
    OPEN_APPS.push(app);
    await app.register(fastifyCookie);
    registerAssetRoutes(app, db);
    const headers = { cookie: `${WEB_SESSION_COOKIE}=${session.sessionToken}` };

    const first = await app.inject({
      method: 'GET',
      url: `/api/web/assets/snapshots/${oldSync.snapshotId}?limit=500`,
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      total: 5001,
      limit: 500,
      offset: 0,
      hasMore: true,
      nextOffset: 500,
    });
    expect(first.json().items).toHaveLength(500);

    const last = await app.inject({
      method: 'GET',
      url: `/api/web/assets/snapshots/${oldSync.snapshotId}?limit=500&offset=5000`,
      headers,
    });
    expect(last.statusCode).toBe(200);
    expect(last.json()).toMatchObject({
      total: 5001,
      limit: 500,
      offset: 5000,
      hasMore: false,
      nextOffset: null,
    });
    expect(last.json().items).toHaveLength(1);

    const latest = await app.inject({
      method: 'GET',
      url: `/api/web/assets/snapshots/${newSync.snapshotId}?limit=500`,
      headers,
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toMatchObject({ total: 1, hasMore: false, nextOffset: null });
    expect(latest.json().items).toEqual([
      expect.objectContaining({ item_id: 2_000_001, type_id: 35, quantity: 2 }),
    ]);
  });

  it('covers the 0/1/4999/5000/5001/10000 boundaries without duplicate or missing items', async () => {
    const lineage = resolveAssetLineage(db, CHARACTER_ID, session.userId, session.chatId);
    const sizes = [0, 1, 4_999, 5_000, 5_001, 10_000];
    const insertSnapshot = db.prepare(`
      INSERT INTO real_asset_snapshots
        (snapshot_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
         started_at, completed_at, status, total_items, total_unique_types, total_locations,
         total_quantity, data_hash, hash_algorithm, canonical_version, is_latest)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'COMPLETED', ?, 1, 1, ?, ?, 'sha256', 1, 0)
    `);
    const insertItem = db.prepare(`
      INSERT INTO real_asset_snapshot_items
        (snapshot_id, item_id, type_id, quantity, location_id, location_type,
         location_flag, is_singleton, is_blueprint_copy, parent_item_id, raw_json)
      VALUES (?, ?, 34, 1, ?, 'station', 'Hangar', 0, 0, NULL, '{}')
    `);
    const seed = db.transaction(() => {
      for (const size of sizes) {
        const snapshotId = `P9338-BOUNDARY-${size}`;
        insertSnapshot.run(
          snapshotId, CHARACTER_ID, lineage.ownerUserId, lineage.ownerChatId,
          lineage.bindingEpoch, lineage.bindingDigest, size, size, `hash-${size}`,
        );
        for (let index = 1; index <= size; index += 1) {
          insertItem.run(snapshotId, index, LOCATION_ID);
        }
      }
    });
    seed();

    const app = Fastify({ bodyLimit: 64 * 1024 });
    OPEN_APPS.push(app);
    await app.register(fastifyCookie);
    registerAssetRoutes(app, db);
    const headers = { cookie: `${WEB_SESSION_COOKIE}=${session.sessionToken}` };

    for (const size of sizes) {
      const snapshotId = `P9338-BOUNDARY-${size}`;
      let offset = 0;
      const ids: number[] = [];
      let pages = 0;
      while (true) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/web/assets/snapshots/${snapshotId}?limit=5000&offset=${offset}`,
          headers,
        });
        expect(response.statusCode).toBe(200);
        const payload = response.json();
        expect(payload.snapshot.snapshot_id).toBe(snapshotId);
        expect(payload.total).toBe(size);
        expect(payload.offset).toBe(offset);
        ids.push(...payload.items.map((row: any) => Number(row.item_id)));
        pages += 1;
        if (!payload.hasMore) {
          expect(payload.nextOffset).toBeNull();
          break;
        }
        expect(payload.nextOffset).toBe(offset + payload.items.length);
        offset = payload.nextOffset;
        expect(pages).toBeLessThanOrEqual(3);
      }
      expect(pages).toBe(size === 0 ? 1 : Math.ceil(size / 5000));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(size);
      expect(ids).toEqual(Array.from({ length: size }, (_, index) => index + 1));
    }

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/web/assets/snapshots/P9338-BOUNDARY-1?limit=0&offset=-1',
      headers,
    });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json()).toMatchObject({ total: 1, limit: 500, offset: 0, hasMore: false });

    const thirdParty = createWebSession(db);
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/web/assets/snapshots/P9338-BOUNDARY-1?limit=500',
      headers: { cookie: `${WEB_SESSION_COOKIE}=${thirdParty.sessionToken}` },
    });
    expect(forbidden.statusCode).toBe(404);
  });
});
