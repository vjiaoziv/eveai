import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { RealAssetSyncService } from '../../src/assets/asset-sync-service.js';
import { runMigrations } from '../../src/db/migrations.js';
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

const USER_ID = 9_756_301;
const CHARACTER_ID = 9_756_401;
const CHAT_ID = 9_756_501;
const CTX = { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID };
const CHILDREN: ChildProcessWithoutNullStreams[] = [];
const TEMP_DIRS: string[] = [];

function response(quantity: number): Response {
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
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'p9335-crash-pilot', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'p9335-crash-pilot', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, ?, 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?, ?)
  `).run(CHARACTER_ID, 'Crash Pilot', JSON.stringify(['esi-assets.read_assets.v1']), USER_ID, 'owner-p9335-crash');
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

async function createFileDb(): Promise<{ dir: string; path: string; db: Db }> {
  const dir = await mkdtemp(join(tmpdir(), 'eveai-p9335-crash-'));
  TEMP_DIRS.push(dir);
  const path = join(dir, 'assets.sqlite');
  const db = new Database(path) as Db;
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 20000');
  runMigrations(db);
  linkCharacter(db);
  return { dir, path, db };
}

function spawnCrashChild(dir: string, dbPath: string, quantity: number): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'tests/helpers/p9-3.3.4-asset-child.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      EVEAI_ASSET_DB: dbPath,
      EVEAI_ASSET_BARRIER: dir,
      EVEAI_ASSET_MODE: 'crash-after-mirror-delete',
      EVEAI_ASSET_ROLE: 'crash',
      EVEAI_ASSET_CHARACTER_ID: String(CHARACTER_ID),
      EVEAI_ASSET_USER_ID: String(USER_ID),
      EVEAI_ASSET_CHAT_ID: String(CHAT_ID),
      EVEAI_ASSET_QUANTITY: String(quantity),
    },
    stdio: 'pipe',
  });
  CHILDREN.push(child);
  return child;
}

function waitForChild(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`barrier timeout: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const child of CHILDREN.splice(0)) {
    if (!child.killed) child.kill('SIGKILL');
  }
  for (const dir of TEMP_DIRS.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

describe('P9.3.3.5 crash after a partial transaction mutation', () => {
  it('SIGKILL after the mirror DELETE rolls back mirror deletion and preserves the previous latest snapshot', async () => {
    const { dir, path, db } = await createFileDb();
    vi.stubGlobal('fetch', vi.fn(async () => response(1)));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual');
    db.close();
    vi.unstubAllGlobals();

    const crashed = spawnCrashChild(dir, path, 2);
    await waitForFile(join(dir, 'mirror-deleted'));
    crashed.kill('SIGKILL');
    const result = await waitForChild(crashed);
    expect(result.signal).toBe('SIGKILL');

    const verifier = new Database(path) as Db;
    const latest = verifier.prepare(`
      SELECT snapshot_id, total_quantity FROM real_asset_snapshots
      WHERE character_id = ? AND is_latest = 1
    `).all(CHARACTER_ID) as Array<{ snapshot_id: string; total_quantity: number }>;
    const mirror = verifier.prepare(`
      SELECT quantity FROM character_assets WHERE character_id = ? AND item_id = 98001
    `).get(CHARACTER_ID) as { quantity: number } | undefined;
    const snapshots = verifier.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?
    `).get(CHARACTER_ID) as { n: number };
    const jobs = verifier.prepare(`
      SELECT status FROM real_asset_sync_jobs WHERE character_id = ? ORDER BY generation
    `).all(CHARACTER_ID) as Array<{ status: string }>;
    verifier.close();

    expect(latest).toEqual([{ snapshot_id: first.snapshotId, total_quantity: 1 }]);
    expect(mirror).toEqual({ quantity: 1 });
    expect(snapshots.n).toBe(1);
    expect(jobs.map((job) => job.status)).toEqual(['COMPLETED', 'RUNNING']);
  }, 30_000);
});