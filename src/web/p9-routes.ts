import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';
import { getLinkedCharacter } from '../eve/sso.js';
import type { WebSession } from './web-session.js';
import { P9OpportunityService } from '../trading/p9-opportunity-service.js';
import { P9RealPortfolioService } from '../trading/p9-real-portfolio.js';
import { P93FifoService } from '../trading/p9-3-fifo-service.js';
import { P93LedgerService } from '../trading/p9-3-ledger-service.js';
import type { P9OpportunityState, P9PlanStatus } from '../trading/p9-types.js';

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
    const accounting = P93FifoService.performance(db, char.characterId);
    const ledgerSummary = P93LedgerService.summary(db, char.characterId);
    const fifoLots = db.prepare(`
      SELECT COUNT(*) AS lot_count,
             SUM(CASE WHEN remaining_quantity > 0 THEN 1 ELSE 0 END) AS active_lot_count
      FROM real_fifo_lots WHERE character_id = ?
    `).get(char.characterId) as any;
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
      portfolio: {
        ...portfolio,
        funding: {
          ...portfolio.funding,
          knownInventoryCost: accounting.inventoryCost,
          unknownInventoryExitValue: null,
          note: 'REAL 财务指标来自 P9.3 已核实 FIFO；PAPER 不进入本统计。',
        },
        inventory: {
          ...portfolio.inventory,
          lotCount: Number(fifoLots?.active_lot_count || 0),
          knownCost: accounting.inventoryCost,
          unknownLotCount: accounting.unknownCostCount,
          unknownExitValue: null,
        },
        performance: {
          realizedNetPnl: accounting.realizedPnl,
          knownRealizedPnl: accounting.knownRealizedPnl,
          feesPaid: accounting.totalFees,
          unrealizedPnl: accounting.unrealizedPnl,
          tradeCount: accounting.tradeCount,
          profitableTradeRatio: accounting.profitableTradeRatio,
          averageHoldingDays: accounting.averageHoldingDays,
        },
      },
      ledgerSummary,
      trades: {
        count: accounting.tradeCount,
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
      error: '旧 P9 真实交易/库存账本接口已停用。请使用 /api/web/trading/p9/real-ledger。',
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
      SELECT COUNT(*) AS lots FROM real_fifo_lots
      WHERE character_id = ? AND remaining_quantity > 0 AND cost_status <> 'KNOWN'
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