import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import {
  clearCapabilitySnapshots,
  hasFreshCapabilitySnapshot,
} from '../../../src/eve/capabilities.js';
import {
  EsiWalletTransactionValidationError,
  normalizeEsiWalletTransaction,
  P93EsiEvidenceService,
} from '../../../src/trading/p9-3-evidence-service.js';
import { resolveAssetLineage } from '../../../src/assets/asset-lineage.js';
import { registerP93Routes } from '../../../src/web/p9-3-routes.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} from '../../../src/web/web-session.js';
import type { Db } from '../../../src/db/sqlite.js';

vi.mock('../../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    auth: { secretKey: 'p9339-wallet-adversarial-secret' },
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

const USER_A = 9_940_001;
const CHAT_A = 9_940_101;
const USER_B = 9_940_002;
const CHAT_B = 9_940_102;
const CHARACTER_ID = 9_940_201;
const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1';
const LOCATION_ID = 60_003_760;
const BASE = '/api/web/trading/p9/real-ledger';
const ORIGIN = 'http://localhost:3000';

let db: Db;

function row(transactionId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_id: transactionId,
    date: '2026-09-01T00:00:00Z',
    type_id: 34,
    quantity: 1,
    unit_price: 100,
    is_buy: true,
    location_id: LOCATION_ID,
    ...overrides,
  };
}

function response(payload: unknown, xPages = '1'): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      'X-Pages': xPages,
    },
  });
}

function principal(userId: number, chatId: number): void {
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(userId, `P9339 ${userId}`, CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(chatId, `p9339-${chatId}`, CHARACTER_ID);
}

function link(userId: number, chatId: number, scopes = [WALLET_SCOPE]): void {
  principal(userId, chatId);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'P9339 Wallet Pilot', 'access-token', 'refresh-token',
            datetime('now', '+1 hour'), ?, ?, 'owner-a')
    ON CONFLICT(character_id) DO UPDATE SET
      user_id = excluded.user_id,
      owner_hash = excluded.owner_hash,
      scopes_json = excluded.scopes_json,
      access_token = excluded.access_token,
      expires_at = excluded.expires_at
  `).run(CHARACTER_ID, JSON.stringify(scopes), userId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(chatId, CHARACTER_ID, userId);
}

function transferToB(): void {
  principal(USER_B, CHAT_B);
  db.prepare('UPDATE eve_accounts SET user_id = ?, owner_hash = ? WHERE character_id = ?')
    .run(USER_B, 'owner-b', CHARACTER_ID);
  db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_B, CHARACTER_ID, USER_B);
  db.prepare('UPDATE users SET active_character_id = NULL WHERE user_id = ?').run(USER_A);
  db.prepare('UPDATE telegram_sessions SET active_character_id = NULL WHERE chat_id = ?').run(CHAT_A);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(CHARACTER_ID, USER_B);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?').run(CHARACTER_ID, CHAT_B);
}

function context(userId = USER_A, chatId = CHAT_A) {
  return { userId, chatId, characterId: CHARACTER_ID };
}

function cursor(userId = USER_A, chatId = CHAT_A) {
  const lineage = resolveAssetLineage(db, CHARACTER_ID, userId, chatId);
  return db.prepare(`
    SELECT last_transaction_id, status FROM real_esi_transaction_sync
    WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ?
  `).get(CHARACTER_ID, lineage.ownerUserId, lineage.ownerChatId, lineage.bindingEpoch);
}

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  link(USER_A, CHAT_A);
});

afterEach(() => {
  clearCapabilitySnapshots();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

describe('P9.3.3.9 independent wallet journal validation', () => {
  it.each([
    ['string is_buy', { is_buy: 'false' }, /is_buy/],
    ['fractional transaction id', { transaction_id: 1.5 }, /transaction_id/],
    ['zero transaction id', { transaction_id: 0 }, /transaction_id/],
    ['string type id', { type_id: '34' }, /type_id/],
    ['zero quantity', { quantity: 0 }, /quantity/],
    ['infinite price', { unit_price: Number.POSITIVE_INFINITY }, /unit_price/],
    ['negative price', { unit_price: -1 }, /unit_price/],
    ['unparseable date', { date: 'not-a-date' }, /date/],
    ['zero location', { location_id: 0 }, /location_id/],
  ])('rejects %s without coercion', (_label, overrides, pattern) => {
    expect(() => normalizeEsiWalletTransaction(row(1, overrides)))
      .toThrow(EsiWalletTransactionValidationError);
    expect(() => normalizeEsiWalletTransaction(row(1, overrides))).toThrow(pattern);
  });

  it('creates a fresh capability snapshot for a pinned character even without prior ESI use', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const fetchMock = vi.fn(async () => response([row(10)]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, context());
    expect(result).toMatchObject({ ok: true, imported: 1, lastTransactionId: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hasFreshCapabilitySnapshot(context(), CHARACTER_ID)).toBe(true);

    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(hasFreshCapabilitySnapshot(context(), CHARACTER_ID)).toBe(false);
    const second = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, context());
    expect(second.ok).toBe(true);
    expect(hasFreshCapabilitySnapshot(context(), CHARACTER_ID)).toBe(true);
  });

  it('rejects a missing wallet scope before any ESI request and records a non-success state', async () => {
    db.prepare('UPDATE eve_accounts SET scopes_json = ? WHERE character_id = ?')
      .run(JSON.stringify(['esi-assets.read_assets.v1']), CHARACTER_ID);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, context());
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'WALLET_SCOPE_MISSING',
      imported: 0,
      lastTransactionId: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cursor()).toEqual({ last_transaction_id: null, status: 'error' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 0 });
  });

  it('fences a role ownership switch during fetch and writes no ledger facts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      transferToB();
      return response([row(20)]);
    }));

    const result = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, context());
    expect(result).toMatchObject({ ok: false, errorCode: 'IDENTITY_CHANGED', imported: 0, lastTransactionId: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 0 });
  });
});

describe('P9.3.3.9 independent wallet cursor and failure recovery', () => {
  it('does not advance over failed transaction 100 and recovers it idempotently after 101 succeeds', async () => {
    db.exec(`
      CREATE TRIGGER p9339_reject_100
      BEFORE INSERT ON real_trade_records
      WHEN NEW.source_ref = 'esi-wallet:100'
      BEGIN SELECT RAISE(ABORT, 'p9339 injected transaction 100 failure'); END;
    `);
    vi.stubGlobal('fetch', vi.fn(async () => response([row(100), row(101)])));

    const first = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, context());
    expect(first).toMatchObject({
      ok: false,
      errorCode: 'TRANSACTION_IMPORT_FAILED',
      imported: 1,
      lastTransactionId: null,
    });
    expect(cursor()).toEqual({ last_transaction_id: null, status: 'error' });
    expect(db.prepare('SELECT source_ref FROM real_trade_records WHERE character_id = ? ORDER BY source_ref')
      .all(CHARACTER_ID)).toEqual([{ source_ref: 'esi-wallet:101' }]);
    expect(db.prepare(`
      SELECT transaction_id, error_code FROM real_esi_transaction_failures
      WHERE character_id = ? AND transaction_id = 100
    `).get(CHARACTER_ID)).toEqual({ transaction_id: 100, error_code: 'TRANSACTION_IMPORT_FAILED' });

    db.exec('DROP TRIGGER p9339_reject_100');
    const second = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, context());
    expect(second).toMatchObject({ ok: true, imported: 2, lastTransactionId: 101 });
    expect(cursor()).toEqual({ last_transaction_id: 101, status: 'ok' });

    const third = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, context());
    expect(third).toMatchObject({ ok: true, imported: 0, skipped: 2, lastTransactionId: 101 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence_links').get()).toEqual({ n: 2 });
  });

  it('records malformed rows and blocks cursor even when a higher valid row imports', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([row(200, { type_id: undefined }), row(201)])));
    const result = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, context());

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'TRANSACTION_DATA_INVALID',
      imported: 1,
      lastTransactionId: null,
    });
    expect(cursor()).toEqual({ last_transaction_id: null, status: 'error' });
    expect(db.prepare(`
      SELECT transaction_id, error_code FROM real_esi_transaction_failures
      WHERE character_id = ? AND transaction_id = 200
    `).get(CHARACTER_ID)).toEqual({ transaction_id: 200, error_code: 'TRANSACTION_DATA_INVALID' });
  });

  it('rejects an over-budget page declaration without committing facts or cursor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([row(300)], '11')));
    const result = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, context());

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'ESI_REQUEST_FAILED',
      imported: 0,
      lastTransactionId: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 0 });
    expect(cursor()).toEqual({ last_transaction_id: null, status: 'error' });
  });

  it('isolates durable cursor state across owners after character transfer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([row(400)])));
    expect(await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, context())).toMatchObject({
      ok: true,
      lastTransactionId: 400,
    });

    const lineageA = resolveAssetLineage(db, CHARACTER_ID, USER_A, CHAT_A);
    transferToB();
    vi.stubGlobal('fetch', vi.fn(async () => response([row(500)])));
    const ownerB = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, context(USER_B, CHAT_B));
    expect(ownerB).toMatchObject({ ok: true, imported: 1, lastTransactionId: 500 });

    expect(db.prepare(`
      SELECT last_transaction_id, status FROM real_esi_transaction_sync
      WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ?
    `).get(CHARACTER_ID, lineageA.ownerUserId, lineageA.ownerChatId, lineageA.bindingEpoch))
      .toEqual({ last_transaction_id: 400, status: 'ok' });
    expect(cursor(USER_B, CHAT_B)).toEqual({ last_transaction_id: 500, status: 'ok' });
    expect(db.prepare(`
      SELECT owner_user_id, source_ref FROM real_trade_records
      WHERE character_id = ? ORDER BY owner_user_id, source_ref
    `).all(CHARACTER_ID)).toEqual([
      { owner_user_id: USER_A, source_ref: 'esi-wallet:400' },
      { owner_user_id: USER_B, source_ref: 'esi-wallet:500' },
    ]);
  });
});

describe('P9.3.3.9 independent wallet route behavior', () => {
  it('returns a 403 for missing wallet scope and does not dispatch ESI', async () => {
    resetWebSessionCreationGuardForTests();
    const created = createWebSession(db);
    db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?')
      .run(CHARACTER_ID, created.userId);
    db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
      .run(CHARACTER_ID, created.chatId);
    db.prepare('UPDATE eve_accounts SET user_id = ?, scopes_json = ? WHERE character_id = ?')
      .run(created.userId, JSON.stringify(['esi-assets.read_assets.v1']), CHARACTER_ID);
    db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(created.chatId, CHARACTER_ID, created.userId);

    const app = Fastify();
    await app.register(fastifyCookie);
    registerP93Routes(app, db);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await app.inject({
        method: 'POST',
        url: `${BASE}/esi-wallet-sync`,
        headers: {
          origin: ORIGIN,
          cookie: `${WEB_SESSION_COOKIE}=${created.sessionToken}`,
          'x-csrf-token': created.csrfToken,
        },
        payload: {},
      });
      expect(result.statusCode).toBe(403);
      expect(result.json()).toMatchObject({ ok: false, errorCode: 'WALLET_SCOPE_MISSING' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('keeps the route-selected character pinned when the active character changes mid-request', async () => {
    resetWebSessionCreationGuardForTests();
    const created = createWebSession(db);
    const otherCharacter = CHARACTER_ID + 1;
    db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?')
      .run(CHARACTER_ID, created.userId);
    db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
      .run(CHARACTER_ID, created.chatId);
    db.prepare('UPDATE eve_accounts SET user_id = ? WHERE character_id = ?')
      .run(created.userId, CHARACTER_ID);
    db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(created.chatId, CHARACTER_ID, created.userId);
    db.prepare(`
      INSERT INTO eve_accounts
        (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
      VALUES (?, 'P9339 Other', 'other-token', 'other-refresh', datetime('now', '+1 hour'), ?, ?, 'other-owner')
    `).run(otherCharacter, JSON.stringify([WALLET_SCOPE]), created.userId);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(created.chatId, otherCharacter, created.userId);

    const app = Fastify();
    await app.register(fastifyCookie);
    registerP93Routes(app, db);
    vi.stubGlobal('fetch', vi.fn(async () => {
      db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?')
        .run(otherCharacter, created.userId);
      db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
        .run(otherCharacter, created.chatId);
      return response([row(600)]);
    }));
    try {
      const result = await app.inject({
        method: 'POST',
        url: `${BASE}/esi-wallet-sync`,
        headers: {
          origin: ORIGIN,
          cookie: `${WEB_SESSION_COOKIE}=${created.sessionToken}`,
          'x-csrf-token': created.csrfToken,
        },
        payload: {},
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ ok: true, imported: 1, lastTransactionId: 600 });
      expect(db.prepare('SELECT character_id, source_ref FROM real_trade_records').all())
        .toEqual([{ character_id: CHARACTER_ID, source_ref: 'esi-wallet:600' }]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE character_id = ?')
        .get(otherCharacter)).toEqual({ n: 0 });
    } finally {
      await app.close();
    }
  });
});
