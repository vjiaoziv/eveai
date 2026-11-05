import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { deleteCharacterData } from '../../../src/db/character-datastore.js';
import { P93FifoService } from '../../../src/trading/p9-3-fifo-service.js';
import { P93LedgerService } from '../../../src/trading/p9-3-ledger-service.js';
import type { P93RecordInput } from '../../../src/trading/p9-3-types.js';
import { registerP9Routes } from '../../../src/web/p9-routes.js';
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

const CHARACTER_ID = 9_833_803;
const LOCATION_ID = 60_003_760;
const OPEN_APPS: Array<ReturnType<typeof Fastify>> = [];
let db: Db;
let sessionA: CreatedWebSession;
let sessionB: CreatedWebSession;
let privateRecordId: string;
let app: ReturnType<typeof Fastify>;

function linkAccount(session: CreatedWebSession, ownerHash: string): void {
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at,
       scopes_json, user_id, owner_hash)
    VALUES (?, 'Overview Ownership Pilot', 'access-token', 'refresh-token',
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

function seedLegacyOwnerAccounting(): void {
  db.prepare(`
    INSERT INTO p9_real_trades
      (trade_id, character_id, client_key, direction, type_id, location_id,
       quantity, price, fee, fee_status, trade_time, source, confirmed,
       realized_pnl, pnl_status, notes)
    VALUES
      ('LEGACY-OWNER-A-TRADE', ?, 'legacy-owner-a', 'buy', 34, ?,
       5, 10, 7, 'CONFIRMED', '2026-08-01T00:00:00.000Z', 'manual', 1,
       123456.78, 'CALCULATED', 'LEGACY_OWNER_A_TRADE_MARKER')
  `).run(CHARACTER_ID, LOCATION_ID);
  db.prepare(`
    INSERT INTO p9_inventory_lots
      (lot_id, character_id, item_id, type_id, location_id, quantity,
       original_quantity, cost_per_unit, cost_status, source, acquired_at, notes)
    VALUES
      ('LEGACY-OWNER-A-LOT', ?, 987654321, 34, ?, 5, 5, 10, 'CONFIRMED',
       'manual', '2026-08-01T00:00:00.000Z', 'LEGACY_OWNER_A_LOT_MARKER')
  `).run(CHARACTER_ID, LOCATION_ID);
  db.prepare(`
    INSERT INTO p9_inventory_moves
      (character_id, trade_id, lot_id, type_id, quantity, cost_per_unit,
       exit_price, allocated_fee, realized_pnl, pnl_status)
    VALUES (?, 'LEGACY-OWNER-A-TRADE', 'LEGACY-OWNER-A-LOT', 34, 5, 10,
            20, 0, 654321.09, 'CALCULATED')
  `).run(CHARACTER_ID);
}

function transferOwnershipToB(): void {
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

function createVerifiedOwnerATrade(): string {
  const input: P93RecordInput = {
    ledgerKey: 'owner-a-overview-private-trade',
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
    notes: 'OWNER_A_OVERVIEW_PRIVATE',
  };
  const record = P93LedgerService.recordManual(db, CHARACTER_ID, input, `user:${sessionA.userId}`);
  const evidence = P93LedgerService.addEvidence(db, CHARACTER_ID, {
    evidenceType: 'ESI_WALLET_LOG',
    sourceSystem: 'ESI_WALLET_TRANSACTIONS',
    sourceRef: 'esi-wallet:9833803',
    capturedAt: input.tradeTime,
    payloadHash: 'owner-a-overview-evidence-hash',
    summary: 'OWNER_A_OVERVIEW_EVIDENCE',
    initialStatus: 'VERIFIED',
    metadata: {
      transactionId: 9_833_803,
      typeId: 34,
      quantity: 10,
      unitPrice: 100,
      isBuy: true,
      locationId: LOCATION_ID,
      tradeTime: input.tradeTime,
    },
  }, 'ESI_SYNC');
  P93LedgerService.linkEvidence(db, CHARACTER_ID, record.recordId, evidence.evidenceId, 'PRIMARY', 'HIGH');
  P93LedgerService.verify(db, CHARACTER_ID, record.recordId, `user:${sessionA.userId}`);
  P93FifoService.recalculate(db, CHARACTER_ID);
  return record.recordId;
}

beforeEach(async () => {
  resetWebSessionCreationGuardForTests();
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  sessionA = createWebSession(db);
  sessionB = createWebSession(db);
  linkAccount(sessionA, 'owner-a-old-hash');
  privateRecordId = createVerifiedOwnerATrade();
  seedLegacyOwnerAccounting();
  transferOwnershipToB();

  app = Fastify({ bodyLimit: 64 * 1024 });
  OPEN_APPS.push(app);
  await app.register(fastifyCookie);
  registerP9Routes(app, db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const openApp of OPEN_APPS.splice(0)) await openApp.close();
  db.close();
});

describe('P9.3.3.8 P9 overview ownership isolation', () => {
  it('does not expose the previous owner REAL ledger or FIFO counts to the new owner', async () => {
    const overview = await app.inject({
      method: 'GET',
      url: '/api/web/trading/p9/overview',
      headers: readHeaders(sessionB),
    });
    expect(overview.statusCode).toBe(200);
    const body = overview.json() as any;
    expect(overview.body).not.toContain(privateRecordId);
    expect(overview.body).not.toContain('OWNER_A_OVERVIEW_PRIVATE');
    expect(overview.body).not.toContain('LEGACY_OWNER_A_TRADE_MARKER');
    expect(overview.body).not.toContain('LEGACY_OWNER_A_LOT_MARKER');
    expect(overview.body).not.toContain('LEGACY-OWNER-A-TRADE');
    expect(overview.body).not.toContain('LEGACY-OWNER-A-LOT');
    expect(body.ledgerSummary.rows).toEqual([]);
    expect(body.portfolio.inventory.lotCount).toBe(0);
    expect(body.portfolio.performance.unknownOpenLotCount).toBe(0);
    expect(body.portfolio.performance.realizedMoveCount).toBe(0);
    expect(body.trades.count).toBe(0);
  });

  it('does not count previous owner UNKNOWN FIFO lots in the current risk summary', async () => {
    const risk = await app.inject({
      method: 'GET',
      url: '/api/web/trading/p9/risk',
      headers: readHeaders(sessionB),
    });
    expect(risk.statusCode).toBe(200);
    expect(risk.json().unknownInventoryLots).toBe(0);
  });
});