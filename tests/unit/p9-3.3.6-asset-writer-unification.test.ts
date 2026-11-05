import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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

const USER_ID = 9_767_001;
const CHAT_ID = 9_767_101;
const CHARACTER_ID = 9_767_201;
const SCOPE = 'esi-assets.read_assets.v1';
const CTX = { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID };

let db: Db;

function assetRows(quantity: number): unknown[] {
  return [
    {
      item_id: 98_101,
      type_id: 34,
      location_id: 60_003_760,
      location_type: 'station',
      location_flag: 'Hangar',
      quantity,
      is_singleton: false,
      is_blueprint_copy: false,
    },
    {
      item_id: 98_102,
      type_id: 35,
      location_id: 60_003_760,
      location_type: 'station',
      location_flag: 'Hangar',
      quantity: 2,
      is_singleton: false,
      is_blueprint_copy: false,
    },
  ];
}

function response(quantity: number): Response {
  return new Response(JSON.stringify(assetRows(quantity)), {
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
    .run(USER_ID, 'Writer Unification', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'writer-unification', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'Writer Pilot', 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?, 'owner-writer')
  `).run(CHARACTER_ID, JSON.stringify([SCOPE]), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

function listTsFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listTsFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:') as Db;
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

describe('P9.3.3.6 real-asset writer unification', () => {
  it('routes the generic character asset dataset through the coordinator and leaves one consistent mirror/latest/job result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(9)));

    const statuses = await refreshCharacterDatasets(db, CTX, ['assets']);
    const job = db.prepare(`
      SELECT job_id, trigger, status, snapshot_id, items_committed
      FROM real_asset_sync_jobs
      WHERE character_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).get(CHARACTER_ID) as {
      job_id: string;
      trigger: string;
      status: string;
      snapshot_id: string;
      items_committed: number;
    };
    const latest = db.prepare(`
      SELECT snapshot_id, total_quantity, total_items
      FROM real_asset_snapshots
      WHERE character_id = ? AND is_latest = 1
    `).get(CHARACTER_ID) as { snapshot_id: string; total_quantity: number; total_items: number };
    const mirror = db.prepare(`
      SELECT item_id, quantity FROM character_assets
      WHERE character_id = ? ORDER BY item_id
    `).all(CHARACTER_ID);

    expect(statuses).toContainEqual(expect.objectContaining({ dataset: 'assets', status: 'ok' }));
    expect(job).toMatchObject({
      trigger: 'auto',
      status: 'COMPLETED',
      snapshot_id: latest.snapshot_id,
      items_committed: 2,
    });
    expect(latest).toMatchObject({ total_quantity: 11, total_items: 2 });
    expect(mirror).toEqual([
      { item_id: 98_101, quantity: 9 },
      { item_id: 98_102, quantity: 2 },
    ]);
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_snapshot_items WHERE snapshot_id = ?
    `).get(latest.snapshot_id)).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
  });

  it('has no runtime character_assets mutation outside RealAssetSyncService', () => {
    const srcRoot = join(process.cwd(), 'src');
    const writePattern = /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|DELETE\s+FROM|UPDATE)\s+character_assets\b/gi;
    const writers = listTsFiles(srcRoot)
      .map((file) => {
        const text = readFileSync(file, 'utf8');
        return { file: relative(process.cwd(), file).replaceAll('\\', '/'), matches: text.match(writePattern) ?? [] };
      })
      .filter((entry) => entry.matches.length > 0);

    expect(writers).toEqual([
      { file: 'src/assets/asset-sync-service.ts', matches: expect.any(Array) },
    ]);
    expect(writers[0].matches.every((statement) => /character_assets\b/.test(statement))).toBe(true);
  });

  it('does not let the generic adapter report ok when the coordinator rejects an incomplete response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{
      item_id: 98_101,
      type_id: 34,
      location_id: 60_003_760,
      location_type: 'station',
      location_flag: 'Hangar',
      quantity: 1,
      is_singleton: false,
      is_blueprint_copy: false,
    }]), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      },
    })));

    const statuses = await refreshCharacterDatasets(db, CTX, ['assets']);
    expect(statuses).toContainEqual(expect.objectContaining({ dataset: 'assets', status: 'error' }));
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
    expect(db.prepare(`
      SELECT status FROM real_asset_sync_jobs
      WHERE character_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).get(CHARACTER_ID)).toEqual({ status: 'FAILED' });
  });
});

