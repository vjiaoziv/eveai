import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { RealAssetSyncService } from '../../src/assets/asset-sync-service.js';
import { readAssetBindingSnapshot } from '../../src/assets/asset-lineage.js';
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
      leaseTtlSeconds: 3,
      heartbeatSeconds: 1,
    },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720 },
  },
}));

const USER_ID = 9_769_001;
const CHAT_ID = 9_769_101;
const CHARACTER_ID = 9_769_201;
const SCOPE = 'esi-assets.read_assets.v1';
const CTX = { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID };
const TEMP_DIRS: string[] = [];

let db: Db;

function response(): Response {
  return new Response(JSON.stringify([{
    item_id: 98_301,
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
  db.prepare('INSERT OR IGNORE INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'Heartbeat Pilot', CHARACTER_ID);
  db.prepare('INSERT OR IGNORE INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'heartbeat-pilot', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'Heartbeat Pilot', 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?, 'owner-heartbeat')
    ON CONFLICT(character_id) DO UPDATE SET
      scopes_json = excluded.scopes_json,
      user_id = excluded.user_id,
      owner_hash = excluded.owner_hash,
      expires_at = excluded.expires_at
  `).run(CHARACTER_ID, JSON.stringify([SCOPE]), USER_ID);
  db.prepare(`
    INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)
    ON CONFLICT(chat_id, character_id) DO UPDATE SET user_id = excluded.user_id
  `).run(CHAT_ID, CHARACTER_ID, USER_ID);
}

function ownership(jobId: string, generation: number) {
  return {
    jobId,
    characterId: CHARACTER_ID,
    generation,
    pinnedCtx: CTX,
    binding: readAssetBindingSnapshot(db, CHARACTER_ID, CTX, true),
  };
}

function insertOwnedRunningJob(jobId: string, generation: number, renewedAt = '-1 seconds'): ReturnType<typeof ownership> {
  const own = ownership(jobId, generation);
  db.prepare(`
    INSERT INTO real_asset_sync_jobs
      (job_id, character_id, trigger, status, phase, generation,
       owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       account_owner_hash, started_at, source)
    VALUES (?, ?, 'auto', 'RUNNING', 'fetch', ?, ?, ?, ?, ?, ?, datetime('now'), 'esi_character_assets')
  `).run(
    jobId,
    CHARACTER_ID,
    generation,
    own.binding.userId,
    own.binding.chatId,
    own.binding.bindingEpoch,
    own.binding.digest,
    own.binding.ownerHash,
  );
  db.prepare(`
    INSERT INTO real_asset_sync_leases
      (character_id, generation, job_id, acquired_at, renewed_at)
    VALUES (?, ?, ?, datetime('now', '-5 seconds'), datetime('now', ?))
  `).run(CHARACTER_ID, generation, jobId, renewedAt);
  return own;
}

async function createFileDb(): Promise<{ dir: string; path: string; db: Db }> {
  const dir = await mkdtemp(join(tmpdir(), 'eveai-p936-heartbeat-'));
  TEMP_DIRS.push(dir);
  const path = join(dir, 'heartbeat.sqlite');
  const fileDb = new Database(path) as Db;
  fileDb.pragma('foreign_keys = ON');
  fileDb.pragma('journal_mode = WAL');
  fileDb.pragma('busy_timeout = 20');
  runMigrations(fileDb);
  return { dir, path, db: fileDb };
}

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:') as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  linkCharacter();
});

afterEach(async () => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
  await Promise.all(TEMP_DIRS.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('P9.3.3.6 asset lease heartbeat and fencing', () => {
  it('renews the current owner lease while a long fetch is still in progress', async () => {
    let observed: { acquired_at: string; renewed_at: string } | undefined;
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_350));
      observed = db.prepare(`
        SELECT acquired_at, renewed_at FROM real_asset_sync_leases WHERE character_id = ?
      `).get(CHARACTER_ID) as { acquired_at: string; renewed_at: string };
      return response();
    }));

    const result = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual');

    expect(result.job.status).toBe('COMPLETED');
    expect(observed).toBeDefined();
    expect(Date.parse(observed!.renewed_at)).toBeGreaterThan(Date.parse(observed!.acquired_at));
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
  });

  it('cannot revive an expired lease', () => {
    const own = insertOwnedRunningJob('EXPIRED', 1, '-10 seconds');
    expect(() => RealAssetSyncService.renewOwnershipLease(db, own))
      .toThrow(/租约已过期|已被其他任务接管/);
  });

  it('cannot renew an older generation after a higher generation takes ownership', () => {
    const oldOwn = insertOwnedRunningJob('OLD', 1);
    db.prepare("UPDATE real_asset_sync_jobs SET status = 'FAILED', finished_at = datetime('now') WHERE job_id = 'OLD'").run();
    db.prepare('DELETE FROM real_asset_sync_leases WHERE job_id = ?').run('OLD');
    insertOwnedRunningJob('NEW', 2, '-1 seconds');

    expect(() => RealAssetSyncService.renewOwnershipLease(db, oldOwn))
      .toThrow(/任务已被接管或身份上下文已变化/);
    expect(db.prepare('SELECT generation, job_id FROM real_asset_sync_leases WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ generation: 2, job_id: 'NEW' });
  });

  it('stops renewal when unlink/rebind changes the binding epoch', () => {
    const own = insertOwnedRunningJob('REBOUND', 1);
    db.prepare('DELETE FROM eve_character_links WHERE chat_id = ? AND character_id = ?')
      .run(CHAT_ID, CHARACTER_ID);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(CHAT_ID, CHARACTER_ID, USER_ID);

    expect(() => RealAssetSyncService.renewOwnershipLease(db, own))
      .toThrow(/身份上下文已变化|目标角色账户所有权|解绑/);
  });

  it('aborts the final commit when a heartbeat renewal fails during fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_350));
      return response();
    }));
    const syncing = RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual');
    setTimeout(() => {
      db.prepare('DELETE FROM eve_character_links WHERE chat_id = ? AND character_id = ?')
        .run(CHAT_ID, CHARACTER_ID);
    }, 350);

    await expect(syncing).rejects.toThrow(/身份上下文已变化|解绑|租约续期失败/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
    expect(db.prepare(`
      SELECT status FROM real_asset_sync_jobs ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).get()).toEqual({ status: 'FAILED' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
  });

  it('performs a final authorization fence even before the first heartbeat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      db.prepare('DELETE FROM eve_character_links WHERE chat_id = ? AND character_id = ?')
        .run(CHAT_ID, CHARACTER_ID);
      return response();
    }));

    await expect(RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/解绑|身份上下文|所有权/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
  });

  it('stops the heartbeat after caller cancellation and leaves no live lease', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(response()), 1_500);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    })));
    const syncing = RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual', {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);

    await expect(syncing).rejects.toThrow(/abort|取消|lease|租约/i);
    await new Promise((resolve) => setTimeout(resolve, 1_150));
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
    expect(db.prepare(`
      SELECT status FROM real_asset_sync_jobs ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).get()).toEqual({ status: 'FAILED' });
  });

  it('surfaces SQLITE_BUSY instead of pretending the lease was renewed', async () => {
    db.close();
    const file = await createFileDb();
    db = file.db;
    linkCharacter();
    const own = insertOwnedRunningJob('BUSY', 1);
    const blocker = new Database(file.path);
    blocker.pragma('busy_timeout = 20');
    blocker.exec('BEGIN IMMEDIATE');
    try {
      expect(() => RealAssetSyncService.renewOwnershipLease(db, own))
        .toThrow(/SQLITE_BUSY|database is locked/i);
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
  });
});
