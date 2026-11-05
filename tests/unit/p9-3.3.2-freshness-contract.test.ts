import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import type { Db } from '../../src/db/sqlite.js';
import { registerP9Routes } from '../../src/web/p9-routes.js';
import { registerP93Routes } from '../../src/web/p9-3-routes.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} from '../../src/web/web-session.js';
import { P93FifoService } from '../../src/trading/p9-3-fifo-service.js';
import { P93LedgerService } from '../../src/trading/p9-3-ledger-service.js';
import { buildP9AnalysisPrompt } from '../../src/trading/p9-ai-analysis.js';
import { formatP93Number, freshnessPresentation } from '../../web/src/p93-freshness.js';
import { translateOutOfReact } from '../../web/src/i18n-dictionary.js';

/** The helper is locale-agnostic: it takes a translator, so the test feeds it zh. */
const zh = (key: Parameters<typeof translateOutOfReact>[0]) => translateOutOfReact(key, 'zh');
import { resolveAssetLineage } from '../../src/assets/asset-lineage.js';

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
    web: {
      baseUrl: 'http://localhost:3000',
      sessionTtlHours: 720,
      sessionCreationWindowSeconds: 60,
      maxSessionCreationsPerWindow: 100,
    },
  },
}));

const CHARACTER_ID = 9324001;
let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let cookie = '';
let sessionUserId = 0;
let sessionChatId = 0;

function linkCharacter(userId: number, chatId: number): void {
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(CHARACTER_ID, userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?').run(CHARACTER_ID, chatId);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Freshness Audit', 'fresh-token', 'fresh-refresh', datetime('now', '+1 hour'), '[]', ?)
  `).run(CHARACTER_ID, userId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(chatId, CHARACTER_ID, userId);
}

function verifyBuy(): void {
  const record = P93LedgerService.recordManual(db as Db, CHARACTER_ID, {
    ledgerKey: 'freshness-route-buy',
    tradeKind: 'BUY',
    direction: 'BUY',
    typeId: 34,
    locationId: 60003760,
    quantity: 2,
    unitPrice: 10,
    tradeTime: '2026-05-01T00:00:00.000Z',
    sourceType: 'USER_MANUAL_ENTRY',
    feeStatus: 'COMPLETE',
  }, 'user:freshness');
  P93LedgerService.submitDraft(db as Db, CHARACTER_ID, record.recordId, 'user:freshness');
  const evidence = P93LedgerService.addEvidence(db as Db, CHARACTER_ID, {
    evidenceType: 'ESI_WALLET_LOG',
    sourceSystem: 'ESI_WALLET_TRANSACTIONS',
    sourceRef: 'esi-wallet:932400001',
    capturedAt: '2026-05-01T00:00:00.000Z',
    payloadHash: 'freshness-route-payload',
    summary: 'freshness route test',
    metadata: {
      transactionId: 932400001,
      typeId: record.typeId,
      quantity: record.quantity,
      unitPrice: record.unitPrice,
      isBuy: true,
      locationId: record.locationId,
      tradeTime: record.tradeTime,
    },
    initialStatus: 'PENDING',
  }, 'ESI_SYNC');
  P93LedgerService.linkEvidence(
    db as Db, CHARACTER_ID, record.recordId, evidence.evidenceId, 'PRIMARY', 'HIGH',
    undefined, 'USER', 'user:freshness',
  );
  P93LedgerService.setEvidenceStatus(db as Db, CHARACTER_ID, evidence.evidenceId, 'VERIFIED', 'user:freshness');
  P93LedgerService.verify(db as Db, CHARACTER_ID, record.recordId, 'user:freshness');
}

async function getJson(url: string): Promise<any> {
  const response = await app.inject({
    method: 'GET',
    url,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function overview(): Promise<any> {
  return getJson('/api/web/trading/p9/overview');
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  const created = createWebSession(db);
  sessionUserId = created.userId;
  sessionChatId = created.chatId;
  cookie = `${WEB_SESSION_COOKIE}=${created.sessionToken}`;
  linkCharacter(created.userId, created.chatId);
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerP9Routes(app, db);
  registerP93Routes(app, db);
});

afterEach(async () => {
  if (app) await app.close();
  if (db) db.close();
});

describe('P9.3.3.2 FIFO freshness contract', () => {
  it('treats missing freshness as unknown and keeps null financial values as N/A', () => {
    expect(freshnessPresentation(undefined, zh)).toMatchObject({ status: 'UNKNOWN' });
    expect(freshnessPresentation({ status: 'STALE', message: 'stale message' }, zh)).toEqual({
      status: 'STALE',
      warning: 'stale message',
    });
    expect(freshnessPresentation({ status: 'CURRENT', message: 'ignored' }, zh)).toEqual({
      status: 'CURRENT',
      warning: null,
    });
    expect(formatP93Number(null)).toBe('N/A');
    expect(formatP93Number(Number.NaN)).toBe('N/A');
    expect(formatP93Number(0)).toBe('0');
  });

  it('exposes NEVER_CALCULATED, CURRENT, and STALE through the compatible overview API', async () => {
    let payload = await overview();
    expect(payload.portfolio.performance.freshness).toMatchObject({
      status: 'NEVER_CALCULATED',
      latestCalculationAt: null,
    });
    expect(payload.portfolio.performance.realizedNetPnl).not.toBeUndefined();

    verifyBuy();
    P93FifoService.recalculate(db as Db, CHARACTER_ID);
    payload = await overview();
    expect(payload.portfolio.performance.freshness.status).toBe('CURRENT');
    expect(payload.portfolio.performance).toMatchObject({
      unknownConsumptionCount: 0,
      unknownOpenLotCount: 0,
      unknownCostSellCount: 0,
      deterministicSellCount: 0,
    });

    db.prepare(`
      UPDATE real_calculation_runs
      SET started_at = '2026-01-01 00:00:00', completed_at = '2026-01-01 00:00:01'
      WHERE character_id = ?
    `).run(CHARACTER_ID);
    payload = await overview();
    expect(payload.portfolio.performance.freshness.status).toBe('STALE');
    expect(payload.portfolio.performance.freshness.message).toContain('晚于最近一次成功计算');
  });

  it('preserves STALE and known partial P&L in every compatibility, ledger, and AI consumer', async () => {
    verifyBuy();
    P93FifoService.recalculate(db as Db, CHARACTER_ID);
    db.prepare(`
      UPDATE real_calculation_runs
      SET started_at = '2026-01-01 00:00:00', completed_at = '2026-01-01 00:00:01'
      WHERE character_id = ?
    `).run(CHARACTER_ID);

    const compatible = await overview();
    expect(compatible.portfolio.performance.freshness.status).toBe('STALE');
    expect(compatible.portfolio.performance.knownRealizedPnl).toBe(0);

    const ledgerOverview = await getJson('/api/web/trading/p9/real-ledger/overview');
    expect(ledgerOverview.performance.freshness.status).toBe('STALE');
    expect(ledgerOverview.performance).toMatchObject({
      knownRealizedPnl: 0,
      unknownConsumptionCount: 0,
      unknownOpenLotCount: 0,
      unknownCostSellCount: 0,
      deterministicSellCount: 0,
    });

    const performance = await getJson('/api/web/trading/p9/real-ledger/performance');
    expect(performance.performance.freshness.status).toBe('STALE');
    expect(performance.performance.knownRealizedPnl).toBe(0);
    expect(performance.unrealized).toBeDefined();

    const costs = await getJson('/api/web/trading/p9/real-ledger/costs');
    expect(costs.freshness.status).toBe('STALE');
    expect(costs.lots).toEqual(expect.any(Array));
    expect(costs.consumptions).toEqual(expect.any(Array));

    const lineage = resolveAssetLineage(db as Db, CHARACTER_ID, sessionUserId, sessionChatId);
    const built = buildP9AnalysisPrompt(db as Db, CHARACTER_ID, lineage, { mode: 'daily' });
    expect(built.prompt).toContain('"realAccounting"');
    expect(built.prompt).toContain('"freshness"');
    expect(built.prompt).toContain('"status": "STALE"');
    expect(built.prompt).toContain('"knownRealizedPnl": 0');
    expect(built.prompt).toContain('不得把 USER_REPORTED、PENDING、DRAFT 或旧账本数据说成已核实真实交易');
  });
});
