import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { deleteCharacterData } from '../../../src/db/character-datastore.js';
import { resolveAssetLineage } from '../../../src/assets/asset-lineage.js';
import { P93AuditService } from '../../../src/trading/p9-3-audit-service.js';
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
    auth: { secretKey: 'p9339-child-resource-owner-secret' },
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

const CHARACTER_ID = 9_943_301;
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
    ledgerKey: 'p9339-child-resource-private-buy',
    tradeKind: 'BUY',
    direction: 'BUY',
    typeId: TYPE_ID,
    locationId: LOCATION_ID,
    quantity: 7,
    unitPrice: 12,
    tradeTime: '2026-09-03T00:00:00.000Z',
    sourceType: 'USER_MANUAL_ENTRY',
    sourceRef: 'p9339-child-resource-source',
    draft: false,
    feeStatus: 'COMPLETE',
    notes: 'P9339_CHILD_RESOURCE_PRIVATE',
  };
}

function attachSession(session: CreatedWebSession, ownerHash: string): void {
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'P9339 Child Resource Pilot', 'access-token', 'refresh-token',
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
  attachSession(sessionB, 'owner-b-p9339-child-resource');
}

function snapshot() {
  return {
    records: db.prepare('SELECT * FROM real_trade_records WHERE character_id = ? ORDER BY record_id').all(CHARACTER_ID),
    evidence: db.prepare('SELECT * FROM real_trade_evidence WHERE character_id = ? ORDER BY evidence_id').all(CHARACTER_ID),
    links: db.prepare(`
      SELECT l.* FROM real_trade_evidence_links l
      JOIN real_trade_records r ON r.record_id = l.record_id
      WHERE r.character_id = ? ORDER BY l.record_id, l.evidence_id
    `).all(CHARACTER_ID),
    events: db.prepare('SELECT * FROM real_trade_events WHERE character_id = ? ORDER BY event_id').all(CHARACTER_ID),
    lots: db.prepare('SELECT * FROM real_fifo_lots WHERE character_id = ? ORDER BY lot_id').all(CHARACTER_ID),
    consumptions: db.prepare('SELECT * FROM real_fifo_consumptions WHERE character_id = ? ORDER BY consumption_id').all(CHARACTER_ID),
    calculations: db.prepare('SELECT * FROM real_calculation_runs WHERE character_id = ? ORDER BY started_at, run_id').all(CHARACTER_ID),
    reconciliations: db.prepare('SELECT * FROM real_reconciliation_runs WHERE character_id = ? ORDER BY created_at, run_id').all(CHARACTER_ID),
  };
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
  attachSession(sessionA, 'owner-a-p9339-child-resource');
  lineageA = resolveAssetLineage(db, CHARACTER_ID, sessionA.userId, sessionA.chatId);

  const record = P93LedgerService.recordManual(
    db, CHARACTER_ID, recordInput(), `user:${sessionA.userId}`, lineageA,
  );
  recordId = record.recordId;
  const evidence = P93LedgerService.addEvidence(db, CHARACTER_ID, {
    evidenceType: 'ESI_WALLET_LOG',
    sourceSystem: 'ESI_WALLET_TRANSACTIONS',
    sourceRef: 'esi-wallet:93393301',
    capturedAt: record.tradeTime,
    payloadHash: 'p9339-child-resource-evidence-hash',
    summary: 'P9339_CHILD_RESOURCE_EVIDENCE',
    initialStatus: 'VERIFIED',
    metadata: {
      transactionId: 93_393_301,
      typeId: TYPE_ID,
      quantity: record.quantity,
      unitPrice: record.unitPrice,
      isBuy: true,
      locationId: LOCATION_ID,
      tradeTime: record.tradeTime,
    },
  }, 'ESI_SYNC', lineageA);
  evidenceId = evidence.evidenceId;
  P93LedgerService.linkEvidence(
    db, CHARACTER_ID, recordId, evidenceId, 'PRIMARY', 'HIGH',
    undefined, 'USER', `user:${sessionA.userId}`, lineageA,
  );
  P93LedgerService.verify(
    db, CHARACTER_ID, recordId, `user:${sessionA.userId}`,
    undefined, 'USER', lineageA,
  );
  P93FifoService.recalculate(db, CHARACTER_ID, lineageA);sessionB = createWebSession(db);
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

describe('P9.3.3.9 child-resource and audit-history authorization', () => {
  it('denies every discovered child identifier to a new owner without changing original facts', async () => {
    const lineageB = resolveAssetLineage(db, CHARACTER_ID, sessionB.userId, sessionB.chatId);
    const before = snapshot();

    expect(P93LedgerService.getEvidence(db, CHARACTER_ID, evidenceId, lineageB)).toBeNull();
    expect(P93AuditService.events(db, CHARACTER_ID, recordId, 100, lineageB)).toEqual([]);
    expect(P93AuditService.calculationRuns(db, CHARACTER_ID, 50, lineageB)).toEqual([]);
    expect(P93AuditService.reconciliationRuns(db, CHARACTER_ID, lineageB)).toEqual([]);
    expect(P93FifoService.performance(db, CHARACTER_ID, lineageB)).toMatchObject({
      realizedPnl: 0,
      deterministicSellCount: 0,
      unknownCostSellCount: 0,
    });
    expect(() => P93LedgerService.setEvidenceStatus(
      db, CHARACTER_ID, evidenceId, 'REJECTED', `user:${sessionB.userId}`,
      'cross-owner evidence mutation', lineageB,
    )).toThrow();
    expect(() => P93LedgerService.linkEvidence(
      db, CHARACTER_ID, recordId, evidenceId, 'CORROBORATING', 'LOW',
      'cross-owner link', 'USER', `user:${sessionB.userId}`, lineageB,
    )).toThrow();
    expect(() => P93LedgerService.reverse(
      db, CHARACTER_ID, recordId, `user:${sessionB.userId}`,
      'cross-owner reversal', lineageB,
    )).toThrow();
    expect(() => P93LedgerService.correction(
      db, CHARACTER_ID, recordId,
      { ...recordInput(), ledgerKey: 'p9339-cross-owner-correction' },
      `user:${sessionB.userId}`, 'cross-owner correction', lineageB,
    )).toThrow();

    const headers = mutationHeaders(sessionB);
    const forged = {
      ownerId: sessionA.userId,
      owner_user_id: sessionA.userId,
      chatId: sessionA.chatId,
      owner_chat_id: sessionA.chatId,
      bindingEpoch: lineageA.bindingEpoch,
      actor: `user:${sessionA.userId}`,
    };
    const reads = await Promise.all([
      app.inject({ method: 'GET', url: `${BASE}/records/${recordId}`, headers: { cookie: `${WEB_SESSION_COOKIE}=${sessionB.sessionToken}` } }),
      app.inject({ method: 'GET', url: `${BASE}/evidence`, headers: { cookie: `${WEB_SESSION_COOKIE}=${sessionB.sessionToken}` } }),
      app.inject({ method: 'GET', url: `${BASE}/costs`, headers: { cookie: `${WEB_SESSION_COOKIE}=${sessionB.sessionToken}` } }),
      app.inject({ method: 'GET', url: `${BASE}/audit`, headers: { cookie: `${WEB_SESSION_COOKIE}=${sessionB.sessionToken}` } }),
    ]);
    expect(reads.map((row) => row.statusCode)).toEqual([404, 200, 200, 200]);
    expect(reads[1].json().evidence).toEqual([]);
    expect(reads[2].json()).toMatchObject({ lots: [], consumptions: [] });
    expect(reads[3].json()).toMatchObject({ events: [], calculationRuns: [], reconciliationRuns: [] });

    const mutations = await Promise.all([
      app.inject({ method: 'PUT', url: `${BASE}/records/${recordId}`, headers, payload: { ...recordInput(), ...forged, quantity: 999 } }),
      app.inject({ method: 'POST', url: `${BASE}/records/${recordId}/submit`, headers, payload: forged }),
      app.inject({ method: 'POST', url: `${BASE}/records/${recordId}/verify`, headers, payload: forged }),
      app.inject({ method: 'POST', url: `${BASE}/records/${recordId}/reject`, headers, payload: { ...forged, reason: 'cross owner' } }),
      app.inject({ method: 'POST', url: `${BASE}/records/${recordId}/reverse`, headers, payload: { ...forged, reason: 'cross owner' } }),
      app.inject({ method: 'POST', url: `${BASE}/records/${recordId}/correct`, headers, payload: { ...forged, reason: 'cross owner', record: { ...recordInput(), ledgerKey: 'p9339-route-cross-owner-correction' } } }),
      app.inject({ method: 'POST', url: `${BASE}/evidence/${evidenceId}/status`, headers, payload: { ...forged, status: 'REJECTED', reason: 'cross owner' } }),
      app.inject({ method: 'POST', url: `${BASE}/records/${recordId}/evidence-links`, headers, payload: { ...forged, evidenceId, relation: 'CORROBORATING', confidence: 'LOW' } }),
    ]);
    expect(mutations.map((row) => row.statusCode)).toEqual([400, 400, 400, 400, 400, 400, 400, 400]);

    expect(snapshot()).toEqual(before);
    expect(P93LedgerService.get(db, CHARACTER_ID, recordId, lineageA)).toMatchObject({
      recordId,
      quantity: 7,
      verificationStatus: 'VERIFIED',
    });
    expect(P93LedgerService.getEvidence(db, CHARACTER_ID, evidenceId, lineageA)).toMatchObject({
      evidenceId,
      status: 'VERIFIED',
    });
  });

  it('returns the original owner record-scoped audit history instead of silently hiding it', () => {
    const directEvents = db.prepare(`
      SELECT * FROM real_trade_events
      WHERE character_id = ? AND record_id = ?
      ORDER BY created_at DESC, event_id DESC
    `).all(CHARACTER_ID, recordId);
    expect(directEvents).toHaveLength(3);
    expect(P93AuditService.events(db, CHARACTER_ID, undefined, 100, lineageA)).toHaveLength(directEvents.length);

    const originalEvents = P93AuditService.events(db, CHARACTER_ID, recordId, 100, lineageA) as any[];
    expect(originalEvents).toHaveLength(directEvents.length);
    expect(originalEvents.every((event) => event.recordId === recordId || event.record_id === recordId)).toBe(true);
  });
});