import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { RealAssetSyncService } from '../../../src/assets/asset-sync-service.js';
import { readAssetBindingSnapshot, resolveAssetLineage } from '../../../src/assets/asset-lineage.js';
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
    auth: { secretKey: 'p9339-pagination-fencing-secret' },
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
    assetSync: { enabled: false, intervalMinutes: 60, staleJobMinutes: 30, leaseTtlSeconds: 180, heartbeatSeconds: 45 },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' }, sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720, sessionCreationWindowSeconds: 60, maxSessionCreationsPerWindow: 100 },
  },
}));

const CHARACTER_ID = 9_945_201;
const LOCATION_ID = 60_003_760;
const SCOPE = 'esi-assets.read_assets.v1';

let db: Db;
let session: CreatedWebSession;
let app: ReturnType<typeof Fastify>;
let ctx: { userId: number; chatId: number; characterId: number };

function attachSession(): void {
  resetWebSessionCreationGuardForTests();
  session = createWebSession(db);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'P9339 Pagination Pilot', 'access-token', 'refresh-token',
            datetime('now', '+1 hour'), ?, ?, 'owner-p9339-pagination')
  `).run(CHARACTER_ID, JSON.stringify([SCOPE]), session.userId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(session.chatId, CHARACTER_ID, session.userId);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?')
    .run(CHARACTER_ID, session.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
    .run(CHARACTER_ID, session.chatId);
  ctx = { userId: session.userId, chatId: session.chatId, characterId: CHARACTER_ID };
}

function insertSnapshot(snapshotId: string, size: number, latest: boolean): void {
  const lineage = resolveAssetLineage(db, CHARACTER_ID, session.userId, session.chatId);
  db.prepare(`
    INSERT INTO real_asset_snapshots
      (snapshot_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       started_at, completed_at, status, total_items, total_unique_types, total_locations,
       total_quantity, data_hash, hash_algorithm, canonical_version, is_latest)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'COMPLETED', ?, 1, 1, ?, ?, 'sha256', 1, ?)
  `).run(
    snapshotId, CHARACTER_ID, lineage.ownerUserId, lineage.ownerChatId,
    lineage.bindingEpoch, lineage.bindingDigest, size, size, `hash-${snapshotId}`, latest ? 1 : 0,
  );
  const insertItem = db.prepare(`
    INSERT INTO real_asset_snapshot_items
      (snapshot_id, item_id, type_id, quantity, location_id, location_type,
       location_flag, is_singleton, is_blueprint_copy, parent_item_id, raw_json)
    VALUES (?, ?, 34, 1, ?, 'station', 'Hangar', 0, 0, NULL, '{}')
  `);
  db.transaction(() => {
    for (let index = 1; index <= size; index += 1) insertItem.run(snapshotId, index, LOCATION_ID);
  })();
}

function insertRunningJob(jobId: string, generation: number, leaseAge: string): void {
  const binding = readAssetBindingSnapshot(db, CHARACTER_ID, ctx, true);
  db.prepare(`
    INSERT INTO real_asset_sync_jobs
      (job_id, character_id, trigger, status, phase, generation,
       owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       account_owner_hash, started_at, source)
    VALUES (?, ?, 'manual', 'RUNNING', 'fetch', ?, ?, ?, ?, ?, ?, datetime('now', ?), 'esi_character_assets')
  `).run(
    jobId, CHARACTER_ID, generation, binding.userId, binding.chatId,
    binding.bindingEpoch, binding.digest, binding.ownerHash, leaseAge,
  );
  db.prepare(`
    INSERT INTO real_asset_sync_leases
      (character_id, generation, job_id, acquired_at, renewed_at)
    VALUES (?, ?, ?, datetime('now', ?), datetime('now', ?))
  `).run(CHARACTER_ID, generation, jobId, leaseAge, leaseAge);
}

beforeEach(async () => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  attachSession();
  app = Fastify();
  await app.register(fastifyCookie);
  registerAssetRoutes(app, db);
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  db.close();
});

describe('P9.3.3.9 snapshot pagination and generation fencing', () => {
  it('keeps an old snapshot page pinned while the latest pointer changes between pages', async () => {
    insertSnapshot('P9339-OLD-5001', 5_001, false);
    insertSnapshot('P9339-NEW-LATEST', 1, true);
    const headers = { cookie: `${WEB_SESSION_COOKIE}=${session.sessionToken}` };

    const first = await app.inject({
      method: 'GET',
      url: '/api/web/assets/snapshots/P9339-OLD-5001?limit=5000&offset=0',
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      total: 5_001,
      hasMore: true,
      nextOffset: 5_000,
      snapshot: { snapshot_id: 'P9339-OLD-5001' },
    });
    expect(first.json().items).toHaveLength(5_000);

    db.prepare("UPDATE real_asset_snapshots SET is_latest = CASE WHEN snapshot_id = 'P9339-NEW-LATEST' THEN 1 ELSE 0 END WHERE character_id = ?")
      .run(CHARACTER_ID);

    const second = await app.inject({
      method: 'GET',
      url: '/api/web/assets/snapshots/P9339-OLD-5001?limit=5000&offset=5000',
      headers,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      total: 5_001,
      hasMore: false,
      nextOffset: null,
      snapshot: { snapshot_id: 'P9339-OLD-5001' },
    });
    expect(second.json().items.map((row: any) => row.item_id)).toEqual([5_001]);
  });

  it('rejects heartbeat renewal from a reclaimed generation after a newer generation acquires the lease', () => {
    insertRunningJob('P9339-OLD-GENERATION', 1, '-10 minutes');
    const binding = readAssetBindingSnapshot(db, CHARACTER_ID, ctx, true);
    const oldOwnership = {
      jobId: 'P9339-OLD-GENERATION',
      characterId: CHARACTER_ID,
      generation: 1,
      pinnedCtx: ctx,
      binding: {
        characterId: binding.characterId,
        userId: binding.userId,
        chatId: binding.chatId,
        accountUserId: binding.accountUserId,
        ownerHash: binding.ownerHash,
        scopes: binding.scopes,
        bindingEpoch: binding.bindingEpoch,
        digest: binding.digest,
      },
    };

    expect(RealAssetSyncService.reclaimStaleJobs(db, CHARACTER_ID)).toBe(1);
    insertRunningJob('P9339-NEW-GENERATION', 2, '-1 second');

    expect(() => RealAssetSyncService.renewOwnershipLease(db, oldOwnership))
      .toThrow(/任务已被接管|任务已被回收/);
    expect(db.prepare('SELECT generation, job_id FROM real_asset_sync_leases WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ generation: 2, job_id: 'P9339-NEW-GENERATION' });
    expect(db.prepare('SELECT status FROM real_asset_sync_jobs WHERE job_id = ?')
      .get('P9339-OLD-GENERATION')).toEqual({ status: 'FAILED' });
  });

  it('keeps an old snapshot pinned while latest changes across five rounds', async () => {
    const headers = { cookie: `${WEB_SESSION_COOKIE}=${session.sessionToken}` };

    for (let round = 1; round <= 5; round += 1) {
      db.prepare('UPDATE real_asset_snapshots SET is_latest = 0 WHERE character_id = ?').run(CHARACTER_ID);
      const oldSnapshotId = `P9339-OLD-5001-ROUND-${round}`;
      const newSnapshotId = `P9339-NEW-LATEST-ROUND-${round}`;
      insertSnapshot(oldSnapshotId, 5_001, false);
      insertSnapshot(newSnapshotId, 1, true);

      const first = await app.inject({
        method: 'GET',
        url: `/api/web/assets/snapshots/${oldSnapshotId}?limit=5000&offset=0`,
        headers,
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        total: 5_001,
        hasMore: true,
        nextOffset: 5_000,
        snapshot: { snapshot_id: oldSnapshotId },
      });
      expect(first.json().items).toHaveLength(5_000);

      db.prepare('UPDATE real_asset_snapshots SET is_latest = CASE WHEN snapshot_id = ? THEN 1 ELSE 0 END WHERE character_id = ?')
        .run(newSnapshotId, CHARACTER_ID);

      const second = await app.inject({
        method: 'GET',
        url: `/api/web/assets/snapshots/${oldSnapshotId}?limit=5000&offset=5000`,
        headers,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({
        total: 5_001,
        hasMore: false,
        nextOffset: null,
        snapshot: { snapshot_id: oldSnapshotId },
      });
      expect(second.json().items.map((row: any) => row.item_id)).toEqual([5_001]);
    }
  });

  it('rejects reclaimed-generation heartbeat renewal across five rounds', () => {
    for (let round = 1; round <= 5; round += 1) {
      db.prepare('DELETE FROM real_asset_sync_leases WHERE character_id = ?').run(CHARACTER_ID);
      db.prepare('DELETE FROM real_asset_sync_jobs WHERE character_id = ?').run(CHARACTER_ID);
      const oldGeneration = round * 2 - 1;
      const newGeneration = round * 2;
      const oldJobId = `P9339-OLD-GENERATION-${round}`;
      const newJobId = `P9339-NEW-GENERATION-${round}`;
      insertRunningJob(oldJobId, oldGeneration, '-10 minutes');
      const binding = readAssetBindingSnapshot(db, CHARACTER_ID, ctx, true);
      const oldOwnership = {
        jobId: oldJobId,
        characterId: CHARACTER_ID,
        generation: oldGeneration,
        pinnedCtx: ctx,
        binding: {
          characterId: binding.characterId,
          userId: binding.userId,
          chatId: binding.chatId,
          accountUserId: binding.accountUserId,
          ownerHash: binding.ownerHash,
          scopes: binding.scopes,
          bindingEpoch: binding.bindingEpoch,
          digest: binding.digest,
        },
      };

      expect(RealAssetSyncService.reclaimStaleJobs(db, CHARACTER_ID)).toBeGreaterThanOrEqual(1);
      insertRunningJob(newJobId, newGeneration, '-1 second');

      expect(() => RealAssetSyncService.renewOwnershipLease(db, oldOwnership))
        .toThrow(/任务已被接管|任务已被回收/);
      expect(db.prepare('SELECT generation, job_id FROM real_asset_sync_leases WHERE character_id = ?')
        .get(CHARACTER_ID)).toEqual({ generation: newGeneration, job_id: newJobId });
      expect(db.prepare('SELECT status FROM real_asset_sync_jobs WHERE job_id = ?')
        .get(oldJobId)).toEqual({ status: 'FAILED' });
    }
  });
});