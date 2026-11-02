import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { requireSession, requireMutationSession } from './web-route-guards.js';
import { PortfolioManager } from '../trading/portfolio-manager.js';
import { StationArbitrageStrategy } from '../trading/strategies/station-arbitrage.js';
import { RegionalHaulingStrategy, STANDARD_HIGHSEC_ROUTES } from '../trading/strategies/regional-hauling.js';
import { ManufacturingArbitrageStrategy } from '../trading/strategies/manufacturing-arbitrage.js';
import { TrendAnalysisStrategy } from '../trading/strategies/trend-following.js';
import { DraftSystem } from '../trading/draft-system.js';
import { PaperTradingSystem } from '../trading/paper-trading.js';
import { getLinkedCharacter } from '../eve/sso.js';
import type { WebSession } from './web-session.js';
function sessionContext(session: WebSession) { return { userId: session.userId, chatId: session.chatId }; }

export function registerTradingRoutes(app: FastifyInstance, db: Db): void {
  // 1. Capital Breakdown & Risk Limits
  app.get('/api/web/trading/capital', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = getLinkedCharacter(db, sessionContext(session));
    if (!char) {
      return reply.status(404).send({ error: '尚未关联 EVE 角色' });
    }
    const breakdown = PortfolioManager.getCapitalBreakdown(db, char.characterId);
    return { capital: breakdown };
  });

  // 2. Station Arbitrage Scanner
  app.get<{ Querystring: { stationId?: string } }>('/api/web/trading/scan/station', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const stationId = request.query.stationId ? Number(request.query.stationId) : 60003760; // Jita 4-4
    const opps = StationArbitrageStrategy.scan(db, {
      stationId,
      regionId: 10000002,
      minNetMarginPct: 8.0,
      minNetProfit: 50_000,
      maxCapitalPerItem: 30_000_000,
    });
    return { opportunities: opps.slice(0, 25) };
  });

  // 3. High-sec Regional Hauling Scanner
  app.get<{ Querystring: { routeIndex?: string; mode?: string } }>('/api/web/trading/scan/hauling', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const idx = request.query.routeIndex ? Number(request.query.routeIndex) : 0;
    const route = STANDARD_HIGHSEC_ROUTES[idx] || STANDARD_HIGHSEC_ROUTES[0];
    const opps = RegionalHaulingStrategy.scan(db, {
      route,
      mode: (request.query.mode as any) || 'all',
      minNetMarginPct: 6.0,
      minNetProfit: 100_000,
      maxCapital: 50_000_000,
      maxCargoM3: 5_000,
    });
    return { route, opportunities: opps.slice(0, 25) };
  });

  // 4. Reprocessing vs Market Analysis
  app.get<{ Params: { typeId: string } }>('/api/web/trading/reprocess/:typeId', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const typeId = Number(request.params.typeId);
    const analysis = ManufacturingArbitrageStrategy.analyzeReprocessing(db, typeId);
    if (!analysis) {
      return reply.status(404).send({ error: '该物品无法再处理或缺少矿物数据' });
    }
    return { analysis };
  });

  // 5. Trend Analysis
  app.get<{ Params: { typeId: string }; Querystring: { regionId?: string } }>('/api/web/trading/trend/:typeId', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const typeId = Number(request.params.typeId);
    const regionId = request.query.regionId ? Number(request.query.regionId) : 10000002;
    const trend = TrendAnalysisStrategy.analyzeTrend(db, typeId, regionId);
    if (!trend) {
      return reply.status(404).send({ error: '暂无该物品的历史价格点' });
    }
    return { trend };
  });

  // 6. Trade Drafts Management
  app.get<{ Querystring: { status?: string } }>('/api/web/trading/drafts', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = getLinkedCharacter(db, sessionContext(session));
    if (!char) return { drafts: [] };
    const drafts = DraftSystem.getDrafts(db, char.characterId, request.query.status);
    return { drafts };
  });

  app.post('/api/web/trading/drafts/auto', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = getLinkedCharacter(db, sessionContext(session));
    if (!char) return reply.status(404).send({ error: '尚未关联角色' });

    const bd = PortfolioManager.getCapitalBreakdown(db, char.characterId);
    const opps = RegionalHaulingStrategy.scan(db, {
      route: STANDARD_HIGHSEC_ROUTES[0],
      mode: 'instant_fill',
      minNetMarginPct: 8.0,
      minNetProfit: 200_000,
      maxCapital: bd.singleItemCapIsk,
    });

    const validOpps = opps.filter(o => {
      const risk = PortfolioManager.validateTradeRisk(bd, o.capitalRequired, o.strategy, o.volumeM3 * o.suggestedQuantity);
      return risk.allowed;
    });

    if (validOpps.length === 0) {
      return reply.status(409).send({ error: '当前无满足全部风控条件的即时套利机会' });
    }

    const draft = DraftSystem.createDraft(db, char.characterId, validOpps[0], 24);
    return { draft, opportunity: validOpps[0] };
  });

  app.post<{ Params: { draftId: string } }>('/api/web/trading/drafts/:draftId/approve', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const ok = DraftSystem.updateStatus(db, request.params.draftId, 'approved');
    if (!ok) return reply.status(404).send({ error: '草案不存在' });
    return { success: true };
  });

  app.post<{ Params: { draftId: string } }>('/api/web/trading/drafts/:draftId/reject', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const ok = DraftSystem.updateStatus(db, request.params.draftId, 'rejected');
    if (!ok) return reply.status(404).send({ error: '草案不存在' });
    return { success: true };
  });

  app.post<{
    Params: { draftId: string };
    Body: { actualBuyPrice: number; actualSellPrice: number; actualQuantity: number; actualFees: number; notes?: string };
  }>('/api/web/trading/drafts/:draftId/execute', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const b = request.body;
    const ok = DraftSystem.recordManualExecution(db, {
      draftId: request.params.draftId,
      actualBuyPrice: Number(b.actualBuyPrice),
      actualSellPrice: Number(b.actualSellPrice),
      actualQuantity: Number(b.actualQuantity),
      actualFees: Number(b.actualFees || 0),
      notes: b.notes,
    });
    if (!ok) return reply.status(404).send({ error: '草案不存在' });
    return { success: true };
  });

  // 7. Paper Trading
  app.get('/api/web/trading/paper', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = getLinkedCharacter(db, sessionContext(session));
    if (!char) return { positions: [], totalInvested: 0, totalCurrentValue: 0, totalUnrealizedPnl: 0, totalRealizedPnl: 0 };
    return PaperTradingSystem.getPortfolio(db, char.characterId);
  });
}