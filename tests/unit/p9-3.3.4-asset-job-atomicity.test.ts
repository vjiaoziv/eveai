import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { RealAssetSyncService } from '../../src/assets/asset-sync-service.js';
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

const USER_ID = 9_744_001;
const CHARACTER_A = 9_744_101;
const CHARACTER_B = 9_744_102;
const CHAT_A = 9_744_201;
const CHAT_B = 9_744_202;
const SCOPES = ['esi-assets.read_assets.v1'];
const OPEN_CHILDREN: ChildProcessWithoutNullStreams[] = [];
const TEMP_DIRS: string[] = [];

type ChildResult = { code: number | null; stdout: string; stderr: string };

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

function linkCharacter(db: Db, characterId: number, chatId: number): void {
  db.prepare('INSERT OR IGNORE INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'asset-race-pilot', characterId);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(chatId, 'asset-race-pilot', characterId);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, ?, 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?, ?)
  `).run(characterId, `Pilot ${characterId}`, JSON.stringify(SCOPES), USER_ID, `owner-${characterId}`);
  db.prepare(`
    INSERT INTO eve_character_links (chat_id, character_id, user_id)
    VALUES (?, ?, ?)
  `).run(chatId, characterId, USER_ID);
}

async function createFileDb(): Promise<{ dir: string; path: string; db: Db }> {
  const dir = await mkdtemp(join(tmpdir(), 'eveai-p9334-atomic-'));
  TEMP_DIRS.push(dir);
  const path = join(dir, 'assets.sqlite');
  const db = new Database(path) as Db;
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 20000');
  runMigrations(db);
  return { dir, path, db };
}

function spawnAssetChild(input: {
  dir: string;
  dbPath: string;
  mode: 'race' | 'normal' | 'crash-after-job' | 'crash-during-commit' | 'hold-fetch' | 'commit-hold' | 'unlink';
  role?: string;
  characterId: number;
  chatId: number;
  quantity: number;
}): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'tests/helpers/p9-3.3.4-asset-child.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      EVEAI_ASSET_DB: input.dbPath,
      EVEAI_ASSET_BARRIER: input.dir,
      EVEAI_ASSET_MODE: input.mode,
      EVEAI_ASSET_ROLE: input.role ?? 'solo',
      EVEAI_ASSET_CHARACTER_ID: String(input.characterId),
      EVEAI_ASSET_USER_ID: String(USER_ID),
      EVEAI_ASSET_CHAT_ID: String(input.chatId),
      EVEAI_ASSET_QUANTITY: String(input.quantity),
    },
    stdio: 'pipe',
  });
  OPEN_CHILDREN.push(child);
  return child;
}

function waitForChild(child: ChildProcessWithoutNullStreams): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
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

describe('P9.3.3.4 asset job atomicity and crash recovery', () => {
  it('T01: two independent processes racing for one character create exactly one owned job', async () => {
    const { dir, path, db } = await createFileDb();
    linkCharacter(db, CHARACTER_A, CHAT_A);
    db.close();

    const a = spawnAssetChild({
      dir, dbPath: path, mode: 'race', role: 'a', characterId: CHARACTER_A, chatId: CHAT_A, quantity: 1,
    });
    const b = spawnAssetChild({
      dir, dbPath: path, mode: 'race', role: 'b', characterId: CHARACTER_A, chatId: CHAT_A, quantity: 2,
    });
    const [resultA, resultB] = await Promise.all([waitForChild(a), waitForChild(b)]);

    const verifier = new Database(path) as Db;
    const jobs = verifier.prepare(`
      SELECT job_id, generation, status, snapshot_id, items_committed
      FROM real_asset_sync_jobs WHERE character_id = ? ORDER BY generation
    `).all(CHARACTER_A) as Array<{
      job_id: string; generation: number; status: string; snapshot_id: string | null; items_committed: number | null;
    }>;
    const latest = verifier.prepare(`
      SELECT snapshot_id, total_quantity FROM real_asset_snapshots
      WHERE character_id = ? AND is_latest = 1
    `).get(CHARACTER_A) as { snapshot_id: string; total_quantity: number } | undefined;
    const mirror = verifier.prepare(`
      SELECT quantity FROM character_assets WHERE character_id = ? AND item_id = 98001
    `).get(CHARACTER_A) as { quantity: number } | undefined;
    const leaseCount = verifier.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?')
      .get(CHARACTER_A) as { n: number };
    verifier.close();

    expect([resultA.code, resultB.code].sort(), JSON.stringify({ resultA, resultB })).toEqual([0, 1]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ generation: 1, status: 'COMPLETED' });
    expect(jobs[0]!.snapshot_id).toBe(latest?.snapshot_id);
    expect(latest?.total_quantity).toBe(2);
    expect(mirror?.quantity).toBe(2);
    expect(leaseCount.n).toBe(0);
  });

  it('T02: independent characters can own and commit their own sync lanes concurrently', async () => {
    const { dir, path, db } = await createFileDb();
    linkCharacter(db, CHARACTER_A, CHAT_A);
    linkCharacter(db, CHARACTER_B, CHAT_B);
    db.close();

    const a = spawnAssetChild({
      dir, dbPath: path, mode: 'normal', role: 'a', characterId: CHARACTER_A, chatId: CHAT_A, quantity: 3,
    });
    const b = spawnAssetChild({
      dir, dbPath: path, mode: 'normal', role: 'b', characterId: CHARACTER_B, chatId: CHAT_B, quantity: 7,
    });
    const [resultA, resultB] = await Promise.all([waitForChild(a), waitForChild(b)]);

    const verifier = new Database(path) as Db;
    const jobs = verifier.prepare(`
      SELECT character_id, generation, status FROM real_asset_sync_jobs ORDER BY character_id
    `).all() as Array<{ character_id: number; generation: number; status: string }>;
    const snapshots = verifier.prepare(`
      SELECT character_id, total_quantity FROM real_asset_snapshots WHERE is_latest = 1 ORDER BY character_id
    `).all() as Array<{ character_id: number; total_quantity: number }>;
    verifier.close();

    expect([resultA.code, resultB.code]).toEqual([0, 0]);
    expect(jobs).toEqual([
      { character_id: CHARACTER_A, generation: 1, status: 'COMPLETED' },
      { character_id: CHARACTER_B, generation: 1, status: 'COMPLETED' },
    ]);
    expect(snapshots).toEqual([
      { character_id: CHARACTER_A, total_quantity: 3 },
      { character_id: CHARACTER_B, total_quantity: 7 },
    ]);
  });

  it('T07: a process crash after job creation leaves a stale RUNNING owner that a later generation can recover', async () => {
    const { dir, path, db } = await createFileDb();
    linkCharacter(db, CHARACTER_A, CHAT_A);
    db.close();

    const crashed = spawnAssetChild({
      dir, dbPath: path, mode: 'crash-after-job', role: 'a', characterId: CHARACTER_A, chatId: CHAT_A, quantity: 1,
    });
    await waitForFile(join(dir, 'fetch-entered'));
    crashed.kill('SIGKILL');
    await waitForChild(crashed);

    const before = new Database(path) as Db;
    const stale = before.prepare(`
      SELECT job_id, generation, status FROM real_asset_sync_jobs WHERE character_id = ?
    `).get(CHARACTER_A) as { job_id: string; generation: number; status: string };
    expect(stale.status).toBe('RUNNING');
    before.prepare(`
      UPDATE real_asset_sync_jobs SET started_at = datetime('now', '-2 hours') WHERE job_id = ?
    `).run(stale.job_id);
    // A crashed process stops renewing its lease. Age the heartbeat too so the
    // fixture models a real crash rather than a live task with a fresh lease.
    before.prepare(`
      UPDATE real_asset_sync_leases SET renewed_at = datetime('now', '-2 hours') WHERE job_id = ?
    `).run(stale.job_id);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(9)));
    const recovered = await RealAssetSyncService.syncCharacter(
      before,
      CHARACTER_A,
      { userId: USER_ID, chatId: CHAT_A, characterId: CHARACTER_A },
      'manual',
    );
    const jobs = before.prepare(`
      SELECT job_id, generation, status FROM real_asset_sync_jobs WHERE character_id = ? ORDER BY generation
    `).all(CHARACTER_A) as Array<{ job_id: string; generation: number; status: string }>;
    const lease = before.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?')
      .get(CHARACTER_A) as { n: number };
    before.close();

    expect(recovered.job.generation).toBe(2);
    expect(recovered.job.status).toBe('COMPLETED');
    expect(jobs).toEqual([
      { job_id: stale.job_id, generation: 1, status: 'FAILED' },
      { job_id: recovered.job.jobId, generation: 2, status: 'COMPLETED' },
    ]);
    expect(lease.n).toBe(0);
  });

  it('T08: killing a process inside the commit transaction leaves the previous latest and mirror intact', async () => {
    const { dir, path, db } = await createFileDb();
    linkCharacter(db, CHARACTER_A, CHAT_A);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(1)));
    const first = await RealAssetSyncService.syncCharacter(
      db,
      CHARACTER_A,
      { userId: USER_ID, chatId: CHAT_A, characterId: CHARACTER_A },
      'manual',
    );
    db.close();
    vi.unstubAllGlobals();

    const crashed = spawnAssetChild({
      dir, dbPath: path, mode: 'crash-during-commit', role: 'a', characterId: CHARACTER_A, chatId: CHAT_A, quantity: 2,
    });
    await waitForFile(join(dir, 'commit-blocked'));
    crashed.kill('SIGKILL');
    await waitForChild(crashed);

    const verifier = new Database(path) as Db;
    const latest = verifier.prepare(`
      SELECT snapshot_id, total_quantity FROM real_asset_snapshots
      WHERE character_id = ? AND is_latest = 1
    `).get(CHARACTER_A) as { snapshot_id: string; total_quantity: number };
    const mirror = verifier.prepare(`
      SELECT quantity FROM character_assets WHERE character_id = ? AND item_id = 98001
    `).get(CHARACTER_A) as { quantity: number };
    const snapshotCount = verifier.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?
    `).get(CHARACTER_A) as { n: number };
    const running = verifier.prepare(`
      SELECT status FROM real_asset_sync_jobs WHERE character_id = ? AND status = 'RUNNING'
    `).get(CHARACTER_A) as { status: string } | undefined;
    verifier.close();

    expect(latest).toEqual({ snapshot_id: first.snapshotId, total_quantity: 1 });
    expect(mirror.quantity).toBe(1);
    expect(snapshotCount.n).toBe(1);
    expect(running?.status).toBe('RUNNING');
  }, 30_000);
});
