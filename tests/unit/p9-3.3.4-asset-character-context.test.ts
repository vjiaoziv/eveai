import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { RealAssetSyncService } from '../../src/assets/asset-sync-service.js';
import type { Db } from '../../src/db/sqlite.js';

const tokenMock = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
}));

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

vi.mock('../../src/eve/sso.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/eve/sso.js')>();
  return { ...actual, getAccessToken: tokenMock.getAccessToken };
});

const USER_ID = 9_745_001;
const CHARACTER_ID = 9_745_101;
const OTHER_CHARACTER_ID = 9_745_102;
const CHAT_ID = 9_745_201;
const ASSET_SCOPE = 'esi-assets.read_assets.v1';

let db: Db;
let fetchMock: ReturnType<typeof vi.fn>;

function response(): Response {
  return new Response(JSON.stringify([{
    item_id: 98_001,
    type_id: 34,
    location_id: 60_003_760,
    location_type: 'station',
    location_flag: 'Hangar',
    quantity: 5,
    is_singleton: false,
    is_blueprint_copy: false,
  }]), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      'X-Pages': '1',
    },
  });
}

function linkCharacter(characterId: number, scopes = [ASSET_SCOPE], chatId = CHAT_ID): void {
  db.prepare('INSERT OR IGNORE INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'context-pilot', characterId);
  db.prepare('INSERT OR IGNORE INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(chatId, 'context-pilot', characterId);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, ?, 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?, ?)
  `).run(characterId, `Pilot ${characterId}`, JSON.stringify(scopes), USER_ID, `owner-${characterId}`);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(chatId, characterId, USER_ID);
}

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:') as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  fetchMock = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  tokenMock.getAccessToken.mockReset();
  tokenMock.getAccessToken.mockImplementation(async () => ({
    token: 'character-bound-token',
    characterId: CHARACTER_ID,
  }));
});

afterEach(() => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

describe('P9.3.3.4 pinned character and token context', () => {
  it('T13: target characterId contradicting the pinned context is rejected before any side effect', async () => {
    linkCharacter(CHARACTER_ID);
    linkCharacter(OTHER_CHARACTER_ID, [ASSET_SCOPE], CHAT_ID + 1);

    await expect(RealAssetSyncService.syncCharacter(
      db,
      OTHER_CHARACTER_ID,
      { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID },
      'manual',
    )).rejects.toThrow(/上下文|characterId|角色/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_jobs').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets').get()).toEqual({ n: 0 });
  });

  it('T14: a token belonging to another character is rejected before job creation or ESI dispatch', async () => {
    linkCharacter(CHARACTER_ID);
    tokenMock.getAccessToken.mockResolvedValue({
      token: 'wrong-character-token',
      characterId: OTHER_CHARACTER_ID,
    });

    await expect(RealAssetSyncService.syncCharacter(
      db,
      CHARACTER_ID,
      { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID },
      'manual',
    )).rejects.toThrow(/Access Token|不属于目标角色/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_jobs').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets').get()).toEqual({ n: 0 });
  });

  it('rejects a missing asset scope with an actionable reauthorization error', async () => {
    linkCharacter(CHARACTER_ID, ['esi-wallet.read_character_wallet.v1']);

    await expect(RealAssetSyncService.syncCharacter(
      db,
      CHARACTER_ID,
      { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID },
      'manual',
    )).rejects.toThrow(/esi-assets\.read_assets\.v1.*重新授权/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_jobs').get()).toEqual({ n: 0 });
  });

  it('rebuilds an absent capability snapshot instead of trusting prior process state', async () => {
    linkCharacter(CHARACTER_ID);
    clearCapabilitySnapshots();

    const result = await RealAssetSyncService.syncCharacter(
      db,
      CHARACTER_ID,
      { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID },
      'manual',
    );

    expect(result.job.status).toBe('COMPLETED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the target pinned when the user switches their active character during the request', async () => {
    linkCharacter(CHARACTER_ID);
    linkCharacter(OTHER_CHARACTER_ID, [ASSET_SCOPE], CHAT_ID + 1);
    db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(OTHER_CHARACTER_ID, USER_ID);
    db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?').run(OTHER_CHARACTER_ID, CHAT_ID);

    const result = await RealAssetSyncService.syncCharacter(
      db,
      CHARACTER_ID,
      { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID },
      'manual',
    );

    const [url, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit | undefined];
    expect(String(url)).toContain(`/characters/${CHARACTER_ID}/assets`);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(result.job.characterId).toBe(CHARACTER_ID);
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(OTHER_CHARACTER_ID))
      .toEqual({ n: 0 });
  });
});