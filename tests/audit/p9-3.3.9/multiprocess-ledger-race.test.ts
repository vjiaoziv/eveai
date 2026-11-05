import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { resolveAssetLineage } from '../../../src/assets/asset-lineage.js';
import { P93LedgerService } from '../../../src/trading/p9-3-ledger-service.js';
import type { P93RecordInput } from '../../../src/trading/p9-3-types.js';
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
    auth: { secretKey: 'p9339-multiprocess-ledger-secret' },
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

const CHARACTER_ID = 9_948_201;
const TYPE_ID = 34;
const LOCATION_ID = 60_003_760;
const CHILDREN: ChildProcessWithoutNullStreams[] = [];
const TEMP_DIRS: string[] = [];

function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 20000');
  return db;
}

function linkAccount(db: Database.Database, session: CreatedWebSession, ownerHash: string): void {
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'P9339 Multiprocess Ledger Pilot', 'access-token', 'refresh-token',
            datetime('now', '+1 hour'), ?, ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET
      user_id = excluded.user_id,
      owner_hash = excluded.owner_hash,
      scopes_json = excluded.scopes_json,
      access_token = excluded.access_token,
      expires_at = excluded.expires_at
  `).run(CHARACTER_ID, JSON.stringify(['esi-wallet.read_character_wallet.v1']), session.userId, ownerHash);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(session.chatId, CHARACTER_ID, session.userId);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?')
    .run(CHARACTER_ID, session.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
    .run(CHARACTER_ID, session.chatId);
}

function transferOwnership(db: Database.Database, ownerA: CreatedWebSession, ownerB: CreatedWebSession): void {
  db.prepare('UPDATE users SET active_character_id = NULL WHERE user_id = ?').run(ownerA.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = NULL WHERE chat_id = ?').run(ownerA.chatId);
  db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
  linkAccount(db, ownerB, 'p9339-multiprocess-owner-b');
}

function seedVerifiedTrade(db: Database.Database, session: CreatedWebSession, round: number): string {
  const lineage = resolveAssetLineage(db as Db, CHARACTER_ID, session.userId, session.chatId);
  const input: P93RecordInput = {
    ledgerKey: `p9339-multiprocess-private-${round}`,
    tradeKind: 'BUY',
    direction: 'BUY',
    typeId: TYPE_ID,
    locationId: LOCATION_ID,
    quantity: 11,
    unitPrice: 13,
    tradeTime: '2026-09-04T00:00:00.000Z',
    sourceType: 'USER_MANUAL_ENTRY',
    sourceRef: `p9339-multiprocess-source-${round}`,
    draft: false,
    feeStatus: 'COMPLETE',
    notes: `P9339_MULTIPROCESS_PRIVATE_${round}`,
  };
  const record = P93LedgerService.recordManual(
    db as Db, CHARACTER_ID, input, `user:${session.userId}`, lineage,
  );
  const evidence = P93LedgerService.addEvidence(db as Db, CHARACTER_ID, {
    evidenceType: 'ESI_WALLET_LOG',
    sourceSystem: 'ESI_WALLET_TRANSACTIONS',
    sourceRef: `esi-wallet:${94980000 + round}`,
    capturedAt: record.tradeTime,
    payloadHash: `p9339-multiprocess-hash-${round}`,
    summary: `P9339 multiprocess evidence ${round}`,
    initialStatus: 'VERIFIED',
    metadata: {
      transactionId: 94_980_000 + round,
      typeId: TYPE_ID,
      quantity: record.quantity,
      unitPrice: record.unitPrice,
      isBuy: true,
      locationId: LOCATION_ID,
      tradeTime: record.tradeTime,
    },
  }, 'ESI_SYNC', lineage);
  P93LedgerService.linkEvidence(
    db as Db, CHARACTER_ID, record.recordId, evidence.evidenceId, 'PRIMARY', 'HIGH',
    undefined, 'USER', `user:${session.userId}`, lineage,
  );
  P93LedgerService.verify(
    db as Db, CHARACTER_ID, record.recordId, `user:${session.userId}`,
    undefined, 'USER', lineage,
  );
  return record.recordId;
}

function spawnReverse(input: {
  dbPath: string;
  barrierDir: string;
  role: string;
  recordId: string;
  actor: string;
  lineage: Record<string, unknown>;
}): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'tests/audit/p9-3.3.9/ledger-reversal-child.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      EVEAI_P9339_LEDGER_DB: input.dbPath,
      EVEAI_P9339_LEDGER_BARRIER: input.barrierDir,
      EVEAI_P9339_LEDGER_ROLE: input.role,
      EVEAI_P9339_LEDGER_CHARACTER_ID: String(CHARACTER_ID),
      EVEAI_P9339_LEDGER_RECORD_ID: input.recordId,
      EVEAI_P9339_LEDGER_ACTOR: input.actor,
      EVEAI_P9339_LEDGER_LINEAGE_JSON: JSON.stringify(input.lineage),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  CHILDREN.push(child);
  return child;
}

function collect(child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> {
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

describe('P9.3.3.9 multiprocess REAL ledger authorization race', () => {
  it('rejects stale-owner and new-owner reversals through a shared barrier in five independent rounds', async () => {
    resetWebSessionCreationGuardForTests();
    for (let round = 1; round <= 5; round += 1) {
      const dir = await mkdtemp(join(tmpdir(), `eveai-p9339-ledger-race-${round}-`));
      TEMP_DIRS.push(dir);
      const dbPath = join(dir, 'ledger.sqlite');
      const primary = openDatabase(dbPath);
      runMigrations(primary);
      const ownerA = createWebSession(primary);
      const ownerB = createWebSession(primary);
      linkAccount(primary, ownerA, 'p9339-multiprocess-owner-a');
      const recordId = seedVerifiedTrade(primary, ownerA, round);
      const lineageA = resolveAssetLineage(primary as Db, CHARACTER_ID, ownerA.userId, ownerA.chatId);
      const secondary = openDatabase(dbPath);
      transferOwnership(secondary, ownerA, ownerB);
      const lineageB = resolveAssetLineage(primary as Db, CHARACTER_ID, ownerB.userId, ownerB.chatId);
      secondary.close();
      primary.close();

      const stale = spawnReverse({
        dbPath, barrierDir: dir, role: `stale-${round}`, recordId,
        actor: `user:${ownerA.userId}`, lineage: lineageA as unknown as Record<string, unknown>,
      });
      const newOwner = spawnReverse({
        dbPath, barrierDir: dir, role: `new-${round}`, recordId,
        actor: `user:${ownerB.userId}`, lineage: lineageB as unknown as Record<string, unknown>,
      });
      await Promise.all([
        waitForFile(join(dir, `stale-${round}.ready`)),
        waitForFile(join(dir, `new-${round}.ready`)),
      ]);
      writeFileSync(join(dir, 'go'), '1');

      const results = await Promise.all([collect(stale), collect(newOwner)]);
      expect(results.every((row) => row.ok === false), `round ${round}: ${JSON.stringify(results)}`).toBe(true);
      expect(String(results[0].error)).toMatch(/账户所有权与当前用户不一致/);
      expect(String(results[1].error)).toMatch(/不存在/);

      const verifier = openDatabase(dbPath);
      expect(verifier.prepare(`
        SELECT record_state, verification_status, reverses_record_id
        FROM real_trade_records WHERE record_id = ?
      `).get(recordId)).toEqual({
        record_state: 'VERIFIED', verification_status: 'VERIFIED', reverses_record_id: null,
      });
      expect(verifier.prepare('SELECT COUNT(*) AS n FROM real_trade_events WHERE record_id = ?')
        .get(recordId)).toEqual({ n: 3 });
      expect(verifier.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence WHERE character_id = ? AND owner_user_id = ?')
        .get(CHARACTER_ID, ownerA.userId)).toEqual({ n: 1 });
      expect(verifier.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
      verifier.close();
    }
  }, 60_000);
});