import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { RealAssetSyncService } from '../../src/assets/asset-sync-service.js';
import { getCharacterDatasetStatuses, refreshCharacterDatasets } from '../../src/eve/character-sync.js';
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
      enabled: true,
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

const USER_ID = 9_736_001;
const CHAT_ID = 9_736_101;
const CHARACTER_ID = 9_736_201;
const SCOPE = 'esi-assets.read_assets.v1';
const CTX = { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID };

let db: Database.Database;

function assetRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: 86_001,
    type_id: 34,
    location_id: 60_003_760,
    location_type: 'station',
    location_flag: 'Hangar',
    quantity: 7,
    is_singleton: false,
    is_blueprint_copy: false,
    ...overrides,
  };
}

function response(payload: unknown, pages: string | null): Response {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Expires: new Date(Date.now() + 3_600_000).toUTCString(),
  });
  if (pages !== null) headers.set('X-Pages', pages);
  return new Response(JSON.stringify(payload), { status: 200, headers });
}

function linkCharacter(): void {
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'Pagination Integrity', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'pagination-integrity', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Pagination Integrity', 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_ID, JSON.stringify([SCOPE]), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

async function seedPriorSnapshot(): Promise<string> {
  vi.stubGlobal('fetch', vi.fn(async () => response([assetRow({ quantity: 4 })], '1')));
  const result = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');
  return result.snapshotId;
}

function latestSnapshotId(): string | null {
  const row = db.prepare(`
    SELECT snapshot_id FROM real_asset_snapshots
    WHERE character_id = ? AND is_latest = 1
  `).get(CHARACTER_ID) as { snapshot_id: string } | undefined;
  return row?.snapshot_id ?? null;
}

function expectPriorState(snapshotId: string): void {
  expect(latestSnapshotId()).toBe(snapshotId);
  expect(db.prepare('SELECT quantity FROM character_assets WHERE character_id = ?').all(CHARACTER_ID))
    .toEqual([{ quantity: 4 }]);
  expect(db.prepare(`
    SELECT status FROM real_asset_sync_jobs
    WHERE character_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(CHARACTER_ID)).toEqual({ status: 'FAILED' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?')
    .get(CHARACTER_ID)).toEqual({ n: 0 });
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

describe('P9.3.3.6 strict pagination metadata', () => {
  const invalidHeaders: Array<{ label: string; pages: string | null; pattern: RegExp }> = [
    { label: 'missing X-Pages', pages: null, pattern: /missing X-Pages/ },
    { label: 'empty X-Pages', pages: '', pattern: /positive integer/ },
    { label: 'nonnumeric X-Pages', pages: 'abc', pattern: /positive integer/ },
    { label: 'NaN X-Pages', pages: 'NaN', pattern: /positive integer/ },
    { label: 'Infinity X-Pages', pages: 'Infinity', pattern: /positive integer/ },
    { label: 'zero X-Pages', pages: '0', pattern: /positive integer/ },
    { label: 'negative X-Pages', pages: '-1', pattern: /positive integer/ },
    { label: 'fractional X-Pages', pages: '1.5', pattern: /positive integer/ },
    { label: 'over-budget X-Pages', pages: '51', pattern: /exceeds configured/ },
  ];

  it.each(invalidHeaders)('rejects $label and preserves the prior complete snapshot', async ({ pages, pattern }) => {
    const prior = await seedPriorSnapshot();
    db.prepare('DELETE FROM esi_cache').run();
    vi.stubGlobal('fetch', vi.fn(async () => response([assetRow({ quantity: 9 })], pages)));

    await expect(RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(pattern);
    expectPriorState(prior);
  });

  it('records a dataset error rather than ok when generic asset refresh sees invalid pagination', async () => {
    const prior = await seedPriorSnapshot();
    db.prepare('DELETE FROM esi_cache').run();
    vi.stubGlobal('fetch', vi.fn(async () => response([assetRow({ quantity: 9 })], null)));

    const statuses = await refreshCharacterDatasets(db as Db, CTX, ['assets']);
    expect(statuses).toContainEqual(expect.objectContaining({ dataset: 'assets', status: 'error' }));
    expect(getCharacterDatasetStatuses(db as Db, CHARACTER_ID, ['assets'])[0])
      .toMatchObject({ dataset: 'assets', status: 'error' });
    expect(latestSnapshotId()).toBe(prior);
  });
});
