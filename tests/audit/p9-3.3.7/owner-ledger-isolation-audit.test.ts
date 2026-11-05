import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { deleteCharacterData } from '../../../src/db/character-datastore.js';
import { P93FifoService } from '../../../src/trading/p9-3-fifo-service.js';
import { P93LedgerService } from '../../../src/trading/p9-3-ledger-service.js';
import type { P93RecordInput } from '../../../src/trading/p9-3-types.js';
import { registerP93Routes } from '../../../src/web/p9-3-routes.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
  type CreatedWebSession,
} from '../../../src/web/web-session.js';
import type { Db } from '../../../src/db/sqlite.js';

vi.mock('../../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    auth: { secretKey: 'audit-test-secret' },
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

const CHARACTER_ID = 9_833_701;
const LOCATION_ID = 60_003_760;
const BASE = '/api/web/trading/p9/real-ledger';
const ORIGIN = 'http://localhost:3000';
const OPEN_APPS: Array<ReturnType<typeof Fastify>> = [];

let db: Db;
let sessionA: CreatedWebSession;
let sessionB: CreatedWebSession;
let oldRecordId: string;

function recordInput(): P93RecordInput {
  return {
    ledgerKey: 'owner-a-private-trade',
    tradeKind: 'BUY',
    direction: 'BUY',
    typeId: 34,
    locationId: LOCATION_ID,
    quantity: 10,
    unitPrice: 100,
    tradeTime: '2026-09-01T00:00:00.000Z',
    sourceType: 'USER_MANUAL_ENTRY',
    draft: false,
    feeStatus: 'COMPLETE',
    notes: 'OWNER_A_PRIVATE_NOTE',
  };
}

function linkAccount(session: CreatedWebSession, ownerHash: string): void {
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at,
       scopes_json, user_id, owner_hash)
    VALUES (?, 'Ownership Transfer Pilot', 'access-token', 'refresh-token',
            datetime('now', '+1 hour'), ?, ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET
      user_id = excluded.user_id,
      owner_hash = excluded.owner_hash,
      scopes_json = excluded.scopes_json,
      expires_at = excluded.expires_at
  `).run(CHARACTER_ID, JSON.stringify(['esi-wallet.read_character_wallet.v1']), session.userId, ownerHash);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(session.chatId, CHARACTER_ID, session.userId);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?')
    .run(CHARACTER_ID, session.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
    .run(CHARACTER_ID, session.chatId);
}

function transferOwnershipToB(): void {
  // Mirrors auth-routes reassignCharacterOwnership(): private character profile
  // rows are deleted, while REAL accounting tables are not covered by
  // deleteCharacterData().
  db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
  db.prepare('UPDATE eve_accounts SET user_id = ?, owner_hash = ? WHERE character_id = ?')
    .run(sessionB.userId, 'owner-b-new-hash', CHARACTER_ID);
  db.prepare('DELETE FROM eve_character_links WHERE chat_id = ?').run(sessionB.chatId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(sessionB.chatId, CHARACTER_ID, sessionB.userId);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id IN (?, ?)')
    .run(CHARACTER_ID, sessionA.userId, sessionB.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id IN (?, ?)')
    .run(CHARACTER_ID, sessionA.chatId, sessionB.chatId);
  deleteCharacterData(db, CHARACTER_ID);
}

function readHeaders(session: CreatedWebSession): { cookie: string } {
  return { cookie: `${WEB_SESSION_COOKIE}=${session.sessionToken}` };
}

function mutationHeaders(session: CreatedWebSession): Record<string, string> {
  return {
    ...readHeaders(session),
    origin: ORIGIN,
    'x-csrf-token': session.csrfToken,
  };
}

beforeEach(async () => {
  resetWebSessionCreationGuardForTests();
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  sessionA = createWebSession(db);
  sessionB = createWebSession(db);
  linkAccount(sessionA, 'owner-a-old-hash');

  const record = P93LedgerService.recordManual(db, CHARACTER_ID, recordInput(), `user:${sessionA.userId}`);
  oldRecordId = record.recordId;
  const evidence = P93LedgerService.addEvidence(db, CHARACTER_ID, {
    evidenceType: 'ESI_WALLET_LOG',
    sourceSystem: 'ESI_WALLET_TRANSACTIONS',
    sourceRef: 'esi-wallet:9833701',
    capturedAt: record.tradeTime,
    payloadHash: 'owner-a-private-evidence-hash',
    summary: 'OWNER_A_PRIVATE_EVIDENCE',
    initialStatus: 'VERIFIED',
    metadata: {
      transactionId: 9_833_701,
      typeId: 34,
      quantity: 10,
      unitPrice: 100,
      isBuy: true,
      locationId: LOCATION_ID,
      tradeTime: record.tradeTime,
    },
  }, 'ESI_SYNC');
  P93LedgerService.linkEvidence(db, CHARACTER_ID, oldRecordId, evidence.evidenceId, 'PRIMARY', 'HIGH');
  P93LedgerService.verify(db, CHARACTER_ID, oldRecordId, `user:${sessionA.userId}`);
  P93FifoService.recalculate(db, CHARACTER_ID);
  db.prepare(`
    INSERT INTO real_esi_transaction_sync
      (character_id, last_transaction_id, last_synced_at, status, error)
    VALUES (?, 9833701, datetime('now'), 'ok', NULL)
  `).run(CHARACTER_ID);

  transferOwnershipToB();

  const app = Fastify({ bodyLimit: 64 * 1024 });
  OPEN_APPS.push(app);
  await app.register(fastifyCookie);
  registerP93Routes(app, db);
  appRef = app;
});

let appRef: ReturnType<typeof Fastify>;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of OPEN_APPS.splice(0)) await app.close();
  db.close();
});

describe('P9.3.3.7 owner isolation audit for REAL accounting data', () => {
  it('F-P9337-01 (FIXED): a new owner cannot read or reverse the previous owner REAL ledger by reusing character_id', async () => {
    const records = await appRef.inject({
      method: 'GET',
      url: `${BASE}/records`,
      headers: readHeaders(sessionB),
    });
    expect(records.statusCode).toBe(200);
    expect(records.json().records).toEqual([]);
    expect(records.body).not.toContain(oldRecordId);
    expect(records.body).not.toContain('OWNER_A_PRIVATE_NOTE');

    const evidence = await appRef.inject({
      method: 'GET',
      url: `${BASE}/evidence`,
      headers: readHeaders(sessionB),
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().evidence).toEqual([]);
    expect(evidence.body).not.toContain('OWNER_A_PRIVATE_EVIDENCE');

    const audit = await appRef.inject({
      method: 'GET',
      url: `${BASE}/audit`,
      headers: readHeaders(sessionB),
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.body).not.toContain(oldRecordId);

    const reverse = await appRef.inject({
      method: 'POST',
      url: `${BASE}/records/${oldRecordId}/reverse`,
      headers: mutationHeaders(sessionB),
      payload: { reason: 'new owner attempted an unauthorized reversal' },
    });
    expect(reverse.statusCode).toBe(400);
    expect(reverse.json()).toEqual({ error: 'trade_status_processing_failed' });
    expect(db.prepare('SELECT record_state FROM real_trade_records WHERE record_id = ?')
      .get(oldRecordId)).toEqual({ record_state: 'VERIFIED' });
    expect(db.prepare('SELECT last_transaction_id FROM real_esi_transaction_sync WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ last_transaction_id: 9_833_701 });
  });
});
