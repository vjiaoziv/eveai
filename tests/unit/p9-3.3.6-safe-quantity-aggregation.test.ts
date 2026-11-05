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

const USER_ID = 9_746_001;
const CHAT_ID = 9_746_101;
const CHARACTER_ID = 9_746_201;
const CTX = { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID };
let db: Database.Database;
let sequence = 0;

function row(quantity: unknown, itemId?: number): Record<string, unknown> {
  sequence += 1;
  return {
    item_id: itemId ?? 87_000 + sequence,
    type_id: 34,
    location_id: 60_003_760,
    location_type: 'station',
    location_flag: 'Hangar',
    quantity,
    is_singleton: false,
    is_blueprint_copy: false,
  };
}

function response(rows: unknown[]): Response {
  return new Response(JSON.stringify(rows), {
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
    .run(USER_ID, 'Quantity Integrity', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'quantity-integrity', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Quantity Integrity', 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_ID, JSON.stringify(['esi-assets.read_assets.v1']), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

async function sync(rows: unknown[]): Promise<Awaited<ReturnType<typeof RealAssetSyncService.syncCharacter>>> {
  vi.stubGlobal('fetch', vi.fn(async () => response(rows)));
  return RealAssetSyncService.syncCharacter(db as Db, CHARACTER_ID, CTX, 'manual');
}

async function seedPrior(): Promise<string> {
  return (await sync([row(4, 87_001)])).snapshotId;
}

function expectPriorState(snapshotId: string): void {
  const latest = db.prepare(`
    SELECT snapshot_id, total_quantity FROM real_asset_snapshots
    WHERE character_id = ? AND is_latest = 1
  `).get(CHARACTER_ID) as { snapshot_id: string; total_quantity: number };
  expect(latest).toEqual({ snapshot_id: snapshotId, total_quantity: 4 });
  expect(db.prepare('SELECT item_id, quantity FROM character_assets WHERE character_id = ?').all(CHARACTER_ID))
    .toEqual([{ item_id: 87_001, quantity: 4 }]);
  expect(db.prepare(`
    SELECT status FROM real_asset_sync_jobs
    WHERE character_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(CHARACTER_ID)).toEqual({ status: 'FAILED' });
}

beforeEach(() => {
  clearCapabilitySnapshots();
  sequence = 0;
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

describe('P9.3.3.6 safe asset quantity aggregation', () => {
  it('accepts a single maximum-safe quantity', async () => {
    const result = await sync([row(Number.MAX_SAFE_INTEGER, 87_101)]);
    const snapshot = db.prepare(`
      SELECT total_quantity FROM real_asset_snapshots WHERE snapshot_id = ?
    `).get(result.snapshotId) as { total_quantity: number };
    expect(snapshot.total_quantity).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects two-row and multi-row sums that exceed the safe-integer domain', async () => {
    const prior = await seedPrior();
    db.prepare('DELETE FROM esi_cache').run();
    await expect(sync([
      row(Number.MAX_SAFE_INTEGER, 87_201),
      row(1, 87_202),
    ])).rejects.toThrow(/安全整数范围/);
    expectPriorState(prior);

    db.prepare('DELETE FROM esi_cache').run();
    await expect(sync([
      row(Number.MAX_SAFE_INTEGER, 87_301),
      row(Number.MAX_SAFE_INTEGER, 87_302),
      row(Number.MAX_SAFE_INTEGER, 87_303),
    ])).rejects.toThrow(/安全整数范围/);
    expectPriorState(prior);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['positive Infinity', Number.POSITIVE_INFINITY],
    ['string number', '1'],
  ])('rejects a %s quantity and leaves the mirror/latest unchanged', async (_label, quantity) => {
    const prior = await seedPrior();
    db.prepare('DELETE FROM esi_cache').run();
    await expect(sync([row(quantity, 87_401)])).rejects.toThrow(/quantity/);
    expectPriorState(prior);
  });
});
