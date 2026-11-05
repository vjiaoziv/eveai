import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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

const USER_ID = 9_755_001;
const CHARACTER_ID = 9_755_101;
const CHAT_ID = 9_755_201;
const ROLES = ['p1', 'p2', 'p3', 'p4', 'p5'] as const;
const CHILDREN: ChildProcessWithoutNullStreams[] = [];
const TEMP_DIRS: string[] = [];

function linkCharacter(db: Db): void {
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'five-race-pilot', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'five-race-pilot', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, ?, 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?, ?)
  `).run(CHARACTER_ID, 'Five Race Pilot', JSON.stringify(['esi-assets.read_assets.v1']), USER_ID, 'owner-five');
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

function spawnRole(dir: string, dbPath: string, role: string, quantity: number): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'tests/helpers/p9-3.3.5-race-child.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      EVEAI_AUDIT_DB: dbPath,
      EVEAI_AUDIT_BARRIER: dir,
      EVEAI_AUDIT_ROLE: role,
      EVEAI_AUDIT_CHARACTER_ID: String(CHARACTER_ID),
      EVEAI_AUDIT_USER_ID: String(USER_ID),
      EVEAI_AUDIT_CHAT_ID: String(CHAT_ID),
      EVEAI_AUDIT_QUANTITY: String(quantity),
    },
    stdio: 'pipe',
  });
  CHILDREN.push(child);
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

afterEach(async () => {
  for (const child of CHILDREN.splice(0)) {
    if (!child.killed) child.kill('SIGKILL');
  }
  for (const dir of TEMP_DIRS.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('P9.3.3.5 independent five-process asset ownership race', () => {
  it('allows exactly one owner and one RUNNING job among five independent SQLite processes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eveai-p9335-five-race-'));
    TEMP_DIRS.push(dir);
    const dbPath = join(dir, 'assets.sqlite');
    const db = new Database(dbPath) as Db;
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 20000');
    runMigrations(db);
    linkCharacter(db);
    db.close();

    const children = ROLES.map((role, index) => spawnRole(dir, dbPath, role, index + 1));
    const results = await Promise.all(children.map(waitForChild));
    const parsed = results.map((result) => JSON.parse(result.stdout) as {
      ok: boolean; role: string; quantity: number; error?: string;
    });
    const winner = parsed.find((result) => result.ok);
    expect(winner, JSON.stringify({ results, parsed })).toBeDefined();
    expect(parsed.filter((result) => result.ok)).toHaveLength(1);
    expect(parsed.filter((result) => !result.ok)).toHaveLength(4);

    const verifier = new Database(dbPath) as Db;
    const jobs = verifier.prepare(`
      SELECT generation, status, items_committed, snapshot_id
      FROM real_asset_sync_jobs WHERE character_id = ? ORDER BY generation
    `).all(CHARACTER_ID) as Array<{ generation: number; status: string; items_committed: number; snapshot_id: string }>;
    const latest = verifier.prepare(`
      SELECT snapshot_id, total_quantity FROM real_asset_snapshots
      WHERE character_id = ? AND is_latest = 1
    `).get(CHARACTER_ID) as { snapshot_id: string; total_quantity: number } | undefined;
    const lease = verifier.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?
    `).get(CHARACTER_ID) as { n: number };
    verifier.close();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ generation: 1, status: 'COMPLETED', items_committed: 1 });
    expect(latest?.snapshot_id).toBe(jobs[0]!.snapshot_id);
    expect(latest?.total_quantity).toBe(winner!.quantity);
    expect(lease.n).toBe(0);
  }, 30_000);
});