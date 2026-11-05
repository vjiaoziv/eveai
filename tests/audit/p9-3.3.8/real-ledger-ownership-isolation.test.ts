import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { deleteCharacterData } from '../../../src/db/character-datastore.js';
import { resolveAssetLineage, type AssetLineage } from '../../../src/assets/asset-lineage.js';
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
    auth: { secretKey: 'p9338-real-ledger-audit-secret' },
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

const CHARACTER_ID = 9_833_821;
const TYPE_ID = 34;
const LOCATION_ID = 60_003_760;
const BASE = '/api/web/trading/p9/real-ledger';
const ORIGIN = 'http://localhost:3000';
const OPEN_APPS: Array<ReturnType<typeof Fastify>> = [];

let db: Db;
let sessionA: CreatedWebSession;
let sessionB: CreatedWebSession;
let recordId: string;
let evidenceId: string;
let lineageA: AssetLineage;
let app: ReturnType<typeof Fastify>;

function tradeInput(): P93RecordInput {
  return {
    ledgerKey: 'owner-a-cross-owner-private',
    tradeKind: 'BUY',
    direction: 'BUY',
    typeId: TYPE_ID,
    locationId: LOCATION_ID,
    quantity: 10,
    unitPrice: 100,
    tradeTime: '2026-09-01T00:00:00.000Z',
    sourceType: 'USER_MANUAL_ENTRY',
    sourceRef: 'owner-a-private-source',
    draft: false,
    feeStatus: 'COMPLETE',
    notes: 'OWNER_A_PRIVATE_LEDGER_NOTE',
  };
}

function linkAccount(session: CreatedWebSession, ownerHash: string): void {
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at,
       scopes_json, user_id, owner_hash)
    VALUES (?, 'Ownership Isolation Pilot', 'access-token', 'refresh-token',
            datetime('now', '+1 hour'), ?, ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET
      user_id = excluded.user_id,
      owner_hash = excluded.owner_hash,
      scopes_json = excluded.scopes_json,
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

function transferOwnershipToB(): void {
  db.prepare('UPDATE users SET active_character_id = NULL WHERE user_id = ?').run(sessionA.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = NULL WHERE chat_id = ?').run(sessionA.chatId);
  db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
  linkAccount(sessionB, 'owner-b-new-binding');
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

async function makeApp(): Promise<ReturnType<typeof Fastify>> {
  const instance = Fastify({ bodyLimit: 64 * 1024 });
  OPEN_APPS.push(instance);
  await instance.register(fastifyCookie);
  registerP93Routes(instance, db);
  return instance;
}

function seedOwnerAVerifiedTrade(): void {
  const input = tradeInput();
  const record = P93LedgerService.recordManual(db, CHARACTER_ID, input, `user:${sessionA.userId}`);
  recordId = record.recordId;
  const evidence = P93LedgerService.addEvidence(db, CHARACTER_ID, {
    evidenceType: 'ESI_WALLET_LOG',
    sourceSystem: 'ESI_WALLET_TRANSACTIONS',
    sourceRef: 'esi-wallet:9833821',
    capturedAt: input.tradeTime,
    payloadHash: 'owner-a-private-payload-hash',
    summary: 'OWNER_A_PRIVATE_EVIDENCE_MARKER',
    initialStatus: 'VERIFIED',
    metadata: {
      transactionId: 9_833_821,
      typeId: TYPE_ID,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      isBuy: true,
      locationId: LOCATION_ID,
      tradeTime: input.tradeTime,
    },
  }, 'ESI_SYNC');
  evidenceId = evidence.evidenceId;
  P93LedgerService.linkEvidence(
    db,
    CHARACTER_ID,
    recordId,
    evidenceId,
    'PRIMARY',
    'HIGH',
    undefined,
    'USER',
    `user:${sessionA.userId}`,
  );
  P93LedgerService.verify(db, CHARACTER_ID, recordId, `user:${sessionA.userId}`);
  P93FifoService.recalculate(db, CHARACTER_ID);
  lineageA = resolveAssetLineage(db, CHARACTER_ID, sessionA.userId, sessionA.chatId);
  db.prepare(`
    INSERT INTO real_reconciliation_runs
      (run_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       snapshot_id, calculation_run_id, status, created_at, completed_at, summary_json)
    VALUES ('OWNER-A-RECON-PRIVATE', ?, ?, ?, ?, ?, NULL, NULL, 'MATCHED',
            '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:01.000Z',
            '{"marker":"OWNER_A_PRIVATE_RECONCILIATION"}')
  `).run(
    CHARACTER_ID,
    lineageA.ownerUserId,
    lineageA.ownerChatId,
    lineageA.bindingEpoch,
    lineageA.bindingDigest,
  );
}

beforeEach(async () => {
  resetWebSessionCreationGuardForTests();
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  sessionA = createWebSession(db);
  sessionB = createWebSession(db);
  linkAccount(sessionA, 'owner-a-original-binding');
  seedOwnerAVerifiedTrade();
  app = await makeApp();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const openApp of OPEN_APPS.splice(0)) await openApp.close();
  db.close();
});

describe('P9.3.3.8 REAL ledger owner isolation', () => {
  it('hides all previous-owner records, evidence, events, FIFO state and reconciliation history from the new owner', async () => {
    transferOwnershipToB();

    const headers = readHeaders(sessionB);
    const records = await app.inject({ method: 'GET', url: `${BASE}/records`, headers });
    expect(records.statusCode).toBe(200);
    expect(records.json().records).toEqual([]);
    expect(records.body).not.toContain(recordId);
    expect(records.body).not.toContain('OWNER_A_PRIVATE_LEDGER_NOTE');

    const record = await app.inject({ method: 'GET', url: `${BASE}/records/${recordId}`, headers });
    expect(record.statusCode).toBe(404);
    expect(record.json()).toEqual({ error: 'p9_record_not_found' });

    const evidence = await app.inject({ method: 'GET', url: `${BASE}/evidence`, headers });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().evidence).toEqual([]);
    expect(evidence.body).not.toContain(evidenceId);
    expect(evidence.body).not.toContain('OWNER_A_PRIVATE_EVIDENCE_MARKER');

    const audit = await app.inject({ method: 'GET', url: `${BASE}/audit`, headers });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().events).toEqual([]);
    expect(audit.json().calculationRuns).toEqual([]);
    expect(audit.json().reconciliationRuns).toEqual([]);
    expect(audit.body).not.toContain(recordId);
    expect(audit.body).not.toContain('OWNER-A-RECON-PRIVATE');

    const costs = await app.inject({ method: 'GET', url: `${BASE}/costs`, headers });
    expect(costs.statusCode).toBe(200);
    expect(costs.json().lots).toEqual([]);
    expect(costs.json().consumptions).toEqual([]);

    const performance = await app.inject({ method: 'GET', url: `${BASE}/performance`, headers });
    expect(performance.statusCode).toBe(200);
    expect(performance.json().performance.tradeCount).toBe(0);
    expect(performance.json().performance.unknownConsumptionCount).toBe(0);
    expect(performance.json().performance.unknownOpenLotCount).toBe(0);
    expect(performance.json().unrealized.snapshotId).toBeNull();

    const exportRoute = await app.inject({ method: 'GET', url: `${BASE}/export`, headers });
    expect(exportRoute.statusCode).toBe(404);

    const reconciliation = await app.inject({ method: 'GET', url: `${BASE}/reconciliation`, headers });
    expect(reconciliation.statusCode).toBe(200);
    expect(reconciliation.json().reconciliation).toBeNull();
  });

  it('rejects every cross-owner mutation and leaves the old owner facts and audit history unchanged', async () => {
    transferOwnershipToB();
    const beforeRecord = db.prepare(`
      SELECT record_state, verification_status, rejected_reason, reverses_record_id
      FROM real_trade_records WHERE record_id = ?
    `).get(recordId);
    const beforeEvidence = db.prepare('SELECT status FROM real_trade_evidence WHERE evidence_id = ?')
      .get(evidenceId);
    const beforeEventCount = db.prepare('SELECT COUNT(*) AS n FROM real_trade_events WHERE record_id = ?')
      .get(recordId);
    const beforeLinkCount = db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence_links WHERE record_id = ?')
      .get(recordId);
    const headers = mutationHeaders(sessionB);

    for (const action of ['verify', 'reject', 'reverse'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `${BASE}/records/${recordId}/${action}`,
        headers,
        payload: action === 'reverse' ? { reason: 'cross-owner reversal attempt' } : { reason: 'cross-owner change attempt' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'trade_status_processing_failed' });
    }

    const correct = await app.inject({
      method: 'POST',
      url: `${BASE}/records/${recordId}/correct`,
      headers,
      payload: {
        reason: 'cross-owner correction attempt',
        record: {
          ledgerKey: 'cross-owner-correction',
          tradeKind: 'BUY',
          direction: 'BUY',
          typeId: TYPE_ID,
          locationId: LOCATION_ID,
          quantity: 1,
          unitPrice: 1,
          tradeTime: '2026-09-03T00:00:00.000Z',
          sourceType: 'USER_MANUAL_ENTRY',
          draft: false,
          feeStatus: 'UNKNOWN',
        },
      },
    });
    expect(correct.statusCode).toBe(400);
    expect(correct.json()).toEqual({ error: 'trade_correction_failed' });

    const evidenceStatus = await app.inject({
      method: 'POST',
      url: `${BASE}/evidence/${evidenceId}/status`,
      headers,
      payload: { status: 'REJECTED', reason: 'cross-owner evidence mutation' },
    });
    expect(evidenceStatus.statusCode).toBe(400);
    expect(evidenceStatus.json()).toEqual({ error: 'evidence_status_processing_failed' });

    const link = await app.inject({
      method: 'POST',
      url: `${BASE}/records/${recordId}/evidence-links`,
      headers,
      payload: { evidenceId, relation: 'CORROBORATING', confidence: 'LOW', notes: 'cross-owner link' },
    });
    expect(link.statusCode).toBe(400);
    expect(link.json()).toEqual({ error: 'evidence_linking_failed' });

    expect(db.prepare(`
      SELECT record_state, verification_status, rejected_reason, reverses_record_id
      FROM real_trade_records WHERE record_id = ?
    `).get(recordId)).toEqual(beforeRecord);
    expect(db.prepare('SELECT status FROM real_trade_evidence WHERE evidence_id = ?')
      .get(evidenceId)).toEqual(beforeEvidence);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_events WHERE record_id = ?')
      .get(recordId)).toEqual(beforeEventCount);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence_links WHERE record_id = ?')
      .get(recordId)).toEqual(beforeLinkCount);
  });

  it('replays the same-owner reversal idempotently without duplicating audit facts', () => {
    const actor = `user:${sessionA.userId}`;
    const first = P93LedgerService.reverse(db, CHARACTER_ID, recordId, actor, 'owner-a confirmed reversal', lineageA);
    const eventCount = db.prepare('SELECT COUNT(*) AS n FROM real_trade_events WHERE record_id = ?').get(recordId);

    const second = P93LedgerService.reverse(db, CHARACTER_ID, recordId, actor, 'duplicate delivery', lineageA);

    expect(first.recordState).toBe('REVERSED');
    expect(second.recordState).toBe('REVERSED');
    expect(db.prepare('SELECT record_state FROM real_trade_records WHERE record_id = ?').get(recordId))
      .toEqual({ record_state: 'REVERSED' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_events WHERE record_id = ?').get(recordId))
      .toEqual(eventCount);
  });

  it('enforces owner lineage on direct service paths and rejects stale post-transfer authority', () => {
    transferOwnershipToB();
    const lineageB = resolveAssetLineage(db, CHARACTER_ID, sessionB.userId, sessionB.chatId);
    const beforeEventCount = db.prepare('SELECT COUNT(*) AS n FROM real_trade_events WHERE record_id = ?').get(recordId);
    const correctionInput: P93RecordInput = {
      ...tradeInput(),
      ledgerKey: 'cross-owner-direct-correction',
      quantity: 1,
      unitPrice: 1,
    };

    expect(P93LedgerService.list(db, CHARACTER_ID, {}, lineageB).records).toEqual([]);
    expect(P93LedgerService.get(db, CHARACTER_ID, recordId, lineageB)).toBeNull();
    expect(() => P93LedgerService.reverse(
      db,
      CHARACTER_ID,
      recordId,
      `user:${sessionB.userId}`,
      'new owner direct reversal attempt',
      lineageB,
    )).toThrow(/不存在/);
    expect(() => P93LedgerService.correction(
      db,
      CHARACTER_ID,
      recordId,
      correctionInput,
      `user:${sessionB.userId}`,
      'new owner direct correction attempt',
      lineageB,
    )).toThrow(/不存在/);
    expect(() => P93LedgerService.reverse(
      db,
      CHARACTER_ID,
      recordId,
      `user:${sessionA.userId}`,
      'stale owner lineage attempt',
      lineageA,
    )).toThrow(/所有权或绑定上下文已变化|账户所有权与当前用户不一致/);

    expect(db.prepare('SELECT record_state, verification_status, reverses_record_id FROM real_trade_records WHERE record_id = ?').get(recordId)).toEqual({
      record_state: 'VERIFIED',
      verification_status: 'VERIFIED',
      reverses_record_id: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_events WHERE record_id = ?').get(recordId))
      .toEqual(beforeEventCount);
  });

  it('keeps the same owner and chat lane able to read history after authorization scope refresh changes only the digest', async () => {
    db.prepare('UPDATE eve_accounts SET owner_hash = ?, scopes_json = ? WHERE character_id = ?')
      .run(
        'owner-a-refreshed-binding',
        JSON.stringify(['esi-wallet.read_character_wallet.v1', 'esi-assets.read_assets.v1']),
        CHARACTER_ID,
      );

    const headers = readHeaders(sessionA);
    const records = await app.inject({ method: 'GET', url: `${BASE}/records`, headers });
    expect(records.statusCode).toBe(200);
    expect(records.json().records.map((row: any) => row.recordId)).toContain(recordId);

    const detail = await app.inject({ method: 'GET', url: `${BASE}/records/${recordId}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().record.recordId).toBe(recordId);
    expect(detail.json().evidence.map((row: any) => row.evidence_id)).toContain(evidenceId);

    const audit = await app.inject({ method: 'GET', url: `${BASE}/audit`, headers });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().events.some((row: any) => row.record_id === recordId)).toBe(true);
    expect(audit.json().reconciliationRuns.map((row: any) => row.run_id)).toContain('OWNER-A-RECON-PRIVATE');
  });
});
