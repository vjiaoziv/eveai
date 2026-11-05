import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import type { Db } from '../../src/db/sqlite.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { getCharacterDatasetStatuses, refreshCharacterDatasets } from '../../src/eve/character-sync.js';

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
      intervalMinutes: 60,
      staleJobMinutes: 30,
      leaseTtlSeconds: 180,
      heartbeatSeconds: 45,
    },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720, sessionCreationWindowSeconds: 60, maxSessionCreationsPerWindow: 100 },
  },
}));

const CHARACTER_ID = 90003001;
const USER_ID = 701;
const CHAT_ID = 1701;
const SCOPES = ['esi-wallet.read_character_wallet.v1', 'esi-assets.read_assets.v1'];
let db: Database.Database;

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

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'Profile Pilot', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'profile-pilot', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Profile Pilot', 'token-profile', 'refresh-profile', datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_ID, JSON.stringify(SCOPES), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
});

afterEach(() => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

describe('P9.3.3 character profile sync integrity', () => {
  it.each([
    ['quantity 为零', { quantity: 0 }, 'quantity'],
    ['location_type 为空', { location_type: '' }, 'location_type'],
    ['location_type 不在 ESI 枚举内', { location_type: 'container' }, 'location_type'],
    ['缺少 location_flag', { location_flag: undefined }, 'location_flag'],
    ['is_singleton 不是 boolean', { is_singleton: 'false' }, 'is_singleton'],
    ['is_blueprint_copy 为 null', { is_blueprint_copy: null }, 'is_blueprint_copy'],
  ])('拒绝 %s 的资产行且不写入部分镜像', async (_label, override, expectedField) => {
    const invalidRow = {
      item_id: 10,
      type_id: 34,
      location_id: 60003760,
      location_type: 'station',
      location_flag: 'Hangar',
      quantity: 10,
      is_singleton: false,
      ...override,
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([invalidRow])));

    const result = await refreshCharacterDatasets(
      db as Db,
      { userId: USER_ID, chatId: CHAT_ID },
      ['assets'],
    );

    expect(result[0]).toMatchObject({ dataset: 'assets', status: 'error' });
    expect(result[0]?.error).toContain(expectedField);
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 0 });
  });

  it('rejects an invalid wallet balance, preserves the last valid balance, and records a separate error state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(1234.5)));
    const first = await refreshCharacterDatasets(db as Db, { userId: USER_ID, chatId: CHAT_ID }, ['wallet']);
    expect(first[0]).toMatchObject({ dataset: 'wallet', status: 'ok', rows_synced: 1 });
    const before = db.prepare('SELECT balance, synced_at FROM character_wallet WHERE character_id = ?').get(CHARACTER_ID) as any;
    expect(before.balance).toBe(1234.5);

    db.prepare('DELETE FROM esi_cache').run();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('not-a-number')));
    const second = await refreshCharacterDatasets(db as Db, { userId: USER_ID, chatId: CHAT_ID }, ['wallet']);

    expect(second[0]).toMatchObject({ dataset: 'wallet', status: 'error', synced_at: before.synced_at });
    expect(second[0]?.error).toContain('钱包余额响应不是有限数值');
    expect(db.prepare('SELECT balance, synced_at FROM character_wallet WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual(before);
    expect(db.prepare('SELECT status, synced_at FROM character_sync_state WHERE character_id = ? AND dataset = ?').get(CHARACTER_ID, 'wallet'))
      .toEqual({ status: 'error', synced_at: before.synced_at });
  });

  it('validates the entire asset response before replacing the last valid mirror', async () => {
    const firstAsset = {
      item_id: 1,
      type_id: 34,
      location_id: 60003760,
      location_type: 'station',
      location_flag: 'Hangar',
      quantity: 10,
      is_singleton: false,
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([firstAsset])));
    const first = await refreshCharacterDatasets(db as Db, { userId: USER_ID, chatId: CHAT_ID }, ['assets']);
    expect(first[0]).toMatchObject({ dataset: 'assets', status: 'ok', rows_synced: 1 });

    db.prepare('DELETE FROM esi_cache').run();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
      { ...firstAsset, item_id: 2, quantity: 999 },
      { item_id: 3, location_id: 60003760, quantity: 1, is_singleton: false },
    ])));
    const second = await refreshCharacterDatasets(db as Db, { userId: USER_ID, chatId: CHAT_ID }, ['assets']);

    expect(second[0]).toMatchObject({ dataset: 'assets', status: 'error' });
    expect(second[0]?.error).toContain('type_id');
    expect(db.prepare('SELECT item_id, quantity FROM character_assets WHERE character_id = ?').all(CHARACTER_ID))
      .toEqual([{ item_id: 1, quantity: 10 }]);
    expect(getCharacterDatasetStatuses(db as Db, CHARACTER_ID, ['assets'])[0]).toMatchObject({ status: 'error' });
  });
});
