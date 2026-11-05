import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { deleteCharacterData } from '../../../src/db/character-datastore.js';
import type { Db } from '../../../src/db/sqlite.js';
import { clearCapabilitySnapshots } from '../../../src/eve/capabilities.js';
import { P93EsiEvidenceService } from '../../../src/trading/p9-3-evidence-service.js';

vi.mock('../../../src/config.js', () => ({
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

const USER_A = 9_833_711;
const CHAT_A = 9_833_721;
const USER_B = 9_833_712;
const CHAT_B = 9_833_722;
const CHARACTER_ID = 9_833_731;
const LOCATION_ID = 60_003_760;
const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1';

let db: Db;

function walletResponse(transactionId: number): Response {
  return new Response(JSON.stringify([{
    transaction_id: transactionId,
    date: '2026-09-01T00:00:00Z',
    type_id: 34,
    quantity: 1,
    unit_price: 100,
    is_buy: true,
    location_id: LOCATION_ID,
  }]), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      'X-Pages': '1',
    },
  });
}

function createPrincipal(userId: number, chatId: number): void {
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, NULL)')
    .run(userId, `Pilot ${userId}`);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, NULL)')
    .run(chatId, `chat-${chatId}`);
}

function linkOwner(userId: number, chatId: number, ownerHash: string): void {
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at,
       scopes_json, user_id, owner_hash)
    VALUES (?, 'Ownership Cursor Pilot', 'access-token', 'refresh-token',
            datetime('now', '+1 hour'), ?, ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET
      user_id = excluded.user_id,
      owner_hash = excluded.owner_hash,
      scopes_json = excluded.scopes_json,
      expires_at = excluded.expires_at
  `).run(CHARACTER_ID, JSON.stringify([WALLET_SCOPE]), userId, ownerHash);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(CHARACTER_ID, userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?').run(CHARACTER_ID, chatId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(chatId, CHARACTER_ID, userId);
}

function transferOwnershipToB(): void {
  db.prepare('UPDATE users SET active_character_id = NULL WHERE user_id = ?').run(USER_A);
  db.prepare('UPDATE telegram_sessions SET active_character_id = NULL WHERE chat_id = ?').run(CHAT_A);
  db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
  linkOwner(USER_B, CHAT_B, 'owner-b-new-hash');
  deleteCharacterData(db, CHARACTER_ID);
}

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  createPrincipal(USER_A, CHAT_A);
  createPrincipal(USER_B, CHAT_B);
  linkOwner(USER_A, CHAT_A, 'owner-a-old-hash');
});

afterEach(() => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

describe('P9.3.3.7 wallet cursor ownership audit', () => {
  it('F-P9337-05 (FIXED): an ownership change uses an isolated cursor and imports the new owner\'s lower transaction ID', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => walletResponse(101)));
    const first = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, {
      userId: USER_A,
      chatId: CHAT_A,
      characterId: CHARACTER_ID,
    });
    expect(first).toMatchObject({ ok: true, imported: 1, skipped: 0, lastTransactionId: 101 });
    expect(db.prepare('SELECT last_transaction_id FROM real_esi_transaction_sync WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ last_transaction_id: 101 });

    transferOwnershipToB();
    vi.stubGlobal('fetch', vi.fn(async () => walletResponse(100)));
    const second = await P93EsiEvidenceService.syncWalletTransactions(db, CHARACTER_ID, {
      userId: USER_B,
      chatId: CHAT_B,
      characterId: CHARACTER_ID,
    });

    expect(second).toMatchObject({ ok: true, imported: 1, skipped: 0, lastTransactionId: 100 });
    expect(db.prepare(`
      SELECT source_ref, owner_chat_id
      FROM real_trade_records WHERE character_id = ?
      ORDER BY source_ref
    `).all(CHARACTER_ID)).toEqual([
      { source_ref: 'esi-wallet:100', owner_chat_id: CHAT_B },
      { source_ref: 'esi-wallet:101', owner_chat_id: CHAT_A },
    ]);
    expect(db.prepare(`
      SELECT owner_chat_id, last_transaction_id
      FROM real_esi_transaction_sync
      WHERE character_id = ? AND owner_user_id = ?
      ORDER BY owner_chat_id
    `).all(CHARACTER_ID, USER_A)).toEqual([
      { owner_chat_id: CHAT_A, last_transaction_id: 101 },
    ]);
    expect(db.prepare(`
      SELECT owner_chat_id, last_transaction_id
      FROM real_esi_transaction_sync
      WHERE character_id = ? AND owner_user_id = ?
      ORDER BY owner_chat_id
    `).all(CHARACTER_ID, USER_B)).toEqual([
      { owner_chat_id: CHAT_B, last_transaction_id: 100 },
    ]);
  });
});
