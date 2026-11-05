import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import type { Db } from '../../src/db/sqlite.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { P93EsiEvidenceService } from '../../src/trading/p9-3-evidence-service.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    auth: { secretKey: 'test-auth-secret' },
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
    assetSync: { enabled: false, intervalMinutes: 60 },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720 },
  },
}));

const USER_ID = 9434001;
const CHAT_ID = 9434101;
const CHARACTER_ID = 9434201;
const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1';
const CTX = { userId: USER_ID, chatId: CHAT_ID };
const OPEN_DATABASES: Database.Database[] = [];
const OPEN_CHILDREN: ChildProcessWithoutNullStreams[] = [];

const CHILD_SCRIPT = String.raw`
const Database = require('better-sqlite3');
const db = new Database(process.env.EVEAI_TEST_DB_PATH);
db.pragma('busy_timeout = 5000');
const ownerId = 'child-process-lease-owner';
const characterId = Number(process.env.EVEAI_TEST_CHARACTER_ID);
db.prepare(
  "INSERT INTO real_esi_transaction_sync_leases " +
  "(character_id, owner_id, acquired_at, expires_at) " +
  "VALUES (?, ?, datetime('now'), datetime('now', '+30 seconds'))"
).run(characterId, ownerId);
process.stdout.write('LEASE_ACQUIRED\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (!String(chunk).includes('release')) return;
  db.prepare('DELETE FROM real_esi_transaction_sync_leases WHERE character_id = ? AND owner_id = ?')
    .run(characterId, ownerId);
  process.stdout.write('LEASE_RELEASED\n');
  setTimeout(() => {
    db.close();
    process.exit(0);
  }, 0);
});
setInterval(() => {}, 1000);
`;

function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  OPEN_DATABASES.push(db);
  return db;
}

function linkCharacter(db: Database.Database): void {
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'Multi Process Lease', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'multi-process-lease', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Multi Process Lease', 'lease-token', 'lease-refresh',
            datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_ID, JSON.stringify([WALLET_SCOPE]), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

function walletRow(transactionId: number): Record<string, unknown> {
  return {
    transaction_id: transactionId,
    date: '2026-05-01T00:00:00Z',
    type_id: 34,
    quantity: 1,
    unit_price: 10,
    is_buy: true,
    location_id: 60003760,
  };
}

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      'X-Pages': '1',
    },
  });
}

function spawnLeaseOwner(dbPath: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ['-e', CHILD_SCRIPT], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      EVEAI_TEST_DB_PATH: dbPath,
      EVEAI_TEST_CHARACTER_ID: String(CHARACTER_ID),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  OPEN_CHILDREN.push(child);
  return child;
}

function waitForOutput(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`子进程等待 ${expected} 超时。stdout=${stdout} stderr=${stderr}`));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!stdout.includes(expected)) return;
      cleanup();
      resolve();
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`子进程在 ${expected} 前退出：code=${code} signal=${signal} stderr=${stderr}`));
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('exit', onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`子进程异常退出：code=${code} signal=${signal}`));
    });
  });
}

function observeWalletLeaseAttempt(db: Database.Database): Promise<void> {
  let signalAttempt!: () => void;
  const attempted = new Promise<void>((resolve) => {
    signalAttempt = resolve;
  });
  const originalPrepare = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => {
    const statement = originalPrepare(sql);
    if (!sql.includes('INSERT INTO real_esi_transaction_sync_leases')) return statement;
    return new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === 'run') {
          return (...args: unknown[]) => {
            signalAttempt();
            return (value as (...params: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return attempted;
}

afterEach(() => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const child of OPEN_CHILDREN.splice(0)) {
    if (!child.killed) child.kill('SIGKILL');
  }
  while (OPEN_DATABASES.length > 0) OPEN_DATABASES.pop()?.close();
});

describe('P9.3.3.2 multi-process wallet lease', () => {
  it('does not commit while a separate process owns the character lease and resumes after explicit release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eveai-wallet-multiprocess-'));
    const dbPath = join(dir, 'wallet.sqlite');
    const db = openDatabase(dbPath);
    let child: ChildProcessWithoutNullStreams | null = null;
    try {
      runMigrations(db);
      linkCharacter(db);
      child = spawnLeaseOwner(dbPath);
      await waitForOutput(child, 'LEASE_ACQUIRED');
      expect(db.prepare(`
        SELECT owner_id FROM real_esi_transaction_sync_leases WHERE character_id = ?
      `).get(CHARACTER_ID)).toEqual({ owner_id: 'child-process-lease-owner' });

      vi.stubGlobal('fetch', vi.fn(async () => response([walletRow(970)])));
      const leaseAttempted = observeWalletLeaseAttempt(db);
      const sync = P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_ID, CTX);
      await leaseAttempted;

      expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE character_id = ?').get(CHARACTER_ID))
        .toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM real_esi_transaction_sync WHERE character_id = ?').get(CHARACTER_ID))
        .toEqual({ n: 0 });
      expect(db.prepare(`
        SELECT owner_id FROM real_esi_transaction_sync_leases WHERE character_id = ?
      `).get(CHARACTER_ID)).toEqual({ owner_id: 'child-process-lease-owner' });

      const childExited = waitForExit(child);
      const released = waitForOutput(child, 'LEASE_RELEASED');
      child.stdin.write('release\n');
      await released;
      await childExited;

      const result = await sync;
      expect(result).toMatchObject({ ok: true, status: 'ok', imported: 1, lastTransactionId: 970 });
      expect(db.prepare(`
        SELECT last_transaction_id, status FROM real_esi_transaction_sync WHERE character_id = ?
      `).get(CHARACTER_ID)).toEqual({ last_transaction_id: 970, status: 'ok' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE character_id = ?').get(CHARACTER_ID))
        .toEqual({ n: 1 });
      expect(db.prepare(`
        SELECT COUNT(*) AS n FROM real_esi_transaction_sync_leases WHERE character_id = ?
      `).get(CHARACTER_ID)).toEqual({ n: 0 });
    } finally {
      if (child && !child.killed) child.kill('SIGKILL');
      const index = OPEN_DATABASES.indexOf(db);
      if (index >= 0) OPEN_DATABASES.splice(index, 1);
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
