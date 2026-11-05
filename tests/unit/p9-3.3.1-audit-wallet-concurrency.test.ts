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
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720, sessionCreationWindowSeconds: 60, maxSessionCreationsPerWindow: 100 },
  },
}));

const USER_ID = 821;
const CHAT_ID = 1821;
const CHARACTER_A = 93120001;
const CHARACTER_B = 93120002;
const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1';
let db: Database.Database;

type PendingFetch = {
  url: string;
  authorization: string | null;
  resolve: (response: Response) => void;
};

function walletRow(transactionId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_id: transactionId,
    date: '2026-04-02T00:00:00Z',
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

function linkCharacter(characterId: number, token: string): void {
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, ?, ?, ?, datetime('now', '+1 hour'), ?, ?)
  `).run(characterId, `Audit ${characterId}`, token, `refresh-${token}`, JSON.stringify([WALLET_SCOPE]), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, characterId, USER_ID);
}

function installDeferredFetch(): PendingFetch[] {
  const pending: PendingFetch[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
    pending.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('Authorization'),
      resolve,
    });
  }));
  vi.stubGlobal('fetch', fetchMock);
  return pending;
}

function cursor(characterId: number): { last_transaction_id: number | null; status: string } {
  return db.prepare(
    'SELECT last_transaction_id, status FROM real_esi_transaction_sync WHERE character_id = ?',
  ).get(characterId) as { last_transaction_id: number | null; status: string };
}

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'Wallet Audit', CHARACTER_A);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'wallet-audit', CHARACTER_A);
  linkCharacter(CHARACTER_A, 'token-a');
});

afterEach(() => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

describe('P9.3.3.1 independent wallet identity/cursor audit', () => {
  it('keeps two concurrently synced characters isolated', async () => {
    linkCharacter(CHARACTER_B, 'token-b');
    const pending = installDeferredFetch();

    const promiseA = P93EsiEvidenceService.syncWalletTransactions(
      db as Db,
      CHARACTER_A,
      { userId: USER_ID, chatId: CHAT_ID },
    );
    const promiseB = P93EsiEvidenceService.syncWalletTransactions(
      db as Db,
      CHARACTER_B,
      { userId: USER_ID, chatId: CHAT_ID },
    );

    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const fetchA = pending.find((item) => item.url.includes(`/characters/${CHARACTER_A}/`));
    const fetchB = pending.find((item) => item.url.includes(`/characters/${CHARACTER_B}/`));
    expect(fetchA?.authorization).toBe('Bearer token-a');
    expect(fetchB?.authorization).toBe('Bearer token-b');

    fetchA!.resolve(response([walletRow(301)]));
    await new Promise((resolve) => setImmediate(resolve));
    fetchB!.resolve(response([walletRow(401)]));

    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
    expect(resultA).toMatchObject({ ok: true, lastTransactionId: 301 });
    expect(resultB).toMatchObject({ ok: true, lastTransactionId: 401 });
    expect(db.prepare('SELECT character_id, source_ref FROM real_trade_records ORDER BY character_id').all()).toEqual([
      { character_id: CHARACTER_A, source_ref: 'esi-wallet:301' },
      { character_id: CHARACTER_B, source_ref: 'esi-wallet:401' },
    ]);
    expect(cursor(CHARACTER_A).last_transaction_id).toBe(301);
    expect(cursor(CHARACTER_B).last_transaction_id).toBe(401);
  });

  it('prevents a slower same-character sync from moving the cursor backwards', async () => {
    db.prepare(`
      INSERT INTO real_esi_transaction_sync
        (character_id, owner_user_id, owner_chat_id, binding_epoch, last_transaction_id, last_synced_at, status)
      VALUES (?, ?, ?, 1, 100, datetime('now'), 'ok')
    `).run(CHARACTER_A, USER_ID, CHAT_ID);
    const pending = installDeferredFetch();

    const first = P93EsiEvidenceService.syncWalletTransactions(
      db as Db,
      CHARACTER_A,
      { userId: USER_ID, chatId: CHAT_ID },
    );
    const second = P93EsiEvidenceService.syncWalletTransactions(
      db as Db,
      CHARACTER_A,
      { userId: USER_ID, chatId: CHAT_ID },
    );

    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0]!.resolve(response([walletRow(200)]));
    await new Promise((resolve) => setImmediate(resolve));
    pending[1]!.resolve(response([walletRow(150)]));

    await Promise.all([first, second]);
    expect(cursor(CHARACTER_A)).toEqual({ last_transaction_id: 200, status: 'ok' });
  });

  it('does not let one concurrent success advance past a low-ID failure from another sync', async () => {
    db.prepare(`
      INSERT INTO real_esi_transaction_sync
        (character_id, owner_user_id, owner_chat_id, binding_epoch, last_transaction_id, last_synced_at, status)
      VALUES (?, ?, ?, 1, 100, datetime('now'), 'ok')
    `).run(CHARACTER_A, USER_ID, CHAT_ID);
    const pending = installDeferredFetch();

    const failing = P93EsiEvidenceService.syncWalletTransactions(
      db as Db,
      CHARACTER_A,
      { userId: USER_ID, chatId: CHAT_ID },
    );
    const succeeding = P93EsiEvidenceService.syncWalletTransactions(
      db as Db,
      CHARACTER_A,
      { userId: USER_ID, chatId: CHAT_ID },
    );

    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0]!.resolve(response([
      walletRow(150, { is_buy: 'false' }),
      walletRow(200),
    ]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(cursor(CHARACTER_A)).toEqual({ last_transaction_id: 100, status: 'error' });

    pending[1]!.resolve(response([walletRow(200)]));
    const [failedResult, successResult] = await Promise.all([failing, succeeding]);
    expect(failedResult).toMatchObject({ ok: false, errorCode: 'TRANSACTION_DATA_INVALID' });
    expect(successResult).toMatchObject({ ok: false, status: 'error', lastTransactionId: 100 });
    expect(cursor(CHARACTER_A)).toEqual({ last_transaction_id: 100, status: 'error' });
  });

  it('does not append duplicate evidence-link events during an idempotent retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([walletRow(500)])));

    const first = await P93EsiEvidenceService.syncWalletTransactions(
      db as Db,
      CHARACTER_A,
      { userId: USER_ID, chatId: CHAT_ID },
    );
    expect(first).toMatchObject({ ok: true, lastTransactionId: 500 });

    db.prepare('UPDATE real_esi_transaction_sync SET last_transaction_id = NULL, status = \'error\' WHERE character_id = ?')
      .run(CHARACTER_A);
    db.prepare('DELETE FROM esi_cache').run();
    const second = await P93EsiEvidenceService.syncWalletTransactions(
      db as Db,
      CHARACTER_A,
      { userId: USER_ID, chatId: CHAT_ID },
    );
    expect(second).toMatchObject({ ok: true, lastTransactionId: 500 });

    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence_links').get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM real_trade_events WHERE event_type = 'evidence_linked'").get())
      .toEqual({ n: 1 });
  });

  it('does not commit a cursor if the character is unlinked during the cursor write', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([walletRow(600)])));
    db.exec(`
      CREATE TRIGGER audit_unlink_during_cursor_write
      BEFORE INSERT ON real_esi_transaction_sync
      BEGIN
        DELETE FROM eve_character_links WHERE character_id = NEW.character_id;
      END;
    `);

    const result = await P93EsiEvidenceService.syncWalletTransactions(
      db as Db,
      CHARACTER_A,
      { userId: USER_ID, chatId: CHAT_ID },
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'IDENTITY_CHANGED' });
    expect(cursor(CHARACTER_A).last_transaction_id).toBeNull();
  });

  it('aborts after an ownership change detected following the ESI response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      db.prepare('UPDATE eve_accounts SET user_id = ? WHERE character_id = ?').run(USER_ID + 1, CHARACTER_A);
      return response([walletRow(650)]);
    }));

    const result = await P93EsiEvidenceService.syncWalletTransactions(
      db as Db,
      CHARACTER_A,
      { userId: USER_ID, chatId: CHAT_ID },
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'IDENTITY_CHANGED' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence').get()).toEqual({ n: 0 });
    expect(cursor(CHARACTER_A).last_transaction_id).toBeNull();
  });

  it('rolls back record/evidence writes if identity disappears inside the row transaction', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([walletRow(700)])));
    const originalAddEvidence = P93LedgerService.addEvidence.bind(P93LedgerService);
    vi.spyOn(P93LedgerService, 'addEvidence').mockImplementationOnce((...args) => {
      const evidence = originalAddEvidence(...args);
      db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_A);
      return evidence;
    });

    const result = await P93EsiEvidenceService.syncWalletTransactions(
      db as Db,
      CHARACTER_A,
      { userId: USER_ID, chatId: CHAT_ID },
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/解绑|发生变化/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence').get()).toEqual({ n: 0 });
    expect(cursor(CHARACTER_A).last_transaction_id).toBeNull();
  });

  it('can recover idempotently after the cursor write itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([walletRow(800)])));
    db.prepare(`
      INSERT INTO real_esi_transaction_sync
        (character_id, owner_user_id, owner_chat_id, binding_epoch, last_transaction_id, last_synced_at, status)
      VALUES (?, ?, ?, 1, NULL, datetime('now'), 'error')
    `).run(CHARACTER_A, USER_ID, CHAT_ID);
    db.exec(`
      CREATE TRIGGER audit_reject_success_cursor
      BEFORE UPDATE ON real_esi_transaction_sync
      WHEN NEW.status = 'ok'
      BEGIN
        SELECT RAISE(ABORT, 'injected cursor write failure');
      END;
    `);

    await expect(P93EsiEvidenceService.syncWalletTransactions(
      db as Db,
      CHARACTER_A,
      { userId: USER_ID, chatId: CHAT_ID },
    )).rejects.toThrow(/injected cursor write failure/);

    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence_links').get()).toEqual({ n: 1 });
    expect(cursor(CHARACTER_A).last_transaction_id).toBeNull();

    db.exec('DROP TRIGGER audit_reject_success_cursor');
    db.prepare('DELETE FROM esi_cache').run();
    const recovered = await P93EsiEvidenceService.syncWalletTransactions(
      db as Db,
      CHARACTER_A,
      { userId: USER_ID, chatId: CHAT_ID },
    );
    expect(recovered).toMatchObject({ ok: true, lastTransactionId: 800 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence_links').get()).toEqual({ n: 1 });
  });
});
