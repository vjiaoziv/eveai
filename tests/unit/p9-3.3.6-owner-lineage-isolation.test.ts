import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { deleteCharacterData } from '../../src/db/character-datastore.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { RealAssetSyncService } from '../../src/assets/asset-sync-service.js';
import { resolveAssetLineage, type AssetLineage } from '../../src/assets/asset-lineage.js';
import { RealAssetHistoryService } from '../../src/assets/history-service.js';
import { RealInventoryService } from '../../src/assets/inventory-service.js';
import { RealValuationService } from '../../src/assets/valuation-service.js';
import { RealOpportunityMatchService } from '../../src/assets/opportunity-match-service.js';
import { P9RealPortfolioService } from '../../src/trading/p9-real-portfolio.js';
import { registerAssetRoutes } from '../../src/web/asset-routes.js';
import { registerProfileRoutes } from '../../src/web/profile-routes.js';
import { registerP9Routes } from '../../src/web/p9-routes.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
  type CreatedWebSession,
} from '../../src/web/web-session.js';
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
    marketSnapshot: { staleMinutes: 30, majorMinPages: 5, majorIntervalMinutes: 60, minorIntervalMinutes: 15 },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: {
      baseUrl: 'http://localhost:3000',
      sessionTtlHours: 720,
      sessionCreationWindowSeconds: 60,
      maxSessionCreationsPerWindow: 1000,
    },
    auth: { secretKey: 'p936-owner-lineage-test-secret' },
  },
}));

const CHARACTER_ID = 9_770_201;
const LOCATION_ID = 60_003_760;
const OLD_ITEM = 94_001;
const NEW_ITEM = 94_002;
const LEGACY_ITEM = 94_003;
const LEGACY_SNAPSHOT = 'P936-LEGACY-SNAPSHOT';
const OLD_VALUATION = 'P936-OLD-VALUATION';
const NEW_VALUATION = 'P936-NEW-VALUATION';
const OLD_CHANGE = 'P936-OLD-CHANGE';
const NEW_CHANGE = 'P936-NEW-CHANGE';
const OLD_MATCH = 'P936-OLD-MATCH';
const NEW_OPPORTUNITY = 'P936-NEW-OPPORTUNITY';
const OLD_OPPORTUNITY = 'P936-OLD-OPPORTUNITY';
const SCOPE = 'esi-assets.read_assets.v1';
const OPEN_APPS: Array<ReturnType<typeof Fastify>> = [];

let db: Db;
let sessionA: CreatedWebSession;
let sessionB: CreatedWebSession;
let lineageA: AssetLineage;
let lineageB: AssetLineage;
let oldSyncJobId: string;
let newSyncJobId: string;
let oldSnapshotId: string;
let newSnapshotId: string;

function assetsResponse(itemId: number, typeId: number): Response {
  return new Response(JSON.stringify([{
    item_id: itemId,
    type_id: typeId,
    location_id: LOCATION_ID,
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

function linkCharacter(session: CreatedWebSession, ownerHash: string): void {
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at,
       scopes_json, user_id, owner_hash)
    VALUES (?, 'Lineage Pilot', 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET
      scopes_json = excluded.scopes_json,
      user_id = excluded.user_id,
      owner_hash = excluded.owner_hash,
      expires_at = excluded.expires_at
  `).run(CHARACTER_ID, JSON.stringify([SCOPE]), session.userId, ownerHash);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(session.chatId, CHARACTER_ID, session.userId);
}

function insertSnapshot(input: {
  snapshotId: string;
  itemId: number;
  typeId: number;
  lineage: AssetLineage | null;
  isLatest: 0 | 1;
  hash: string;
}): void {
  db.prepare(`
    INSERT INTO real_asset_snapshots
      (snapshot_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       job_id, started_at, completed_at, status,
       total_items, total_unique_types, total_locations, total_quantity,
       data_hash, hash_algorithm, canonical_version, source, is_latest)
    VALUES (?, ?, ?, ?, ?, ?, NULL, datetime('now'), datetime('now'), 'COMPLETED',
            1, 1, 1, 5, ?, 'sha256', 1, 'esi_character_assets', ?)
  `).run(
    input.snapshotId,
    CHARACTER_ID,
    input.lineage?.ownerUserId ?? null,
    input.lineage?.ownerChatId ?? null,
    input.lineage?.bindingEpoch ?? 0,
    input.lineage?.bindingDigest ?? '',
    input.hash,
    input.isLatest,
  );
  db.prepare(`
    INSERT INTO real_asset_snapshot_items
      (snapshot_id, item_id, type_id, quantity, location_id, location_type,
       location_flag, is_singleton, is_blueprint_copy, parent_item_id, raw_json)
    VALUES (?, ?, ?, 5, ?, 'station', 'Hangar', 0, 0, NULL, '{}')
  `).run(input.snapshotId, input.itemId, input.typeId, LOCATION_ID);
}

function insertValuation(input: {
  valuationId: string;
  snapshotId: string;
  itemId: number;
  typeId: number;
  lineage: AssetLineage;
}): void {
  db.prepare(`
    INSERT INTO real_asset_valuations
      (valuation_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       snapshot_id, hub_location_id, hub_region_id, market_snapshot_at,
       fee_model_version, status, created_at, completed_at, items_valued, items_unknown)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10000002, datetime('now'), 'fee-v1', 'COMPLETED',
            datetime('now'), datetime('now'), 1, 0)
  `).run(
    input.valuationId,
    CHARACTER_ID,
    input.lineage.ownerUserId,
    input.lineage.ownerChatId,
    input.lineage.bindingEpoch,
    input.lineage.bindingDigest,
    input.snapshotId,
    LOCATION_ID,
  );
  db.prepare(`
    INSERT INTO real_asset_valuation_items
      (valuation_id, item_id, type_id, quantity, market_reference_value,
       bid_liquidation_net, ask_replacement_gross, statuses_json, flags_json)
    VALUES (?, ?, ?, 5, 500, 450, 550, '[]', '[]')
  `).run(input.valuationId, input.itemId, input.typeId);
}

function insertChange(input: {
  changeId: string;
  fromSnapshotId: string | null;
  toSnapshotId: string;
  itemId: number;
  typeId: number;
  lineage: AssetLineage;
}): void {
  db.prepare(`
    INSERT INTO real_asset_changes
      (change_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       item_id, type_id, change_type, prev_quantity, new_quantity,
       prev_location_id, new_location_id, source_class, confidence,
       from_snapshot_id, to_snapshot_id, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ADDED', NULL, 5, NULL, ?,
            'OBSERVED_CHANGE', 'HIGH', ?, ?, datetime('now'))
  `).run(
    input.changeId,
    CHARACTER_ID,
    input.lineage.ownerUserId,
    input.lineage.ownerChatId,
    input.lineage.bindingEpoch,
    input.lineage.bindingDigest,
    input.itemId,
    input.typeId,
    LOCATION_ID,
    input.fromSnapshotId,
    input.toSnapshotId,
  );
}

function insertTag(input: { itemId: number; tag: string; lineage: AssetLineage }): void {
  db.prepare(`
    INSERT INTO real_asset_tags
      (character_id, item_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       tag, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    CHARACTER_ID,
    input.itemId,
    input.lineage.ownerUserId,
    input.lineage.ownerChatId,
    input.lineage.bindingEpoch,
    input.lineage.bindingDigest,
    input.tag,
  );
}

function insertOpportunity(opportunityId: string): void {
  db.prepare(`
    INSERT INTO p9_real_opportunities
      (opportunity_id, character_id, scan_key, strategy, type_id, type_name_en, type_name_zh,
       buy_location_id, buy_location_name, sell_location_id, sell_location_name,
       buy_region_id, sell_region_id, buy_price, sell_price,
       suggested_quantity, executable_quantity, purchase_amount, sales_revenue,
       broker_fees, sales_tax, theoretical_gross_profit, executable_gross_profit,
       fee_net_profit, comprehensive_status, capital_required, roi_pct,
       buy_snapshot_id, sell_snapshot_id, calculation_version, original_snapshot_json,
       state, detected_at, expires_at)
    VALUES (?, ?, ?, 'station_trade', 34, 'Tritanium', '三钛合金',
            ?, 'Jita', ?, 'Amarr', 10000002, 10000043, 5, 7,
            5, 5, 25, 35, 1, 1, 10, 10, 8, 'UNKNOWN', 25, 32,
            'BUY-SNAP', 'SELL-SNAP', 'p936-test', '{}', 'ACTIONABLE', datetime('now'), datetime('now', '+1 hour'))
  `).run(opportunityId, CHARACTER_ID, `${opportunityId}-KEY`, LOCATION_ID, LOCATION_ID + 1);
}

function insertMatch(matchId: string, opportunityId: string, lineage: AssetLineage): void {
  db.prepare(`
    INSERT INTO real_asset_opportunity_matches
      (match_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       opportunity_id, type_id, held_quantity, accessible_quantity, required_quantity,
       support_class, needs_transport, locations_json, snapshot_id, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 34, 5, 5, 5, 'SUPPORTED', 0, '[]', ?, datetime('now'))
  `).run(
    matchId,
    CHARACTER_ID,
    lineage.ownerUserId,
    lineage.ownerChatId,
    lineage.bindingEpoch,
    lineage.bindingDigest,
    opportunityId,
    oldSnapshotId,
  );
}

function headers(session: CreatedWebSession): { cookie: string } {
  return { cookie: `${WEB_SESSION_COOKIE}=${session.sessionToken}` };
}

async function seedOwnershipTransfer(): Promise<void> {
  sessionA = createWebSession(db);
  sessionB = createWebSession(db);
  linkCharacter(sessionA, 'owner-lineage-a');
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(CHARACTER_ID, sessionA.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?').run(CHARACTER_ID, sessionA.chatId);

  vi.stubGlobal('fetch', vi.fn(async () => assetsResponse(OLD_ITEM, 34)));
  const oldSync = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, {
    userId: sessionA.userId,
    chatId: sessionA.chatId,
    characterId: CHARACTER_ID,
  }, 'manual');
  oldSyncJobId = oldSync.job.jobId;
  oldSnapshotId = oldSync.snapshotId;
  lineageA = resolveAssetLineage(db, CHARACTER_ID, sessionA.userId, sessionA.chatId);

  insertChange({ changeId: OLD_CHANGE, fromSnapshotId: null, toSnapshotId: oldSync.snapshotId, itemId: OLD_ITEM, typeId: 34, lineage: lineageA });
  insertValuation({ valuationId: OLD_VALUATION, snapshotId: oldSync.snapshotId, itemId: OLD_ITEM, typeId: 34, lineage: lineageA });
  insertTag({ itemId: OLD_ITEM, tag: 'FOR_SALE', lineage: lineageA });
  insertOpportunity(OLD_OPPORTUNITY);
  insertMatch(OLD_MATCH, OLD_OPPORTUNITY, lineageA);
  insertSnapshot({ snapshotId: LEGACY_SNAPSHOT, itemId: LEGACY_ITEM, typeId: 35, lineage: null, isLatest: 0, hash: 'legacy-hash' });

  deleteCharacterData(db, CHARACTER_ID);
  db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
  linkCharacter(sessionB, 'owner-lineage-b');
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(CHARACTER_ID, sessionB.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?').run(CHARACTER_ID, sessionB.chatId);
  lineageB = resolveAssetLineage(db, CHARACTER_ID, sessionB.userId, sessionB.chatId);

  vi.stubGlobal('fetch', vi.fn(async () => assetsResponse(NEW_ITEM, 35)));
  const newSync = await RealAssetSyncService.syncCharacter(db, CHARACTER_ID, {
    userId: sessionB.userId,
    chatId: sessionB.chatId,
    characterId: CHARACTER_ID,
  }, 'manual');
  newSyncJobId = newSync.job.jobId;
  newSnapshotId = newSync.snapshotId;

  insertChange({ changeId: NEW_CHANGE, fromSnapshotId: oldSync.snapshotId, toSnapshotId: newSync.snapshotId, itemId: NEW_ITEM, typeId: 35, lineage: lineageB });
  insertValuation({ valuationId: NEW_VALUATION, snapshotId: newSync.snapshotId, itemId: NEW_ITEM, typeId: 35, lineage: lineageB });
  insertTag({ itemId: NEW_ITEM, tag: 'PRODUCTION', lineage: lineageB });

  expect(newSync.snapshotId).not.toBe(oldSync.snapshotId);
}

async function makeApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ bodyLimit: 64 * 1024 });
  OPEN_APPS.push(app);
  await app.register(fastifyCookie);
  registerAssetRoutes(app, db);
  registerProfileRoutes(app, db);
  registerP9Routes(app, db);
  return app;
}

beforeEach(async () => {
  clearCapabilitySnapshots();
  resetWebSessionCreationGuardForTests();
  db = new Database(':memory:') as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`
    INSERT INTO sde_types (type_id, name, group_id, data_json)
    VALUES (34, 'Tritanium', NULL, '{"name":{"en":"Tritanium","zh":"三钛合金"}}')
  `).run();
  db.prepare(`
    INSERT INTO sde_types (type_id, name, group_id, data_json)
    VALUES (35, 'Pyerite', NULL, '{"name":{"en":"Pyerite","zh":"类胶质"}}')
  `).run();
  db.prepare(`
    INSERT INTO real_asset_locations
      (location_id, location_type, location_name, solar_system_id, solar_system_name,
       region_id, region_name, parent_location_id, resolution_status, resolution_source, resolved_at)
    VALUES (?, 'STATION', 'Jita Trade Hub', 30000142, 'Jita', 10000002, 'The Forge',
            NULL, 'RESOLVED', 'sde_stations', datetime('now'))
  `).run(LOCATION_ID);
  await seedOwnershipTransfer();
});

afterEach(async () => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const app of OPEN_APPS.splice(0)) await app.close();
  db.close();
});

describe('P9.3.3.6 owner and binding lineage isolation', () => {
  it('exposes only the new owner lineage to the current owner and preserves the new mirror/latest/job association', async () => {
    const app = await makeApp();
    const overview = await app.inject({
      method: 'GET', url: '/api/web/assets/overview', headers: headers(sessionB),
    });
    expect(overview.statusCode).toBe(200);
    const payload = overview.json();
    expect(payload.characters).toHaveLength(1);
    expect(payload.characters[0]).toMatchObject({
      characterId: CHARACTER_ID,
      currentAssetItems: 1,
      latestSnapshot: { snapshot_id: expect.any(String) },
      lastJob: { jobId: newSyncJobId },
      latestValuation: { valuationId: NEW_VALUATION },
      dataIntegrity: 'COMPLETE',
    });
    expect(payload.characters[0].latestSnapshot.snapshot_id).not.toBe(oldSnapshotId);
    expect(payload.characters[0].latestSnapshot.snapshot_id).not.toBe(LEGACY_SNAPSHOT);
    expect(overview.body).not.toContain(oldSnapshotId);
    expect(overview.body).not.toContain(LEGACY_SNAPSHOT);
    expect(overview.body).not.toContain(OLD_VALUATION);
  });

  it('filters snapshot, item-child, changes, totals, compare, job, inventory, valuation and opportunity lists by lineage', async () => {
    const app = await makeApp();
    const snapshotList = await app.inject({
      method: 'GET', url: `/api/web/assets/snapshots?characterId=${CHARACTER_ID}&limit=50`, headers: headers(sessionB),
    });
    expect(snapshotList.statusCode).toBe(200);
    expect(snapshotList.json()).toMatchObject({ total: 1 });
    expect(snapshotList.json().rows.map((row: any) => row.snapshot_id)).not.toContain(oldSnapshotId);
    expect(snapshotList.json().rows.map((row: any) => row.snapshot_id)).not.toContain(LEGACY_SNAPSHOT);

    const newSnapshotDetail = await app.inject({
      method: 'GET', url: `/api/web/assets/snapshots/${snapshotList.json().rows[0].snapshot_id}`, headers: headers(sessionB),
    });
    expect(newSnapshotDetail.statusCode).toBe(200);
    expect(newSnapshotDetail.json().items.map((item: any) => item.item_id)).toEqual([NEW_ITEM]);

    for (const snapshotId of [oldSnapshotId, LEGACY_SNAPSHOT]) {
      const denied = await app.inject({
        method: 'GET', url: `/api/web/assets/snapshots/${snapshotId}`, headers: headers(sessionB),
      });
      expect(denied.statusCode, snapshotId).toBe(404);
      expect(denied.body).not.toContain(OLD_ITEM.toString());
    }

    const changes = await app.inject({
      method: 'GET', url: `/api/web/assets/changes?characterId=${CHARACTER_ID}`, headers: headers(sessionB),
    });
    expect(changes.statusCode).toBe(200);
    expect(changes.json()).toMatchObject({ total: 1 });
    expect(changes.json().rows.map((row: any) => row.change_id)).toEqual([NEW_CHANGE]);

    const totals = await app.inject({
      method: 'GET', url: `/api/web/assets/history/totals?characterId=${CHARACTER_ID}`, headers: headers(sessionB),
    });
    expect(totals.statusCode).toBe(200);
    expect(JSON.stringify(totals.json())).not.toContain(oldSnapshotId);
    expect(JSON.stringify(totals.json())).not.toContain(LEGACY_SNAPSHOT);

    const oldItemHistory = await app.inject({
      method: 'GET', url: `/api/web/assets/history/item/${OLD_ITEM}`, headers: headers(sessionB),
    });
    expect(oldItemHistory.statusCode).toBe(404);
    const newItemHistory = await app.inject({
      method: 'GET', url: `/api/web/assets/history/item/${NEW_ITEM}`, headers: headers(sessionB),
    });
    expect(newItemHistory.statusCode).toBe(200);
    expect(newItemHistory.json().characterId).toBe(CHARACTER_ID);

    const deniedCompareFrom = await app.inject({
      method: 'GET', url: `/api/web/assets/history/compare/${oldSnapshotId}/${newSnapshotId}`, headers: headers(sessionB),
    });
    expect(deniedCompareFrom.statusCode).toBe(404);
    const deniedCompareTo = await app.inject({
      method: 'GET', url: `/api/web/assets/history/compare/${newSnapshotId}/${oldSnapshotId}`, headers: headers(sessionB),
    });
    expect(deniedCompareTo.statusCode).toBe(400);

    const jobs = await app.inject({
      method: 'GET', url: `/api/web/assets/sync/jobs?characterId=${CHARACTER_ID}`, headers: headers(sessionB),
    });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json().jobs.map((job: any) => job.jobId)).toEqual([newSyncJobId]);
    expect(jobs.body).not.toContain(oldSyncJobId);

    const inventory = await app.inject({
      method: 'GET', url: `/api/web/assets/inventory?characterId=${CHARACTER_ID}`, headers: headers(sessionB),
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json().rows.map((row: any) => row.itemId)).toEqual([NEW_ITEM]);
    const deniedInventoryDetail = await app.inject({
      method: 'GET', url: `/api/web/assets/inventory/${OLD_ITEM}`, headers: headers(sessionB),
    });
    expect(deniedInventoryDetail.statusCode).toBe(404);
    const inventoryDetail = await app.inject({
      method: 'GET', url: `/api/web/assets/inventory/${NEW_ITEM}`, headers: headers(sessionB),
    });
    expect(inventoryDetail.statusCode).toBe(200);

    const valuations = await app.inject({
      method: 'GET', url: `/api/web/assets/valuations?characterId=${CHARACTER_ID}`, headers: headers(sessionB),
    });
    expect(valuations.statusCode).toBe(200);
    expect(valuations.json().runs.map((row: any) => row.valuation_id)).toEqual([NEW_VALUATION]);
    const deniedValuation = await app.inject({
      method: 'GET', url: `/api/web/assets/valuations/${OLD_VALUATION}`, headers: headers(sessionB),
    });
    expect(deniedValuation.statusCode).toBe(404);
    const newValuation = await app.inject({
      method: 'GET', url: `/api/web/assets/valuations/${NEW_VALUATION}`, headers: headers(sessionB),
    });
    expect(newValuation.statusCode).toBe(200);
    expect(newValuation.json().items.map((item: any) => item.item_id)).toEqual([NEW_ITEM]);

    const matches = await app.inject({
      method: 'GET', url: `/api/web/assets/opportunity-matches?characterId=${CHARACTER_ID}`, headers: headers(sessionB),
    });
    expect(matches.statusCode).toBe(200);
    expect(matches.json()).toMatchObject({ total: 0, rows: [] });
    expect(matches.body).not.toContain(OLD_MATCH);

    const tags = await app.inject({
      method: 'GET', url: '/api/web/assets/tags', headers: headers(sessionB),
    });
    expect(tags.statusCode).toBe(200);
    expect(tags.json().tags.map((row: any) => row.item_id)).toEqual([NEW_ITEM]);
    expect(tags.body).not.toContain(OLD_ITEM.toString());
  });

  it('protects child rows through authorized parents at the service layer', () => {
    const snapshots = RealAssetHistoryService.listSnapshots(db, { characterId: CHARACTER_ID }, lineageB);
    expect(snapshots.rows.map((row) => row.snapshot_id)).toEqual([newSnapshotId]);

    expect(RealValuationService.getRun(db, CHARACTER_ID, OLD_VALUATION, lineageB)).toBeNull();
    expect(RealValuationService.getRun(db, CHARACTER_ID, NEW_VALUATION, lineageB))
      .toMatchObject({ header: { valuation_id: NEW_VALUATION }, items: [{ item_id: NEW_ITEM }] });

    expect(RealInventoryService.detail(db, CHARACTER_ID, OLD_ITEM, lineageB)).toBeNull();
    expect(RealInventoryService.detail(db, CHARACTER_ID, NEW_ITEM, lineageB)).not.toBeNull();
    expect(RealOpportunityMatchService.list(db, CHARACTER_ID, lineageB).total).toBe(0);
    expect(P9RealPortfolioService.inventory(db, CHARACTER_ID, lineageB).rawAssets)
      .toContainEqual(expect.objectContaining({ itemId: NEW_ITEM }));
  });

  it('keeps profile and P9 asset projections scoped to the new owner and denies the old session', async () => {
    const app = await makeApp();
    const profileAssets = await app.inject({
      method: 'GET', url: '/api/web/profile/assets', headers: headers(sessionB),
    });
    expect(profileAssets.statusCode).toBe(200);
    expect(profileAssets.json().locations).toHaveLength(1);
    expect(profileAssets.json().locations[0].itemCount).toBe(1);

    const profileItems = await app.inject({
      method: 'GET', url: `/api/web/profile/assets/items?location_id=${LOCATION_ID}`, headers: headers(sessionB),
    });
    expect(profileItems.statusCode).toBe(200);
    expect(profileItems.json().items.map((item: any) => item.itemId)).toEqual([NEW_ITEM]);

    const p9Overview = await app.inject({
      method: 'GET', url: '/api/web/trading/p9/overview', headers: headers(sessionB),
    });
    expect(p9Overview.statusCode).toBe(200);
    expect(p9Overview.json().portfolio.inventory.rawAssetCount).toBe(1);

    for (const url of [
      '/api/web/assets/overview',
      '/api/web/profile/assets',
      '/api/web/trading/p9/overview',
    ]) {
      const oldOwner = await app.inject({ method: 'GET', url, headers: headers(sessionA) });
      expect([200, 404], url).toContain(oldOwner.statusCode);
      expect(oldOwner.body, url).not.toContain(newSnapshotId);
      expect(oldOwner.body, url).not.toContain(NEW_ITEM.toString());
      expect(oldOwner.body, url).not.toContain(NEW_VALUATION);
      expect(oldOwner.body, url).not.toContain(newSyncJobId);
      if (oldOwner.statusCode === 200) {
        expect(oldOwner.json(), url).toMatchObject({ characters: [] });
      }
    }
  });

  it('keeps legacy ownerless rows invisible even when their IDs point to otherwise valid child records', async () => {
    const app = await makeApp();
    const list = await app.inject({
      method: 'GET', url: `/api/web/assets/snapshots?characterId=${CHARACTER_ID}&status=COMPLETED`, headers: headers(sessionB),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().rows.map((row: any) => row.snapshot_id)).not.toContain(LEGACY_SNAPSHOT);

    const detail = await app.inject({
      method: 'GET', url: `/api/web/assets/snapshots/${LEGACY_SNAPSHOT}`, headers: headers(sessionB),
    });
    expect(detail.statusCode).toBe(404);
    const item = await app.inject({
      method: 'GET', url: `/api/web/assets/history/item/${LEGACY_ITEM}`, headers: headers(sessionB),
    });
    expect(item.statusCode).toBe(404);
    const inventory = await app.inject({
      method: 'GET', url: `/api/web/assets/inventory/${LEGACY_ITEM}`, headers: headers(sessionB),
    });
    expect(inventory.statusCode).toBe(404);
  });
});



