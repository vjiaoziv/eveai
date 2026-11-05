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

const USER_ID = 9_747_001;
const CHARACTER_ID = 9_747_101;
const CHAT_ID = 9_747_201;
const CTX = { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID };
const SCOPES = ['esi-assets.read_assets.v1'];
const OPEN_CHILDREN: ChildProcessWithoutNullStreams[] = [];
const TEMP_DIRS: string[] = [];
let memoryDb: Db | null = null;

function jsonResponse(): Response {
  return new Response(JSON.stringify([{
    item_id: 98_001,
    type_id: 34,
    location_id: 60_003_760,
    location_type: 'station',
    location_flag: 'Hangar',
    quantity: 1,
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
    .run(USER_ID, 'asset-unbind-pilot', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'asset-unbind-pilot', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, ?, 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?, ?)
  `).run(CHARACTER_ID, 'Asset Unbind Pilot', JSON.stringify(SCOPES), USER_ID, 'owner-unbind');
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

function createMemoryDb(): Db {
  const db = new Database(':memory:') as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  linkCharacter(db);
  memoryDb = db;
  return db;
}

async function createFileDb(): Promise<{ dir: string; path: string; db: Db }> {
  const dir = await mkdtemp(join(tmpdir(), 'eveai-p9334-unbind-'));
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
  memoryDb = null;
});

afterEach(async () => {
  memoryDb?.close();
  memoryDb = null;
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

describe('P9.3.3.4 asset unlink and binding generation races', () => {
  it('T15: unlinking during the ESI response rejects commit and preserves the previous state', async () => {
    const db = createMemoryDb();
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input).includes(`/characters/${CHARACTER_ID}/assets`)) {
        db.prepare('DELETE FROM eve_character_links WHERE chat_id = ? AND character_id = ?')
          .run(CHAT_ID, CHARACTER_ID);
      }
      return jsonResponse();
    }));

    await expect(RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/身份上下文已失效|解绑|上下文/);

    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({ n: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({ n: 0 });
    expect(db.prepare(`
      SELECT status FROM real_asset_sync_jobs WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({ status: 'FAILED' });
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({ n: 0 });
  });

  it('T16: unlink followed by rebinding the same character still invalidates the in-flight task', async () => {
    const db = createMemoryDb();
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input).includes(`/characters/${CHARACTER_ID}/assets`)) {
        db.prepare('DELETE FROM eve_character_links WHERE chat_id = ? AND character_id = ?')
          .run(CHAT_ID, CHARACTER_ID);
        db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
          .run(CHAT_ID, CHARACTER_ID, USER_ID);
      }
      return jsonResponse();
    }));

    await expect(RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/身份上下文已失效|上下文/);

    const link = db.prepare(`
      SELECT user_id FROM eve_character_links WHERE chat_id = ? AND character_id = ?
    `).get(CHAT_ID, CHARACTER_ID) as { user_id: number };
    const epoch = db.prepare(`
      SELECT epoch FROM eve_character_binding_epochs WHERE chat_id = ? AND character_id = ?
    `).get(CHAT_ID, CHARACTER_ID) as { epoch: number };
    expect(link.user_id).toBe(USER_ID);
    expect(epoch.epoch).toBeGreaterThanOrEqual(3);
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({ n: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({ n: 0 });
  });

  it('T17a/T18: unlink linearized first rejects the waiter even while its lease is still present', async () => {
    const { dir, path, db } = await createFileDb();
    db.close();

    const syncing = spawnAssetChild({ dir, path, mode: 'hold-fetch', role: 'sync', quantity: 1 });
    await waitForFile(join(dir, 'fetch-entered'));
    const observer = new Database(path) as Db;
    observer.pragma('busy_timeout = 20000');
    expect(observer.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({ n: 1 });

    observer.prepare('DELETE FROM eve_character_links WHERE chat_id = ? AND character_id = ?')
      .run(CHAT_ID, CHARACTER_ID);
    writeFileSync(join(dir, 'release-fetch'), '1');
    const result = await waitForChild(syncing);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/身份上下文已失效|解绑|上下文/);
    expect(observer.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({ n: 0 });
    expect(observer.prepare(`
      SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({ n: 0 });
    expect(observer.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({ n: 0 });
    observer.close();
  }, 30_000);

  it('T17b: when commit linearizes first, the snapshot commits and a waiting unlink applies afterward', async () => {
    const { dir, path, db } = await createFileDb();
    db.close();

    const syncing = spawnAssetChild({ dir, path, mode: 'commit-hold', role: 'sync', quantity: 2 });
    await waitForFile(join(dir, 'commit-blocked'));
    const unlinking = spawnAssetChild({ dir, path, mode: 'unlink', role: 'unlink' });
    writeFileSync(join(dir, 'unlink-requested'), '1');
    await waitForFile(join(dir, 'unlink-attempting'));

    // The sync transaction holds the write lock. Releasing it makes the commit
    // linearize before the already-waiting unlink transaction.
    writeFileSync(join(dir, 'release-commit'), '1');
    const [syncResult, unlinkResult] = await Promise.all([
      waitForChild(syncing),
      waitForChild(unlinking),
    ]);

    const observer = new Database(path) as Db;
    const latest = observer.prepare(`
      SELECT total_quantity FROM real_asset_snapshots
      WHERE character_id = ? AND is_latest = 1
    `).get(CHARACTER_ID) as { total_quantity: number };
    const mirror = observer.prepare(`
      SELECT quantity FROM character_assets WHERE character_id = ? AND item_id = 98001
    `).get(CHARACTER_ID) as { quantity: number };
    const linkCount = observer.prepare(`
      SELECT COUNT(*) AS n FROM eve_character_links WHERE chat_id = ? AND character_id = ?
    `).get(CHAT_ID, CHARACTER_ID) as { n: number };
    const leaseCount = observer.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?
    `).get(CHARACTER_ID) as { n: number };
    observer.close();

    expect(syncResult.code).toBe(0);
    expect(unlinkResult.code).toBe(0);
    expect(latest.total_quantity).toBe(2);
    expect(mirror.quantity).toBe(2);
    expect(linkCount.n).toBe(0);
    expect(leaseCount.n).toBe(0);
  }, 30_000);
});
