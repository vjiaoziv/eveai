import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { clearCapabilitySnapshots } from '../../../src/eve/capabilities.js';
import { refreshCharacterDatasets } from '../../../src/eve/character-sync.js';
import type { Db } from '../../../src/db/sqlite.js';

vi.mock('../../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    eve: {
      clientId: 'test-client', clientSecret: 'test-secret',
      callbackUrl: 'http://localhost:3000/auth/eve/callback', requestTimeoutMs: 5000,
    },
    esi: {
      baseUrl: 'https://esi.evetech.net/latest/', specUrl: 'https://esi.evetech.net/latest/swagger.json',
      catalogCachePath: './data/cache/esi-swagger.json', compatibilityDate: '2026-03-15',
      userAgent: 'EVEAI/4.0 (+https://github.com/example/eveai; contact=operator@example.com)',
      maxPages: 5, backoffMaxSeconds: 1, requestTimeoutMs: 5000, retryMaxAttempts: 1,
    },
    characterSync: { maxPages: 50, fallbackTtlSeconds: 3600, errorRetrySeconds: 120 },
    assetSync: { enabled: true, intervalMinutes: 30, staleJobMinutes: 30, leaseTtlSeconds: 180, heartbeatSeconds: 45 },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' }, sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720, sessionCreationWindowSeconds: 60, maxSessionCreationsPerWindow: 100 },
  },
}));

const USER_ID = 9_942_001;
const CHAT_ID = 9_942_101;
const CHARACTER_ID = 9_942_201;
const WALLET = 'esi-wallet.read_character_wallet.v1';
const ASSETS = 'esi-assets.read_assets.v1';
const LOCATION_ID = 60_003_760;
const ctx = { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID };
let db: Db;

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

function asset(itemId: number, quantity = 1): Record<string, unknown> {
  return {
    item_id: itemId, type_id: 34, location_id: LOCATION_ID,
    location_type: 'station', location_flag: 'Hangar', quantity,
    is_singleton: false, is_blueprint_copy: false,
  };
}

function link(scopes: string[]): void {
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'P9339 character sync', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'p9339-character-sync', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'P9339 Character Sync', 'access', 'refresh', datetime('now', '+1 hour'), ?, ?, 'owner-p9339-sync')
  `).run(CHARACTER_ID, JSON.stringify(scopes), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  link([WALLET, ASSETS]);
});

afterEach(() => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

describe('P9.3.3.9 independent character datastore integrity', () => {
  it('preserves last-known-good wallet balance and separates failure state from last sync time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(1_234.5)));
    const good = await refreshCharacterDatasets(db, ctx, ['wallet']);
    expect(good[0]).toMatchObject({ dataset: 'wallet', status: 'ok' });
    const before = db.prepare('SELECT balance, synced_at FROM character_wallet WHERE character_id = ?')
      .get(CHARACTER_ID) as { balance: number; synced_at: string };

    db.prepare('DELETE FROM esi_cache').run();
    vi.stubGlobal('fetch', vi.fn(async () => response('1,234.5')));
    const bad = await refreshCharacterDatasets(db, ctx, ['wallet']);
    expect(bad[0]).toMatchObject({ dataset: 'wallet', status: 'error' });
    expect(db.prepare('SELECT balance, synced_at FROM character_wallet WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual(before);
    expect(db.prepare('SELECT status, synced_at FROM character_sync_state WHERE character_id = ? AND dataset = ?')
      .get(CHARACTER_ID, 'wallet')).toEqual({ status: 'error', synced_at: before.synced_at });

    db.prepare('DELETE FROM esi_cache').run();
    vi.stubGlobal('fetch', vi.fn(async () => response(0)));
    const recovered = await refreshCharacterDatasets(db, ctx, ['wallet']);
    expect(recovered[0]).toMatchObject({ dataset: 'wallet', status: 'ok' });
    expect(db.prepare('SELECT balance FROM character_wallet WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ balance: 0 });
  });

  it('validates the entire asset payload before atomically replacing the previous mirror', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([asset(8_001, 4)])));
    const good = await refreshCharacterDatasets(db, ctx, ['assets']);
    expect(good[0]).toMatchObject({ dataset: 'assets', status: 'ok' });
    const oldSnapshot = db.prepare(`
      SELECT snapshot_id, status, is_latest FROM real_asset_snapshots
      WHERE character_id = ? AND is_latest = 1
    `).get(CHARACTER_ID) as { snapshot_id: string; status: string; is_latest: number };
    const oldMirror = db.prepare('SELECT item_id, quantity, binding_digest FROM character_assets WHERE character_id = ?')
      .all(CHARACTER_ID);

    vi.stubGlobal('fetch', vi.fn(async () => response([asset(8_002, 1), asset(8_003, 0)])));
    const bad = await refreshCharacterDatasets(db, ctx, ['assets']);
    expect(bad[0]).toMatchObject({ dataset: 'assets', status: 'error' });
    expect(db.prepare('SELECT item_id, quantity, binding_digest FROM character_assets WHERE character_id = ?')
      .all(CHARACTER_ID)).toEqual(oldMirror);
    expect(db.prepare('SELECT snapshot_id, status, is_latest FROM real_asset_snapshots WHERE character_id = ? AND is_latest = 1')
      .get(CHARACTER_ID)).toEqual(oldSnapshot);
    expect(db.prepare('SELECT status FROM character_sync_state WHERE character_id = ? AND dataset = ?')
      .get(CHARACTER_ID, 'assets')).toEqual({ status: 'error' });
  });

  it('does not turn a non-array wallet journal response into an empty successful journal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([{
      id: 1, date: '2026-09-01T00:00:00Z', ref_type: 'market_transaction',
      amount: -10, balance: 90, description: 'valid first row',
    }])));
    const good = await refreshCharacterDatasets(db, ctx, ['wallet_journal']);
    expect(good[0]).toMatchObject({ dataset: 'wallet_journal', status: 'ok' });
    const before = db.prepare('SELECT journal_id, amount FROM character_wallet_journal WHERE character_id = ?').all(CHARACTER_ID);

    db.prepare('DELETE FROM esi_cache').run();
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'not an array' })));
    const bad = await refreshCharacterDatasets(db, ctx, ['wallet_journal']);
    expect(bad[0]).toMatchObject({ dataset: 'wallet_journal', status: 'error' });
    expect(db.prepare('SELECT journal_id, amount FROM character_wallet_journal WHERE character_id = ?').all(CHARACTER_ID))
      .toEqual(before);
  });
});
