import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { RealAssetSyncService } from '../../src/assets/asset-sync-service.js';
import { runMigrations } from '../../src/db/migrations.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
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
    assetSync: { enabled: true, intervalMinutes: 30, staleJobMinutes: 30 },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720 },
  },
}));

const USER_ID = 9_746_001;
const CHARACTER_ID = 9_746_101;
const CHAT_ID = 9_746_201;
const CTX = { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID };
const SCOPES = ['esi-assets.read_assets.v1'];
const OPEN_CHILDREN: ChildProcessWithoutNullStreams[] = [];
const TEMP_DIRS: string[] = [];

function jsonResponse(quantity: number): Response {
  return new Response(JSON.stringify([{
    item_id: 98_001,
    type_id: 34,
    location_id: 60_003_760,
    location_type: 'station',
    location_flag: 'Hangar',
    quantity,
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

function linkCharacter(db: Db): void {
  db.prepare('INSERT OR IGNORE INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'asset-fencing-pilot', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'asset-fencing-pilot', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, ?, 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?, ?)
  `).run(CHARACTER_ID, 'Asset Fencing Pilot', JSON.stringify(SCOPES), USER_ID, 'owner-fencing');
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

async function createFileDb(): Promise<{ dir: string; path: string; db: Db }> {
  const dir = await mkdtemp(join(tmpdir(), 'eveai-p9334-fencing-'));
  TEMP_DIRS.push(dir);
  const path = join(dir, 'assets.sqlite');
  const db = new Database(path) as Db;
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 20000');
  runMigrations(db);
  return { dir, path, db };
}

function spawnAssetChild(env: {
  dir: string;
  path: string;
  mode: 'hold-fetch' | 'commit-hold' | 'unlink';
  role?: string;
  quantity?: number;
}): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'tests/helpers/p9-3.3.4-asset-child.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      EVEAI_ASSET_DB: env.path,
      EVEAI_ASSET_BARRIER: env.dir,
      EVEAI_ASSET_MODE: env.mode,
      EVEAI_ASSET_ROLE: env.role ?? 'solo',
      EVEAI_ASSET_CHARACTER_ID: String(CHARACTER_ID),
      EVEAI_ASSET_USER_ID: String(USER_ID),
      EVEAI_ASSET_CHAT_ID: String(CHAT_ID),
      EVEAI_ASSET_QUANTITY: String(env.quantity ?? 1),
    },
    stdio: 'pipe',
  });
  OPEN_CHILDREN.push(child);
  return child;
}

function waitForChild(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  clearCapabilitySnapshots();
});

afterEach(async () => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const child of OPEN_CHILDREN.splice(0)) {
    if (!child.killed) child.kill('SIGKILL');
  }
  for (const dir of TEMP_DIRS.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('P9.3.3.4 asset generation fencing', () => {
  it('T03/T04/T20: a stale live response cannot revive an old generation or overwrite the newer latest snapshot', async () => {
    const { dir, path, db } = await createFileDb();
    linkCharacter(db);
    db.close();

    const old = spawnAssetChild({ dir, path, mode: 'hold-fetch', role: 'old', quantity: 1 });
    await waitForFile(join(dir, 'fetch-entered'));

    const verifier = new Database(path) as Db;
    verifier.pragma('busy_timeout = 20000');
    const oldJob = verifier.prepare(`
      SELECT job_id, generation, status FROM real_asset_sync_jobs WHERE character_id = ?
    `).get(CHARACTER_ID) as { job_id: string; generation: number; status: string };
    expect(oldJob).toMatchObject({ generation: 1, status: 'RUNNING' });
    verifier.prepare("UPDATE real_asset_sync_jobs SET started_at = datetime('now', '-2 hours') WHERE job_id = ?")
      .run(oldJob.job_id);
    verifier.prepare("UPDATE real_asset_sync_leases SET renewed_at = datetime('now', '-2 hours') WHERE job_id = ?")
      .run(oldJob.job_id);

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(2)));
    const newer = await RealAssetSyncService.syncCharacter(verifier, CHARACTER_ID, CTX, 'manual');
    expect(newer.job.generation).toBe(2);
    expect(newer.job.status).toBe('COMPLETED');

    writeFileSync(join(dir, 'release-fetch'), '1');
    const oldResult = await waitForChild(old);
    expect(oldResult.code).toBe(1);
    expect(oldResult.stdout).toContain('fencing');

    const jobs = verifier.prepare(`
      SELECT generation, status FROM real_asset_sync_jobs WHERE character_id = ? ORDER BY generation
    `).all(CHARACTER_ID) as Array<{ generation: number; status: string }>;
    const latest = verifier.prepare(`
      SELECT snapshot_id, total_quantity FROM real_asset_snapshots
      WHERE character_id = ? AND is_latest = 1
    `).get(CHARACTER_ID) as { snapshot_id: string; total_quantity: number };
    const mirror = verifier.prepare(`
      SELECT quantity FROM character_assets WHERE character_id = ? AND item_id = 98001
    `).get(CHARACTER_ID) as { quantity: number };
    const snapshotCount = verifier.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?
    `).get(CHARACTER_ID) as { n: number };
    const leaseCount = verifier.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?
    `).get(CHARACTER_ID) as { n: number };
    verifier.close();

    expect(jobs).toEqual([
      { generation: 1, status: 'FAILED' },
      { generation: 2, status: 'COMPLETED' },
    ]);
    expect(latest).toEqual({ snapshot_id: newer.snapshotId, total_quantity: 2 });
    expect(mirror.quantity).toBe(2);
    expect(snapshotCount.n).toBe(1);
    expect(leaseCount.n).toBe(0);
  }, 30_000);

  it('T05: a snapshot insert failure rolls back the mirror and preserves the prior latest snapshot', async () => {
    const { db } = await createFileDb();
    linkCharacter(db);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(1)));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual');

    db.exec(`
      CREATE TRIGGER test_fail_snapshot_insert
      BEFORE INSERT ON real_asset_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'injected snapshot insert failure');
      END;
    `);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(2)));
    await expect(RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/injected snapshot insert failure/);

    const latest = db.prepare(`
      SELECT snapshot_id, total_quantity FROM real_asset_snapshots
      WHERE character_id = ? AND is_latest = 1
    `).get(CHARACTER_ID) as { snapshot_id: string; total_quantity: number };
    const mirror = db.prepare(`
      SELECT quantity FROM character_assets WHERE character_id = ? AND item_id = 98001
    `).get(CHARACTER_ID) as { quantity: number };
    const jobs = db.prepare(`
      SELECT status FROM real_asset_sync_jobs ORDER BY generation
    `).all() as Array<{ status: string }>;
    const leaseCount = db.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?
    `).get(CHARACTER_ID) as { n: number };
    db.close();

    expect(latest).toEqual({ snapshot_id: first.snapshotId, total_quantity: 1 });
    expect(mirror.quantity).toBe(1);
    expect(jobs.map((job) => job.status)).toEqual(['COMPLETED', 'FAILED']);
    expect(leaseCount.n).toBe(0);
  });

  it('T06: a latest unique-index conflict leaves no half-written mirror or snapshot state', async () => {
    const { db } = await createFileDb();
    linkCharacter(db);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(1)));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual');

    db.exec(`
      CREATE TRIGGER test_latest_conflict
      AFTER DELETE ON character_assets
      BEGIN
        INSERT INTO real_asset_snapshots
          (snapshot_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
           started_at, completed_at, status, total_items, total_unique_types, total_locations,
           total_quantity, data_hash, hash_algorithm, canonical_version, source, is_latest)
        VALUES
          ('CONFLICT-SNAPSHOT', OLD.character_id, OLD.owner_user_id, OLD.owner_chat_id,
           OLD.binding_epoch, OLD.binding_digest, datetime('now'), datetime('now'), 'COMPLETED',
           0, 0, 0, 0, 'conflict', 'sha256', 1, 'test', 1);
      END;
    `);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(2)));
    await expect(RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/UNIQUE constraint failed/);

    const latest = db.prepare(`
      SELECT snapshot_id, total_quantity FROM real_asset_snapshots
      WHERE character_id = ? AND is_latest = 1
    `).get(CHARACTER_ID) as { snapshot_id: string; total_quantity: number };
    const mirror = db.prepare(`
      SELECT quantity FROM character_assets WHERE character_id = ? AND item_id = 98001
    `).get(CHARACTER_ID) as { quantity: number };
    const snapshotCount = db.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?
    `).get(CHARACTER_ID) as { n: number };
    const running = db.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_sync_jobs WHERE character_id = ? AND status = 'RUNNING'
    `).get(CHARACTER_ID) as { n: number };
    db.close();

    expect(latest).toEqual({ snapshot_id: first.snapshotId, total_quantity: 1 });
    expect(mirror.quantity).toBe(1);
    expect(snapshotCount.n).toBe(1);
    expect(running.n).toBe(0);
  });

  it('T19: repeated identical sync dedupes snapshots and refuses to compare across canonical versions', async () => {
    const { db } = await createFileDb();
    linkCharacter(db);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(4)));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual');
    const duplicate = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual');

    expect(first.deduped).toBe(false);
    expect(duplicate.deduped).toBe(true);
    expect(duplicate.snapshotId).toBe(first.snapshotId);
    expect(duplicate.itemsCommitted).toBe(0);
    expect(duplicate.changesRecorded).toBe(0);
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({ n: 1 });
    expect(db.prepare(`
      SELECT hash_algorithm, canonical_version FROM real_asset_snapshots WHERE snapshot_id = ?
    `).get(first.snapshotId)).toEqual({ hash_algorithm: 'sha256', canonical_version: 1 });

    db.prepare(`
      UPDATE real_asset_snapshots SET canonical_version = 0 WHERE snapshot_id = ?
    `).run(first.snapshotId);
    const versioned = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual');
    const latest = db.prepare(`
      SELECT snapshot_id, hash_algorithm, canonical_version
      FROM real_asset_snapshots WHERE character_id = ? AND is_latest = 1
    `).get(CHARACTER_ID) as { snapshot_id: string; hash_algorithm: string; canonical_version: number };

    expect(versioned.deduped).toBe(false);
    expect(versioned.snapshotId).not.toBe(first.snapshotId);
    expect(latest).toEqual({
      snapshot_id: versioned.snapshotId,
      hash_algorithm: 'sha256',
      canonical_version: 1,
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({ n: 2 });
    db.close();
  });
});
