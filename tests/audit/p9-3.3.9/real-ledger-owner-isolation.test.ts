import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { deleteCharacterData } from '../../../src/db/character-datastore.js';
import { resolveAssetLineage } from '../../../src/assets/asset-lineage.js';
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
    auth: { secretKey: 'p9339-independent-ledger-owner-secret' },
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

const CHARACTER_ID = 9_943_201;
const TYPE_ID = 34;
const LOCATION_ID = 60_003_760;
const BASE = '/api/web/trading/p9/real-ledger';
const ORIGIN = 'http://localhost:3000';

let db: Db;
let sessionA: CreatedWebSession;
let sessionB: CreatedWebSession;
let app: ReturnType<typeof Fastify>;
let recordId: string;
let evidenceId: string;
let lineageA: ReturnType<typeof resolveAssetLineage>;

function recordInput(): P93RecordInput {
  return {
    ledgerKey: 'p9339-owner-a-private-buy',
    tradeKind: 'BUY',
    direction: 'BUY',
    typeId: TYPE_ID,
    locationId: LOCATION_ID,
    quantity: 10,
    unitPrice: 100,
    tradeTime: '2026-09-01T00:00:00.000Z',
    sourceType: 'USER_MANUAL_ENTRY',
    sourceRef: 'p9339-owner-a-private-source',
    draft: false,
    feeStatus: 'COMPLETE',
    notes: 'OWNER_A_P9339_PRIVATE',
  };
}

function attachSession(session: CreatedWebSession, ownerHash: string): void {
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'P9339 Ledger Pilot', 'access-token', 'refresh-token',
            datetime('now', '+1 hour'), ?, ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET
      user_id = excluded.user_id,
      owner_hash = excluded.owner_hash,
      scopes_json = excluded.scopes_json,
      access_token = excluded.access_token,
      expires_at = excluded.expires_at
  `).run(
    CHARACTER_ID,
    JSON.stringify(['esi-wallet.read_character_wallet.v1', 'esi-assets.read_assets.v1']),
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

function transferToB(): void {
  deleteCharacterData(db, CHARACTER_ID);
  db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
  db.prepare('UPDATE users SET active_character_id = NULL WHERE user_id = ?').run(sessionA.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = NULL WHERE chat_id = ?').run(sessionA.chatId);
  attachSession(sessionB, 'owner-b-p9339');
}

function mutationHeaders(session: CreatedWebSession) {
  return {
    origin: ORIGIN,
    cookie: `${WEB_SESSION_COOKIE}=${session.sessionToken}`,
    'x-csrf-token': session.csrfToken,
  };
}

beforeEach(async () => {
  resetWebSessionCreationGuardForTests();
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  sessionA = createWebSession(db);
  attachSession(sessionA, 'owner-a-p9339');
  lineageA = resolveAssetLineage(db, CHARACTER_ID, sessionA.userId, sessionA.chatId);

  const record = P93LedgerService.recordManual(db, CHARACTER_ID, recordInput(), `user:${sessionA.userId}`, lineageA);
  recordId = record.recordId;
  const evidence = P93LedgerService.addEvidence(db, CHARACTER_ID, {
    evidenceType: 'ESI_WALLET_LOG',
    sourceSystem: 'ESI_WALLET_TRANSACTIONS',
    sourceRef: 'esi-wallet:9339001',
    capturedAt: record.tradeTime,
    payloadHash: 'p9339-owner-a-evidence-hash',
    summary: 'OWNER_A_P9339_EVIDENCE',
    initialStatus: 'VERIFIED',
    metadata: {
      transactionId: 9_339_001,
      typeId: TYPE_ID,
      quantity: 10,
      unitPrice: 100,
      isBuy: true,
      locationId: LOCATION_ID,
      tradeTime: record.tradeTime,
    },
  }, 'ESI_SYNC', lineageA);
  evidenceId = evidence.evidenceId;
  P93LedgerService.linkEvidence(db, CHARACTER_ID, recordId, evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', `user:${sessionA.userId}`, lineageA);
  P93LedgerService.verify(db, CHARACTER_ID, recordId, `user:${sessionA.userId}`, undefined, 'USER', lineageA);
  P93FifoService.recalculate(db, CHARACTER_ID, lineageA);

  sessionB = createWebSession(db);
  transferToB();

  app = Fastify();
  await app.register(fastifyCookie);
  registerP93Routes(app, db);
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  db.close();
});

describe('P9.3.3.9 independent REAL ledger owner isolation', () => {
  it('denies every new-owner read and mutation while preserving the original owner history', async () => {
    const lineageB = resolveAssetLineage(db, CHARACTER_ID, sessionB.userId, sessionB.chatId);
    const beforeRecord = db.prepare(`
      SELECT record_state, verification_status, quantity, unit_price, updated_at
      FROM real_trade_records WHERE record_id = ?
    `).get(recordId);
    const beforeEvidence = db.prepare('SELECT status, payload_hash FROM real_trade_evidence WHERE evidence_id = ?')
      .get(evidenceId);
    const beforeAudit = db.prepare('SELECT COUNT(*) AS n FROM real_trade_events WHERE record_id = ?').get(recordId);
    const beforeLinks = db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence_links WHERE record_id = ?').get(recordId);

    expect(P93LedgerService.get(db, CHARACTER_ID, recordId, lineageB)).toBeNull();
    expect(P93LedgerService.list(db, CHARACTER_ID, {}, lineageB).records).toEqual([]);

    const headers = { cookie: `${WEB_SESSION_COOKIE}=${sessionB.sessionToken}` };
    const reads = await Promise.all([
      app.inject({ method: 'GET', url: `${BASE}/records`, headers }),
      app.inject({ method: 'GET', url: `${BASE}/records/${recordId}`, headers }),
      app.inject({ method: 'GET', url: `${BASE}/overview`, headers }),
      app.inject({ method: 'GET', url: `${BASE}/evidence`, headers }),
      app.inject({ method: 'GET', url: `${BASE}/costs`, headers }),
      app.inject({ method: 'GET', url: `${BASE}/audit`, headers }),
      app.inject({ method: 'GET', url: `${BASE}/performance`, headers }),
    ]);
    expect(reads.map((response) => response.statusCode)).toEqual([200, 404, 200, 200, 200, 200, 200]);

    expect(reads[0].json().records).toEqual([]);
    expect(reads[2].json().summary).toMatchObject({ rawRecordCount: 0, rows: [] });
    expect(reads[2].json().performance).toMatchObject({ realizedPnl: 0 });
    expect(reads[3].json().evidence).toEqual([]);
    expect(reads[4].json()).toMatchObject({ lots: [], consumptions: [] });
    expect(reads[5].json()).toMatchObject({ events: [], calculationRuns: [] });
    expect(reads[6].json().performance).toMatchObject({ realizedPnl: 0 });

    const mutatingHeaders = mutationHeaders(sessionB);
    const mutations = await Promise.all([
      app.inject({ method: 'POST', url: `${BASE}/records/${recordId}/reverse`, headers: mutatingHeaders, payload: { reason: 'cross owner' } }),
      app.inject({ method: 'POST', url: `${BASE}/records/${recordId}/correct`, headers: mutatingHeaders, payload: { reason: 'cross owner', record: { ...recordInput(), ledgerKey: 'cross-owner-p9339' } } }),
      app.inject({ method: 'POST', url: `${BASE}/evidence/${evidenceId}/status`, headers: mutatingHeaders, payload: { status: 'REJECTED', reason: 'cross owner' } }),
      app.inject({ method: 'POST', url: `${BASE}/records/${recordId}/evidence-links`, headers: mutatingHeaders, payload: { evidenceId, relation: 'CORROBORATING', confidence: 'LOW' } }),
    ]);
    expect(mutations.map((response) => response.statusCode)).toEqual([400, 400, 400, 400]);

    expect(db.prepare(`
      SELECT record_state, verification_status, quantity, unit_price, updated_at
      FROM real_trade_records WHERE record_id = ?
    `).get(recordId)).toEqual(beforeRecord);
    expect(db.prepare('SELECT status, payload_hash FROM real_trade_evidence WHERE evidence_id = ?')
      .get(evidenceId)).toEqual(beforeEvidence);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_events WHERE record_id = ?').get(recordId)).toEqual(beforeAudit);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence_links WHERE record_id = ?').get(recordId)).toEqual(beforeLinks);

    expect(P93LedgerService.get(db, CHARACTER_ID, recordId, lineageA)).toMatchObject({
      recordId,
      quantity: 10,
      verificationStatus: 'VERIFIED',
    });
    expect(P93LedgerService.list(db, CHARACTER_ID, {}, lineageA).records).toHaveLength(1);
  });
});