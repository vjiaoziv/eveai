import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { deleteCharacterData } from '../../../src/db/character-datastore.js';
import { clearCapabilitySnapshots } from '../../../src/eve/capabilities.js';
import {
  EsiWalletTransactionValidationError,
  normalizeEsiWalletTransaction,
  P93EsiEvidenceService,
} from '../../../src/trading/p9-3-evidence-service.js';
import type { Db } from '../../../src/db/sqlite.js';

vi.mock('../../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    auth: { secretKey: 'p9337-wallet-audit-secret' },
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

const USER_A = 9_834_711;
const CHAT_A = 9_834_721;
const USER_B = 9_834_712;
const CHAT_B = 9_834_722;
const CHARACTER_ID = 9_834_731;
const LOCATION_ID = 60_003_760;
const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1';

let db: Db;

function walletRow(transactionId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function walletResponse(rows: unknown[], pages = '1'): Response {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      'X-Pages': pages,
    },
  });
}

function createPrincipal(userId: number, chatId: number): void {
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, NULL)')
    .run(userId, `Wallet Audit ${userId}`);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, NULL)')
    .run(chatId, `wallet-audit-${chatId}`);
}

function linkOwner(userId: number, chatId: number, ownerHash: string, scopes: string[] = [WALLET_SCOPE]): void {
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at,
       scopes_json, user_id, owner_hash)
    VALUES (?, 'Wallet Audit Pilot', 'access-token', 'refresh-token',
            datetime('now', '+1 hour'), ?, ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET
      user_id = excluded.user_id,
      owner_hash = excluded.owner_hash,
      scopes_json = excluded.scopes_json,
      expires_at = excluded.expires_at
  `).run(CHARACTER_ID, JSON.stringify(scopes), userId, ownerHash);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(CHARACTER_ID, userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?').run(CHARACTER_ID, chatId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(chatId, CHARACTER_ID, userId);
}

function transferToB(): void {
  db.prepare('UPDATE users SET active_character_id = NULL WHERE user_id = ?').run(USER_A);
  db.prepare('UPDATE telegram_sessions SET active_character_id = NULL WHERE chat_id = ?').run(CHAT_A);
  db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
  linkOwner(USER_B, CHAT_B, 'wallet-owner-b');
  deleteCharacterData(db, CHARACTER_ID);
}

function ctxA() {
  return { userId: USER_A, chatId: CHAT_A, characterId: CHARACTER_ID };
}

function cursorRow(): unknown {
  return db.prepare('SELECT last_transaction_id, status FROM real_esi_transaction_sync WHERE character_id = ?')
    .get(CHARACTER_ID);
}

function count(table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE character_id = ?`)
    .get(CHARACTER_ID) as { n: number }).n);
}

function countEvidenceLinks(): number {
  return Number((db.prepare(`
    SELECT COUNT(*) AS n
    FROM real_trade_evidence_links l
    JOIN real_trade_evidence e ON e.evidence_id = l.evidence_id
    WHERE e.character_id = ?
  `).get(CHARACTER_ID) as { n: number }).n);
}

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  createPrincipal(USER_A, CHAT_A);
  createPrincipal(USER_B, CHAT_B);
  linkOwner(USER_A, CHAT_A, 'wallet-owner-a');
});

afterEach(() => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

describe('P9.3.3.7 strict wallet transaction boundary', () => {
  it.each([
    ['string is_buy', { is_buy: 'false' }, /is_buy/],
    ['string transaction_id', { transaction_id: '10' }, /transaction_id/],
    ['zero transaction_id', { transaction_id: 0 }, /transaction_id/],
    ['fractional type_id', { type_id: 1.5 }, /type_id/],
    ['zero quantity', { quantity: 0 }, /quantity/],
    ['infinite unit_price', { unit_price: Number.POSITIVE_INFINITY }, /unit_price/],
    ['invalid date', { date: 'not-a-date' }, /date/],
    ['missing location_id', { location_id: undefined }, /location_id/],
  ])('rejects %s instead of coercing it', (_label, overrides, pattern) => {
    expect(() => normalizeEsiWalletTransaction({
      ...walletRow(10),
      ...overrides,
    })).toThrow(EsiWalletTransactionValidationError);
    expect(() => normalizeEsiWalletTransaction({
      ...walletRow(10),
      ...overrides,
    })).toThrow(pattern);
  });

  it('rebuilds capabilities and refuses a character without wallet scope before any network call', async () => {
    db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
    db.prepare('UPDATE eve_accounts SET scopes_json = ? WHERE character_id = ?')
      .run(JSON.stringify([]), CHARACTER_ID);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(CHAT_A, CHARACTER_ID, USER_A);
    const fetchMock = vi.fn(async () => walletResponse([walletRow(10)]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, ctxA());
    expect(result).toMatchObject({ ok: false, status: 'error', errorCode: 'WALLET_SCOPE_MISSING' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(count('real_trade_records')).toBe(0);
    expect(cursorRow()).toEqual({ last_transaction_id: null, status: 'error' });
  });
});

describe('P9.3.3.7 wallet cursor and retry integrity', () => {
  it('does not cross a failed transaction 100 when 101 succeeds, then retries idempotently', async () => {
    db.exec(`
      CREATE TRIGGER p9337_fail_wallet_100
      BEFORE INSERT ON real_trade_records
      WHEN NEW.source_ref = 'esi-wallet:100'
      BEGIN SELECT RAISE(ABORT, 'p9337 transaction 100 failure'); END;
    `);
    vi.stubGlobal('fetch', vi.fn(async () => walletResponse([walletRow(100), walletRow(101)])));
    const first = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, ctxA());

    expect(first).toMatchObject({
      ok: false,
      status: 'error',
      imported: 1,
      lastTransactionId: null,
      errorCode: 'TRANSACTION_IMPORT_FAILED',
    });
    expect(db.prepare('SELECT source_ref FROM real_trade_records WHERE character_id = ?')
      .all(CHARACTER_ID)).toEqual([{ source_ref: 'esi-wallet:101' }]);
    expect(cursorRow()).toEqual({ last_transaction_id: null, status: 'error' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_esi_transaction_failures WHERE character_id = ? AND transaction_id = 100')
      .get(CHARACTER_ID)).toEqual({ n: 1 });

    db.exec('DROP TRIGGER p9337_fail_wallet_100');
    const second = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, ctxA());
    expect(second).toMatchObject({ ok: true, imported: 2, lastTransactionId: 101 });
    expect(cursorRow()).toEqual({ last_transaction_id: 101, status: 'ok' });
    expect(count('real_trade_records')).toBe(2);
    expect(count('real_trade_evidence')).toBe(2);
    expect(countEvidenceLinks()).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_esi_transaction_failures WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });

    const third = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, ctxA());
    expect(third).toMatchObject({ ok: true, imported: 0, skipped: 2, lastTransactionId: 101 });
    expect(count('real_trade_records')).toBe(2);
    expect(count('real_trade_evidence')).toBe(2);
    expect(countEvidenceLinks()).toBe(2);
  });

  it('keeps the cursor unchanged when one row in a batch is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => walletResponse([
      walletRow(201),
      walletRow(202, { type_id: undefined }),
    ])));
    const result = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, ctxA());

    expect(result).toMatchObject({
      ok: false,
      status: 'error',
      imported: 1,
      lastTransactionId: null,
      errorCode: 'TRANSACTION_DATA_INVALID',
    });
    expect(db.prepare('SELECT source_ref FROM real_trade_records WHERE character_id = ?')
      .all(CHARACTER_ID)).toEqual([{ source_ref: 'esi-wallet:201' }]);
    expect(cursorRow()).toEqual({ last_transaction_id: null, status: 'error' });
    expect(db.prepare('SELECT transaction_id, error_code FROM real_esi_transaction_failures WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ transaction_id: 202, error_code: 'TRANSACTION_DATA_INVALID' });
  });

  it('rejects an over-budget wallet page set without committing records or a cursor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => walletResponse([walletRow(301)], '11')));
    const result = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, ctxA());

    expect(result).toMatchObject({
      ok: false,
      status: 'error',
      imported: 0,
      lastTransactionId: null,
      errorCode: 'ESI_REQUEST_FAILED',
    });
    expect(count('real_trade_records')).toBe(0);
    expect(cursorRow()).toEqual({ last_transaction_id: null, status: 'error' });
  });

  it('fences an ownership transfer that occurs while the wallet fetch is in flight', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      transferToB();
      return walletResponse([walletRow(401)]);
    }));
    const result = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, ctxA());

    expect(result).toMatchObject({
      ok: false,
      status: 'error',
      imported: 0,
      lastTransactionId: null,
      errorCode: 'IDENTITY_CHANGED',
    });
    expect(count('real_trade_records')).toBe(0);
    expect(cursorRow()).toEqual({ last_transaction_id: null, status: 'error' });
  });
});