import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { deleteCharacterData } from '../../../src/db/character-datastore.js';
import { clearCapabilitySnapshots } from '../../../src/eve/capabilities.js';
import { RealAssetSyncService } from '../../../src/assets/asset-sync-service.js';
import { resolveAssetLineage } from '../../../src/assets/asset-lineage.js';
import { getCharacterDatasetStatuses, refreshCharacterDatasets } from '../../../src/eve/character-sync.js';
import { runAssetSyncWorkerTick } from '../../../src/assets/asset-sync-worker.js';
import { registerAssetRoutes } from '../../../src/web/asset-routes.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
  type CreatedWebSession,
} from '../../../src/web/web-session.js';
import type { Db } from '../../../src/db/sqlite.js';

vi.mock('../../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    auth: { secretKey: 'p9337-historical-audit-secret' },
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
      leaseTtlSeconds: 3,
      heartbeatSeconds: 1,
    },
    marketSnapshot: { staleMinutes: 30, majorMinPages: 5, majorIntervalMinutes: 60, minorIntervalMinutes: 15 },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: {
      baseUrl: 'http://localhost:3000',
      sessionTtlHours: 720,
      sessionCreationWindowSeconds: 60,
      maxSessionCreationsPerWindow: 1000,
    },
  },
}));

const CHARACTER_ID = 9_834_701;
const LOCATION_ID = 60_003_760;
const ASSET_SCOPE = 'esi-assets.read_assets.v1';
const WALLET_JOURNAL_SCOPE = 'esi-wallet.read_character_wallet.v1';
const OPEN_APPS: Array<ReturnType<typeof Fastify>> = [];
let db: Db;

function assetRow(itemId: number, quantity: number, typeId = 34): Record<string, unknown> {
  return {
    item_id: itemId,
    type_id: typeId,
    location_id: LOCATION_ID,
    location_type: 'station',
    location_flag: 'Hangar',
    quantity,
    is_singleton: false,
    is_blueprint_copy: false,
  };
}

function assetResponse(
  rows: unknown[] = [assetRow(984_001, 5)],
  pages: string | null = '1',
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Expires: new Date(Date.now() + 3_600_000).toUTCString(),
  });
  if (pages !== null) headers.set('X-Pages', pages);
  return new Response(JSON.stringify(rows), { status: 200, headers });
}

function journalRow(id: number, description = `audit-journal-${id}`): Record<string, unknown> {
  return {
    id,
    date: '2026-09-01T00:00:00Z',
    ref_type: 'player_donation',
    amount: 10,
    balance: 100,
    description,
    first_party_id: null,
    second_party_id: null,
    context_id: null,
    context_id_type: null,
  };
}

function linkSession(
  session: CreatedWebSession,
  scopes: string[] = [ASSET_SCOPE],
  ownerHash = `owner-${session.userId}`,
): void {
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at,
       scopes_json, user_id, owner_hash)
    VALUES (?, 'P9.3.3.7 Historical Pilot', 'access-token', 'refresh-token',
            datetime('now', '+1 hour'), ?, ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET
      scopes_json = excluded.scopes_json,
      user_id = excluded.user_id,
      owner_hash = excluded.owner_hash,
      expires_at = excluded.expires_at
  `).run(CHARACTER_ID, JSON.stringify(scopes), session.userId, ownerHash);
  db.prepare(`
    INSERT INTO eve_character_links (chat_id, character_id, user_id)
    VALUES (?, ?, ?)
  `).run(session.chatId, CHARACTER_ID, session.userId);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?')
    .run(CHARACTER_ID, session.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
    .run(CHARACTER_ID, session.chatId);
}

function transferOwnership(
  from: CreatedWebSession,
  to: CreatedWebSession,
  scopes: string[] = [ASSET_SCOPE],
): void {
  db.prepare('UPDATE users SET active_character_id = NULL WHERE user_id = ?').run(from.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = NULL WHERE chat_id = ?').run(from.chatId);
  db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
  linkSession(to, scopes, `owner-transfer-${to.userId}`);
  deleteCharacterData(db, CHARACTER_ID);
}

function ctx(session: CreatedWebSession) {
  return { userId: session.userId, chatId: session.chatId, characterId: CHARACTER_ID };
}

function headers(session: CreatedWebSession): { cookie: string } {
  return { cookie: `${WEB_SESSION_COOKIE}=${session.sessionToken}` };
}

async function makeAssetApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ bodyLimit: 64 * 1024 });
  OPEN_APPS.push(app);
  await app.register(fastifyCookie);
  registerAssetRoutes(app, db);
  return app;
}

function latestSnapshot(session: CreatedWebSession): { snapshot_id: string; total_quantity: number } {
  const lineage = resolveAssetLineage(db, CHARACTER_ID, session.userId, session.chatId);
  return db.prepare(`
    SELECT snapshot_id, total_quantity
    FROM real_asset_snapshots
    WHERE character_id = ? AND status = 'COMPLETED' AND is_latest = 1
      AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ? AND binding_digest = ?
    LIMIT 1
  `).get(
    CHARACTER_ID,
    lineage.ownerUserId,
    lineage.ownerChatId,
    lineage.bindingEpoch,
    lineage.bindingDigest,
  ) as { snapshot_id: string; total_quantity: number };
}

function insertStaleRunningJob(session: CreatedWebSession): void {
  const lineage = resolveAssetLineage(db, CHARACTER_ID, session.userId, session.chatId);
  db.prepare(`
    INSERT INTO real_asset_sync_jobs
      (job_id, character_id, trigger, status, phase, generation,
       owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       account_owner_hash, started_at, source)
    VALUES ('P9337-STALE-RUNNING', ?, 'auto', 'RUNNING', 'fetch', 1,
            ?, ?, ?, ?, ?, datetime('now', '-10 minutes'), 'esi_character_assets')
  `).run(
    CHARACTER_ID,
    lineage.ownerUserId,
    lineage.ownerChatId,
    lineage.bindingEpoch,
    lineage.bindingDigest,
    `owner-${session.userId}`,
  );
  db.prepare(`
    INSERT INTO real_asset_sync_leases
      (character_id, generation, job_id, acquired_at, renewed_at)
    VALUES (?, 1, 'P9337-STALE-RUNNING', datetime('now', '-10 minutes'), datetime('now', '-10 minutes'))
  `).run(CHARACTER_ID);
}

beforeEach(() => {
  clearCapabilitySnapshots();
  resetWebSessionCreationGuardForTests();
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(async () => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const app of OPEN_APPS.splice(0)) await app.close();
  db.close();
});

describe('P9.3.3.7 independent reconstruction of P9.3.3.5 findings', () => {
  it('F-P9335-01: unlink/rebind does not dedupe against an empty rebuilt mirror', async () => {
    const session = createWebSession(db);
    linkSession(session);
    vi.stubGlobal('fetch', vi.fn(async () => assetResponse([assetRow(984_101, 4)])));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx(session), 'manual');

    deleteCharacterData(db, CHARACTER_ID);
    db.prepare('DELETE FROM eve_character_links WHERE chat_id = ? AND character_id = ?')
      .run(session.chatId, CHARACTER_ID);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(session.chatId, CHARACTER_ID, session.userId);

    const second = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx(session), 'manual');
    expect(second.deduped).toBe(false);
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 1 });
    expect(latestSnapshot(session)).toEqual({ snapshot_id: second.snapshotId, total_quantity: 4 });
  });

  it('F-P9335-02: ownership transfer hides prior snapshots, jobs, inventory and tags from the new owner', async () => {
    const sessionA = createWebSession(db);
    const sessionB = createWebSession(db);
    linkSession(sessionA, [ASSET_SCOPE], 'owner-a');
    vi.stubGlobal('fetch', vi.fn(async () => assetResponse([assetRow(984_201, 5)])));
    const oldSync = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx(sessionA), 'manual');
    const lineageA = resolveAssetLineage(db, CHARACTER_ID, sessionA.userId, sessionA.chatId);
    db.prepare(`
      INSERT INTO real_asset_tags
        (character_id, item_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest, tag, updated_at)
      VALUES (?, 984201, ?, ?, ?, ?, 'SELF_USE', datetime('now'))
    `).run(
      CHARACTER_ID,
      lineageA.ownerUserId,
      lineageA.ownerChatId,
      lineageA.bindingEpoch,
      lineageA.bindingDigest,
    );

    transferOwnership(sessionA, sessionB);
    vi.stubGlobal('fetch', vi.fn(async () => assetResponse([assetRow(984_202, 7, 35)])));
    const newSync = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx(sessionB), 'manual');

    const app = await makeAssetApp();
    const snapshots = await app.inject({
      method: 'GET',
      url: `/api/web/assets/snapshots?characterId=${CHARACTER_ID}`,
      headers: headers(sessionB),
    });
    expect(snapshots.statusCode).toBe(200);
    expect(snapshots.json().rows.map((row: any) => row.snapshot_id)).toEqual([newSync.snapshotId]);
    expect(snapshots.body).not.toContain(oldSync.snapshotId);

    const oldDetail = await app.inject({
      method: 'GET',
      url: `/api/web/assets/snapshots/${oldSync.snapshotId}`,
      headers: headers(sessionB),
    });
    expect(oldDetail.statusCode).toBe(404);

    const jobs = await app.inject({
      method: 'GET',
      url: `/api/web/assets/sync/jobs?characterId=${CHARACTER_ID}`,
      headers: headers(sessionB),
    });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json().jobs.map((job: any) => job.jobId)).toEqual([newSync.job.jobId]);
    expect(jobs.body).not.toContain(oldSync.job.jobId);

    const inventory = await app.inject({
      method: 'GET',
      url: `/api/web/assets/inventory?characterId=${CHARACTER_ID}`,
      headers: headers(sessionB),
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json().rows.map((row: any) => row.itemId)).toEqual([984_202]);

    const tags = await app.inject({
      method: 'GET',
      url: '/api/web/assets/tags',
      headers: headers(sessionB),
    });
    expect(tags.statusCode).toBe(200);
    expect(tags.json().tags).toEqual([]);
    expect(tags.body).not.toContain('984201');
  });

  it('F-P9335-03: generic asset refresh remains behind the coordinator and advances mirror and snapshot together', async () => {
    const session = createWebSession(db);
    linkSession(session);
    vi.stubGlobal('fetch', vi.fn(async () => assetResponse([assetRow(984_301, 4)])));
    const first = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx(session), 'manual');

    vi.stubGlobal('fetch', vi.fn(async () => assetResponse([assetRow(984_301, 9)])));
    const statuses = await refreshCharacterDatasets(db, ctx(session), ['assets']);
    const current = latestSnapshot(session);
    const mirror = db.prepare(`
      SELECT quantity FROM character_assets WHERE character_id = ? AND item_id = 984301
    `).get(CHARACTER_ID) as { quantity: number };

    expect(statuses).toContainEqual(expect.objectContaining({ dataset: 'assets', status: 'ok' }));
    expect(current.snapshot_id).not.toBe(first.snapshotId);
    expect(current.total_quantity).toBe(9);
    expect(mirror.quantity).toBe(9);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_jobs WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 2 });
  });

  it('F-P9335-04: missing X-Pages fails closed and preserves the prior complete snapshot', async () => {
    const session = createWebSession(db);
    linkSession(session);
    vi.stubGlobal('fetch', vi.fn(async () => assetResponse([assetRow(984_401, 4)])));
    const prior = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx(session), 'manual');

    vi.stubGlobal('fetch', vi.fn(async () => assetResponse([assetRow(984_401, 9)], null)));
    await expect(RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx(session), 'manual'))
      .rejects.toThrow(/missing X-Pages/);
    expect(latestSnapshot(session)).toEqual({ snapshot_id: prior.snapshotId, total_quantity: 4 });
    expect(db.prepare('SELECT quantity FROM character_assets WHERE character_id = ? AND item_id = 984401')
      .get(CHARACTER_ID)).toEqual({ quantity: 4 });
  });

  it('F-P9335-05: aggregate quantity overflow fails closed without replacing the prior snapshot', async () => {
    const session = createWebSession(db);
    linkSession(session);
    vi.stubGlobal('fetch', vi.fn(async () => assetResponse([assetRow(984_501, 4)])));
    const prior = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx(session), 'manual');

    const overflowRows = [
      assetRow(984_502, Number.MAX_SAFE_INTEGER),
      assetRow(984_503, Number.MAX_SAFE_INTEGER),
      assetRow(984_504, Number.MAX_SAFE_INTEGER),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => assetResponse(overflowRows)));
    await expect(RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx(session), 'manual'))
      .rejects.toThrow(/安全整数范围/);
    expect(latestSnapshot(session)).toEqual({ snapshot_id: prior.snapshotId, total_quantity: 4 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 1 });
  });

  it('F-P9335-06: malformed journal data and a mid-batch DB failure preserve rows and report error', async () => {
    const session = createWebSession(db);
    linkSession(session, [WALLET_JOURNAL_SCOPE]);
    db.prepare(`
      INSERT INTO character_wallet_journal
        (character_id, journal_id, date, ref_type, amount, balance, first_party_id,
         second_party_id, description, context_id, context_id_type, data_json, synced_at)
      VALUES (?, 999, '2026-09-01T00:00:00Z', 'player_donation', 10, 100,
              NULL, NULL, 'last-known-good', NULL, NULL, '{}', datetime('now'))
    `).run(CHARACTER_ID);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ rows: [] }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        Expires: new Date(Date.now() + 3_600_000).toUTCString(),
        'X-Pages': '1',
      },
    })));
    await refreshCharacterDatasets(db, ctx(session), ['wallet_journal']);
    expect(getCharacterDatasetStatuses(db, CHARACTER_ID, ['wallet_journal'])[0])
      .toMatchObject({ status: 'error' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_wallet_journal WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 1 });

    db.prepare('DELETE FROM esi_cache').run();
    db.exec(`
      CREATE TRIGGER p9337_reject_journal_4
      BEFORE INSERT ON character_wallet_journal
      WHEN NEW.journal_id = 4
      BEGIN SELECT RAISE(ABORT, 'p9337 injected journal failure'); END;
    `);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([journalRow(3), journalRow(4)]), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        Expires: new Date(Date.now() + 3_600_000).toUTCString(),
        'X-Pages': '1',
      },
    })));
    await refreshCharacterDatasets(db, ctx(session), ['wallet_journal']);
    expect(getCharacterDatasetStatuses(db, CHARACTER_ID, ['wallet_journal'])[0])
      .toMatchObject({ status: 'error', error: expect.stringContaining('p9337 injected journal failure') });
    expect(db.prepare('SELECT journal_id FROM character_wallet_journal WHERE character_id = ? ORDER BY journal_id')
      .all(CHARACTER_ID)).toEqual([{ journal_id: 999 }]);
  });
});

describe('P9.3.3.7 independent worker and lease recovery checks', () => {
  it('R-P9335-01: the scheduled worker reclaims a stale RUNNING job and then completes a fresh sync', async () => {
    const session = createWebSession(db);
    linkSession(session);
    insertStaleRunningJob(session);
    vi.stubGlobal('fetch', vi.fn(async () => assetResponse([assetRow(984_601, 6)])));

    await runAssetSyncWorkerTick(db);

    expect(db.prepare("SELECT status, last_error FROM real_asset_sync_jobs WHERE job_id = 'P9337-STALE-RUNNING'").get())
      .toMatchObject({ status: 'FAILED', last_error: expect.stringContaining('presumed crashed') });
    expect(db.prepare("SELECT status FROM real_asset_sync_jobs WHERE job_id <> 'P9337-STALE-RUNNING' ORDER BY rowid DESC LIMIT 1").get())
      .toEqual({ status: 'COMPLETED' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 1 });
  });

  it('R-P9335-02: heartbeat renews a live lease while the ESI fetch is still blocked', async () => {
    const session = createWebSession(db);
    linkSession(session);
    let markEntered!: () => void;
    let releaseFetch!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      markEntered();
      await gate;
      return assetResponse([assetRow(984_701, 8)]);
    }));

    const pending = RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx(session), 'manual');
    await entered;
    const before = db.prepare(`
      SELECT acquired_at, renewed_at FROM real_asset_sync_leases WHERE character_id = ?
    `).get(CHARACTER_ID) as { acquired_at: string; renewed_at: string };
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    const during = db.prepare(`
      SELECT acquired_at, renewed_at FROM real_asset_sync_leases WHERE character_id = ?
    `).get(CHARACTER_ID) as { acquired_at: string; renewed_at: string };

    expect(during.acquired_at).toBe(before.acquired_at);
    expect(Date.parse(during.renewed_at)).toBeGreaterThan(Date.parse(before.renewed_at));

    releaseFetch();
    await expect(pending).resolves.toMatchObject({ itemsCommitted: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
  });

  it.each([1, 2, 3, 4, 5])(
    'role ownership change during in-flight asset fetch is fenced (repeat %i/5)',
    async (iteration) => {
      const sessionA = createWebSession(db);
      const sessionB = createWebSession(db);
      linkSession(sessionA, [ASSET_SCOPE], 'owner-before-transfer');
      vi.stubGlobal('fetch', vi.fn(async () => {
        transferOwnership(sessionA, sessionB);
        return assetResponse([assetRow(984_800 + iteration, iteration)]);
      }));

      await expect(RealAssetSyncService.syncCharacter(db, CHARACTER_ID, ctx(sessionA), 'manual'))
        .rejects.toThrow(/所有权|绑定|身份|解绑|租约|target|context|账户/i);
      expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_snapshots WHERE character_id = ?')
        .get(CHARACTER_ID)).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?')
        .get(CHARACTER_ID)).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM real_asset_sync_leases WHERE character_id = ?')
        .get(CHARACTER_ID)).toEqual({ n: 0 });
    },
  );
});