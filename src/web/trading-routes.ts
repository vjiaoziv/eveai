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
import { PerformanceAnalytics } from '../trading/performance-analytics.js';
import { PaperTradingRuntimeValidation } from '../trading/runtime-validation.js';
import { getLinkedCharacter } from '../eve/sso.js';
import type { WebSession } from './web-session.js';
import { clampNonNegativeInteger, clampPositiveInteger } from '../util/query-bounds.js';
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
    const stationId = clampPositiveInteger(request.query.stationId, 60003760, Number.MAX_SAFE_INTEGER); // Jita 4-4 by default
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
    const idx = clampNonNegativeInteger(request.query.routeIndex, 0, Math.max(0, STANDARD_HIGHSEC_ROUTES.length - 1));
    const route = STANDARD_HIGHSEC_ROUTES[idx] || STANDARD_HIGHSEC_ROUTES[0];
    const mode = request.query.mode === 'instant_fill' || request.query.mode === 'listed_sell' || request.query.mode === 'all'
      ? request.query.mode
      : 'all';
    const opps = RegionalHaulingStrategy.scan(db, {
      route,
      mode,
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
    const typeId = clampPositiveInteger(request.params.typeId, 0, Number.MAX_SAFE_INTEGER);
    if (!typeId) return reply.status(400).send({ error: 'typeId 必须是正整数' });
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
    const typeId = clampPositiveInteger(request.params.typeId, 0, Number.MAX_SAFE_INTEGER);
    if (!typeId) return reply.status(400).send({ error: 'typeId 必须是正整数' });
    const regionId = clampPositiveInteger(request.query.regionId, 10000002, Number.MAX_SAFE_INTEGER);
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

    // Enforce 10-stage pipeline: only A or approved B can generate drafts
    const validOpps = opps.filter(o => o.opportunityRating !== 'D' && !o.riskVetoReason);
    if (validOpps.length === 0) {
      return reply.status(409).send({ error: '当前无通过统一决策管线风控评估的高等级套利机会' });
    }

    try {
      const draft = DraftSystem.createDraft(db, char.characterId, validOpps[0], 24);
      return { draft, opportunity: validOpps[0] };
    } catch (err: any) {
      return reply.status(409).send({ error: err.message });
    }
  });

  app.post<{ Params: { draftId: string } }>('/api/web/trading/drafts/:draftId/approve', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = getLinkedCharacter(db, sessionContext(session));
    if (!char) return reply.status(404).send({ error: '尚未关联 EVE 角色' });
    try {
      const ok = DraftSystem.updateStatus(db, request.params.draftId, 'approved', undefined, char.characterId);
      if (!ok) return reply.status(404).send({ error: '草案不存在' });
      return { success: true };
    } catch (err: any) {
      return reply.status(403).send({ error: err.message });
    }
  });

  app.post<{ Params: { draftId: string } }>('/api/web/trading/drafts/:draftId/reject', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = getLinkedCharacter(db, sessionContext(session));
    if (!char) return reply.status(404).send({ error: '尚未关联 EVE 角色' });
    const ok = DraftSystem.updateStatus(db, request.params.draftId, 'rejected', undefined, char.characterId);
    if (!ok) return reply.status(404).send({ error: '草案不存在' });
    return { success: true };
  });

  app.post<{
    Params: { draftId: string };
    Body: { actualBuyPrice: number; actualSellPrice: number; actualQuantity: number; actualFees: number; notes?: string };
  }>('/api/web/trading/drafts/:draftId/execute', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = getLinkedCharacter(db, sessionContext(session));
    if (!char) return reply.status(404).send({ error: '尚未关联 EVE 角色' });
    const b = request.body;
    try {
      const ok = DraftSystem.recordManualExecution(db, {
        draftId: request.params.draftId,
        actualBuyPrice: Number(b.actualBuyPrice),
        actualSellPrice: Number(b.actualSellPrice),
        actualQuantity: Number(b.actualQuantity),
        actualFees: Number(b.actualFees || 0),
        notes: b.notes,
        characterId: char.characterId,
      });
      if (!ok) return reply.status(404).send({ error: '草案不存在' });
      return { success: true };
    } catch (err: any) {
      return reply.status(403).send({ error: err.message });
    }
  });

  // 7. Paper Trading
  app.get('/api/web/trading/paper', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = getLinkedCharacter(db, sessionContext(session));
    if (!char) return { positions: [], totalInvested: 0, totalCurrentValue: 0, totalUnrealizedPnl: 0, totalRealizedPnl: 0 };
    if (!PaperTradingSystem.getAccount(db, char.characterId)) {
      return {
        initialized: false,
        message: 'Paper Trading 尚未初始化；读取接口不会创建模拟账户。',
        positions: [],
        totalInvested: 0,
        totalCurrentValue: 0,
        totalUnrealizedPnl: 0,
        totalRealizedPnl: 0,
      };
    }
    return { initialized: true, ...PaperTradingSystem.getPortfolio(db, char.characterId) };
  });

  app.get('/api/web/trading/paper/overview', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = getLinkedCharacter(db, sessionContext(session));
    if (!char) return reply.status(404).send({ error: '尚未关联 EVE 角色' });
    if (!PaperTradingSystem.getAccount(db, char.characterId)) {
      return reply.status(200).send({
        initialized: false,
        message: 'Paper Trading 尚未初始化；读取接口不会创建模拟账户。',
        portfolio: null,
        performance: null,
        runtime: null,
      });
    }
    return {
      initialized: true,
      portfolio: PaperTradingSystem.getPortfolio(db, char.characterId),
      performance: PerformanceAnalytics.compute(db, char.characterId),
      runtime: PaperTradingRuntimeValidation.build(db, char.characterId),
    };
  });

  app.get<{ Querystring: { status?: string; limit?: string } }>('/api/web/trading/paper/orders', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = getLinkedCharacter(db, sessionContext(session));
    if (!char) return { orders: [] };
    const limit = clampPositiveInteger(request.query.limit, 100, 500);
    const params: unknown[] = [char.characterId];
    let sql = `
      SELECT o.*, COALESCE(COUNT(f.fill_id), 0) AS fill_count,
             COALESCE(SUM(f.quantity), 0) AS filled_from_fills,
             COALESCE(SUM(f.fees), 0) AS fees_from_fills
      FROM paper_trading_orders o
      LEFT JOIN paper_fills f ON f.order_id = o.order_id
      WHERE o.character_id = ?
    `;
    if (request.query.status) {
      sql += ' AND o.status = ?';
      params.push(request.query.status);
    }
    sql += ' GROUP BY o.order_id ORDER BY o.created_at DESC LIMIT ?';
    params.push(limit);
    return { orders: db.prepare(sql).all(...params) };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/web/trading/paper/opportunities', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = getLinkedCharacter(db, sessionContext(session));
    if (!char) return { opportunities: [] };
    const limit = clampPositiveInteger(request.query.limit, 100, 500);
    const rows = db.prepare(`
      SELECT p.* FROM trade_opportunities_log p
      WHERE EXISTS (
        SELECT 1 FROM paper_trading_orders owner
        WHERE owner.opportunity_id = p.opportunity_id AND owner.character_id = ?
      )
      ORDER BY p.detected_at DESC LIMIT ?
    `).all(char.characterId, limit) as any[];
    return {
      opportunities: rows.map((row) => ({
        ...row,
        profit_layers: row.profit_layers_json ? JSON.parse(row.profit_layers_json) : null,
        data_quality: row.data_quality_json ? JSON.parse(row.data_quality_json) : null,
      })),
    };
  });

  app.get<{ Querystring: { orderId?: string; limit?: string } }>('/api/web/trading/paper/fills', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = getLinkedCharacter(db, sessionContext(session));
    if (!char) return { fills: [] };
    const limit = clampPositiveInteger(request.query.limit, 200, 1000);
    if (request.query.orderId) {
      const owned = db.prepare('SELECT 1 FROM paper_trading_orders WHERE order_id = ? AND character_id = ?')
        .get(request.query.orderId, char.characterId);
      if (!owned) return reply.status(404).send({ error: '订单不存在' });
      return {
        fills: db.prepare(`
          SELECT f.* FROM paper_fills f
          JOIN paper_trading_orders o ON o.order_id = f.order_id
          WHERE f.order_id = ? AND o.character_id = ?
          ORDER BY f.filled_at, f.rowid
        `).all(request.query.orderId, char.characterId),
      };
    }
    return {
      fills: db.prepare(`
        SELECT f.*, o.strategy_type, o.order_type, o.status AS order_status
        FROM paper_fills f
        JOIN paper_trading_orders o ON o.order_id = f.order_id
        WHERE o.character_id = ?
        ORDER BY f.filled_at DESC, f.rowid DESC
        LIMIT ?
      `).all(char.characterId, limit),
    };
  });

  app.get('/api/web/trading/paper/performance', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = getLinkedCharacter(db, sessionContext(session));
    if (!char) return reply.status(404).send({ error: '尚未关联 EVE 角色' });
    if (!PaperTradingSystem.getAccount(db, char.characterId)) {
      return { initialized: false, message: 'Paper Trading 尚未初始化；读取接口不会创建模拟账户。', performance: null };
    }
    return { initialized: true, performance: PerformanceAnalytics.compute(db, char.characterId) };
  });

  app.get('/api/web/trading/paper/runtime-validation', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = getLinkedCharacter(db, sessionContext(session));
    if (!char) return reply.status(404).send({ error: '尚未关联 EVE 角色' });
    if (!PaperTradingSystem.getAccount(db, char.characterId)) {
      return { initialized: false, message: 'Paper Trading 尚未初始化；读取接口不会创建模拟账户。', validation: null };
    }
    return { initialized: true, validation: PaperTradingRuntimeValidation.build(db, char.characterId) };
  });

  app.get('/api/web/trading/paper/risk', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = getLinkedCharacter(db, sessionContext(session));
    if (!char) return reply.status(404).send({ error: '尚未关联 EVE 角色' });
    if (!PaperTradingSystem.getAccount(db, char.characterId)) {
      return { initialized: false, message: 'Paper Trading 尚未初始化；读取接口不会创建模拟账户。', risk: null };
    }
    const validation = PaperTradingRuntimeValidation.build(db, char.characterId);
    return {
      risk: {
        flags: validation.performance.riskFlags,
        gates: validation.gates,
        highRiskOpportunities: db.prepare(`
          SELECT p.* FROM trade_opportunities_log p
          WHERE (p.risk_rating IN ('C', 'D') OR p.outcome_status = 'vetoed')
            AND EXISTS (
              SELECT 1 FROM paper_trading_orders owner
              WHERE owner.opportunity_id = p.opportunity_id AND owner.character_id = ?
            )
          ORDER BY p.detected_at DESC LIMIT 100
        `).all(char.characterId),
        staleSnapshots: db.prepare(`
          SELECT * FROM market_snapshot_regions
          WHERE expires_at IS NULL OR expires_at < datetime('now')
          ORDER BY fetched_at DESC LIMIT 100
        `).all(),
        unfilledOrders: db.prepare(`
          SELECT * FROM paper_trading_orders
          WHERE character_id = ? AND status IN ('open', 'partially_filled')
          ORDER BY created_at DESC
        `).all(char.characterId),
      },
    };
  });
}

