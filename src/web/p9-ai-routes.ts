import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import type { UserContext } from '../auth/user-resolver.js';
import { runP9Analysis, type P9AnalysisInput, type P9AnalysisOutcome } from '../trading/p9-ai-analysis.js';
import { recordModelUsageSafe } from '../usage/tracker.js';
import { toUsageCounts } from '../usage/payer.js';
import { admitWebEvent } from './web-admission.js';
import { buildWebClientIpKey } from './web-session.js';
import { requireMutationSession } from './web-route-guards.js';
import { getLinkedCharacter } from '../eve/sso.js';

export type P9AnalysisRunner = (
  db: Db,
  characterId: number,
  input: P9AnalysisInput,
  ctx: UserContext,
  signal?: AbortSignal,
) => Promise<P9AnalysisOutcome>;

const COST_UNITS = 3;
const USAGE_THREAD_ID = 'web-p9-trade-analysis';

export function registerP9AiRoutes(
  app: FastifyInstance,
  db: Db,
  runner: P9AnalysisRunner = runP9Analysis,
): void {
  app.post<{ Body: unknown }>('/api/web/trading/p9/analyze', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    if (!config.web.aiSearchEnabled) {
      reply.header('Retry-After', '60');
      return reply.status(503).send({ error: 'AI 交易分析当前不可用。' });
    }
    const linked = getLinkedCharacter(db, { userId: session.userId, chatId: session.chatId });
    if (!linked) return reply.status(404).send({ error: '尚未关联 EVE 角色。' });

    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {};
    const mode = body.mode === 'daily' ? 'daily' : 'opportunity';
    const idsRaw = body.opportunityIds;
    const opportunityIds = Array.isArray(idsRaw)
      ? idsRaw.filter((value): value is string => typeof value === 'string').slice(0, 8)
      : [];
    const input: P9AnalysisInput = { mode, opportunityIds };

    const admission = admitWebEvent(db, {
      eventKind: 'ai-search',
      userId: session.userId,
      ipKey: buildWebClientIpKey(request.ip),
      costUnits: COST_UNITS,
    });
    if (!admission.ok) {
      reply.header('Retry-After', String(admission.retryAfterSeconds));
      return reply.status(admission.statusCode).send({ error: admission.error });
    }

    const ctx: UserContext = { userId: session.userId, chatId: session.chatId };
    const signal = AbortSignal.timeout(config.web.profileSyncTimeoutMs);
    let outcome: P9AnalysisOutcome;
    try {
      outcome = await runner(db, linked.characterId, input, ctx, signal);
    } catch (error) {
      console.error('[p9-ai-analysis] runner failed: %s', error instanceof Error ? error.message : String(error));
      reply.header('Retry-After', '60');
      return reply.status(503).send({ error: 'AI 分析暂时失败，请稍后重试。' });
    }
    if (outcome.usage) {
      recordModelUsageSafe(db, ctx, USAGE_THREAD_ID, toUsageCounts(outcome.usage), config.openai.model);
    }
    if (!outcome.ok) {
      reply.header('Retry-After', '60');
      return reply.status(503).send({ error: 'AI 分析暂时失败，请稍后重试。' });
    }
    return {
      analysis: outcome.text,
      deterministicRefs: {
        opportunityIds: outcome.opportunityIds,
        snapshotIds: outcome.snapshotIds,
        dataTimes: outcome.dataTimes,
      },
      aiParticipatesInFinancialCalculation: false,
    };
  });
}