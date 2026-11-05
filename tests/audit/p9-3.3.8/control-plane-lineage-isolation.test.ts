import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { deleteCharacterData } from '../../../src/db/character-datastore.js';
import { resolveAssetLineage, type AssetLineage } from '../../../src/assets/asset-lineage.js';
import { P9OpportunityService } from '../../../src/trading/p9-opportunity-service.js';
import { buildP9AnalysisPrompt } from '../../../src/trading/p9-ai-analysis.js';
import { registerP9Routes } from '../../../src/web/p9-routes.js';
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
    auth: { secretKey: 'audit-test-secret' },
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
      enabled: false,
      intervalMinutes: 60,
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
  },
}));

const CHARACTER_ID = 9_833_811;
const LOCATION_ID = 60_003_760;
const BUY_REGION_ID = 10_000_002;
const SELL_REGION_ID = 10_000_043;
const OPEN_APPS: Array<ReturnType<typeof Fastify>> = [];

let db: Db;
let sessionA: CreatedWebSession;
let sessionB: CreatedWebSession;
let lineageA: AssetLineage;

function linkOwner(session: CreatedWebSession, ownerHash: string): void {
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at,
       scopes_json, user_id, owner_hash)
    VALUES (?, 'Control Plane Pilot', 'access-token', 'refresh-token',
            datetime('now', '+1 hour'), '[]', ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET
      user_id = excluded.user_id,
      owner_hash = excluded.owner_hash,
      scopes_json = excluded.scopes_json,
      expires_at = excluded.expires_at
  `).run(CHARACTER_ID, session.userId, ownerHash);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(session.chatId, CHARACTER_ID, session.userId);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?')
    .run(CHARACTER_ID, session.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
    .run(CHARACTER_ID, session.chatId);
}

function transferToB(): void {
  db.prepare('UPDATE users SET active_character_id = NULL WHERE user_id = ?').run(sessionA.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = NULL WHERE chat_id = ?').run(sessionA.chatId);
  db.prepare('DELETE FROM eve_character_links WHERE character_id = ?').run(CHARACTER_ID);
  db.prepare('UPDATE eve_accounts SET user_id = ?, owner_hash = ? WHERE character_id = ?')
    .run(sessionB.userId, 'owner-b-new-hash', CHARACTER_ID);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?')
    .run(CHARACTER_ID, sessionB.userId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
    .run(CHARACTER_ID, sessionB.chatId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(sessionB.chatId, CHARACTER_ID, sessionB.userId);
  deleteCharacterData(db, CHARACTER_ID);
}

function readHeaders(session: CreatedWebSession): { cookie: string } {
  return { cookie: `${WEB_SESSION_COOKIE}=${session.sessionToken}` };
}

function mutationHeaders(session: CreatedWebSession): Record<string, string> {
  return {
    ...readHeaders(session),
    origin: 'http://localhost:3000',
    'x-csrf-token': session.csrfToken,
  };
}

function insertRegions(): void {
  db.prepare(`INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, '{}')`)
    .run(BUY_REGION_ID, 'The Forge');
  db.prepare(`INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, '{}')`)
    .run(SELL_REGION_ID, 'Domain');
  db.prepare(`INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, '{}')`)
    .run(10_000_032, 'Sinq Laison');
}

function insertSettings(lineage: AssetLineage, minNetProfit: number): void {
  db.prepare(`
    INSERT INTO p9_scan_settings
      (character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       hubs_json, strategies_json, min_net_profit, min_roi_pct, max_capital,
       max_market_age_minutes, max_results, auto_scan_enabled,
       auto_scan_interval_minutes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 5, 1000000, 60, 100, 0, 30, ?)
  `).run(
    CHARACTER_ID,
    lineage.ownerUserId,
    lineage.ownerChatId ?? 0,
    lineage.bindingEpoch,
    lineage.bindingDigest,
    JSON.stringify([{ locationId: LOCATION_ID, regionId: BUY_REGION_ID, name: 'Jita', enabled: true }]),
    JSON.stringify(['station_arbitrage']),
    minNetProfit,
    '2026-11-03T00:00:00.000Z',
  );
}

function insertOpportunity(
  lineage: AssetLineage,
  opportunityId: string,
  marker: string,
  state = 'NEW',
): void {
  db.prepare(`
    INSERT INTO p9_real_opportunities
      (opportunity_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       scan_key, strategy, type_id, type_name_en, type_name_zh,
       buy_location_id, buy_location_name, sell_location_id, sell_location_name,
       buy_region_id, sell_region_id, buy_price, sell_price, suggested_quantity,
       executable_quantity, purchase_amount, sales_revenue, broker_fees, sales_tax,
       theoretical_gross_profit, executable_gross_profit, fee_net_profit,
       capital_required, roi_pct, buy_snapshot_id, sell_snapshot_id,
       calculation_version, original_snapshot_json, state, detected_at, updated_at,
       expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'station_arbitrage', 34, ?, NULL,
            ?, 'Jita', ?, 'Amarr', ?, ?, 10, 12, 10,
            10, 100, 120, 1, 1, 20, 18, 17, 100, 17,
            'BUY-SNAP-A', 'SELL-SNAP-A', 'test-v1', '{}', ?,
            '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z',
            '2027-11-03T00:00:00.000Z')
  `).run(
    opportunityId,
    CHARACTER_ID,
    lineage.ownerUserId,
    lineage.ownerChatId ?? 0,
    lineage.bindingEpoch,
    lineage.bindingDigest,
    `scan:${opportunityId}`,
    marker,
    LOCATION_ID,
    LOCATION_ID + 1,
    BUY_REGION_ID,
    SELL_REGION_ID,
    state,
  );
}

function insertJob(lineage: AssetLineage, jobId: string, marker: string): void {
  db.prepare(`
    INSERT INTO p9_job_runs
      (job_id, job_type, character_id, owner_user_id, owner_chat_id, binding_epoch,
       binding_digest, status, started_at, finished_at, summary_json)
    VALUES (?, 'market_scan', ?, ?, ?, ?, ?, 'ok', ?, ?, ?)
  `).run(
    jobId,
    CHARACTER_ID,
    lineage.ownerUserId,
    lineage.ownerChatId ?? 0,
    lineage.bindingEpoch,
    lineage.bindingDigest,
    '2026-11-03T00:00:00.000Z',
    '2026-11-03T00:01:00.000Z',
    JSON.stringify({ marker }),
  );
}

async function makeApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ bodyLimit: 64 * 1024 });
  OPEN_APPS.push(app);
  await app.register(fastifyCookie);
  registerP9Routes(app, db);
  return app;
}

beforeEach(() => {
  resetWebSessionCreationGuardForTests();
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertRegions();
  sessionA = createWebSession(db);
  sessionB = createWebSession(db);
  linkOwner(sessionA, 'owner-a-old-hash');
  lineageA = resolveAssetLineage(db, CHARACTER_ID, sessionA.userId, sessionA.chatId);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of OPEN_APPS.splice(0)) await app.close();
  db.close();
});

describe('P9.3.3.8 control-plane owner and lane isolation', () => {
  it('isolates settings, opportunities, plans, jobs and mutations across an ownership transfer', async () => {
    insertSettings(lineageA, 11_111);
    insertOpportunity(lineageA, 'OPP-A-PRIVATE', 'OWNER_A_OPPORTUNITY_MARKER');
    insertJob(lineageA, 'JOB-A-PRIVATE', 'OWNER_A_JOB_MARKER');
    const planA = P9OpportunityService.createPlan(db, CHARACTER_ID, 'OPP-A-PRIVATE', { notes: 'OWNER_A_PLAN_MARKER' }, lineageA);
    const app = await makeApp();

    const ownerASettings = await app.inject({
      method: 'GET', url: '/api/web/trading/p9/settings', headers: readHeaders(sessionA),
    });
    expect(ownerASettings.statusCode).toBe(200);
    expect(ownerASettings.json().settings.minNetProfit).toBe(11_111);

    const ownerAOpportunities = await app.inject({
      method: 'GET', url: '/api/web/trading/p9/opportunities', headers: readHeaders(sessionA),
    });
    expect(ownerAOpportunities.statusCode).toBe(200);
    expect(ownerAOpportunities.json().rows.map((row: any) => row.opportunityId)).toEqual(['OPP-A-PRIVATE']);
    expect(ownerAOpportunities.body).toContain('OWNER_A_OPPORTUNITY_MARKER');

    const ownerAPlans = await app.inject({
      method: 'GET', url: '/api/web/trading/p9/plans', headers: readHeaders(sessionA),
    });
    expect(ownerAPlans.statusCode).toBe(200);
    expect(ownerAPlans.json().plans.map((plan: any) => plan.planId)).toEqual([planA.planId]);
    expect(ownerAPlans.body).toContain('OWNER_A_PLAN_MARKER');

    const ownerAJobs = await app.inject({
      method: 'GET', url: '/api/web/trading/p9/jobs', headers: readHeaders(sessionA),
    });
    expect(ownerAJobs.statusCode).toBe(200);
    expect(ownerAJobs.json().jobs.map((job: any) => job.job_id)).toEqual(['JOB-A-PRIVATE']);
    expect(ownerAJobs.body).toContain('OWNER_A_JOB_MARKER');

    transferToB();
    const lineageB = resolveAssetLineage(db, CHARACTER_ID, sessionB.userId, sessionB.chatId);

    const ownerBSettings = await app.inject({
      method: 'GET', url: '/api/web/trading/p9/settings', headers: readHeaders(sessionB),
    });
    expect(ownerBSettings.statusCode).toBe(200);
    expect(ownerBSettings.json().settings.minNetProfit).toBe(100_000);

    const ownerBOpportunities = await app.inject({
      method: 'GET', url: '/api/web/trading/p9/opportunities', headers: readHeaders(sessionB),
    });
    expect(ownerBOpportunities.statusCode).toBe(200);
    expect(ownerBOpportunities.json().rows).toEqual([]);
    expect(ownerBOpportunities.body).not.toContain('OPP-A-PRIVATE');
    expect(ownerBOpportunities.body).not.toContain('OWNER_A_OPPORTUNITY_MARKER');

    const ownerBDetail = await app.inject({
      method: 'GET', url: '/api/web/trading/p9/opportunities/OPP-A-PRIVATE', headers: readHeaders(sessionB),
    });
    expect(ownerBDetail.statusCode).toBe(404);
    expect(ownerBDetail.body).not.toContain('OWNER_A_OPPORTUNITY_MARKER');

    const ownerBPlans = await app.inject({
      method: 'GET', url: '/api/web/trading/p9/plans', headers: readHeaders(sessionB),
    });
    expect(ownerBPlans.statusCode).toBe(200);
    expect(ownerBPlans.json().plans).toEqual([]);
    expect(ownerBPlans.body).not.toContain('OWNER_A_PLAN_MARKER');

    const ownerBJobs = await app.inject({
      method: 'GET', url: '/api/web/trading/p9/jobs', headers: readHeaders(sessionB),
    });
    expect(ownerBJobs.statusCode).toBe(200);
    expect(ownerBJobs.json().jobs).toEqual([]);
    expect(ownerBJobs.body).not.toContain('OWNER_A_JOB_MARKER');

    const ownerBOverview = await app.inject({
      method: 'GET', url: '/api/web/trading/p9/overview', headers: readHeaders(sessionB),
    });
    expect(ownerBOverview.statusCode).toBe(200);
    expect(ownerBOverview.body).not.toContain('OPP-A-PRIVATE');
    expect(ownerBOverview.body).not.toContain('OWNER_A_JOB_MARKER');

    const mutateOpportunity = await app.inject({
      method: 'PATCH',
      url: '/api/web/trading/p9/opportunities/OPP-A-PRIVATE',
      headers: mutationHeaders(sessionB),
      payload: { state: 'WATCHING', reason: 'cross-owner attempt' },
    });
    expect(mutateOpportunity.statusCode).toBe(400);
    expect(mutateOpportunity.json().error).toBe('status_update_failed');

    const createPlan = await app.inject({
      method: 'POST',
      url: '/api/web/trading/p9/plans',
      headers: mutationHeaders(sessionB),
      payload: { opportunityId: 'OPP-A-PRIVATE' },
    });
    expect(createPlan.statusCode).toBe(400);
    expect(createPlan.json().error).toBe('plan_generation_failed');

    const mutatePlan = await app.inject({
      method: 'PATCH',
      url: `/api/web/trading/p9/plans/${planA.planId}`,
      headers: mutationHeaders(sessionB),
      payload: { status: 'USER_CONFIRMED' },
    });
    expect(mutatePlan.statusCode).toBe(400);
    expect(mutatePlan.json().error).toBe('plan_status_update_failed');

    const saveOwnerBSettings = await app.inject({
      method: 'PUT',
      url: '/api/web/trading/p9/settings',
      headers: mutationHeaders(sessionB),
      payload: { minNetProfit: 22_222 },
    });
    expect(saveOwnerBSettings.statusCode).toBe(200);
    expect(saveOwnerBSettings.json().settings.minNetProfit).toBe(22_222);

    expect(P9OpportunityService.get(db, CHARACTER_ID, 'OPP-A-PRIVATE', lineageA)?.state).toBe('NEW');
    expect(P9OpportunityService.get(db, CHARACTER_ID, 'OPP-A-PRIVATE', lineageB)).toBeNull();
    expect(P9OpportunityService.listPlans(db, CHARACTER_ID, undefined, lineageA).map((plan) => plan.planId))
      .toEqual([planA.planId]);
    expect(P9OpportunityService.listPlans(db, CHARACTER_ID, undefined, lineageB)).toEqual([]);
    expect(P9OpportunityService.getSettings(db, CHARACTER_ID, lineageA).minNetProfit).toBe(11_111);
    expect(P9OpportunityService.getSettings(db, CHARACTER_ID, lineageB).minNetProfit).toBe(22_222);
    expect(db.prepare('SELECT COUNT(*) AS n FROM p9_trade_audit_events WHERE character_id = ? AND owner_user_id = ?')
      .get(CHARACTER_ID, lineageA.ownerUserId)).toEqual({ n: 1 });
  });

  it('keeps same-owner chat lanes separate for reads and mutations', () => {
    const laneB: AssetLineage = {
      ...lineageA,
      ownerChatId: sessionB.chatId,
      bindingDigest: 'lane-b-binding-digest',
    };
    insertSettings(lineageA, 33_333);
    insertOpportunity(lineageA, 'OPP-LANE-A', 'LANE_A_MARKER');
    const planA = P9OpportunityService.createPlan(db, CHARACTER_ID, 'OPP-LANE-A', undefined, lineageA);

    expect(P9OpportunityService.get(db, CHARACTER_ID, 'OPP-LANE-A', laneB)).toBeNull();
    expect(P9OpportunityService.list(db, CHARACTER_ID, {}, laneB).rows).toEqual([]);
    expect(P9OpportunityService.getSettings(db, CHARACTER_ID, laneB).minNetProfit).toBe(100_000);
    expect(P9OpportunityService.listPlans(db, CHARACTER_ID, undefined, laneB)).toEqual([]);
    expect(() => P9OpportunityService.transition(db, CHARACTER_ID, 'OPP-LANE-A', 'WATCHING', undefined, laneB)).toThrow();
    expect(() => P9OpportunityService.transitionPlan(db, CHARACTER_ID, planA.planId, 'USER_CONFIRMED', undefined, laneB)).toThrow();
    insertSettings(laneB, 44_444);
    expect(P9OpportunityService.getSettings(db, CHARACTER_ID, lineageA).minNetProfit).toBe(33_333);
    expect(P9OpportunityService.getSettings(db, CHARACTER_ID, laneB).minNetProfit).toBe(44_444);
  });

  it('filters AI-analysis opportunity context by lineage', () => {
    insertOpportunity(lineageA, 'OPP-AI-A', 'AI_OWNER_A_MARKER', 'ACTIONABLE');
    const lineageB: AssetLineage = {
      ...lineageA,
      ownerUserId: lineageA.ownerUserId + 1,
      ownerChatId: (lineageA.ownerChatId ?? 0) + 1,
      bindingDigest: 'ai-owner-b-binding',
    };
    insertOpportunity(lineageB, 'OPP-AI-B', 'AI_OWNER_B_MARKER', 'ACTIONABLE');

    const promptA = buildP9AnalysisPrompt(db, CHARACTER_ID, lineageA, { mode: 'daily' });
    expect(promptA.prompt).toContain('OPP-AI-A');
    expect(promptA.prompt).toContain('AI_OWNER_A_MARKER');
    expect(promptA.prompt).not.toContain('OPP-AI-B');
    expect(promptA.prompt).not.toContain('AI_OWNER_B_MARKER');

    const promptB = buildP9AnalysisPrompt(db, CHARACTER_ID, lineageB, {
      mode: 'opportunity',
      opportunityIds: ['OPP-AI-A'],
    });
    expect(promptB.opportunityIds).toEqual([]);
    expect(promptB.prompt).not.toContain('AI_OWNER_A_MARKER');
  });
});
