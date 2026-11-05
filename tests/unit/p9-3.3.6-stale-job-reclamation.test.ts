import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { RealAssetSyncService } from '../../src/assets/asset-sync-service.js';
import { runAssetSyncWorkerTick } from '../../src/assets/asset-sync-worker.js';
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
      leaseTtlSeconds: 30,
      heartbeatSeconds: 10,
    },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720 },
  },
}));

const USER_ID = 9_768_001;
const CHAT_ID = 9_768_101;
const CHARACTER_ID = 9_768_201;
const SCOPE = 'esi-assets.read_assets.v1';

let db: Db;

function response(): Response {
  return new Response(JSON.stringify([{
    item_id: 98_201,
    type_id: 34,
    location_id: 60_003_760,
    location_type: 'station',
    location_flag: 'Hangar',
    quantity: 5,
    is_singleton: false,
    is_blueprint_copy: false,
  }]), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      'X-Pages': '1',
    },
  });
}

function linkCharacter(): void {
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'Stale Reclaimer', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'stale-reclaimer', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'Stale Pilot', 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?, 'owner-stale')
  `).run(CHARACTER_ID, JSON.stringify([SCOPE]), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

function insertRunningJob(input: {
  jobId: string;
  generation: number;
  leaseAge: string;
  startedAge?: string;
}): void {
  db.prepare(`
    INSERT INTO real_asset_sync_jobs
      (job_id, character_id, trigger, status, phase, generation,
       owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       account_owner_hash, started_at, source)
    VALUES (?, ?, 'auto', 'RUNNING', 'fetch', ?, ?, ?, 1, 'binding-digest',
            'owner-stale', datetime('now', ?), 'esi_character_assets')
  `).run(
    input.jobId,
    CHARACTER_ID,
    input.generation,
    USER_ID,
    CHAT_ID,
    input.startedAge ?? input.leaseAge,
  );
  db.prepare(`
    INSERT INTO real_asset_sync_leases
      (character_id, generation, job_id, acquired_at, renewed_at)
    VALUES (?, ?, ?, datetime('now', ?), datetime('now', ?))
  `).run(CHARACTER_ID, input.generation, input.jobId, input.leaseAge, input.leaseAge);
}

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:') as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  linkCharacter();
});

afterEach(() => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

describe('P9.3.3.6 stale job reclamation', () => {
  it('lets the scheduled worker autonomously reclaim a stale RUNNING job and then schedule the character', async () => {
    insertRunningJob({ jobId: 'STALE-CRASH', generation: 1, leaseAge: '-10 minutes' });
    vi.stubGlobal('fetch', vi.fn(async () => response()));

    await runAssetSyncWorkerTick(db);

    expect(db.prepare(`
      SELECT status, phase, last_error FROM real_asset_sync_jobs WHERE job_id = 'STALE-CRASH'
    `).get()).toEqual({
      status: 'FAILED',
      phase: 'done',
      last_error: 'sync presumed crashed: RUNNING longer than stale window',
    });
    expect(db.prepare(`
      SELECT generation, status, trigger FROM real_asset_sync_jobs
      WHERE character_id = ? AND job_id != 'STALE-CRASH'
    `).get(CHARACTER_ID)).toEqual({ generation: 2, status: 'COMPLETED', trigger: 'auto' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
  });

  it('does not reclaim or schedule around a fresh active RUNNING job', async () => {
    insertRunningJob({ jobId: 'ACTIVE', generation: 1, leaseAge: '-5 seconds' });
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetchMock);

    await runAssetSyncWorkerTick(db);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare(`
      SELECT status, phase FROM real_asset_sync_jobs WHERE job_id = 'ACTIVE'
    `).get()).toEqual({ status: 'RUNNING', phase: 'fetch' });
    expect(db.prepare(`
      SELECT generation, job_id FROM real_asset_sync_leases WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({ generation: 1, job_id: 'ACTIVE' });
  });

  it('is idempotent and revokes the lease only once', () => {
    insertRunningJob({ jobId: 'STALE-ONCE', generation: 1, leaseAge: '-10 minutes' });

    expect(RealAssetSyncService.reclaimStaleJobs(db, CHARACTER_ID)).toBe(1);
    expect(RealAssetSyncService.reclaimStaleJobs(db, CHARACTER_ID)).toBe(0);
    expect(db.prepare('SELECT status FROM real_asset_sync_jobs WHERE job_id = ?')
      .get('STALE-ONCE')).toEqual({ status: 'FAILED' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
  });

  it('prevents a reclaimed old generation from renewing after a newer generation takes over', () => {
    insertRunningJob({ jobId: 'OLD-GENERATION', generation: 1, leaseAge: '-10 minutes' });
    const oldOwnership = {
      jobId: 'OLD-GENERATION',
      characterId: CHARACTER_ID,
      generation: 1,
      pinnedCtx: { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID },
      binding: {
        characterId: CHARACTER_ID,
        userId: USER_ID,
        chatId: CHAT_ID,
        accountUserId: USER_ID,
        ownerHash: 'owner-stale',
        scopes: [SCOPE],
        bindingEpoch: 1,
        digest: 'binding-digest',
      },
    };
    expect(RealAssetSyncService.reclaimStaleJobs(db, CHARACTER_ID)).toBe(1);
    insertRunningJob({ jobId: 'NEW-GENERATION', generation: 2, leaseAge: '-1 second' });

    expect(() => RealAssetSyncService.renewOwnershipLease(db, oldOwnership))
      .toThrow(/任务已被接管|任务已被回收/);
    expect(db.prepare(`
      SELECT generation, job_id FROM real_asset_sync_leases WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({ generation: 2, job_id: 'NEW-GENERATION' });
  });

  it('fails closed without scheduling or touching due rows when stale reclamation itself fails', async () => {
    insertRunningJob({ jobId: 'RECLAIM-FAIL-CLOSED', generation: 1, leaseAge: '-10 minutes' });
    vi.spyOn(RealAssetSyncService, 'reclaimStaleJobs').mockImplementation(() => {
      throw new Error('simulated reclaim database failure');
    });
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetchMock);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runAssetSyncWorkerTick(db);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare(`
      SELECT status FROM real_asset_sync_jobs WHERE job_id = 'RECLAIM-FAIL-CLOSED'
    `).get()).toEqual({ status: 'RUNNING' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_jobs WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 1 });
    expect(errorSpy).toHaveBeenCalledWith(
      '[asset-sync] stale-job reclaim failed: %s',
      'simulated reclaim database failure',
    );
  });
});
