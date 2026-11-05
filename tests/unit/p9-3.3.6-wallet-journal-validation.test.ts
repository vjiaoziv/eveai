import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { refreshCharacterDatasets } from '../../src/eve/character-sync.js';
import type { Db } from '../../src/db/sqlite.js';

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
    assetSync: {
      enabled: false,
      intervalMinutes: 30,
      staleJobMinutes: 30,
      leaseTtlSeconds: 180,
      heartbeatSeconds: 45,
    },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720 },
  },
}));

const USER_ID = 9_756_001;
const CHAT_ID = 9_756_101;
const CHARACTER_ID = 9_756_201;
const CTX = { userId: USER_ID, chatId: CHAT_ID };
let db: Database.Database;

function journalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    date: '2026-11-04T00:00:00Z',
    ref_type: 'player_donation',
    amount: 10,
    balance: 100,
    first_party_id: null,
    second_party_id: null,
    description: 'valid journal row',
    context_id: null,
    context_id_type: null,
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
    .run(USER_ID, 'Wallet Journal Integrity', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'wallet-journal-integrity', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Journal Pilot', 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_ID, JSON.stringify(['esi-wallet.read_character_wallet.v1']), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
  db.prepare(`
    INSERT INTO character_wallet_journal
      (character_id, journal_id, date, ref_type, amount, balance, first_party_id,
       second_party_id, description, context_id, context_id_type, data_json, synced_at)
    VALUES (?, 999, '2020-01-01T00:00:00Z', 'player_donation', 5, 95, NULL,
            NULL, 'last-known-good', NULL, NULL, '{}', '2026-01-01 00:00:00')
  `).run(CHARACTER_ID);
}

function storedRows(): Array<{ journal_id: number; description: string }> {
  return db.prepare(`
    SELECT journal_id, description FROM character_wallet_journal
    WHERE character_id = ? ORDER BY journal_id
  `).all(CHARACTER_ID) as Array<{ journal_id: number; description: string }>;
}

async function refreshWith(payload: unknown): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(async () => response(payload)));
  await refreshCharacterDatasets(db as Db, CTX, ['wallet_journal']);
}

async function establishLastSuccess(): Promise<string> {
  await refreshWith([journalRow({ id: 2, description: 'established success' })]);
  const state = db.prepare(`
    SELECT synced_at FROM character_sync_state
    WHERE character_id = ? AND dataset = 'wallet_journal'
  `).get(CHARACTER_ID) as { synced_at: string };
  db.prepare('DELETE FROM esi_cache').run();
  return state.synced_at;
}

function expectErrorPreserved(syncedAt: string): void {
  expect(storedRows()).toEqual([
    { journal_id: 2, description: 'established success' },
    { journal_id: 999, description: 'last-known-good' },
  ]);
  expect(db.prepare(`
    SELECT status, synced_at, error FROM character_sync_state
    WHERE character_id = ? AND dataset = 'wallet_journal'
  `).get(CHARACTER_ID)).toMatchObject({ status: 'error', synced_at: syncedAt });
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

describe('P9.3.3.6 wallet journal response validation', () => {
  it.each([
    ['object', { rows: [] }],
    ['null', null],
    ['string', 'not-an-array'],
  ])('marks a non-array %s response as error and preserves last-known-good rows', async (_label, payload) => {
    const syncedAt = await establishLastSuccess();
    await refreshWith(payload);
    expectErrorPreserved(syncedAt);
  });

  it('accepts a legal empty array without deleting historical journal rows', async () => {
    await refreshWith([]);
    expect(storedRows()).toEqual([{ journal_id: 999, description: 'last-known-good' }]);
    expect(db.prepare(`
      SELECT status, rows_synced FROM character_sync_state
      WHERE character_id = ? AND dataset = 'wallet_journal'
    `).get(CHARACTER_ID)).toEqual({ status: 'ok', rows_synced: 0 });
  });

  it.each([
    ['missing id', [journalRow({ id: undefined })]],
    ['string transaction id', [journalRow({ id: '1' })]],
    ['zero transaction id', [journalRow({ id: 0 })]],
    ['missing type', [journalRow({ ref_type: undefined })]],
    ['missing amount', [journalRow({ amount: undefined })]],
    ['string amount', [journalRow({ amount: '10' })]],
    ['invalid date', [journalRow({ date: 'not-a-date' })]],
    ['mixed valid and invalid rows', [journalRow({ id: 3 }), journalRow({ id: 4, amount: null })]],
  ])('rejects %s as one atomic batch', async (_label, payload) => {
    const syncedAt = await establishLastSuccess();
    await refreshWith(payload);
    expectErrorPreserved(syncedAt);
  });

  it('rolls back all rows when an upsert fails midway', async () => {
    const syncedAt = await establishLastSuccess();
    db.exec(`
      CREATE TRIGGER reject_wallet_journal_upsert
      BEFORE INSERT ON character_wallet_journal
      WHEN NEW.journal_id = 4
      BEGIN
        SELECT RAISE(ABORT, 'injected journal upsert failure');
      END;
    `);
    await refreshWith([journalRow({ id: 3 }), journalRow({ id: 4 })]);
    expectErrorPreserved(syncedAt);
    expect(db.prepare(`
      SELECT error FROM character_sync_state
      WHERE character_id = ? AND dataset = 'wallet_journal'
    `).get(CHARACTER_ID)).toMatchObject({ error: expect.stringContaining('injected journal upsert failure') });
  });
});
