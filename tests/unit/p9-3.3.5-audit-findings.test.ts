import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { deleteCharacterData } from '../../src/db/character-datastore.js';
import { RealAssetSyncService } from '../../src/assets/asset-sync-service.js';
import { getCharacterDatasetStatuses, refreshCharacterDatasets } from '../../src/eve/character-sync.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { registerAssetRoutes } from '../../src/web/asset-routes.js';
import { assetLineagePredicate, resolveAssetLineage } from '../../src/assets/asset-lineage.js';
import { createWebSession, WEB_SESSION_COOKIE } from '../../src/web/web-session.js';
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

const USER_A = 9_756_001;
const USER_B = 9_756_002;
const CHARACTER_ID = 9_756_101;
const CHAT_A = 9_756_201;
const CTX = { userId: USER_A, chatId: CHAT_A, characterId: CHARACTER_ID };
const SCOPES = ['esi-assets.read_assets.v1'];
const OPEN_APPS: Array<ReturnType<typeof Fastify>> = [];

function createDb(): Db {
  const db = new Database(':memory:') as Db;
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  return db;
}

function linkCharacter(db: Db, userId = USER_A, chatId = CHAT_A): void {
  db.prepare('INSERT OR IGNORE INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(userId, `audit-user-${userId}`, CHARACTER_ID);
  db.prepare('INSERT OR IGNORE INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(chatId, `audit-chat-${chatId}`, CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, ?, 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET user_id = excluded.user_id, owner_hash = excluded.owner_hash,
      scopes_json = excluded.scopes_json, expires_at = excluded.expires_at
  `).run(CHARACTER_ID, 'Audit Pilot', JSON.stringify(SCOPES), userId, `owner-${userId}`);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(chatId, CHARACTER_ID, userId);
}

function assetRows(quantity: number, overrides: Record<string, unknown> = {}): unknown[] {
  return [{
    item_id: 98_001,
    type_id: 34,
    location_id: 60_003_760,
    location_type: 'station',
    location_flag: 'Hangar',
    quantity,
    is_singleton: false,
    is_blueprint_copy: false,
    ...overrides,
  }];
}

function response(rows: unknown[], pages: string | null = '1'): Response {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Expires: new Date(Date.now() + 3_600_000).toUTCString(),
  });
  if (pages !== null) headers.set('X-Pages', pages);
  return new Response(JSON.stringify(rows), { status: 200, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCapabilitySnapshots();
  for (const app of OPEN_APPS.splice(0)) void app.close();
});

describe('P9.3.3.5 independently reproduced audit findings', () => {
  it('F-P9335-01/FIXED: unlink/rebind forces a new lineage snapshot and restores the current mirror', async () => {
    const db = createDb();
    linkCharacter(db);
    vi.stubGlobal('fetch', vi.fn(async () => response(assetRows(4))));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual');
    expect(first.deduped).toBe(false);

    deleteCharacterData(db, CHARACTER_ID);
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(CHARACTER_ID)).toEqual({ n: 0 });
    db.prepare('DELETE FROM eve_character_links WHERE chat_id = ? AND character_id = ?').run(CHAT_A, CHARACTER_ID);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(CHAT_A, CHARACTER_ID, USER_A);

    const duplicate = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual');
    const currentLineage = resolveAssetLineage(db, CHARACTER_ID, USER_A, CHAT_A);
    const lineage = assetLineagePredicate(null, currentLineage);
    const mirror = db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?')
      .get(CHARACTER_ID) as { n: number };
    const latest = db.prepare(`
      SELECT snapshot_id, total_quantity FROM real_asset_snapshots
      WHERE character_id = ? AND is_latest = 1 AND ${lineage.sql}
    `).get(CHARACTER_ID, ...lineage.params) as { snapshot_id: string; total_quantity: number };

    expect(duplicate).toMatchObject({ deduped: false, itemsCommitted: 1 });
    expect(duplicate.snapshotId).not.toBe(first.snapshotId);
    expect(latest).toEqual({ snapshot_id: duplicate.snapshotId, total_quantity: 4 });
    expect(mirror.n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?')
      .get(CHARACTER_ID) as { n: number }).n).toBe(2);
    db.close();
  });

  it('F-P9335-02/FIXED: ownership transfer hides pre-transfer snapshot and item history from the new owner', async () => {
    const db = createDb();
    const firstSession = createWebSession(db);
    linkCharacter(db, firstSession.userId, firstSession.chatId);
    db.prepare(`
      INSERT INTO real_asset_snapshots
        (snapshot_id, character_id, job_id, started_at, completed_at, status,
         total_items, total_unique_types, total_locations, total_quantity, data_hash,
         hash_algorithm, canonical_version, source, is_latest)
      VALUES ('LEGACY-OWNER-SNAPSHOT', ?, NULL, datetime('now'), datetime('now'), 'COMPLETED',
              1, 1, 1, 100, 'legacy-owner-hash', 'sha256', 1, 'esi_character_assets', 1)
    `).run(CHARACTER_ID);
    db.prepare(`
      INSERT INTO real_asset_snapshot_items
        (snapshot_id, item_id, type_id, quantity, location_id, location_type,
         location_flag, is_singleton, is_blueprint_copy, parent_item_id, raw_json)
      VALUES ('LEGACY-OWNER-SNAPSHOT', 77, 34, 100, 60003760, 'station',
              'Hangar', 0, 0, NULL, '{}')
    `).run();

    const newSession = createWebSession(db);
    db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
    db.prepare('UPDATE eve_accounts SET user_id = ?, owner_hash = ? WHERE character_id = ?')
      .run(newSession.userId, 'owner-new', CHARACTER_ID);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(newSession.chatId, CHARACTER_ID, newSession.userId);
    deleteCharacterData(db, CHARACTER_ID);

    const app = Fastify({ bodyLimit: 64 * 1024 });
    OPEN_APPS.push(app);
    await app.register(fastifyCookie);
    registerAssetRoutes(app, db);
    const cookie = `${WEB_SESSION_COOKIE}=${newSession.sessionToken}`;
    const list = await app.inject({
      method: 'GET',
      url: `/api/web/assets/snapshots?characterId=${CHARACTER_ID}`,
      headers: { cookie },
    });
    const detail = await app.inject({
      method: 'GET',
      url: '/api/web/assets/snapshots/LEGACY-OWNER-SNAPSHOT',
      headers: { cookie },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ rows: [], total: 0 });
    expect(list.body).not.toContain('LEGACY-OWNER-SNAPSHOT');
    expect(detail.statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?').get(CHARACTER_ID)).toEqual({ n: 0 });
    db.close();
  });

  it('F-P9335-03/FIXED: generic character asset sync uses the generation/lease-fenced coordinator', async () => {
    const db = createDb();
    linkCharacter(db);
    vi.stubGlobal('fetch', vi.fn(async () => response(assetRows(4))));
    const coordinated = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual');
    db.prepare('DELETE FROM esi_cache').run();

    vi.stubGlobal('fetch', vi.fn(async () => response(assetRows(9))));
    const statuses = await refreshCharacterDatasets(db, CTX, ['assets']);
    const latest = db.prepare(`
      SELECT snapshot_id, total_quantity FROM real_asset_snapshots
      WHERE character_id = ? AND is_latest = 1
    `).get(CHARACTER_ID) as { snapshot_id: string; total_quantity: number };
    const mirror = db.prepare('SELECT quantity FROM character_assets WHERE character_id = ? AND item_id = 98001')
      .get(CHARACTER_ID) as { quantity: number };
    const jobs = db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_jobs WHERE character_id = ?')
      .get(CHARACTER_ID) as { n: number };

    expect(statuses).toContainEqual(expect.objectContaining({ dataset: 'assets', status: 'ok' }));
    expect(latest.total_quantity).toBe(9);
    expect(latest.snapshot_id).not.toBe(coordinated.snapshotId);
    expect(mirror.quantity).toBe(9);
    expect(jobs.n).toBe(2);
    db.close();
  });

  it('F-P9335-06/FIXED: malformed wallet-journal payload fails without replacing prior rows', async () => {
    const db = createDb();
    db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
      .run(USER_A, 'audit-user-wallet', CHARACTER_ID);
    db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
      .run(CHAT_A, 'audit-chat-wallet', CHARACTER_ID);
    db.prepare(`
      INSERT INTO eve_accounts
        (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
      VALUES (?, 'Audit Wallet', 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?, ?)
    `).run(CHARACTER_ID, JSON.stringify(['esi-wallet.read_character_wallet.v1']), USER_A, 'owner-wallet');
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(CHAT_A, CHARACTER_ID, USER_A);
    db.prepare(`
      INSERT INTO character_wallet_journal
        (character_id, journal_id, date, ref_type, amount, balance, first_party_id,
         second_party_id, description, context_id, context_id_type, data_json, synced_at)
      VALUES (?, 1, datetime('now'), 'player_donation', 10, 100, NULL, NULL,
              'existing-private-row', NULL, NULL, '{}', datetime('now'))
    `).run(CHARACTER_ID);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'malformed' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      },
    })));
    const statuses = await refreshCharacterDatasets(db, CTX, ['wallet_journal']);
    const state = getCharacterDatasetStatuses(db, CHARACTER_ID, ['wallet_journal'])[0];
    const rows = db.prepare('SELECT COUNT(*) AS n FROM character_wallet_journal WHERE character_id = ?')
      .get(CHARACTER_ID) as { n: number };

    expect(statuses).toContainEqual(expect.objectContaining({ dataset: 'wallet_journal', status: 'error' }));
    expect(state).toMatchObject({ dataset: 'wallet_journal', status: 'error' });
    expect(state.error).toContain('ESI');
    expect(rows.n).toBe(1);
    db.close();
  });
  it('F-P9335-04/FIXED: a paginated asset response without X-Pages is rejected without a snapshot', async () => {
    const db = createDb();
    linkCharacter(db);
    vi.stubGlobal('fetch', vi.fn(async () => response(assetRows(9), null)));
    await expect(RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/missing X-Pages/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?')
      .get(CHARACTER_ID) as { n: number }).n).toBe(0);
    db.close();
  });

  it('F-P9335-05/FIXED: aggregate asset quantity outside the safe-integer domain is rejected without a partial snapshot', async () => {
    const db = createDb();
    linkCharacter(db);
    const quantity = Number.MAX_SAFE_INTEGER;
    const rows = [
      ...assetRows(quantity, { item_id: 98_001 }),
      ...assetRows(quantity, { item_id: 98_002 }),
      ...assetRows(quantity, { item_id: 98_003 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => response(rows)));
    await expect(RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual'))
      .rejects.toThrow(/安全整数范围/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?')
      .get(CHARACTER_ID) as { n: number }).n).toBe(0);
    db.close();
  });

  it('transaction-error injection after mirror and latest/snapshot/job mutations preserves the prior complete state', async () => {
    const db = createDb();
    linkCharacter(db);
    vi.stubGlobal('fetch', vi.fn(async () => response(assetRows(4))));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual');

    const checks = [
      {
        trigger: `CREATE TRIGGER audit_fail_mirror BEFORE INSERT ON character_assets
          BEGIN SELECT RAISE(ABORT, 'audit fail after mirror delete'); END;`,
        drop: 'DROP TRIGGER audit_fail_mirror',
      },
      {
        trigger: `CREATE TRIGGER audit_fail_latest AFTER UPDATE OF is_latest ON real_asset_snapshots
          WHEN NEW.is_latest = 0
          BEGIN SELECT RAISE(ABORT, 'audit fail after latest clear'); END;`,
        drop: 'DROP TRIGGER audit_fail_latest',
      },
      {
        trigger: `CREATE TRIGGER audit_fail_complete BEFORE UPDATE OF status ON real_asset_sync_jobs
          WHEN OLD.status = 'RUNNING' AND NEW.status = 'COMPLETED'
          BEGIN SELECT RAISE(ABORT, 'audit fail before job completion'); END;`,
        drop: 'DROP TRIGGER audit_fail_complete',
      },
    ];

    for (const [index, check] of checks.entries()) {
      db.exec(check.trigger);
      vi.stubGlobal('fetch', vi.fn(async () => response(assetRows(10 + index))));
      await expect(RealAssetSyncService.syncCharacter(db, CHARACTER_ID, CTX, 'manual'))
        .rejects.toThrow(/audit fail/);
      const latest = db.prepare(`
        SELECT snapshot_id, total_quantity FROM real_asset_snapshots
        WHERE character_id = ? AND is_latest = 1
      `).get(CHARACTER_ID);
      const mirror = db.prepare('SELECT quantity FROM character_assets WHERE character_id = ? AND item_id = 98001')
        .get(CHARACTER_ID);
      expect(latest).toEqual({ snapshot_id: first.snapshotId, total_quantity: 4 });
      expect(mirror).toEqual({ quantity: 4 });
      db.exec(check.drop);
    }

    const lease = db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?')
      .get(CHARACTER_ID);
    expect(lease).toEqual({ n: 0 });
    db.close();
  });
});