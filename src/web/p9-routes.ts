import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';
import { getLinkedCharacter } from '../eve/sso.js';
import type { WebSession } from './web-session.js';
import { P9OpportunityService } from '../trading/p9-opportunity-service.js';
import { P9RealPortfolioService } from '../trading/p9-real-portfolio.js';
import { P93LedgerService } from '../trading/p9-3-ledger-service.js';
import type { P9OpportunityState, P9PlanStatus } from '../trading/p9-types.js';
import { resolveAssetLineage } from '../assets/asset-lineage.js';
import { realLedgerLineagePredicate } from '../trading/p9-3-lineage.js';
import { p9LineagePredicate } from '../trading/p9-control-plane-lineage.js';

function sessionContext(session: WebSession) {
  return { userId: session.userId, chatId: session.chatId };
}

function linkedCharacter(db: Db, session: WebSession, reply: FastifyReply) {
  const char = getLinkedCharacter(db, sessionContext(session));
  if (!char) {
    reply.status(404).send({ error: 'p9_character_required' });
    return null;
  }
  return char;
}

function requireLineage(db: Db, session: WebSession, reply: FastifyReply, characterId: number) {
  try {
    return resolveAssetLineage(db, characterId, session.userId, session.chatId);
  } catch {
    reply.status(403).send({ error: 'character_asset_context_invalid' });
    return null;
  }
}

function text(body: Record<string, unknown>, key: string, fallback?: string): string {
  const value = body[key];
  if (value == null && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${key} 必填。`);
  return value.trim();
}

function integer(body: Record<string, unknown>, key: string, fallback?: number): number {
  const value = body[key];
  if (value == null && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${key} 必须是整数。`);
  return parsed;
}

function number(body: Record<string, unknown>, key: string, fallback?: number): number {
  const value = body[key];
  if (value == null && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${key} 必须是有限数值。`);
  return parsed;
}

export function registerP9Routes(app: FastifyInstance, db: Db): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/web/trading/p9/')) {
      reply.header('Cache-Control', 'no-store');
    }
  });

  const asBody = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象。');
    return value as Record<string, unknown>;
  };

  app.get('/api/web/trading/p9/settings', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    return { settings: P9OpportunityService.getSettings(db, char.characterId, lineage) };
  });

  app.put('/api/web/trading/p9/settings', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    try {
      const body = asBody(request.body);
      const hubsRaw = body.hubs;
      const strategiesRaw = body.strategies;
      const settings = P9OpportunityService.saveSettings(db, {
        characterId: char.characterId,
        hubs: Array.isArray(hubsRaw) ? hubsRaw as never : undefined,
        strategies: Array.isArray(strategiesRaw) ? strategiesRaw as never : undefined,
        minNetProfit: body.minNetProfit == null ? undefined : number(body, 'minNetProfit'),
        minRoiPct: body.minRoiPct == null ? undefined : number(body, 'minRoiPct'),
        maxCapital: body.maxCapital == null ? undefined : number(body, 'maxCapital'),
        maxMarketAgeMinutes: body.maxMarketAgeMinutes == null ? undefined : integer(body, 'maxMarketAgeMinutes'),
        maxResults: body.maxResults == null ? undefined : integer(body, 'maxResults'),
        autoScanEnabled: body.autoScanEnabled == null ? undefined : Boolean(body.autoScanEnabled),
        autoScanIntervalMinutes: body.autoScanIntervalMinutes == null ? undefined : integer(body, 'autoScanIntervalMinutes'),
      }, lineage);
      return { settings };
    } catch {
      return reply.status(400).send({ error: 'config_save_failed' });
    }
  });

  app.post('/api/web/trading/p9/scan', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {};
    const rawTypeIds = body.typeIds;
    const typeIds = Array.isArray(rawTypeIds)
      ? rawTypeIds.map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0).slice(0, 500)
      : [];
    const result = P9OpportunityService.scan(db, char.characterId, { typeIds }, lineage);
    if (result.errors.length > 0) return reply.status(500).send(result);
    return result;
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/trading/p9/opportunities', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    const query = request.query;
    return P9OpportunityService.list(db, char.characterId, {
      state: query.state,
      strategy: query.strategy,
      hubLocationId: query.hub_location ? Number(query.hub_location) : undefined,
      query: query.q,
      sort: query.sort,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    }, lineage);
  });

  app.get<{ Params: { opportunityId: string } }>('/api/web/trading/p9/opportunities/:opportunityId', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    const opportunity = P9OpportunityService.get(db, char.characterId, request.params.opportunityId, lineage);
    if (!opportunity) return reply.status(404).send({ error: 'p9_opportunity_not_found' });
    const plan = P9OpportunityService.getPlanByOpportunity(db, char.characterId, opportunity.opportunityId, lineage);
    return {
      opportunity,
      originalSnapshot: opportunity.originalSnapshot,
      plan,
      executionDisabled: true,
    };
  });
  app.patch<{ Params: { opportunityId: string } }>('/api/web/trading/p9/opportunities/:opportunityId', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    try {
      const body = asBody(request.body);
      const state = text(body, 'state') as P9OpportunityState;
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      return { opportunity: P9OpportunityService.transition(db, char.characterId, request.params.opportunityId, state, reason, lineage) };
    } catch {
      return reply.status(400).send({ error: 'status_update_failed' });
    }
  });

  app.post('/api/web/trading/p9/plans', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    try {
      const body = asBody(request.body);
      const plan = P9OpportunityService.createPlan(db, char.characterId, text(body, 'opportunityId'), {
        exitPlan: typeof body.exitPlan === 'string' ? body.exitPlan : undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
      }, lineage);
      return { plan };
    } catch {
      return reply.status(400).send({ error: 'plan_generation_failed' });
    }
  });

  app.get<{ Querystring: { status?: string } }>('/api/web/trading/p9/plans', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    return { plans: P9OpportunityService.listPlans(db, char.characterId, request.query.status, lineage) };
  });

  app.patch<{ Params: { planId: string } }>('/api/web/trading/p9/plans/:planId', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    try {
      const body = asBody(request.body);
      const status = text(body, 'status') as P9PlanStatus;
      const note = typeof body.note === 'string' ? body.note : undefined;
      return { plan: P9OpportunityService.transitionPlan(db, char.characterId, request.params.planId, status, note, lineage) };
    } catch {
      return reply.status(400).send({ error: 'plan_status_update_failed' });
    }
  });

  app.get('/api/web/trading/p9/overview', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    const portfolio = P9RealPortfolioService.overview(db, char.characterId, lineage);
    const ledgerSummary = P93LedgerService.summary(db, char.characterId, lineage);
    const settings = P9OpportunityService.getSettings(db, char.characterId, lineage);
    const opportunityOwner = p9LineagePredicate(null, lineage);
    const latestJob = db.prepare(`
      SELECT * FROM p9_job_runs
      WHERE character_id = ? AND job_type = 'market_scan' AND ${opportunityOwner.sql}
      ORDER BY started_at DESC LIMIT 1
    `).get(char.characterId, ...opportunityOwner.params) as any;
    const riskRows = db.prepare(`
      SELECT risk_level, state, COUNT(*) AS count
      FROM p9_real_opportunities
      WHERE character_id = ? AND ${opportunityOwner.sql}
      GROUP BY risk_level, state
    `).all(char.characterId, ...opportunityOwner.params) as any[];
    return {
      portfolio,
      ledgerSummary,
      trades: {
        count: portfolio.performance.tradeCount,
        verified: ledgerSummary.rows,
      },
      settings,
      marketScan: latestJob || null,
      riskSummary: riskRows,
      separation: {
        real: true,
        paper: true,
        combinedTotalReturns: false,
        realTradingExecutionDisabled: true,
      },
    };
  });

  const legacyAccountingGone = async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.method === 'GET'
      ? requireSession(db, request, reply)
      : requireMutationSession(db, request, reply);
    if (!session) return;
    return reply.status(410).send({
      error: 'p9_legacy_ledger_retired',
      replacement: '/api/web/trading/p9/real-ledger',
    });
  };
  for (const route of [
    { method: 'GET' as const, url: '/api/web/trading/p9/inventory' },
    { method: 'POST' as const, url: '/api/web/trading/p9/inventory/lots' },
    { method: 'GET' as const, url: '/api/web/trading/p9/real-trades' },
    { method: 'POST' as const, url: '/api/web/trading/p9/real-trades' },
    { method: 'PUT' as const, url: '/api/web/trading/p9/real-trades/:tradeId' },
    { method: 'POST' as const, url: '/api/web/trading/p9/real-trades/esi-sync' },
    { method: 'POST' as const, url: '/api/web/trading/p9/rebuild-ledger' },
  ]) {
    if (route.method === 'GET') app.get(route.url, legacyAccountingGone);
    else if (route.method === 'POST') app.post(route.url, legacyAccountingGone);
    else app.put(route.url, legacyAccountingGone);
  }
  app.get('/api/web/trading/p9/risk', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    const ledgerOwnership = realLedgerLineagePredicate(null, lineage);
    const opportunityOwner = p9LineagePredicate(null, lineage);
    const aliasedOpportunityOwner = p9LineagePredicate('o', lineage);
    const flags = db.prepare(`
      SELECT value AS flag, COUNT(*) AS count
      FROM p9_real_opportunities o, json_each(o.risk_flags_json)
      WHERE o.character_id = ? AND ${aliasedOpportunityOwner.sql}
      GROUP BY value
      ORDER BY count DESC
    `).all(char.characterId, ...aliasedOpportunityOwner.params) as any[];
    const stale = db.prepare(`
      SELECT state, COUNT(*) AS count FROM p9_real_opportunities
      WHERE character_id = ? AND ${opportunityOwner.sql}
        AND (state IN ('STALE', 'EXPIRED') OR data_fresh = 0)
      GROUP BY state
    `).all(char.characterId, ...opportunityOwner.params) as any[];
    const unknownCosts = db.prepare(`
      SELECT COUNT(*) AS lots FROM real_fifo_lots
      WHERE character_id = ? AND ${ledgerOwnership.sql}
        AND remaining_quantity > 0 AND cost_status <> 'KNOWN'
    `).get(char.characterId, ...ledgerOwnership.params) as any;
    const syncErrors = db.prepare(`
      SELECT dataset, status, error FROM character_sync_state
      WHERE character_id = ? AND status = 'error'
    `).all(char.characterId) as any[];
    return {
      flags,
      stale,
      unknownInventoryLots: Number(unknownCosts?.lots || 0),
      syncErrors,
      controls: {
        minNetProfit: P9OpportunityService.getSettings(db, char.characterId, lineage).minNetProfit,
        minRoiPct: P9OpportunityService.getSettings(db, char.characterId, lineage).minRoiPct,
        maxCapital: P9OpportunityService.getSettings(db, char.characterId, lineage).maxCapital,
        maxMarketAgeMinutes: P9OpportunityService.getSettings(db, char.characterId, lineage).maxMarketAgeMinutes,
        realTradingExecutionDisabled: true,
      },
    };
  });

  app.get('/api/web/trading/p9/jobs', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    const owner = p9LineagePredicate(null, lineage);
    return {
      jobs: db.prepare(`
        SELECT * FROM p9_job_runs
        WHERE character_id = ? AND ${owner.sql}
        ORDER BY started_at DESC LIMIT 100
      `).all(char.characterId, ...owner.params),
    };
  });
}
