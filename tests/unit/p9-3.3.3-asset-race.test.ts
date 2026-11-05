import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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

const USER_ID = 9_733_001;
const CHAT_ID = 9_733_101;
const CHARACTER_ID = 9_733_201;
const CTX = { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID };
const SCOPES = ['esi-assets.read_assets.v1'];
const OPEN_CHILDREN: ChildProcessWithoutNullStreams[] = [];

const CHILD_SCRIPT = String.raw`
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { RealAssetSyncService } from './src/assets/asset-sync-service.ts';

const dbPath = process.env.EVEAI_ASSET_DB;
const barrierDir = process.env.EVEAI_ASSET_BARRIER;
const role = process.env.EVEAI_ASSET_ROLE;
const characterId = Number(process.env.EVEAI_ASSET_CHARACTER_ID);
const quantity = Number(process.env.EVEAI_ASSET_QUANTITY);
const waiter = new Int32Array(new SharedArrayBuffer(4));
const sleep = () => Atomics.wait(waiter, 0, 0, 10);
const waitFile = (name, timeoutMs = 15000) => {
  const path = join(barrierDir, name);
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error('barrier timeout: ' + name);
    sleep();
  }
};
const signal = (name) => writeFileSync(join(barrierDir, name), '1');

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');
const originalPrepare = db.prepare.bind(db);
db.prepare = (sql) => {
  const statement = originalPrepare(sql);
  const isRunningJobLookup = sql.includes('FROM real_asset_sync_jobs') &&
    sql.includes("status = 'RUNNING'") && sql.includes('LIMIT 1');
  const isPreviousSnapshotLookup = role === 'a' && sql.includes('FROM real_asset_snapshots') &&
    sql.includes('is_latest = 1') && sql.includes('LIMIT 1');

  if (!isRunningJobLookup && !isPreviousSnapshotLookup) return statement;
  return new Proxy(statement, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property !== 'get' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args) => {
        const row = value.apply(target, args);
        if (isRunningJobLookup) {
          signal(role + '.job-checked');
          waitFile('a.job-checked');
          waitFile('b.job-checked');
          if (role === 'a') waitFile('b.acquired');
        } else if (isPreviousSnapshotLookup) {
          signal('a.before-previous');
          const deadline = Date.now() + 15000;
          while (!existsSync(join(barrierDir, 'b.completed')) && !existsSync(join(barrierDir, 'b.failed'))) {
            if (Date.now() > deadline) throw new Error('barrier timeout: b terminal');
            sleep();
          }
          if (existsSync(join(barrierDir, 'b.failed'))) throw new Error('child b failed before commit barrier');
        }
        return row;
      };
    },
  });
};

globalThis.fetch = async (input) => {
  const url = String(input);
  if (!url.includes('/characters/' + characterId + '/assets')) {
    throw new Error('unexpected fetch: ' + url);
  }
  if (role === 'b') {
    signal('b.acquired');
    waitFile('a.done');
  } else {
    throw new Error('A reached ESI after B acquired the character lease');
  }
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
      'Cache-Control': 'no-store',
      'X-Pages': '1',
    },
  });
};

try {
  const result = await RealAssetSyncService.syncCharacter(
    db,
    characterId,
    { userId: Number(process.env.EVEAI_ASSET_USER_ID), chatId: Number(process.env.EVEAI_ASSET_CHAT_ID), characterId },
    'manual',
  );
  if (role === 'b') signal('b.completed');
  process.stdout.write(JSON.stringify({ ok: true, snapshotId: result.snapshotId }) + '\n');
} catch (error) {
  if (role === 'b') signal('b.completed');
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n');
  process.exitCode = 2;
} finally {
  signal(role + '.done');
  db.close();
}
`;

let db: Database.Database;

function linkCharacter(database: Database.Database): void {
  database.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'Asset Race', CHARACTER_ID);
  database.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'asset-race', CHARACTER_ID);
  database.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Asset Race', 'asset-token', 'asset-refresh', datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_ID, JSON.stringify(SCOPES), USER_ID);
  database.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

function response(rows: unknown[]): Response {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Pages': '1',
    },
  });
}

function asset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: 88_001,
    type_id: 34,
    location_id: 60_003_760,
    location_type: 'station',
    location_flag: 'Hangar',
    quantity: 5,
    is_singleton: false,
    is_blueprint_copy: false,
    ...overrides,
  };
}

function spawnAssetChild(barrierDir: string, dbPath: string, role: 'a' | 'b', quantity: number): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', CHILD_SCRIPT,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      EVEAI_ASSET_DB: dbPath,
      EVEAI_ASSET_BARRIER: barrierDir,
      EVEAI_ASSET_ROLE: role,
      EVEAI_ASSET_CHARACTER_ID: String(CHARACTER_ID),
      EVEAI_ASSET_USER_ID: String(USER_ID),
      EVEAI_ASSET_CHAT_ID: String(CHAT_ID),
      EVEAI_ASSET_QUANTITY: String(quantity),
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
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  linkCharacter(db);
});

afterEach(() => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const child of OPEN_CHILDREN.splice(0)) {
    if (!child.killed) child.kill('SIGKILL');
  }
  db.close();
});

describe('P9.3.3.3 independent asset snapshot audit', () => {
  it('FINDING: asset sync must reject a characterId that contradicts the pinned user context', async () => {
    const otherCharacterId = CHARACTER_ID + 1;
    db.prepare(`
      INSERT INTO eve_accounts
        (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
      VALUES (?, 'Other Asset Pilot', 'other-token', 'other-refresh', datetime('now', '+1 hour'), ?, ?)
    `).run(otherCharacterId, JSON.stringify(SCOPES), USER_ID);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(CHAT_ID, otherCharacterId, USER_ID);
    vi.stubGlobal('fetch', vi.fn(async () => response([asset({ item_id: 88_101 })])));

    await expect(
      RealAssetSyncService.syncCharacter(
        db as Db,
        otherCharacterId,
        { ...CTX, characterId: CHARACTER_ID },
        'manual',
      ),
    ).rejects.toThrow(/上下文|characterId|角色/);

    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(otherCharacterId))
      .toEqual({ n: 0 });
  });
  it('FINDING: canonical hash must not dedupe away location_type/is_singleton/blueprint-copy changes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([asset()])));
    const first = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');
    expect(first.deduped).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => response([
      asset({ location_type: 'item', is_singleton: true, is_blueprint_copy: true }),
    ])));
    const second = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');

    expect(second.deduped).toBe(false);
    expect(db.prepare(`
      SELECT location_type, is_singleton, is_blueprint_copy
      FROM character_assets WHERE character_id = ? AND item_id = 88001
    `).get(CHARACTER_ID)).toEqual({
      location_type: 'item',
      is_singleton: 1,
      is_blueprint_copy: 1,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 2 });
  });

  it('FINDING: two processes must not both pass RUNNING check and let an older response overwrite the newer snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eveai-asset-race-'));
    const dbPath = join(dir, 'assets.sqlite');
    const childDb = new Database(dbPath);
    childDb.pragma('foreign_keys = ON');
    childDb.pragma('journal_mode = WAL');
    runMigrations(childDb);
    linkCharacter(childDb);
    childDb.close();

    const childA = spawnAssetChild(dir, dbPath, 'a', 1);
    const childB = spawnAssetChild(dir, dbPath, 'b', 2);
    const [resultA, resultB] = await Promise.all([waitForChild(childA), waitForChild(childB)]);

    const verifier = new Database(dbPath);
    verifier.pragma('busy_timeout = 10000');
    const jobs = verifier.prepare(`
      SELECT status, items_committed, snapshot_id
      FROM real_asset_sync_jobs WHERE character_id = ? ORDER BY started_at, job_id
    `).all(CHARACTER_ID) as Array<{ status: string; items_committed: number | null; snapshot_id: string | null }>;
    const latest = verifier.prepare(`
      SELECT total_quantity, snapshot_id FROM real_asset_snapshots
      WHERE character_id = ? AND is_latest = 1
    `).get(CHARACTER_ID) as { total_quantity: number; snapshot_id: string } | undefined;
    const mirror = verifier.prepare(`
      SELECT quantity FROM character_assets WHERE character_id = ? AND item_id = 98001
    `).get(CHARACTER_ID) as { quantity: number } | undefined;
    const snapshotCount = verifier.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?
    `).get(CHARACTER_ID) as { n: number };
    verifier.close();
    await rm(dir, { recursive: true, force: true });

    expect.soft(resultA.code, JSON.stringify({ resultA, resultB })).toBe(2);
    expect.soft(resultB.code, JSON.stringify({ resultA, resultB })).toBe(0);
    expect.soft(jobs).toHaveLength(1);
    expect.soft(snapshotCount.n).toBe(1);
    // B is deterministically released into ownership first. A must lose the
    // acquisition and the later (older) response must never overwrite B.
    expect.soft(latest?.total_quantity).toBe(2);
    expect.soft(jobs[0]?.status).toBe('COMPLETED');
    expect.soft(jobs[0]?.snapshot_id).toBe(latest?.snapshot_id);
    expect.soft(mirror?.quantity).toBe(2);
  });

  it('FINDING: asset sync must abort when the pinned character is unlinked during the ESI response', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/characters/' + CHARACTER_ID + '/assets')) {
        db.prepare('DELETE FROM eve_character_links WHERE chat_id = ? AND character_id = ?')
          .run(CHAT_ID, CHARACTER_ID);
      }
      return response([asset({ item_id: 88_202 })]);
    }));

    await expect(
      RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual'),
    ).rejects.toThrow(/角色|解绑|身份|关联|上下文/);

    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 0 });
  });
});






