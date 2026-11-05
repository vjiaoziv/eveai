import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  type CreatedWebSession,
} from '../../../src/web/web-session.js';
import type { Db } from '../../../src/db/sqlite.js';

vi.mock('../../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    auth: { secretKey: 'p9339-wallet-recovery-secret' },
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
    assetSync: { enabled: false, intervalMinutes: 60 },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' }, sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720, sessionCreationWindowSeconds: 60, maxSessionCreationsPerWindow: 100 },
  },
}));

const CHARACTER_ID = 9_949_201;
const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1';
const CHILDREN: ChildProcessWithoutNullStreams[] = [];
const TEMP_DIRS: string[] = [];

function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 20000');
  return db;
}

function linkWallet(db: Database.Database, session: CreatedWebSession, round: number): void {
  db.prepare('UPDATE users SET display_name = ?, active_character_id = ? WHERE user_id = ?')
    .run(`P9339 Wallet Recovery ${round}`, CHARACTER_ID, session.userId);
  db.prepare('UPDATE telegram_sessions SET username = ?, active_character_id = ? WHERE chat_id = ?')
    .run(`p9339-wallet-recovery-${round}`, CHARACTER_ID, session.chatId);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'P9339 Wallet Recovery Pilot', 'access-token', 'refresh-token',
            datetime('now', '+1 hour'), ?, ?, ?)
  `).run(CHARACTER_ID, JSON.stringify([WALLET_SCOPE]), session.userId, `p9339-wallet-owner-${round}`);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(session.chatId, CHARACTER_ID, session.userId);
}

function spawnWallet(input: {
  dbPath: string;
  barrierDir: string;
  role: string;
  session: CreatedWebSession;
  immediate: boolean;
}): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'tests/audit/p9-3.3.9/wallet-recovery-child.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      EVEAI_P9339_WALLET_DB: input.dbPath,
      EVEAI_P9339_WALLET_BARRIER: input.barrierDir,
      EVEAI_P9339_WALLET_ROLE: input.role,
      EVEAI_P9339_WALLET_CHARACTER_ID: String(CHARACTER_ID),
      EVEAI_P9339_WALLET_USER_ID: String(input.session.userId),
      EVEAI_P9339_WALLET_CHAT_ID: String(input.session.chatId),
      EVEAI_P9339_WALLET_IMMEDIATE: input.immediate ? '1' : '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  CHILDREN.push(child);
  return child;
}

function collect(child: ChildProcessWithoutNullStreams): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`child timeout: ${stderr}`)), 20_000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`child failed code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`));
        return;
      }
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error(`invalid output=${stdout} stderr=${stderr}`)); }
    });
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`file barrier timeout: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of CHILDREN.splice(0)) if (!child.killed) child.kill('SIGKILL');
  for (const dir of TEMP_DIRS.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('P9.3.3.9 wallet failure-queue and cursor concurrency', () => {
  it('recovers a failed low transaction ID through two concurrent processes in five rounds without duplicates', async () => {
    for (let round = 1; round <= 5; round += 1) {
      resetWebSessionCreationGuardForTests();
      const dir = await mkdtemp(join(tmpdir(), `eveai-p9339-wallet-race-${round}-`));
      TEMP_DIRS.push(dir);
      const dbPath = join(dir, 'wallet.sqlite');
      const db = openDatabase(dbPath);
      runMigrations(db);
      const session = createWebSession(db);
      linkWallet(db, session, round);
      db.exec(`
        CREATE TRIGGER p9339_reject_low_id
        BEFORE INSERT ON real_trade_records
        WHEN NEW.source_ref = 'esi-wallet:100'
        BEGIN
          SELECT RAISE(ABORT, 'p9339 transient database failure');
        END;
      `);
      db.close();

      const failure = spawnWallet({
        dbPath, barrierDir: dir, role: `failure-${round}`, session, immediate: true,
      });
      await waitForFile(join(dir, `failure-${round}.ready`));
      writeFileSync(join(dir, 'immediate-go'), '1');
      const failureResult = await collect(failure);
      expect(failureResult.result).toMatchObject({
        ok: false,
        status: 'error',
        imported: 1,
        lastTransactionId: null,
        errorCode: 'TRANSACTION_IMPORT_FAILED',
      });

      const afterFailure = openDatabase(dbPath);
      expect(afterFailure.prepare(`
        SELECT transaction_id, error_code FROM real_esi_transaction_failures
        WHERE character_id = ? AND owner_user_id = ? ORDER BY transaction_id
      `).all(CHARACTER_ID, session.userId)).toEqual([
        { transaction_id: 100, error_code: 'TRANSACTION_IMPORT_FAILED' },
      ]);
      expect(afterFailure.prepare(`
        SELECT last_transaction_id, status FROM real_esi_transaction_sync
        WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ?
      `).get(CHARACTER_ID, session.userId, session.chatId)).toEqual({
        last_transaction_id: null, status: 'error',
      });
      afterFailure.exec('DROP TRIGGER p9339_reject_low_id');
      afterFailure.close();

      const recoveryA = spawnWallet({
        dbPath, barrierDir: dir, role: `recovery-a-${round}`, session, immediate: false,
      });
      const recoveryB = spawnWallet({
        dbPath, barrierDir: dir, role: `recovery-b-${round}`, session, immediate: false,
      });
      await Promise.all([
        waitForFile(join(dir, `recovery-a-${round}.ready`)),
        waitForFile(join(dir, `recovery-b-${round}.ready`)),
      ]);
      writeFileSync(join(dir, 'go'), '1');
      const recovered = await Promise.all([collect(recoveryA), collect(recoveryB)]);
      const results = recovered.map((row) => row.result);
      expect(results.every((result) => result.ok === true && result.status === 'ok')).toBe(true);
      expect(results.reduce((sum, result) => sum + Number(result.imported), 0)).toBeGreaterThanOrEqual(1);
      expect(results.reduce((sum, result) => sum + Number(result.skipped), 0)).toBeGreaterThanOrEqual(0);

      const verifier = openDatabase(dbPath);
      expect(verifier.prepare(`
        SELECT last_transaction_id, status, error FROM real_esi_transaction_sync
        WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ?
      `).get(CHARACTER_ID, session.userId, session.chatId)).toEqual({
        last_transaction_id: 101, status: 'ok', error: null,
      });
      expect(verifier.prepare(`
        SELECT COUNT(*) AS n FROM real_esi_transaction_failures WHERE character_id = ?
      `).get(CHARACTER_ID)).toEqual({ n: 0 });
      expect(verifier.prepare(`
        SELECT COUNT(*) AS n FROM real_trade_records WHERE character_id = ? AND owner_user_id = ?
      `).get(CHARACTER_ID, session.userId)).toEqual({ n: 2 });
      expect(verifier.prepare(`
        SELECT COUNT(*) AS n FROM real_trade_evidence WHERE character_id = ? AND owner_user_id = ?
      `).get(CHARACTER_ID, session.userId)).toEqual({ n: 2 });
      expect(verifier.prepare(`
        SELECT COUNT(*) AS n FROM real_trade_evidence_links l
        JOIN real_trade_records r ON r.record_id = l.record_id
        WHERE r.character_id = ? AND r.owner_user_id = ?
      `).get(CHARACTER_ID, session.userId)).toEqual({ n: 2 });
      expect(verifier.prepare(`
        SELECT COUNT(*) AS n FROM real_esi_transaction_sync_leases
        WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ?
      `).get(CHARACTER_ID, session.userId, session.chatId)).toEqual({ n: 0 });
      expect(verifier.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
      verifier.close();
    }
  }, 60_000);
});