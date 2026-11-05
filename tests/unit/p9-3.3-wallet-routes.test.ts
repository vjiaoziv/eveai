import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { registerP93Routes } from '../../src/web/p9-3-routes.js';
import { resolveAssetLineage } from '../../src/assets/asset-lineage.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} from '../../src/web/web-session.js';

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

const ORIGIN = 'http://localhost:3000';
const CHARACTER_A = 90002001;
const CHARACTER_B = 90002002;
const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1';
let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let session: { cookie: string; csrf: string; userId: number; chatId: number };

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      'X-Pages': '1',
    },
  });
}

function walletRow(transactionId: number) {
  return {
    transaction_id: transactionId,
    date: '2026-03-25T00:00:00Z',
    type_id: 34,
    quantity: 1,
    unit_price: 10,
    is_buy: true,
    location_id: 60003760,
  };
}

function mutationHeaders() {
  return {
    origin: ORIGIN,
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
  };
}

beforeEach(async () => {
  clearCapabilitySnapshots();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  const created = createWebSession(db);
  session = {
    cookie: `${WEB_SESSION_COOKIE}=${created.sessionToken}`,
    csrf: created.csrfToken,
    userId: created.userId,
    chatId: created.chatId,
  };
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(CHARACTER_A, session.userId);
  db.prepare("UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?").run(CHARACTER_A, session.chatId);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Wallet Alpha', 'token-a', 'refresh-a', datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_A, JSON.stringify([WALLET_SCOPE]), session.userId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(session.chatId, CHARACTER_A, session.userId);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Wallet Bravo', 'token-b', 'refresh-b', datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_B, JSON.stringify([WALLET_SCOPE]), session.userId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(session.chatId, CHARACTER_B, session.userId);

  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerP93Routes(app, db);
});

afterEach(async () => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (app) await app.close();
  if (db) db.close();
});

describe('P9.3.3 wallet sync route hardening', () => {
  it('returns an actionable 403 and never calls ESI when the wallet scope is missing', async () => {
    db.prepare('UPDATE eve_accounts SET scopes_json = ? WHERE character_id = ?')
      .run(JSON.stringify([]), CHARACTER_A);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/trading/p9/real-ledger/esi-wallet-sync',
      headers: mutationHeaders(),
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ ok: false, errorCode: 'WALLET_SCOPE_MISSING' });
    expect(response.body).toContain(WALLET_SCOPE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the route request pinned to the selected character when active identity changes mid-flight', async () => {
    let switched = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain(`/characters/${CHARACTER_A}/wallet/transactions/`);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-a');
      if (!switched) {
        switched = true;
        db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(CHARACTER_B, session.userId);
      }
      return jsonResponse([walletRow(200)]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/trading/p9/real-ledger/esi-wallet-sync',
      headers: mutationHeaders(),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, imported: 1, lastTransactionId: 200 });
    expect(db.prepare('SELECT active_character_id FROM users WHERE user_id = ?').get(session.userId))
      .toEqual({ active_character_id: CHARACTER_B });
    expect(db.prepare('SELECT character_id, source_ref FROM real_trade_records').all())
      .toEqual([{ character_id: CHARACTER_A, source_ref: 'esi-wallet:200' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE character_id = ?').get(CHARACTER_B))
      .toEqual({ n: 0 });
  });

  it('returns 403 when the target character link disappears during the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_A);
      return jsonResponse([walletRow(202)]);
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/trading/p9/real-ledger/esi-wallet-sync',
      headers: mutationHeaders(),
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ ok: false, errorCode: 'IDENTITY_CHANGED', lastTransactionId: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT last_transaction_id, status FROM real_esi_transaction_sync WHERE character_id = ?').get(CHARACTER_A))
      .toEqual({ last_transaction_id: null, status: 'error' });
  });

  it('returns a failure when another sync left an unresolved lower transaction', async () => {
    const lineage = resolveAssetLineage(db, CHARACTER_A, session.userId, session.chatId);
    db.prepare(`
      INSERT INTO real_esi_transaction_sync
        (character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
         last_transaction_id, last_synced_at, status, error)
      VALUES (?, ?, ?, ?, ?, 100, datetime('now'), 'error', 'unresolved lower transaction')
    `).run(CHARACTER_A, lineage.ownerUserId, lineage.ownerChatId, lineage.bindingEpoch, lineage.bindingDigest);
    db.prepare(`
      INSERT INTO real_esi_transaction_failures
        (character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
         failure_key, transaction_id, error_code, error,
         first_failed_at, last_failed_at, retry_count)
      VALUES (?, ?, ?, ?, ?, 'transaction:150', 150, 'TRANSACTION_DATA_INVALID',
              'unresolved lower transaction', datetime('now'), datetime('now'), 1)
    `).run(CHARACTER_A, lineage.ownerUserId, lineage.ownerChatId, lineage.bindingEpoch, lineage.bindingDigest);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([walletRow(200)])));

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/trading/p9/real-ledger/esi-wallet-sync',
      headers: mutationHeaders(),
      payload: {},
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      ok: false,
      status: 'error',
      errorCode: 'TRANSACTION_DATA_INVALID',
    });
    expect(response.body).toContain('钱包交易 150');
    expect(db.prepare('SELECT last_transaction_id, status FROM real_esi_transaction_sync WHERE character_id = ?').get(CHARACTER_A))
      .toEqual({ last_transaction_id: 100, status: 'error' });
  });

  it('returns 502 for incomplete ESI pagination and leaves the cursor untouched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([walletRow(201)]), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        Expires: new Date(Date.now() + 3_600_000).toUTCString(),
        'X-Pages': '11',
      },
    })));

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/trading/p9/real-ledger/esi-wallet-sync',
      headers: mutationHeaders(),
      payload: {},
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ ok: false, errorCode: 'ESI_REQUEST_FAILED', lastTransactionId: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT last_transaction_id, status FROM real_esi_transaction_sync WHERE character_id = ?').get(CHARACTER_A))
      .toEqual({ last_transaction_id: null, status: 'error' });
  });
});
