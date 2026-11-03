import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { getLinkedCharacter } from '../eve/sso.js';
import type { WebSession } from './web-session.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';
import { P93AuditService } from '../trading/p9-3-audit-service.js';
import { P93FifoService } from '../trading/p9-3-fifo-service.js';
import { P93EsiEvidenceService } from '../trading/p9-3-evidence-service.js';
import { P93LedgerService } from '../trading/p9-3-ledger-service.js';
import { P93ReconciliationService } from '../trading/p9-3-reconciliation-service.js';
import type { P93EvidenceInput, P93RecordInput, P93VerificationStatus } from '../trading/p9-3-types.js';

function sessionContext(session: WebSession) {
  return { userId: session.userId, chatId: session.chatId };
}

function linkedCharacter(db: Db, session: WebSession, reply: FastifyReply) {
  const char = getLinkedCharacter(db, sessionContext(session));
  if (!char) {
    reply.status(404).send({ error: '尚未关联 EVE 角色，无法访问 REAL 交易账本。' });
    return null;
  }
  return char;
}

function asBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象。');
  return value as Record<string, unknown>;
}

function requiredText(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${key} 必填。`);
  return value.trim();
}

function optionalText(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(body: Record<string, unknown>, key: string): number {
  const parsed = Number(body[key]);
  if (!Number.isFinite(parsed)) throw new Error(`${key} 必须是有限数值。`);
  return parsed;
}

function integerValue(body: Record<string, unknown>, key: string): number {
  const parsed = Number(body[key]);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${key} 必须是整数。`);
  return parsed;
}

function recordInput(body: Record<string, unknown>): P93RecordInput {
  return {
    ledgerKey: requiredText(body, 'ledgerKey'),
    tradeKind: requiredText(body, 'tradeKind') as P93RecordInput['tradeKind'],
    direction: requiredText(body, 'direction') as P93RecordInput['direction'],
    typeId: integerValue(body, 'typeId'),
    locationId: integerValue(body, 'locationId'),
    quantity: integerValue(body, 'quantity'),
    unitPrice: numberValue(body, 'unitPrice'),
    tradeTime: requiredText(body, 'tradeTime'),
    sourceType: requiredText(body, 'sourceType'),
    sourceRef: optionalText(body, 'sourceRef'),
    sourceHash: optionalText(body, 'sourceHash'),
    orderId: optionalText(body, 'orderId'),
    fillId: optionalText(body, 'fillId'),
    executionStatus: optionalText(body, 'executionStatus') as P93RecordInput['executionStatus'],
    opportunityId: optionalText(body, 'opportunityId'),
    planId: optionalText(body, 'planId'),
    notes: optionalText(body, 'notes'),
    draft: Boolean(body.draft),
    feeStatus: body.feeStatus === 'COMPLETE' ? 'COMPLETE' : 'UNKNOWN',
    fees: Array.isArray(body.fees) ? body.fees as P93RecordInput['fees'] : undefined,
    adjustmentMode: optionalText(body, 'adjustmentMode') as P93RecordInput['adjustmentMode'],
    adjustmentAmount: body.adjustmentAmount == null ? undefined : numberValue(body, 'adjustmentAmount'),
    targetLotId: optionalText(body, 'targetLotId'),
    fromLocationId: body.fromLocationId == null ? undefined : integerValue(body, 'fromLocationId'),
    toLocationId: body.toLocationId == null ? undefined : integerValue(body, 'toLocationId'),
  };
}

function evidenceInput(body: Record<string, unknown>): P93EvidenceInput {
  return {
    evidenceType: requiredText(body, 'evidenceType') as P93EvidenceInput['evidenceType'],
    sourceSystem: requiredText(body, 'sourceSystem'),
    sourceRef: optionalText(body, 'sourceRef'),
    capturedAt: requiredText(body, 'capturedAt'),
    payloadHash: requiredText(body, 'payloadHash'),
    summary: optionalText(body, 'summary'),
    metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata as Record<string, unknown>
      : undefined,
    // Public evidence creation always starts pending. Verification is a
    // separate, audited human action on the evidence itself.
    initialStatus: 'PENDING',
  };
}

export function registerP93Routes(app: FastifyInstance, db: Db): void {
  const base = '/api/web/trading/p9/real-ledger';
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith(base)) reply.header('Cache-Control', 'no-store');
  });

  app.get(`${base}/overview`, async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    return {
      mode: 'REAL',
      paperIsolation: { enabled: true, paperRecordsAccepted: false, aiMutationAllowed: false, esiReadOnly: true },
      summary: P93LedgerService.summary(db, char.characterId),
      performance: P93FifoService.performance(db, char.characterId),
      latestCalculation: P93AuditService.calculationRuns(db, char.characterId, 1)[0] ?? null,
      latestReconciliation: P93ReconciliationService.latest(db, char.characterId),
    };
  });

  app.get(`${base}/records`, async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const query = request.query as Record<string, string | undefined>;
    return P93LedgerService.list(db, char.characterId, {
      state: query.state,
      verification: query.verification,
      direction: query.direction,
      sourceType: query.sourceType,
      typeId: query.typeId ? Number(query.typeId) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });
  });

  app.get<{ Params: { recordId: string } }>(`${base}/records/:recordId`, async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const record = P93LedgerService.get(db, char.characterId, request.params.recordId);
    if (!record) return reply.status(404).send({ error: '交易记录不存在。' });
    const evidence = db.prepare(`
      SELECT e.*, l.relation, l.confidence, l.notes AS link_notes
      FROM real_trade_evidence_links l
      JOIN real_trade_evidence e ON e.evidence_id = l.evidence_id
      WHERE l.record_id = ? AND e.character_id = ?
      ORDER BY l.relation, e.captured_at
    `).all(request.params.recordId, char.characterId);
    return { record, evidence, events: P93AuditService.events(db, char.characterId, request.params.recordId, 100) };
  });

  app.post(`${base}/records`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    try {
      const record = P93LedgerService.recordManual(db, char.characterId, recordInput(asBody(request.body)), `user:${session.userId}`);
      return { record };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'REAL 交易登记失败。' });
    }
  });

  app.put<{ Params: { recordId: string } }>(`${base}/records/:recordId`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    try {
      const body = asBody(request.body);
      const record = P93LedgerService.updateDraft(db, char.characterId, request.params.recordId, body as Partial<P93RecordInput>, `user:${session.userId}`);
      return { record };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '草稿更新失败。' });
    }
  });

  for (const action of ['verify', 'reject', 'reverse'] as const) {
    app.post<{ Params: { recordId: string } }>(`${base}/records/:recordId/${action}`, async (request, reply) => {
      const session = requireMutationSession(db, request, reply);
      if (!session) return;
      const char = linkedCharacter(db, session, reply);
      if (!char) return;
      try {
        const body = asBody(request.body ?? {});
        const actor = `user:${session.userId}`;
        const reason = optionalText(body, 'reason');
        const record = action === 'verify'
          ? P93LedgerService.verify(db, char.characterId, request.params.recordId, actor, reason)
          : action === 'reject'
            ? P93LedgerService.setVerification(db, char.characterId, request.params.recordId, 'REJECTED', actor, reason)
            : P93LedgerService.reverse(db, char.characterId, request.params.recordId, actor, reason ?? '');
        return { record };
      } catch (error) {
        return reply.status(400).send({ error: error instanceof Error ? error.message : '交易状态处理失败。' });
      }
    });
  }

  app.post<{ Params: { recordId: string } }>(`${base}/records/:recordId/correct`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    try {
      const body = asBody(request.body);
      const record = P93LedgerService.correction(
        db,
        char.characterId,
        request.params.recordId,
        recordInput(asBody(body.record)),
        `user:${session.userId}`,
        requiredText(body, 'reason'),
      );
      return { record };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '交易更正失败。' });
    }
  });

  app.get(`${base}/evidence`, async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    return {
      evidence: db.prepare(`
        SELECT * FROM real_trade_evidence
        WHERE character_id = ?
        ORDER BY captured_at DESC, created_at DESC LIMIT 500
      `).all(char.characterId),
    };
  });

  app.post(`${base}/evidence`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    try {
      return { evidence: P93LedgerService.addEvidence(db, char.characterId, evidenceInput(asBody(request.body))) };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '证据登记失败。' });
    }
  });

  app.post<{ Params: { evidenceId: string } }>(`${base}/evidence/:evidenceId/status`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    try {
      const body = asBody(request.body);
      const evidence = P93LedgerService.setEvidenceStatus(
        db,
        char.characterId,
        request.params.evidenceId,
        requiredText(body, 'status') as P93VerificationStatus,
        `user:${session.userId}`,
        optionalText(body, 'reason'),
      );
      return { evidence };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '证据状态处理失败。' });
    }
  });

  app.post<{ Params: { recordId: string } }>(`${base}/records/:recordId/evidence-links`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    try {
      const body = asBody(request.body);
      P93LedgerService.linkEvidence(
        db,
        char.characterId,
        request.params.recordId,
        requiredText(body, 'evidenceId'),
        requiredText(body, 'relation') as 'PRIMARY' | 'CORROBORATING' | 'CONFLICTING' | 'ADJUSTMENT',
        optionalText(body, 'confidence') as 'HIGH' | 'MEDIUM' | 'LOW' | undefined,
        optionalText(body, 'notes'),
      );
      return { ok: true };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '证据关联失败。' });
    }
  });

  app.get(`${base}/costs`, async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    return {
      lots: db.prepare('SELECT * FROM real_fifo_lots WHERE character_id = ? ORDER BY type_id, location_id, acquired_at, lot_id').all(char.characterId),
      consumptions: db.prepare('SELECT * FROM real_fifo_consumptions WHERE character_id = ? ORDER BY created_at DESC LIMIT 500').all(char.characterId),
    };
  });

  app.post(`${base}/esi-wallet-sync`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    try {
      const result = await P93EsiEvidenceService.syncWalletTransactions(db, char.characterId, {
        userId: session.userId,
        chatId: session.chatId,
      });
      return result;
    } catch (error) {
      return reply.status(502).send({ error: error instanceof Error ? error.message : 'ESI 钱包成交证据同步失败。' });
    }
  });

  app.post(`${base}/recalculate`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    try {
      return { calculation: P93FifoService.recalculate(db, char.characterId) };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'FIFO 历史重算失败。' });
    }
  });

  app.get(`${base}/performance`, async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    return { performance: P93FifoService.performance(db, char.characterId), unrealized: P93FifoService.unrealized(db, char.characterId) };
  });

  app.get(`${base}/reconciliation`, async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    return { reconciliation: P93ReconciliationService.latest(db, char.characterId) };
  });

  app.post(`${base}/reconciliation/run`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    try {
      return { reconciliation: P93ReconciliationService.run(db, char.characterId) };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '资产对账失败。' });
    }
  });

  app.get(`${base}/audit`, async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    return {
      events: P93AuditService.events(db, char.characterId, undefined, 500),
      calculationRuns: P93AuditService.calculationRuns(db, char.characterId),
      reconciliationRuns: P93AuditService.reconciliationRuns(db, char.characterId),
      integrity: P93AuditService.integrityCheck(db),
    };
  });
}