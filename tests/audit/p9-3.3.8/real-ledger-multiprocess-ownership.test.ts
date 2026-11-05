import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
    auth: { secretKey: 'p9338-multiprocess-ledger-secret' },
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
    web: {
      baseUrl: 'http://localhost:3000',
      sessionTtlHours: 720,
      sessionCreationWindowSeconds: 60,
      maxSessionCreationsPerWindow: 100,
    },
  },
}));

const CHARACTER_ID = 9_838_881;
const TYPE_ID = 34;
const LOCATION_ID = 60_003_760;
const OPEN_DATABASES: Database.Database[] = [];
const OPEN_CHILDREN: ChildProcessWithoutNullStreams[] = [];

function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 20000');
  OPEN_DATABASES.push(db);
  return db;
}

function linkAccount(db: Database.Database, session: CreatedWebSession, ownerHash: string): void {
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at,
       scopes_json, user_id, owner_hash)
    VALUES (?, 'Multiprocess Ownership Pilot', 'access-token', 'refresh-token',
            datetime('now', '+1 hour'), ?, ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET
      user_id = excluded.user_id,
      owner_hash = excluded.owner_hash,
      scopes_json = excluded.scopes_json,
      expires_at = excluded.expires_at
  `).run(
    CHARACTER_ID,
    JSON.stringify(['esi-wallet.read_character_wallet.v1']),
    session.userId,
    ownerHash,
  );
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
  linkAccount(db, ownerB, 'multiprocess-owner-b-binding');
}

function seedVerifiedTrade(db: Database.Database, session: CreatedWebSession): {
  recordId: string;
  evidenceId: string;
} {
  const lineage = resolveAssetLineage(db as Db, CHARACTER_ID, session.userId, session.chatId);
  const input: P93RecordInput = {
    ledgerKey: 'multiprocess-owner-a-private',
    tradeKind: 'BUY',
    direction: 'BUY',
    typeId: TYPE_ID,
    locationId: LOCATION_ID,
    quantity: 10,
    unitPrice: 100,
    tradeTime: '2026-09-01T00:00:00.000Z',
    sourceType: 'USER_MANUAL_ENTRY',
    sourceRef: 'multiprocess-owner-a-source',
    draft: false,
    feeStatus: 'COMPLETE',
    notes: 'MULTIPROCESS_OWNER_A_PRIVATE',
  };
  const record = P93LedgerService.recordManual(
    db as Db,
    CHARACTER_ID,
    input,
    `user:${session.userId}`,
    lineage,
  );
  const evidence = P93LedgerService.addEvidence(db as Db, CHARACTER_ID, {
    evidenceType: 'ESI_WALLET_LOG',
    sourceSystem: 'ESI_WALLET_TRANSACTIONS',
    sourceRef: 'esi-wallet:9838881',
    capturedAt: input.tradeTime,
    payloadHash: 'multiprocess-owner-a-payload',
    summary: 'MULTIPROCESS_OWNER_A_EVIDENCE',
    initialStatus: 'VERIFIED',
    metadata: {
      transactionId: 9_838_881,
      typeId: TYPE_ID,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      isBuy: true,
      locationId: LOCATION_ID,
      tradeTime: input.tradeTime,
    },
  }, 'ESI_SYNC', lineage);
  P93LedgerService.linkEvidence(
    db as Db,
    CHARACTER_ID,
    record.recordId,
    evidence.evidenceId,
    'PRIMARY',
    'HIGH',
    undefined,
    'USER',
    `user:${session.userId}`,
    lineage,
  );
  P93LedgerService.verify(
    db as Db,
    CHARACTER_ID,
    record.recordId,
    `user:${session.userId}`,
    undefined,
    'USER',
    lineage,
  );
  return { recordId: record.recordId, evidenceId: evidence.evidenceId };
}

function collectChild(child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child timeout stdout=${stdout} stderr=${stderr}`));
    }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`child exit code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as Record<string, unknown>);
      } catch {
        reject(new Error(`invalid child output stdout=${stdout} stderr=${stderr}`));
      }
    });
  });
}

function spawnReversal(
  dbPath: string,
  lineage: Record<string, unknown>,
  actor: string,
  recordId: string,
): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'tests/helpers/p9-3.3.8-ledger-reversal-child.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      EVEAI_LEDGER_DB: dbPath,
      EVEAI_LEDGER_CHARACTER_ID: String(CHARACTER_ID),
      EVEAI_LEDGER_RECORD_ID: recordId,
      EVEAI_LEDGER_ACTOR: actor,
      EVEAI_LEDGER_LINEAGE_JSON: JSON.stringify(lineage),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  OPEN_CHILDREN.push(child);
  return child;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of OPEN_CHILDREN.splice(0)) {
    if (!child.killed) child.kill('SIGKILL');
  }
  while (OPEN_DATABASES.length > 0) {
    OPEN_DATABASES.pop()?.close();
  }
});

describe('P9.3.3.8 REAL ledger cross-connection and multi-process ownership', () => {
  it('rejects stale-owner and new-owner reversal through separate connections and processes without mutating facts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eveai-p9338-ledger-'));
    const dbPath = join(dir, 'ledger.sqlite');
    let primary: Database.Database | null = null;
    let secondary: Database.Database | null = null;
    try {
      resetWebSessionCreationGuardForTests();
      primary = openDatabase(dbPath);
      runMigrations(primary);
      const ownerA = createWebSession(primary);
      const ownerB = createWebSession(primary);
      linkAccount(primary, ownerA, 'multiprocess-owner-a-binding');
      const { recordId } = seedVerifiedTrade(primary, ownerA);
      const lineageA = resolveAssetLineage(primary as Db, CHARACTER_ID, ownerA.userId, ownerA.chatId);

      secondary = openDatabase(dbPath);
      transferOwnership(secondary, ownerA, ownerB);
      const lineageB = resolveAssetLineage(primary as Db, CHARACTER_ID, ownerB.userId, ownerB.chatId);

      expect(P93LedgerService.list(secondary as Db, CHARACTER_ID, {}, lineageB).records).toEqual([]);
      expect(() => P93LedgerService.reverse(
        secondary as Db,
        CHARACTER_ID,
        recordId,
        `user:${ownerB.userId}`,
        'new owner via independent connection',
        lineageB,
      )).toThrow(/不存在/);
      expect(() => P93LedgerService.reverse(
        secondary as Db,
        CHARACTER_ID,
        recordId,
        `user:${ownerA.userId}`,
        'stale owner via independent connection',
        lineageA,
      )).toThrow(/账户所有权与当前用户不一致/);

      const staleChild = spawnReversal(
        dbPath,
        lineageA as unknown as Record<string, unknown>,
        `user:${ownerA.userId}`,
        recordId,
      );
      const staleResult = await collectChild(staleChild);
      expect(staleResult.ok).toBe(false);
      expect(String(staleResult.error)).toMatch(/账户所有权与当前用户不一致/);

      const newOwnerChild = spawnReversal(
        dbPath,
        lineageB as unknown as Record<string, unknown>,
        `user:${ownerB.userId}`,
        recordId,
      );
      const newOwnerResult = await collectChild(newOwnerChild);
      expect(newOwnerResult.ok).toBe(false);
      expect(String(newOwnerResult.error)).toMatch(/不存在/);

      expect(primary.prepare(`
        SELECT record_state, verification_status, reverses_record_id
        FROM real_trade_records WHERE record_id = ?
      `).get(recordId)).toEqual({
        record_state: 'VERIFIED',
        verification_status: 'VERIFIED',
        reverses_record_id: null,
      });
      expect(primary.prepare(
        'SELECT COUNT(*) AS n FROM real_trade_events WHERE record_id = ?',
      ).get(recordId)).toEqual({ n: 3 });
      expect(primary.prepare(
        'SELECT COUNT(*) AS n FROM real_trade_evidence WHERE character_id = ? AND owner_user_id = ?',
      ).get(CHARACTER_ID, ownerA.userId)).toEqual({ n: 1 });
    } finally {
      const indexPrimary = primary ? OPEN_DATABASES.indexOf(primary) : -1;
      if (indexPrimary >= 0) OPEN_DATABASES.splice(indexPrimary, 1);
      primary?.close();
      const indexSecondary = secondary ? OPEN_DATABASES.indexOf(secondary) : -1;
      if (indexSecondary >= 0) OPEN_DATABASES.splice(indexSecondary, 1);
      secondary?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
