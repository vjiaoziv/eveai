import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';
import { getLinkedCharacter } from '../eve/sso.js';
import type { WebSession } from './web-session.js';
import { P9OpportunityService } from '../trading/p9-opportunity-service.js';
import { P9RealPortfolioService } from '../trading/p9-real-portfolio.js';
import { P9RealTradeService } from '../trading/p9-real-trades.js';
import type { P9OpportunityState, P9PlanStatus, P9RealTradeInput } from '../trading/p9-types.js';

function sessionContext(session: WebSession) {
  return { userId: session.userId, chatId: session.chatId };
}

function linkedCharacter(db: Db, session: WebSession, reply: FastifyReply) {
  const char = getLinkedCharacter(db, sessionContext(session));
  if (!char) {
    reply.status(404).send({ error: '尚未关联 EVE 角色，无法读取真实资产或记录交易。' });
    return null;
  }
  return char;
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
    return { settings: P9OpportunityService.getSettings(db, char.characterId) };
  });

  app.put('/api/web/trading/p9/settings', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
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
      });
      return { settings };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '配置保存失败。' });
    }
  });

  app.post('/api/web/trading/p9/scan', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {};
    const rawTypeIds = body.typeIds;
    const typeIds = Array.isArray(rawTypeIds)
      ? rawTypeIds.map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0).slice(0, 500)
      : [];
    const result = P9OpportunityService.scan(db, char.characterId, { typeIds });
    if (result.errors.length > 0) return reply.status(500).send(result);
    return result;
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/trading/p9/opportunities', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const query = request.query;
    return P9OpportunityService.list(db, char.characterId, {
      state: query.state,
      strategy: query.strategy,
      hubLocationId: query.hub_location ? Number(query.hub_location) : undefined,
      query: query.q,
      sort: query.sort,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });
  });

  app.get<{ Params: { opportunityId: string } }>('/api/web/trading/p9/opportunities/:opportunityId', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const opportunity = P9OpportunityService.get(db, char.characterId, request.params.opportunityId);
    if (!opportunity) return reply.status(404).send({ error: '机会不存在。' });
    const plan = db.prepare('SELECT * FROM p9_trade_plans WHERE opportunity_id = ?').get(opportunity.opportunityId) as any;
    return {
      opportunity,
      originalSnapshot: opportunity.originalSnapshot,
      plan: plan || null,
      executionDisabled: true,
    };
  });
  app.patch<{ Params: { opportunityId: string } }>('/api/web/trading/p9/opportunities/:opportunityId', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    try {
      const body = asBody(request.body);
      const state = text(body, 'state') as P9OpportunityState;
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      return { opportunity: P9OpportunityService.transition(db, char.characterId, request.params.opportunityId, state, reason) };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '状态更新失败。' });
    }
  });

  app.post('/api/web/trading/p9/plans', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    try {
      const body = asBody(request.body);
      const plan = P9OpportunityService.createPlan(db, char.characterId, text(body, 'opportunityId'), {
        exitPlan: typeof body.exitPlan === 'string' ? body.exitPlan : undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
      });
      return { plan };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '交易方案生成失败。' });
    }
  });

  app.get<{ Querystring: { status?: string } }>('/api/web/trading/p9/plans', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    return { plans: P9OpportunityService.listPlans(db, char.characterId, request.query.status) };
  });

  app.patch<{ Params: { planId: string } }>('/api/web/trading/p9/plans/:planId', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    try {
      const body = asBody(request.body);
      const status = text(body, 'status') as P9PlanStatus;
      const note = typeof body.note === 'string' ? body.note : undefined;
      return { plan: P9OpportunityService.transitionPlan(db, char.characterId, request.params.planId, status, note) };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '交易方案状态更新失败。' });
    }
  });

  app.get('/api/web/trading/p9/overview', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const portfolio = P9RealPortfolioService.overview(db, char.characterId);
    const tradeSummary = P9RealTradeService.summary(db, char.characterId);
    const settings = P9OpportunityService.getSettings(db, char.characterId);
    const latestJob = db.prepare(`
      SELECT * FROM p9_job_runs WHERE character_id = ? AND job_type = 'market_scan'
      ORDER BY started_at DESC LIMIT 1
    `).get(char.characterId) as any;
    const riskRows = db.prepare(`
      SELECT risk_level, state, COUNT(*) AS count
      FROM p9_real_opportunities WHERE character_id = ?
      GROUP BY risk_level, state
    `).all(char.characterId) as any[];
    return {
      portfolio,
      trades: tradeSummary,
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

  app.get('/api/web/trading/p9/inventory', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    return P9RealPortfolioService.inventory(db, char.characterId);
  });

  app.post('/api/web/trading/p9/inventory/lots', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    try {
      const body = asBody(request.body);
      const costRaw = body.costPerUnit;
      const lot = P9RealPortfolioService.upsertManualLot(db, char.characterId, {
        itemId: body.itemId == null ? null : integer(body, 'itemId'),
        typeId: integer(body, 'typeId'),
        locationId: integer(body, 'locationId'),
        quantity: integer(body, 'quantity'),
        costPerUnit: costRaw == null ? null : number(body, 'costPerUnit'),
        acquiredAt: typeof body.acquiredAt === 'string' ? body.acquiredAt : undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
      });
      return { lot };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '库存成本保存失败。' });
    }
  });
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/trading/p9/real-trades', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    return P9RealTradeService.list(db, char.characterId, {
      direction: request.query.direction,
      source: request.query.source,
      limit: request.query.limit ? Number(request.query.limit) : undefined,
      offset: request.query.offset ? Number(request.query.offset) : undefined,
    });
  });

  app.post('/api/web/trading/p9/real-trades', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    try {
      const body = asBody(request.body);
      const input: P9RealTradeInput = {
        clientKey: text(body, 'clientKey'),
        direction: text(body, 'direction') as 'buy' | 'sell',
        typeId: integer(body, 'typeId'),
        locationId: integer(body, 'locationId'),
        quantity: integer(body, 'quantity'),
        price: number(body, 'price'),
        fee: body.fee == null ? 0 : number(body, 'fee'),
        tradeTime: text(body, 'tradeTime'),
        opportunityId: typeof body.opportunityId === 'string' && body.opportunityId ? body.opportunityId : undefined,
        planId: typeof body.planId === 'string' && body.planId ? body.planId : undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
        confirmed: body.confirmed == null ? true : Boolean(body.confirmed),
      };
      const trade = P9RealTradeService.recordManual(db, char.characterId, input);
      return { trade, summary: P9RealTradeService.summary(db, char.characterId) };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '真实交易录入失败。' });
    }
  });

  app.put<{ Params: { tradeId: string } }>('/api/web/trading/p9/real-trades/:tradeId', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    try {
      const body = asBody(request.body);
      const patch: Partial<P9RealTradeInput> & { feeStatus?: 'CONFIRMED' | 'UNKNOWN' } = {};
      if (body.direction != null) patch.direction = text(body, 'direction') as 'buy' | 'sell';
      if (body.typeId != null) patch.typeId = integer(body, 'typeId');
      if (body.locationId != null) patch.locationId = integer(body, 'locationId');
      if (body.quantity != null) patch.quantity = integer(body, 'quantity');
      if (body.price != null) patch.price = number(body, 'price');
      if (body.fee != null) patch.fee = number(body, 'fee');
      if (body.tradeTime != null) patch.tradeTime = text(body, 'tradeTime');
      if (body.opportunityId != null) patch.opportunityId = text(body, 'opportunityId');
      if (body.planId != null) patch.planId = text(body, 'planId');
      if (body.notes != null) patch.notes = typeof body.notes === 'string' ? body.notes : undefined;
      if (body.confirmed != null) patch.confirmed = Boolean(body.confirmed);
      if (body.feeStatus != null) patch.feeStatus = text(body, 'feeStatus') === 'UNKNOWN' ? 'UNKNOWN' : 'CONFIRMED';
      const trade = P9RealTradeService.updateManual(db, char.characterId, request.params.tradeId, patch);
      return { trade, summary: P9RealTradeService.summary(db, char.characterId) };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '交易记录修改失败。' });
    }
  });

  app.post('/api/web/trading/p9/real-trades/esi-sync', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const result = await P9RealTradeService.syncEsiTransactions(
      db,
      char.characterId,
      { userId: session.userId, chatId: session.chatId },
    );
    if (result.errors.length > 0 && result.imported === 0) return reply.status(502).send(result);
    return result;
  });

  app.post('/api/web/trading/p9/rebuild-ledger', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    P9RealTradeService.rebuild(db, char.characterId);
    return { ok: true, summary: P9RealTradeService.summary(db, char.characterId) };
  });

  app.get('/api/web/trading/p9/risk', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const flags = db.prepare(`
      SELECT value AS flag, COUNT(*) AS count
      FROM p9_real_opportunities, json_each(p9_real_opportunities.risk_flags_json)
      WHERE character_id = ?
      GROUP BY value
      ORDER BY count DESC
    `).all(char.characterId) as any[];
    const stale = db.prepare(`
      SELECT state, COUNT(*) AS count FROM p9_real_opportunities
      WHERE character_id = ? AND (state IN ('STALE', 'EXPIRED') OR data_fresh = 0)
      GROUP BY state
    `).all(char.characterId) as any[];
    const unknownCosts = db.prepare(`
      SELECT COUNT(*) AS lots FROM p9_inventory_lots
      WHERE character_id = ? AND cost_status = 'UNKNOWN'
    `).get(char.characterId) as any;
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
        minNetProfit: P9OpportunityService.getSettings(db, char.characterId).minNetProfit,
        minRoiPct: P9OpportunityService.getSettings(db, char.characterId).minRoiPct,
        maxCapital: P9OpportunityService.getSettings(db, char.characterId).maxCapital,
        maxMarketAgeMinutes: P9OpportunityService.getSettings(db, char.characterId).maxMarketAgeMinutes,
        realTradingExecutionDisabled: true,
      },
    };
  });

  app.get('/api/web/trading/p9/jobs', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    return {
      jobs: db.prepare(`
        SELECT * FROM p9_job_runs
        WHERE character_id IS NULL OR character_id = ?
        ORDER BY started_at DESC LIMIT 100
      `).all(char.characterId),
    };
  });
}