import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { clearCapabilitySnapshots } from '../../../src/eve/capabilities.js';
import { RealAssetSyncService } from '../../../src/assets/asset-sync-service.js';
import { assetLineagePredicate, readAssetBindingSnapshot } from '../../../src/assets/asset-lineage.js';
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

const USER_ID = 9_939_001;
const CHAT_ID = 9_939_101;
const CHARACTER_ID = 9_939_201;
const ASSET_SCOPE = 'esi-assets.read_assets.v1';
const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1';
const LOCATION_ID = 60_003_760;
const ctx = { userId: USER_ID, chatId: CHAT_ID, characterId: CHARACTER_ID };

let db: Db;

function asset(itemId: number, quantity = 1): Record<string, unknown> {
  return {
    item_id: itemId,
    type_id: 34,
    location_id: LOCATION_ID,
    location_type: 'station',
    location_flag: 'Hangar',
    quantity,
    is_singleton: false,
    is_blueprint_copy: false,
  };
}

function response(payload: unknown[]): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      'X-Pages': '1',
    },
  });
}

function linkCharacter(scopes: string[]): void {
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'P9339 lineage audit', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'p9339-lineage-audit', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id, owner_hash)
    VALUES (?, 'P9339 Pilot', 'access', 'refresh', datetime('now', '+1 hour'), ?, ?, 'owner-p9339')
  `).run(CHARACTER_ID, JSON.stringify(scopes), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

beforeEach(() => {
  clearCapabilitySnapshots();
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  linkCharacter([ASSET_SCOPE]);
});

afterEach(() => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

describe('P9.3.3.9 adversarial asset lineage and scope refresh', () => {
  it('keeps one authoritative latest snapshot when a harmless stored-scope addition changes the digest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([asset(1001, 1)])));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx, 'manual');

    const firstSnapshot = db.prepare(`
      SELECT snapshot_id, binding_digest, is_latest
      FROM real_asset_snapshots WHERE character_id = ?
    `).get(CHARACTER_ID) as { snapshot_id: string; binding_digest: string; is_latest: number };
    expect(firstSnapshot.snapshot_id).toBe(first.snapshotId);
    expect(firstSnapshot.is_latest).toBe(1);

    // This is a normal OAuth scope refresh: ownership, chat binding and epoch
    // are unchanged, but the exact authorization digest necessarily changes.
    db.prepare('UPDATE eve_accounts SET scopes_json = ? WHERE character_id = ?')
      .run(JSON.stringify([ASSET_SCOPE, WALLET_SCOPE]), CHARACTER_ID);

    vi.stubGlobal('fetch', vi.fn(async () => response([asset(1002, 2)])));
    const second = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx, 'manual');

    const snapshots = db.prepare(`
      SELECT snapshot_id, binding_digest, is_latest, status
      FROM real_asset_snapshots WHERE character_id = ? ORDER BY completed_at, snapshot_id
    `).all(CHARACTER_ID) as Array<{ snapshot_id: string; binding_digest: string; is_latest: number; status: string }>;
    const latest = snapshots.filter((row) => row.is_latest === 1);
    const mirror = db.prepare(`
      SELECT item_id, quantity, binding_digest FROM character_assets
      WHERE character_id = ? ORDER BY item_id
    `).all(CHARACTER_ID) as Array<{ item_id: number; quantity: number; binding_digest: string }>;

    expect(snapshots).toHaveLength(2);
    expect(latest).toHaveLength(1);
    expect(latest[0].snapshot_id).toBe(second.snapshotId);
    expect(latest[0].status).toBe('COMPLETED');
    expect(latest[0].binding_digest).not.toBe(firstSnapshot.binding_digest);
    expect(mirror).toEqual([{ item_id: 1002, quantity: 2, binding_digest: latest[0].binding_digest }]);
  });

  it('records the current broken state after a scope-triggered digest refresh fails', async () => {
    const originalBinding = readAssetBindingSnapshot(db, CHARACTER_ID, ctx, true);
    vi.stubGlobal('fetch', vi.fn(async () => response([asset(1001, 1)])));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx, 'manual');

    db.prepare('UPDATE eve_accounts SET scopes_json = ? WHERE character_id = ?')
      .run(JSON.stringify([ASSET_SCOPE, WALLET_SCOPE]), CHARACTER_ID);
    const refreshedBinding = readAssetBindingSnapshot(db, CHARACTER_ID, ctx, true);
    expect(refreshedBinding.digest).not.toBe(originalBinding.digest);

    vi.stubGlobal('fetch', vi.fn(async () => response([asset(1002, 2)])));
    let failure: unknown;
    try {
      await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx, 'manual');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('UNIQUE constraint failed');

    const failedJob = db.prepare(`
      SELECT status, last_error FROM real_asset_sync_jobs
      WHERE character_id = ? AND status = 'FAILED'
      ORDER BY started_at DESC LIMIT 1
    `).get(CHARACTER_ID) as { status: string; last_error: string } | undefined;
    expect(failedJob).toMatchObject({ status: 'FAILED' });
    expect(failedJob?.last_error).toContain('UNIQUE constraint failed');

    const retainedLatest = db.prepare(`
      SELECT snapshot_id, binding_digest, is_latest FROM real_asset_snapshots
      WHERE character_id = ? AND is_latest = 1
    `).get(CHARACTER_ID);
    expect(retainedLatest).toEqual({
      snapshot_id: first.snapshotId,
      binding_digest: originalBinding.digest,
      is_latest: 1,
    });

    const refreshedPredicate = assetLineagePredicate(null, {
      ownerUserId: refreshedBinding.userId,
      ownerChatId: refreshedBinding.chatId,
      bindingEpoch: refreshedBinding.bindingEpoch,
      bindingDigest: refreshedBinding.digest,
    });
    const visibleSnapshot = db.prepare(`
      SELECT snapshot_id FROM real_asset_snapshots
      WHERE character_id = ? AND status = 'COMPLETED' AND is_latest = 1
        AND ${refreshedPredicate.sql}
      LIMIT 1
    `).get(CHARACTER_ID, ...refreshedPredicate.params);
    const visibleMirror = db.prepare(`
      SELECT item_id, quantity FROM character_assets
      WHERE character_id = ? AND ${refreshedPredicate.sql}
      ORDER BY item_id
    `).all(CHARACTER_ID, ...refreshedPredicate.params);
    expect(visibleSnapshot).toBeUndefined();
    expect(visibleMirror).toEqual([]);

    const retainedMirror = db.prepare(`
      SELECT item_id, quantity FROM character_assets
      WHERE character_id = ? AND binding_digest = ?
      ORDER BY item_id
    `).all(CHARACTER_ID, originalBinding.digest);
    expect(retainedMirror).toEqual([{ item_id: 1001, quantity: 1 }]);
  });
});