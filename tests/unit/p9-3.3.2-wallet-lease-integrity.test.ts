import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import type { Db } from '../../src/db/sqlite.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { P93EsiEvidenceService } from '../../src/trading/p9-3-evidence-service.js';
import { P93LedgerService } from '../../src/trading/p9-3-ledger-service.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
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
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720 },
  },
}));

const USER_ID = 9322001;
const CHAT_ID = 9322101;
const CHARACTER_ID = 9322201;
const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1';
const CTX = { userId: USER_ID, chatId: CHAT_ID };
let db: Database.Database;

function walletRow(transactionId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_id: transactionId,
    date: '2026-05-01T00:00:00Z',
    type_id: 34,
    quantity: 1,
    unit_price: 10,
    is_buy: true,
    location_id: 60003760,
    ...overrides,
  };
}

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      'X-Pages': '1',
    },
  });
}

function linkCharacter(): void {
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'Lease Audit', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'lease-audit', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Lease Audit', 'lease-token', 'lease-refresh', datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_ID, JSON.stringify([WALLET_SCOPE]), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

function cursorRow(): { last_transaction_id: number | null; status: string } | undefined {
  return db.prepare(
    'SELECT last_transaction_id, status FROM real_esi_transaction_sync WHERE character_id = ?',
  ).get(CHARACTER_ID) as { last_transaction_id: number | null; status: string } | undefined;
}

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  linkCharacter();
});

afterEach(() => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

describe('P9.3.3.2 wallet sync lease and durable retry queue', () => {
  it('reclaims an expired character lease and releases it after a successful sync', async () => {
    db.prepare(`
      INSERT INTO real_esi_transaction_sync_leases
        (character_id, owner_user_id, owner_chat_id, binding_epoch, owner_id, acquired_at, expires_at)
      VALUES (?, ?, ?, 1, 'crashed-worker', datetime('now', '-60 seconds'), datetime('now', '-1 second'))
    `).run(CHARACTER_ID, USER_ID, CHAT_ID);
    vi.stubGlobal('fetch', vi.fn(async () => response([walletRow(901)])));

    const result = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_ID, CTX);

    expect(result).toMatchObject({ ok: true, lastTransactionId: 901 });
    expect(cursorRow()).toEqual({ last_transaction_id: 901, status: 'ok' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_esi_transaction_sync_leases WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 0 });
  });

  it('persists a retryable transaction failure and clears it only after idempotent success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([walletRow(910), walletRow(911)])));
    const originalAddEvidence = P93LedgerService.addEvidence.bind(P93LedgerService);
    vi.spyOn(P93LedgerService, 'addEvidence').mockImplementationOnce(() => {
      throw new Error('injected transient evidence write failure');
    });

    const first = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_ID, CTX);
    expect(first).toMatchObject({ ok: false, errorCode: 'TRANSACTION_IMPORT_FAILED', lastTransactionId: null });
    expect(cursorRow()).toEqual({ last_transaction_id: null, status: 'error' });
    expect(db.prepare(`
      SELECT transaction_id, error_code, retry_count
      FROM real_esi_transaction_failures WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({
      transaction_id: 910,
      error_code: 'TRANSACTION_IMPORT_FAILED',
      retry_count: 0,
    });

    vi.restoreAllMocks();
    vi.spyOn(P93LedgerService, 'addEvidence').mockImplementation(originalAddEvidence);
    db.prepare('DELETE FROM esi_cache').run();
    const second = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_ID, CTX);

    expect(second).toMatchObject({ ok: true, lastTransactionId: 911 });
    expect(cursorRow()).toEqual({ last_transaction_id: 911, status: 'ok' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_esi_transaction_failures WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 2 });
  });

  it('replays a corrected transaction below the current cursor to clear its durable failure', async () => {
    db.prepare(`
      INSERT INTO real_esi_transaction_sync
        (character_id, owner_user_id, owner_chat_id, binding_epoch, last_transaction_id, last_synced_at, status, error)
      VALUES (?, ?, ?, 1, 200, datetime('now'), 'error', 'prior malformed transaction')
    `).run(CHARACTER_ID, USER_ID, CHAT_ID);
    db.prepare(`
      INSERT INTO real_esi_transaction_failures
        (character_id, owner_user_id, owner_chat_id, binding_epoch, failure_key, transaction_id, error_code, error,
         first_failed_at, last_failed_at, retry_count)
      VALUES (?, ?, ?, 1, 'transaction:150', 150, 'TRANSACTION_DATA_INVALID',
              'prior malformed transaction', datetime('now'), datetime('now'), 1)
    `).run(CHARACTER_ID, USER_ID, CHAT_ID);
    vi.stubGlobal('fetch', vi.fn(async () => response([walletRow(150), walletRow(200)])));

    const result = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_ID, CTX);

    expect(result).toMatchObject({ ok: true, status: 'ok', imported: 1, skipped: 1, lastTransactionId: 200 });
    expect(cursorRow()).toEqual({ last_transaction_id: 200, status: 'ok' });
    expect(db.prepare('SELECT source_ref FROM real_trade_records WHERE character_id = ?').all(CHARACTER_ID))
      .toEqual([{ source_ref: 'esi-wallet:150' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_esi_transaction_failures WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 0 });
  });

  it('retains the validation failure when a duplicate ID is partially imported', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([walletRow(960), walletRow(960)])));

    const result = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_ID, CTX);

    expect(result).toMatchObject({ ok: false, status: 'error', errorCode: 'TRANSACTION_DATA_INVALID' });
    expect(cursorRow()).toEqual({ last_transaction_id: null, status: 'error' });
    expect(db.prepare(`
      SELECT transaction_id, error_code
      FROM real_esi_transaction_failures WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({
      transaction_id: 960,
      error_code: 'TRANSACTION_DATA_INVALID',
    });
  });

  it('prevents an old lease owner from committing after the lease is replaced', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([walletRow(920)])));
    db.exec(`
      CREATE TRIGGER replace_wallet_lease_during_cursor_write
      BEFORE INSERT ON real_esi_transaction_sync
      BEGIN
        UPDATE real_esi_transaction_sync_leases
        SET owner_id = 'replacement-worker',
            acquired_at = datetime('now'),
            expires_at = datetime('now', '+30 seconds')
        WHERE character_id = NEW.character_id;
      END;
    `);

    const result = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_ID, CTX);

    expect(result).toMatchObject({ ok: false, errorCode: 'TRANSACTION_IMPORT_FAILED' });
    expect(result.errors.join(' ')).toContain('租约');
    expect(cursorRow()?.last_transaction_id ?? null).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 1 });
    // The injected ownership replacement and the cursor insert share the same
    // transaction, so losing the lease rolls both back and the old owner
    // cannot leave a committed boundary behind.
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_esi_transaction_sync_leases WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 0 });
  });
});
