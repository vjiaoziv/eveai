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
    auth: { secretKey: 'p9339-independent-asset-secret' },
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

const CHARACTER_ID = 9_944_201;
const CHAT_B = 9_944_102;
const LOCATION_ID = 60_003_760;
const SCOPE = 'esi-assets.read_assets.v1';

let db: Db;
let sessionA: CreatedWebSession;
let app: ReturnType<typeof Fastify>;

function assetRow(itemId: number, quantity = 1, typeId = 34) {
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

function response(payload: unknown[]): Response {
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
  sessionA = createWebSession(db);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'P9339 Asset Pilot', 'access-token', 'refresh-token',
            datetime('now', '+1 hour'), ?, ?, 'owner-p9339-assets')
  `).run(CHARACTER_ID, JSON.stringify([SCOPE]), sessionA.userId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(sessionA.chatId, CHARACTER_ID, sessionA.userId);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?')
    .run(CHARACTER_ID, sessionA.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
    .run(CHARACTER_ID, sessionA.chatId);
}

function addSecondLane(): void {
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_B, 'p9339-second-lane', CHARACTER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_B, CHARACTER_ID, sessionA.userId);
}

beforeEach(async () => {
  clearCapabilitySnapshots();
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  linkSession();
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerAssetRoutes(app, db);
});

afterEach(async () => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await app.close();
  db.close();
});

describe('P9.3.3.9 independent asset mirror isolation and pagination', () => {
  it('keeps two chat lanes for the same character isolated through repeated replacement', async () => {
    addSecondLane();
    const ctxA = { userId: sessionA.userId, chatId: sessionA.chatId, characterId: CHARACTER_ID };
    const ctxB = { userId: sessionA.userId, chatId: CHAT_B, characterId: CHARACTER_ID };

    vi.stubGlobal('fetch', vi.fn(async () => response([assetRow(1001, 2)])));
    const firstA = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctxA, 'manual');
    vi.stubGlobal('fetch', vi.fn(async () => response([assetRow(1001, 7)])));
    const firstB = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctxB, 'manual');
    vi.stubGlobal('fetch', vi.fn(async () => response([assetRow(1001, 3)])));
    const secondA = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctxA, 'manual');

    const lineageA = resolveAssetLineage(db, CHARACTER_ID, sessionA.userId, sessionA.chatId);
    const lineageB = resolveAssetLineage(db, CHARACTER_ID, sessionA.userId, CHAT_B);
    const mirrors = db.prepare(`
      SELECT owner_chat_id, item_id, quantity, binding_digest
      FROM character_assets WHERE character_id = ?
      ORDER BY owner_chat_id, item_id
    `).all(CHARACTER_ID);
    expect(mirrors).toEqual([
      { owner_chat_id: sessionA.chatId, item_id: 1001, quantity: 3, binding_digest: lineageA.bindingDigest },
      { owner_chat_id: CHAT_B, item_id: 1001, quantity: 7, binding_digest: lineageB.bindingDigest },
    ]);

    const latest = db.prepare(`
      SELECT owner_chat_id, snapshot_id, binding_digest, total_quantity, is_latest
      FROM real_asset_snapshots WHERE character_id = ? AND is_latest = 1
      ORDER BY owner_chat_id
    `).all(CHARACTER_ID);
    expect(latest).toEqual([
      expect.objectContaining({ owner_chat_id: sessionA.chatId, snapshot_id: secondA.snapshotId, total_quantity: 3 }),
      expect.objectContaining({ owner_chat_id: CHAT_B, snapshot_id: firstB.snapshotId, total_quantity: 7 }),
    ]);
    expect(firstA.snapshotId).not.toBe(firstB.snapshotId);
    expect(secondA.snapshotId).not.toBe(firstA.snapshotId);
  });

  it('keeps two chat lanes isolated through five repeated replacement rounds', async () => {
    addSecondLane();
    const ctxA = { userId: sessionA.userId, chatId: sessionA.chatId, characterId: CHARACTER_ID };
    const ctxB = { userId: sessionA.userId, chatId: CHAT_B, characterId: CHARACTER_ID };
    const lineageA = resolveAssetLineage(db, CHARACTER_ID, sessionA.userId, sessionA.chatId);
    const lineageB = resolveAssetLineage(db, CHARACTER_ID, sessionA.userId, CHAT_B);

    for (let round = 1; round <= 5; round += 1) {
      vi.stubGlobal('fetch', vi.fn(async () => response([assetRow(1001, round * 10 + 1)])));
      await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctxA, 'manual');
      vi.stubGlobal('fetch', vi.fn(async () => response([assetRow(1001, round * 10 + 7)])));
      await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctxB, 'manual');
      vi.stubGlobal('fetch', vi.fn(async () => response([assetRow(1001, round * 10 + 3)])));
      const latestA = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctxA, 'manual');

      expect(db.prepare(`
        SELECT owner_chat_id, item_id, quantity, binding_digest
        FROM character_assets WHERE character_id = ?
        ORDER BY owner_chat_id, item_id
      `).all(CHARACTER_ID)).toEqual([
        { owner_chat_id: sessionA.chatId, item_id: 1001, quantity: round * 10 + 3, binding_digest: lineageA.bindingDigest },
        { owner_chat_id: CHAT_B, item_id: 1001, quantity: round * 10 + 7, binding_digest: lineageB.bindingDigest },
      ]);
      expect(db.prepare(`
        SELECT owner_chat_id, snapshot_id, total_quantity
        FROM real_asset_snapshots WHERE character_id = ? AND is_latest = 1
        ORDER BY owner_chat_id
      `).all(CHARACTER_ID)).toEqual([
        expect.objectContaining({ owner_chat_id: sessionA.chatId, snapshot_id: latestA.snapshotId, total_quantity: round * 10 + 3 }),
        expect.objectContaining({ owner_chat_id: CHAT_B, total_quantity: round * 10 + 7 }),
      ]);
    }
  });
  it('does not deduplicate different persistent item sets with identical count and quantity totals', async () => {
    const ctx = { userId: sessionA.userId, chatId: sessionA.chatId, characterId: CHARACTER_ID };
    vi.stubGlobal('fetch', vi.fn(async () => response([
      assetRow(2001, 2, 34),
      assetRow(2002, 3, 35),
    ])));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx, 'manual');

    vi.stubGlobal('fetch', vi.fn(async () => response([
      assetRow(2003, 2, 34),
      assetRow(2004, 3, 35),
    ])));
    const second = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx, 'manual');

    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(second).toMatchObject({ deduped: false, itemsCommitted: 2 });
    const rows = db.prepare(`
      SELECT snapshot_id, item_id, type_id, quantity FROM real_asset_snapshot_items
      WHERE snapshot_id = ? ORDER BY item_id
    `).all(second.snapshotId);
    expect(rows).toEqual([
      { snapshot_id: second.snapshotId, item_id: 2003, type_id: 34, quantity: 2 },
      { snapshot_id: second.snapshotId, item_id: 2004, type_id: 35, quantity: 3 },
    ]);
    const hashes = db.prepare(`
      SELECT snapshot_id, data_hash, total_items, total_quantity
      FROM real_asset_snapshots WHERE snapshot_id IN (?, ?) ORDER BY snapshot_id
    `).all(first.snapshotId, second.snapshotId) as Array<{ data_hash: string; total_items: number; total_quantity: number }>;
    expect(new Set(hashes.map((row) => row.data_hash)).size).toBe(2);
    expect(hashes.map((row) => [row.total_items, row.total_quantity])).toEqual([[2, 5], [2, 5]]);
  });

  it('pages every required boundary from persisted snapshot items without truncation or duplication', async () => {
    const lineage = resolveAssetLineage(db, CHARACTER_ID, sessionA.userId, sessionA.chatId);
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
    db.transaction(() => {
      for (const size of sizes) {
        const snapshotId = `P9339-BOUNDARY-${size}`;
        insertSnapshot.run(
          snapshotId, CHARACTER_ID, lineage.ownerUserId, lineage.ownerChatId,
          lineage.bindingEpoch, lineage.bindingDigest, size, size, `hash-${size}`,
        );
        for (let index = 1; index <= size; index += 1) insertItem.run(snapshotId, index, LOCATION_ID);
      }
    })();

    const headers = { cookie: `${WEB_SESSION_COOKIE}=${sessionA.sessionToken}` };
    for (const size of sizes) {
      const snapshotId = `P9339-BOUNDARY-${size}`;
      let offset = 0;
      const ids: number[] = [];
      let pages = 0;
      while (true) {
        const page = await app.inject({
          method: 'GET',
          url: `/api/web/assets/snapshots/${snapshotId}?limit=5000&offset=${offset}`,
          headers,
        });
        expect(page.statusCode).toBe(200);
        const body = page.json();
        expect(body.snapshot.snapshot_id).toBe(snapshotId);
        expect(body.total).toBe(size);
        ids.push(...body.items.map((row: any) => Number(row.item_id)));
        pages += 1;
        if (!body.hasMore) {
          expect(body.nextOffset).toBeNull();
          break;
        }
        expect(body.nextOffset).toBe(offset + body.items.length);
        offset = body.nextOffset;
      }
      expect(pages).toBe(size === 0 ? 1 : Math.ceil(size / 5_000));
      expect(ids).toHaveLength(size);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(Array.from({ length: size }, (_, index) => index + 1));
    }
  });
});