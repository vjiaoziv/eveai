import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { RealAssetSyncService } from '../../src/assets/asset-sync-service.js';
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
    assetSync: { enabled: true, intervalMinutes: 30, staleJobMinutes: 30 },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720 },
  },
}));

const USER_ID = 811;
const CHAT_ID = 1811;
const CHARACTER_ID = 93110001;
const CTX = { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID };
const SCOPES = ['esi-assets.read_assets.v1', 'esi-wallet.read_character_wallet.v1'];

let db: Database.Database;

function validAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: 1,
    type_id: 34,
    location_id: 42424242,
    location_type: 'station',
    location_flag: 'Hangar',
    quantity: 10,
    is_singleton: false,
    is_blueprint_copy: false,
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
    .run(USER_ID, 'Audit Pilot', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'audit-pilot', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Audit Pilot', 'audit-token', 'audit-refresh', datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_ID, JSON.stringify(SCOPES), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
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

describe('P9.3.3.1 independent asset-integrity audit', () => {
  it('rejects quantity=0 instead of normalizing it to one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([validAsset({ quantity: 0 })])));

    await expect(RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/quantity/i);

    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 0 });
  });

  it('rejects string booleans instead of silently converting them to false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([
      validAsset({ is_singleton: 'false', is_blueprint_copy: 'true' }),
    ])));

    await expect(RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/is_singleton|is_blueprint_copy/i);

    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 0 });
  });

  it('rejects non-positive item/type/location identifiers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([
      validAsset({ item_id: 0, type_id: -1, location_id: -60003760 }),
    ])));

    await expect(RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/item_id|type_id|location_id/i);

    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 0 });
  });
  it('rejects a negative wallet balance and preserves the last known good balance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(1234.5)));
    const first = await refreshCharacterDatasets(
      db as Db,
      { userId: USER_ID, chatId: CHAT_ID },
      ['wallet'],
    );
    expect(first[0]).toMatchObject({ dataset: 'wallet', status: 'ok', rows_synced: 1 });
    const before = db.prepare('SELECT balance, synced_at FROM character_wallet WHERE character_id = ?').get(CHARACTER_ID) as any;
    expect(before.balance).toBe(1234.5);

    db.prepare('DELETE FROM esi_cache').run();
    vi.stubGlobal('fetch', vi.fn(async () => response(-1)));
    const second = await refreshCharacterDatasets(
      db as Db,
      { userId: USER_ID, chatId: CHAT_ID },
      ['wallet'],
    );

    expect(second[0]).toMatchObject({ dataset: 'wallet', status: 'error', synced_at: before.synced_at });
    expect(db.prepare('SELECT balance, synced_at FROM character_wallet WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual(before);
  });

});
