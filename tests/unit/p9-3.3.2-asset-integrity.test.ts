import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { RealAssetSyncService } from '../../src/assets/asset-sync-service.js';
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

const USER_ID = 9321001;
const CHAT_ID = 9321101;
const CHARACTER_ID = 9321201;
const SCOPES = ['esi-assets.read_assets.v1', 'esi-wallet.read_character_wallet.v1'];
const CTX = { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID };
let db: Database.Database;
let snapshotSequence = 0;

function validAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  snapshotSequence += 1;
  return {
    item_id: 100 + snapshotSequence,
    type_id: 34,
    location_id: 60003760,
    location_type: 'station',
    location_flag: 'Hangar',
    quantity: 10,
    is_singleton: false,
    is_blueprint_copy: false,
    ...overrides,
  };
}

function response(payload: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      ...headers,
    },
  });
}

function singlePage(rows: unknown[]): Response {
  return response(rows, { 'X-Pages': '1' });
}

function paginated(pages: unknown[][], failPage?: number) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const requestedPage = Number(url.searchParams.get('page') || '1');
    if (requestedPage === failPage) return response({ error: 'injected final page failure' }, {}, 500);
    return response(pages[requestedPage - 1] ?? [], { 'X-Pages': String(pages.length) });
  });
}

function linkCharacter(): void {
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'Asset Integrity', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'asset-integrity', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Asset Integrity', 'asset-token', 'asset-refresh', datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_ID, JSON.stringify(SCOPES), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

function latestSnapshotId(): string {
  const row = db.prepare(
    'SELECT snapshot_id FROM real_asset_snapshots WHERE character_id = ? AND is_latest = 1',
  ).get(CHARACTER_ID) as { snapshot_id: string } | undefined;
  if (!row) throw new Error('latest snapshot missing');
  return row.snapshot_id;
}

async function seedValidSnapshot(): Promise<{ snapshotId: string; itemId: number }> {
  const asset = validAsset({ item_id: 7001, quantity: 7 });
  vi.stubGlobal('fetch', vi.fn(async () => singlePage([asset])));
  const result = await RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');
  return { snapshotId: result.snapshotId, itemId: 7001 };
}

function expectPriorSnapshotPreserved(snapshotId: string, itemId = 7001, quantity = 7): void {
  expect(latestSnapshotId()).toBe(snapshotId);
  expect(db.prepare('SELECT item_id, quantity FROM character_assets WHERE character_id = ?').all(CHARACTER_ID))
    .toEqual([{ item_id: itemId, quantity }]);
  expect(db.prepare(
    'SELECT status FROM real_asset_sync_jobs WHERE character_id = ? ORDER BY rowid DESC LIMIT 1',
  ).get(CHARACTER_ID)).toEqual({ status: 'FAILED' });
}

beforeEach(() => {
  clearCapabilitySnapshots();
  snapshotSequence = 0;
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

describe('P9.3.3.2 strict asset response validation', () => {
  const malformedCases: Array<{ label: string; rows: () => unknown[]; pattern: RegExp }> = [
    { label: 'string quantity', rows: () => [validAsset({ item_id: 7101, quantity: '10' })], pattern: /quantity/ },
    { label: 'zero quantity', rows: () => [validAsset({ item_id: 7102, quantity: 0 })], pattern: /quantity/ },
    { label: 'negative quantity', rows: () => [validAsset({ item_id: 7103, quantity: -1 })], pattern: /quantity/ },
    { label: 'fractional quantity', rows: () => [validAsset({ item_id: 7104, quantity: 1.5 })], pattern: /quantity/ },
    { label: 'NaN quantity', rows: () => [validAsset({ item_id: 7105, quantity: Number.NaN })], pattern: /quantity/ },
    { label: 'Infinity quantity', rows: () => [validAsset({ item_id: 7106, quantity: Number.POSITIVE_INFINITY })], pattern: /quantity/ },
    { label: 'zero item id', rows: () => [validAsset({ item_id: 0 })], pattern: /item_id/ },
    { label: 'invalid type id', rows: () => [validAsset({ item_id: 7107, type_id: -34 })], pattern: /type_id/ },
    { label: 'invalid location id', rows: () => [validAsset({ item_id: 7108, location_id: 0 })], pattern: /location_id/ },
    { label: 'string singleton boolean', rows: () => [validAsset({ item_id: 7109, is_singleton: 'false' })], pattern: /is_singleton/ },
    { label: 'string blueprint-copy boolean', rows: () => [validAsset({ item_id: 7110, is_blueprint_copy: 'true' })], pattern: /is_blueprint_copy/ },
    { label: 'missing location flag', rows: () => [validAsset({ item_id: 7111, location_flag: undefined })], pattern: /location_flag/ },
    { label: 'duplicate item id', rows: () => [validAsset({ item_id: 7112 }), validAsset({ item_id: 7112 })], pattern: /重复/ },
  ];

  it.each(malformedCases)('rejects $label and preserves the previous complete snapshot', async ({ rows, pattern }) => {
    const previous = await seedValidSnapshot();
    db.prepare('DELETE FROM esi_cache').run();
    vi.stubGlobal('fetch', vi.fn(async () => singlePage(rows())));

    await expect(RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(pattern);
    expectPriorSnapshotPreserved(previous.snapshotId);
  });

  it('rejects a malformed second page without replacing the old snapshot', async () => {
    const previous = await seedValidSnapshot();
    db.prepare('DELETE FROM esi_cache').run();
    vi.stubGlobal('fetch', paginated([
      [validAsset({ item_id: 7201, quantity: 2 })],
      [validAsset({ item_id: 7202, quantity: null })],
    ]));

    await expect(RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/quantity/);
    expectPriorSnapshotPreserved(previous.snapshotId);
  });

  it('does not commit a partial page walk when the final page request fails', async () => {
    const previous = await seedValidSnapshot();
    db.prepare('DELETE FROM esi_cache').run();
    vi.stubGlobal('fetch', paginated([
      [validAsset({ item_id: 7301, quantity: 2 })],
      [validAsset({ item_id: 7302, quantity: 3 })],
    ], 2));

    await expect(RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow();
    expectPriorSnapshotPreserved(previous.snapshotId);
  });

  it('rolls back the snapshot transaction on a database commit failure', async () => {
    const previous = await seedValidSnapshot();
    db.prepare('DELETE FROM esi_cache').run();
    vi.stubGlobal('fetch', vi.fn(async () => singlePage([
      validAsset({ item_id: 7401, quantity: 9 }),
    ])));
    db.exec(`
      CREATE TRIGGER reject_asset_snapshot_item
      BEFORE INSERT ON real_asset_snapshot_items
      BEGIN
        SELECT RAISE(ABORT, 'injected asset transaction failure');
      END;
    `);

    await expect(RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/injected asset transaction failure/);
    expectPriorSnapshotPreserved(previous.snapshotId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 1 });
  });
});
