import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import type { Db } from '../../src/db/sqlite.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { refreshCharacterDatasets } from '../../src/eve/character-sync.js';

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
    assetSync: { enabled: false, intervalMinutes: 60 },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720 },
  },
}));

const USER_ID = 9323001;
const CHAT_ID = 9323101;
const CHARACTER_ID = 9323201;
const SCOPE = 'esi-wallet.read_character_wallet.v1';
let db: Database.Database;

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
    .run(USER_ID, 'Balance Audit', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'balance-audit', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Balance Audit', 'balance-token', 'balance-refresh', datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_ID, JSON.stringify([SCOPE]), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

async function syncWallet(payload: unknown) {
  db.prepare('DELETE FROM esi_cache').run();
  vi.stubGlobal('fetch', vi.fn(async () => response(payload)));
  return refreshCharacterDatasets(db as Db, { userId: USER_ID, chatId: CHAT_ID }, ['wallet']);
}

function storedWallet(): { balance: number; synced_at: string } {
  return db.prepare('SELECT balance, synced_at FROM character_wallet WHERE character_id = ?')
    .get(CHARACTER_ID) as { balance: number; synced_at: string };
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

describe('P9.3.3.2 wallet balance data integrity', () => {
  it('preserves the last known good balance for every invalid numeric shape', async () => {
    const seed = await syncWallet(1234.5);
    expect(seed[0]).toMatchObject({ dataset: 'wallet', status: 'ok' });
    const before = storedWallet();

    const invalidValues: unknown[] = ['1234.5', -1, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, {}];
    for (const invalid of invalidValues) {
      const result = await syncWallet(invalid);
      expect(result[0]).toMatchObject({ dataset: 'wallet', status: 'error', synced_at: before.synced_at });
      expect(storedWallet()).toEqual(before);
      expect(db.prepare(
        'SELECT status, synced_at FROM character_sync_state WHERE character_id = ? AND dataset = ?',
      ).get(CHARACTER_ID, 'wallet')).toEqual({ status: 'error', synced_at: before.synced_at });
    }
  });

  it('accepts zero as a valid balance and recovers after a later successful response', async () => {
    expect((await syncWallet(100))[0]).toMatchObject({ dataset: 'wallet', status: 'ok' });
    expect((await syncWallet('invalid'))[0]).toMatchObject({ dataset: 'wallet', status: 'error' });

    const zero = await syncWallet(0);
    expect(zero[0]).toMatchObject({ dataset: 'wallet', status: 'ok' });
    expect(storedWallet().balance).toBe(0);
    expect(db.prepare(
      'SELECT status FROM character_sync_state WHERE character_id = ? AND dataset = ?',
    ).get(CHARACTER_ID, 'wallet')).toEqual({ status: 'ok' });

    const recovered = await syncWallet(4321.25);
    expect(recovered[0]).toMatchObject({ dataset: 'wallet', status: 'ok' });
    expect(storedWallet().balance).toBe(4321.25);
  });
});
