import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { getLinkedCharacter } from '../eve/sso.js';
import type { WebSession } from './web-session.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';
import { P93AuditService } from '../trading/p9-3-audit-service.js';
import { P93FifoService } from '../trading/p9-3-fifo-service.js';
import { P93EsiEvidenceService } from '../trading/p9-3-evidence-service.js';
import { P93LedgerService } from '../trading/p9-3-ledger-service.js';
import { resolveAssetLineage, type AssetLineage } from '../assets/asset-lineage.js';
import { realLedgerLineagePredicate } from '../trading/p9-3-lineage.js';
import { P93ReconciliationService } from '../trading/p9-3-reconciliation-service.js';
import type { P93EvidenceInput, P93RecordInput, P93VerificationStatus } from '../trading/p9-3-types.js';

function sessionContext(session: WebSession) {
  return { userId: session.userId, chatId: session.chatId };
}

function linkedCharacter(db: Db, session: WebSession, reply: FastifyReply) {
  const char = getLinkedCharacter(db, sessionContext(session));
  if (!char) {
    reply.status(404).send({ error: 'p9_real_ledger_character_required' });
    return null;
  }
  return char;
}

function requireLineage(
  db: Db,
  session: WebSession,
  reply: FastifyReply,
  characterId: number,
): AssetLineage | null {
  try {
    return resolveAssetLineage(db, characterId, session.userId, session.chatId);
  } catch {
    reply.status(403).send({ error: 'character_asset_context_invalid' });
    return null;
  }
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
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    return {
      mode: 'REAL',
      paperIsolation: { enabled: true, paperRecordsAccepted: false, aiMutationAllowed: false, esiReadOnly: true },
      summary: P93LedgerService.summary(db, char.characterId, lineage),
      performance: P93FifoService.performance(db, char.characterId, lineage),
      latestCalculation: P93AuditService.calculationRuns(db, char.characterId, 1, lineage)[0] ?? null,
      latestReconciliation: P93ReconciliationService.latest(db, char.characterId, lineage),
    };
  });

  app.get(`${base}/records`, async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    const query = request.query as Record<string, string | undefined>;
    return P93LedgerService.list(db, char.characterId, {
      state: query.state,
      verification: query.verification,
      direction: query.direction,
      sourceType: query.sourceType,
      typeId: query.typeId ? Number(query.typeId) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    }, lineage);
  });

  app.get<{ Params: { recordId: string } }>(`${base}/records/:recordId`, async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    const record = P93LedgerService.get(db, char.characterId, request.params.recordId, lineage);
    if (!record) return reply.status(404).send({ error: 'p9_record_not_found' });
    const evidence = db.prepare(`
      SELECT e.*, l.relation, l.confidence, l.notes AS link_notes
      FROM real_trade_evidence_links l
      JOIN real_trade_evidence e ON e.evidence_id = l.evidence_id
      WHERE l.record_id = ? AND e.character_id = ?
        AND ${realLedgerLineagePredicate('e', lineage).sql}
      ORDER BY l.relation, e.captured_at
    `).all(
      request.params.recordId,
      char.characterId,
      ...realLedgerLineagePredicate('e', lineage).params,
    );
    return { record, evidence, events: P93AuditService.events(db, char.characterId, request.params.recordId, 100, lineage) };
  });

  app.post(`${base}/records`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    try {
      const record = P93LedgerService.recordManual(db, char.characterId, recordInput(asBody(request.body)), `user:${session.userId}`, lineage);
      return { record };
    } catch {
      return reply.status(400).send({ error: 'real_trade_registration_failed' });
    }
  });

  app.put<{ Params: { recordId: string } }>(`${base}/records/:recordId`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    try {
      const body = asBody(request.body);
      const record = P93LedgerService.updateDraft(db, char.characterId, request.params.recordId, body as Partial<P93RecordInput>, `user:${session.userId}`, lineage);
      return { record };
    } catch {
      return reply.status(400).send({ error: 'draft_update_failed' });
    }
  });

  for (const action of ['submit', 'verify', 'reject', 'reverse'] as const) {
    app.post<{ Params: { recordId: string } }>(`${base}/records/:recordId/${action}`, async (request, reply) => {
      const session = requireMutationSession(db, request, reply);
      if (!session) return;
      const char = linkedCharacter(db, session, reply);
      if (!char) return;
      const lineage = requireLineage(db, session, reply, char.characterId);
      if (!lineage) return;
      try {
        const body = asBody(request.body ?? {});
        const actor = `user:${session.userId}`;
        const reason = optionalText(body, 'reason');
        const record = action === 'submit'
          ? P93LedgerService.submitDraft(db, char.characterId, request.params.recordId, actor, lineage)
          : action === 'verify'
            ? P93LedgerService.verify(db, char.characterId, request.params.recordId, actor, reason, 'USER', lineage)
            : action === 'reject'
              ? P93LedgerService.setVerification(db, char.characterId, request.params.recordId, 'REJECTED', actor, reason, lineage)
              : P93LedgerService.reverse(db, char.characterId, request.params.recordId, actor, reason ?? '', lineage);
        return { record };
      } catch {
        return reply.status(400).send({ error: 'trade_status_processing_failed' });
      }
    });
  }

  app.post<{ Params: { recordId: string } }>(`${base}/records/:recordId/correct`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    try {
      const body = asBody(request.body);
      const record = P93LedgerService.correction(
        db,
        char.characterId,
        request.params.recordId,
        recordInput(asBody(body.record)),
        `user:${session.userId}`,
        requiredText(body, 'reason'),
        lineage,
      );
      return { record };
    } catch {
      return reply.status(400).send({ error: 'trade_correction_failed' });
    }
  });

  app.get(`${base}/evidence`, async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    const owner = realLedgerLineagePredicate(null, lineage);
    return {
      evidence: db.prepare(`
        SELECT * FROM real_trade_evidence
        WHERE character_id = ? AND ${owner.sql}
        ORDER BY captured_at DESC, created_at DESC LIMIT 500
      `).all(char.characterId, ...owner.params),
    };
  });

  app.post(`${base}/evidence`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    try {
      return { evidence: P93LedgerService.addEvidence(db, char.characterId, evidenceInput(asBody(request.body)), 'USER', lineage) };
    } catch {
      return reply.status(400).send({ error: 'evidence_registration_failed' });
    }
  });

  app.post<{ Params: { evidenceId: string } }>(`${base}/evidence/:evidenceId/status`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    try {
      const body = asBody(request.body);
      const evidence = P93LedgerService.setEvidenceStatus(
        db,
        char.characterId,
        request.params.evidenceId,
        requiredText(body, 'status') as P93VerificationStatus,
        `user:${session.userId}`,
        optionalText(body, 'reason'),
        lineage,
      );
      return { evidence };
    } catch {
      return reply.status(400).send({ error: 'evidence_status_processing_failed' });
    }
  });

  app.post<{ Params: { recordId: string } }>(`${base}/records/:recordId/evidence-links`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
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
        'USER',
        `user:${session.userId}`,
        lineage,
      );
      return { ok: true };
    } catch {
      return reply.status(400).send({ error: 'evidence_linking_failed' });
    }
  });

  app.get(`${base}/costs`, async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    const owner = realLedgerLineagePredicate(null, lineage);
    return {
      freshness: P93FifoService.performance(db, char.characterId, lineage).freshness,
      lots: db.prepare(`
        SELECT * FROM real_fifo_lots
        WHERE character_id = ? AND ${owner.sql}
        ORDER BY type_id, location_id, acquired_at, lot_id
      `).all(char.characterId, ...owner.params),
      consumptions: db.prepare(`
        SELECT * FROM real_fifo_consumptions
        WHERE character_id = ? AND ${owner.sql}
        ORDER BY created_at DESC LIMIT 500
      `).all(char.characterId, ...owner.params),
    };
  });

  app.post(`${base}/esi-wallet-sync`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    try {
      const result = await P93EsiEvidenceService.syncWalletTransactions(
        db,
        char.characterId,
        { userId: session.userId, chatId: session.chatId, characterId: char.characterId },
        lineage,
      );
      if (!result.ok || result.status !== 'ok') {
        const status = result.errorCode === 'WALLET_SCOPE_MISSING'
          || result.errorCode === 'IDENTITY_UNAVAILABLE'
          || result.errorCode === 'IDENTITY_CHANGED'
          ? 403
          : result.errorCode === 'ESI_REQUEST_FAILED'
            ? 502
            : 422;
        return reply.status(status).send({
          ...result,
          ok: false,
          error: 'wallet_evidence_sync_incomplete',
        });
      }
      return result;
    } catch {
      return reply.status(502).send({ error: 'wallet_evidence_sync_failed' });
    }
  });

  app.post(`${base}/recalculate`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    try {
      return { calculation: P93FifoService.recalculate(db, char.characterId, lineage) };
    } catch {
      return reply.status(400).send({ error: 'fifo_recompute_failed' });
    }
  });

  app.get(`${base}/performance`, async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    return {
      performance: P93FifoService.performance(db, char.characterId, lineage),
      unrealized: P93FifoService.unrealized(db, char.characterId, lineage),
    };
  });

  app.get<{ Querystring: { limit?: string; offset?: string } }>(`${base}/reconciliation`, async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    return {
      reconciliation: P93ReconciliationService.latest(db, char.characterId, lineage, {
        limit: request.query.limit,
        offset: request.query.offset,
      }),
    };
  });

  app.post(`${base}/reconciliation/run`, async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    try {
      return { reconciliation: P93ReconciliationService.run(db, char.characterId, lineage) };
    } catch {
      return reply.status(400).send({ error: 'asset_reconciliation_failed' });
    }
  });

  app.get(`${base}/audit`, async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const char = linkedCharacter(db, session, reply);
    if (!char) return;
    const lineage = requireLineage(db, session, reply, char.characterId);
    if (!lineage) return;
    return {
      events: P93AuditService.events(db, char.characterId, undefined, 500, lineage),
      calculationRuns: P93AuditService.calculationRuns(db, char.characterId, 50, lineage),
      reconciliationRuns: P93AuditService.reconciliationRuns(db, char.characterId, lineage),
      integrity: P93AuditService.integrityCheck(db, char.characterId, lineage),
    };
  });
}
