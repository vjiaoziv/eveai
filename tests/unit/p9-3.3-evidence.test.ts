import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import type { Db } from '../../src/db/sqlite.js';
import { clearCapabilitySnapshots, getEveCapabilities } from '../../src/eve/capabilities.js';
import { P93EsiEvidenceService, normalizeEsiWalletTransaction } from '../../src/trading/p9-3-evidence-service.js';
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

const USER_ID = 501;
const CHAT_ID = 1501;
const CHARACTER_A = 90001001;
const CHARACTER_B = 90001002;
const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1';
let db: Database.Database;

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      'X-Pages': '1',
      ...headers,
    },
  });
}

function walletRow(transactionId: number, overrides: Record<string, unknown> = {}) {
  return {
    transaction_id: transactionId,
    date: '2026-03-25T00:00:00Z',
    type_id: 34,
    quantity: 5,
    unit_price: 12.5,
    is_buy: true,
    location_id: 60003760,
    ...overrides,
  };
}

function linkCharacter(characterId: number, scopes: string[] = [WALLET_SCOPE], token = 'token-a'): void {
  db.prepare('INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id) VALUES (?, ?, ?, ?, datetime(\'now\', \'+1 hour\'), ?, ?)')
    .run(characterId, `Pilot ${characterId}`, token, `refresh-${token}`, JSON.stringify(scopes), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, characterId, USER_ID);
}

beforeEach(() => {
  vi.useRealTimers();
  clearCapabilitySnapshots();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'Wallet Pilot', CHARACTER_A);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'wallet-pilot', CHARACTER_A);
  linkCharacter(CHARACTER_A);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  clearCapabilitySnapshots();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

describe('P9.3.3 ESI wallet evidence hardening', () => {
  it('strictly validates every wallet transaction field without coercing strings or directions', () => {
    expect(normalizeEsiWalletTransaction(walletRow(100))).toMatchObject({
      transactionId: 100,
      typeId: 34,
      quantity: 5,
      unitPrice: 12.5,
      isBuy: true,
      locationId: 60003760,
      date: '2026-03-25T00:00:00.000Z',
    });
    expect(() => normalizeEsiWalletTransaction(walletRow(101, { is_buy: 'false' }))).toThrow(/boolean/);
    expect(() => normalizeEsiWalletTransaction(walletRow(102, { transaction_id: '102' }))).toThrow(/正安全整数/);
    expect(() => normalizeEsiWalletTransaction(walletRow(103, { type_id: 0 }))).toThrow(/正整数/);
    expect(() => normalizeEsiWalletTransaction(walletRow(104, { quantity: 1.5 }))).toThrow(/正整数/);
    expect(() => normalizeEsiWalletTransaction(walletRow(105, { unit_price: -1 }))).toThrow(/有限非负数/);
    expect(() => normalizeEsiWalletTransaction(walletRow(106, { date: 'not-a-date' }))).toThrow(/可解析/);
    expect(() => normalizeEsiWalletTransaction(walletRow(107, { location_id: 0 }))).toThrow(/正安全整数/);
    expect(() => normalizeEsiWalletTransaction(walletRow(108, { unit_price: undefined, price: 12.5 }))).toThrow(/unit_price/);
    expect(() => normalizeEsiWalletTransaction(walletRow(109, { location_id: undefined, station_id: 60003760 }))).toThrow(/location_id/);
  });

  it('creates its own capability snapshot and keeps wallet requests and writes pinned during a character switch', async () => {
    linkCharacter(CHARACTER_B, [WALLET_SCOPE], 'token-b');
    let switched = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain(`/characters/${CHARACTER_A}/wallet/transactions/`);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-a');
      if (!switched) {
        switched = true;
        db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(CHARACTER_B, USER_ID);
      }
      return jsonResponse([walletRow(101), walletRow(100)]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_A, {
      userId: USER_ID,
      chatId: CHAT_ID,
    });

    expect(result).toMatchObject({ ok: true, imported: 2, lastTransactionId: 101 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT active_character_id FROM users WHERE user_id = ?').get(USER_ID))
      .toEqual({ active_character_id: CHARACTER_B });
    expect(db.prepare('SELECT character_id, source_ref FROM real_trade_records ORDER BY source_ref').all())
      .toEqual([
        { character_id: CHARACTER_A, source_ref: 'esi-wallet:100' },
        { character_id: CHARACTER_A, source_ref: 'esi-wallet:101' },
      ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE character_id = ?').get(CHARACTER_B))
      .toEqual({ n: 0 });
  });

  it('follows from_id wallet-history pagination without committing an incomplete set', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const fromId = url.searchParams.get('from_id');
      if (fromId === null) {
        return jsonResponse([walletRow(101), walletRow(100)], { 'X-Pages': '2' });
      }
      expect(fromId).toBe('100');
      return jsonResponse([walletRow(99)], { 'X-Pages': '2' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_A, { userId: USER_ID, chatId: CHAT_ID });

    expect(result).toMatchObject({ ok: true, imported: 3, lastTransactionId: 101 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT source_ref FROM real_trade_records ORDER BY source_ref').all())
      .toEqual([
        { source_ref: 'esi-wallet:100' },
        { source_ref: 'esi-wallet:101' },
        { source_ref: 'esi-wallet:99' },
      ]);
  });

  it('aborts without writes if the pinned character link disappears during the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_A);
      return jsonResponse([walletRow(105)]);
    }));

    const result = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_A, {
      userId: USER_ID,
      chatId: CHAT_ID,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'IDENTITY_CHANGED', lastTransactionId: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT status, last_transaction_id FROM real_esi_transaction_sync WHERE character_id = ?').get(CHARACTER_A))
      .toEqual({ status: 'error', last_transaction_id: null });
  });

  it('reports a missing wallet scope before any ESI request', async () => {
    db.prepare('UPDATE eve_accounts SET scopes_json = ? WHERE character_id = ?')
      .run(JSON.stringify([]), CHARACTER_A);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_A, { userId: USER_ID, chatId: CHAT_ID });

    expect(result).toMatchObject({ ok: false, errorCode: 'WALLET_SCOPE_MISSING' });
    expect(result.errors.join(' ')).toContain(WALLET_SCOPE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status, last_transaction_id FROM real_esi_transaction_sync WHERE character_id = ?').get(CHARACTER_A))
      .toEqual({ status: 'error', last_transaction_id: null });
  });

  it('re-establishes an expired capability snapshot instead of relying on a prior check', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T00:00:00Z'));
    await getEveCapabilities(db as Db, 'prior check', { userId: USER_ID, chatId: CHAT_ID });
    vi.setSystemTime(new Date('2026-03-25T00:11:00Z'));
    const fetchMock = vi.fn(async () => jsonResponse([walletRow(110)]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_A, {
      userId: USER_ID,
      chatId: CHAT_ID,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not advance the cursor when pagination exceeds the allowed maximum', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([walletRow(120)], { 'X-Pages': '11' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_A, { userId: USER_ID, chatId: CHAT_ID });

    expect(result).toMatchObject({ ok: false, errorCode: 'ESI_REQUEST_FAILED', lastTransactionId: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT status, last_transaction_id FROM real_esi_transaction_sync WHERE character_id = ?').get(CHARACTER_A))
      .toEqual({ status: 'error', last_transaction_id: null });
  });

  it('does not commit a declared multi-page batch when a later page is empty', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([walletRow(115)], { 'X-Pages': '2' }))
      .mockResolvedValueOnce(jsonResponse([], { 'X-Pages': '2' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_A, { userId: USER_ID, chatId: CHAT_ID });

    expect(result).toMatchObject({ ok: false, errorCode: 'ESI_REQUEST_FAILED', lastTransactionId: null });
    expect(result.errors.join(' ')).toContain('第 2 页为空');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT status, last_transaction_id FROM real_esi_transaction_sync WHERE character_id = ?').get(CHARACTER_A))
      .toEqual({ status: 'error', last_transaction_id: null });
  });

  it('accepts a legitimate empty single-page wallet history without inventing a cursor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([], { 'X-Pages': '1' })));

    const result = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_A, { userId: USER_ID, chatId: CHAT_ID });

    expect(result).toMatchObject({ ok: true, status: 'ok', imported: 0, lastTransactionId: null });
    expect(db.prepare('SELECT status, last_transaction_id FROM real_esi_transaction_sync WHERE character_id = ?').get(CHARACTER_A))
      .toEqual({ status: 'ok', last_transaction_id: null });
  });

  it('rejects an empty first page when ESI declares more pages', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([], { 'X-Pages': '2' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_A, { userId: USER_ID, chatId: CHAT_ID });

    expect(result).toMatchObject({ ok: false, errorCode: 'ESI_REQUEST_FAILED', lastTransactionId: null });
    expect(result.errors.join(' ')).toContain('第 1 页为空');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT status, last_transaction_id FROM real_esi_transaction_sync WHERE character_id = ?').get(CHARACTER_A))
      .toEqual({ status: 'error', last_transaction_id: null });
  });

  it('keeps the conservative cursor after a failed low ID and retries it idempotently', async () => {
    const rows = [walletRow(100), walletRow(101)];
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(rows)));
    const originalAddEvidence = P93LedgerService.addEvidence.bind(P93LedgerService);
    vi.spyOn(P93LedgerService, 'addEvidence').mockImplementationOnce(() => {
      throw new Error('temporary isolated database failure');
    });

    const first = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_A, { userId: USER_ID, chatId: CHAT_ID });
    expect(first).toMatchObject({ ok: false, errorCode: 'TRANSACTION_IMPORT_FAILED', lastTransactionId: null });
    expect(first.errors.join(' ')).toContain('temporary isolated database failure');
    expect(db.prepare('SELECT source_ref FROM real_trade_records ORDER BY source_ref').all())
      .toEqual([{ source_ref: 'esi-wallet:101' }]);
    expect(db.prepare('SELECT status, last_transaction_id FROM real_esi_transaction_sync WHERE character_id = ?').get(CHARACTER_A))
      .toEqual({ status: 'error', last_transaction_id: null });

    vi.restoreAllMocks();
    vi.spyOn(P93LedgerService, 'addEvidence').mockImplementation(originalAddEvidence);
    const second = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_A, { userId: USER_ID, chatId: CHAT_ID });
    expect(second).toMatchObject({ ok: true, lastTransactionId: 101 });

    const third = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_A, { userId: USER_ID, chatId: CHAT_ID });
    expect(third).toMatchObject({ ok: true, skipped: 2, lastTransactionId: 101 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence_links').get()).toEqual({ n: 2 });
  });

  it('keeps a manually verified transaction fact unchanged during an idempotent retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([walletRow(140)])));
    const first = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_A, { userId: USER_ID, chatId: CHAT_ID });
    expect(first).toMatchObject({ ok: true, lastTransactionId: 140 });

    const row = db.prepare('SELECT record_id FROM real_trade_records WHERE character_id = ?').get(CHARACTER_A) as { record_id: string };
    P93LedgerService.verify(db as Db, CHARACTER_A, row.record_id, 'user:test');
    const verified = P93LedgerService.get(db as Db, CHARACTER_A, row.record_id);
    expect(verified?.recordState).toBe('VERIFIED');

    db.prepare('UPDATE real_esi_transaction_sync SET last_transaction_id = NULL, status = \'error\' WHERE character_id = ?')
      .run(CHARACTER_A);
    const second = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_A, { userId: USER_ID, chatId: CHAT_ID });

    expect(second).toMatchObject({ ok: true, lastTransactionId: 140 });
    const after = P93LedgerService.get(db as Db, CHARACTER_A, row.record_id);
    expect(after?.recordState).toBe('VERIFIED');
    expect(after?.verifiedAt).toBe(verified?.verifiedAt);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence_links').get()).toEqual({ n: 1 });
  });

  it('never reports a malformed batch as complete or advances past it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
      walletRow(130),
      { ...walletRow(131), transaction_id: undefined },
      walletRow(132, { is_buy: 'true' }),
    ])));

    const result = await P93EsiEvidenceService.syncWalletTransactions(db as Db, CHARACTER_A, { userId: USER_ID, chatId: CHAT_ID });

    expect(result).toMatchObject({ ok: false, errorCode: 'TRANSACTION_DATA_INVALID', lastTransactionId: null });
    expect(result.errors).toHaveLength(2);
    expect(db.prepare('SELECT source_ref FROM real_trade_records').all()).toEqual([{ source_ref: 'esi-wallet:130' }]);
    expect(db.prepare('SELECT status, last_transaction_id FROM real_esi_transaction_sync WHERE character_id = ?').get(CHARACTER_A))
      .toEqual({ status: 'error', last_transaction_id: null });
  });
});
