import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { deleteCharacterData } from '../../src/db/character-datastore.js';
import { getCharacterDatasetStatuses, refreshCharacterDatasets } from '../../src/eve/character-sync.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
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
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720, sessionCreationWindowSeconds: 60, maxSessionCreationsPerWindow: 1000 },
    auth: { secretKey: 'audit-test-secret' },
  },
}));

const USER_A = 9_756_601;
const USER_B = 9_756_602;
const CHARACTER_ID = 9_756_701;
const CHAT_A = 9_756_801;
const CHAT_B = 9_756_802;
const CTX_A = { userId: USER_A, chatId: CHAT_A, characterId: CHARACTER_ID };
const SCOPES = ['esi-assets.read_assets.v1'];

function createDb(): Db {
  const db = new Database(':memory:') as Db;
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  return db;
}

function insertIdentity(db: Db, userId: number, chatId: number, suffix: string): void {
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(userId, `stale-${suffix}`, CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(chatId, `stale-chat-${suffix}`, CHARACTER_ID);
}

function linkOwnerA(db: Db): void {
  insertIdentity(db, USER_A, CHAT_A, 'a');
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'Stale Asset Pilot', 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?, 'owner-a')
  `).run(CHARACTER_ID, JSON.stringify(SCOPES), USER_A);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_A, CHARACTER_ID, USER_A);
}

function assetResponse(quantity: number): Response {
  return new Response(JSON.stringify([{
    item_id: 98_001,
    type_id: 34,
    location_id: 60_003_760,
    location_type: 'station',
    location_flag: 'Hangar',
    quantity,
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

afterEach(() => {
  clearCapabilitySnapshots();
  vi.unstubAllGlobals();
});

describe('P9.3.3.5 generic asset sync binding fence', () => {
  it('FIXED: an in-flight old-owner generic asset refresh is rejected after unlink/rebind', async () => {
    const db = createDb();
    linkOwnerA(db);

    let releaseFetch!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      if (url.includes(`/characters/${CHARACTER_ID}/assets`)) {
        markEntered();
        await gate;
      }
      return assetResponse(9);
    }));

    const refresh = refreshCharacterDatasets(db, CTX_A, ['assets']);
    await entered;

    deleteCharacterData(db, CHARACTER_ID);
    db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
    insertIdentity(db, USER_B, CHAT_B, 'b');
    db.prepare("UPDATE eve_accounts SET user_id = ?, owner_hash = 'owner-b' WHERE character_id = ?")
      .run(USER_B, CHARACTER_ID);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(CHAT_B, CHARACTER_ID, USER_B);

    releaseFetch();
    const statuses = await refresh;
    const mirror = db.prepare(`
      SELECT quantity FROM character_assets WHERE character_id = ? AND item_id = 98001
    `).get(CHARACTER_ID) as { quantity: number } | undefined;
    const owner = db.prepare('SELECT user_id FROM eve_accounts WHERE character_id = ?')
      .get(CHARACTER_ID) as { user_id: number };
    const state = getCharacterDatasetStatuses(db, CHARACTER_ID, ['assets'])[0];
    const snapshots = db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?')
      .get(CHARACTER_ID) as { n: number };
    const jobs = db.prepare(`
      SELECT COUNT(*) AS n, MAX(status) AS status FROM real_asset_sync_jobs WHERE character_id = ?
    `).get(CHARACTER_ID) as { n: number; status: string | null };
    db.close();

    expect(statuses).toContainEqual(expect.objectContaining({ dataset: 'assets', status: 'error' }));
    expect(owner.user_id).toBe(USER_B);
    expect(mirror).toBeUndefined();
    expect(state).toMatchObject({ dataset: 'assets', status: 'error', rows_synced: 0 });
    expect(state.error).toContain('所有权');
    expect(snapshots.n).toBe(0);
    expect(jobs).toEqual({ n: 1, status: 'FAILED' });
  });
});