import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import {
  assertHumanActor,
  normalizeIso,
  type P93Evidence,
  type P93EvidenceInput,
  type P93Record,
  type P93RecordInput,
  type P93VerificationStatus,
} from './p9-3-types.js';

type ActorType = 'USER' | 'SYSTEM' | 'ESI_SYNC';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, stableValue(source[key])]));
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function recordHash(input: P93RecordInput): string {
  const fees = (input.fees ?? [])
    .map((fee) => ({
      feeKind: fee.feeKind,
      amount: fee.amount,
      treatment: fee.treatment,
      evidenceId: fee.evidenceId ?? null,
      notes: fee.notes ?? null,
    }))
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
  return createHash('sha256').update(canonical({
    ledgerKey: input.ledgerKey,
    tradeKind: input.tradeKind,
    direction: input.direction,
    typeId: input.typeId,
    locationId: input.locationId,
    quantity: input.quantity,
    unitPrice: input.unitPrice,
    tradeTime: normalizeIso(input.tradeTime),
    sourceType: input.sourceType,
    sourceRef: input.sourceRef ?? null,
    orderId: input.orderId ?? null,
    fillId: input.fillId ?? null,
    executionStatus: input.executionStatus ?? (input.tradeKind === 'PARTIAL_FILL' ? 'PARTIAL_FILL' : input.tradeKind === 'MULTI_BATCH_FILL' ? 'MULTI_BATCH' : input.tradeKind === 'INVENTORY_TRANSFER' ? 'TRANSFER' : input.tradeKind === 'COST_ADJUSTMENT' ? 'ADJUSTMENT' : 'MANUAL_ENTRY'),
    feeStatus: input.feeStatus ?? 'UNKNOWN',
    fees,
    adjustmentMode: input.adjustmentMode ?? null,
    adjustmentAmount: input.adjustmentAmount ?? null,
    targetLotId: input.targetLotId ?? null,
    fromLocationId: input.fromLocationId ?? null,
    toLocationId: input.toLocationId ?? null,
  })).digest('hex');
}

function validateInput(input: P93RecordInput): void {
  if (!input.ledgerKey || input.ledgerKey.length > 180) throw new Error('ledgerKey 必填且长度受控。');
  if (!input.sourceType || input.sourceType.length > 80) throw new Error('sourceType 必填且长度受控。');
  if (!Number.isSafeInteger(input.typeId) || input.typeId <= 0) throw new Error('typeId 无效。');
  if (!Number.isSafeInteger(input.locationId) || input.locationId <= 0) throw new Error('locationId 无效。');
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 0) throw new Error('quantity 必须是非负整数。');
  if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0) throw new Error('unitPrice 必须是非负数。');
  const grossCents = input.quantity * input.unitPrice * 100;
  if (!Number.isFinite(grossCents) || !Number.isSafeInteger(Math.round(grossCents))) {
    throw new Error('交易金额超出安全精度范围。');
  }
  normalizeIso(input.tradeTime);
  if (input.fees) {
    for (const fee of input.fees) {
      if (!Number.isFinite(fee.amount) || fee.amount < 0) throw new Error('费用必须是非负数。');
      if (!Number.isSafeInteger(Math.round(fee.amount * 100))) throw new Error('费用金额超出安全精度范围。');
      if (!['BROKER', 'TRANSACTION_TAX', 'OTHER', 'MANUAL'].includes(fee.feeKind)) throw new Error('费用类型无效。');
      if (!['CAPITALIZED', 'SELL_EXPENSE', 'PERIOD_EXPENSE', 'UNRELATED', 'UNKNOWN'].includes(fee.treatment)) {
        throw new Error('费用处理口径无效。');
      }
    }
  }
  if (input.tradeKind === 'BUY' && input.direction !== 'BUY') throw new Error('BUY 交易方向必须为 BUY。');
  if (input.tradeKind === 'SELL' && input.direction !== 'SELL') throw new Error('SELL 交易方向必须为 SELL。');
  if ((input.tradeKind === 'PARTIAL_FILL' || input.tradeKind === 'MULTI_BATCH_FILL')
    && input.direction !== 'BUY' && input.direction !== 'SELL') {
    throw new Error('部分成交/多批次成交必须指定买入或卖出方向。');
  }
  if ((input.tradeKind === 'FEE_ADJUSTMENT' || input.tradeKind === 'COST_ADJUSTMENT'
    || input.tradeKind === 'INVENTORY_TRANSFER' || input.tradeKind === 'REVERSAL')
    && input.direction !== 'NONE') {
    throw new Error('非买卖交易方向必须为 NONE。');
  }
  if ((input.tradeKind === 'BUY' || input.tradeKind === 'SELL' || input.tradeKind === 'PARTIAL_FILL' || input.tradeKind === 'MULTI_BATCH_FILL')
    && input.quantity <= 0) {
    throw new Error('成交记录数量必须大于零。');
  }
  if (input.tradeKind === 'COST_ADJUSTMENT') {
    if (!input.targetLotId) throw new Error('成本调整必须指定 targetLotId。');
    if (input.adjustmentMode !== 'INCREASE' && input.adjustmentMode !== 'DECREASE') throw new Error('adjustmentMode 无效。');
    if (input.adjustmentAmount == null || !Number.isFinite(input.adjustmentAmount) || input.adjustmentAmount < 0) {
      throw new Error('adjustmentAmount 必须是非负数。');
    }
  }
  if (input.tradeKind === 'INVENTORY_TRANSFER') {
    if (!Number.isSafeInteger(input.fromLocationId) || !Number.isSafeInteger(input.toLocationId)
      || Number(input.fromLocationId) <= 0 || Number(input.toLocationId) <= 0) {
      throw new Error('库存转移必须提供有效的 fromLocationId 和 toLocationId。');
    }
    if (input.fromLocationId === input.toLocationId) throw new Error('库存转移的起止地点不能相同。');
    if (input.quantity <= 0) throw new Error('库存转移数量必须大于零。');
  }
}

function mapRecord(db: Db, row: any): P93Record {
  const fees = db.prepare('SELECT * FROM real_trade_fees WHERE record_id = ? ORDER BY created_at, fee_id').all(row.record_id) as any[];
  return {
    recordId: row.record_id,
    characterId: row.character_id,
    ledgerKey: row.ledger_key,
    tradeKind: row.trade_kind,
    direction: row.direction,
    typeId: row.type_id,
    locationId: row.location_id,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    grossAmount: row.gross_amount,
    tradeTime: row.trade_time,
    sourceType: row.source_type,
    sourceRef: row.source_ref || undefined,
    sourceHash: row.source_hash || undefined,
    orderId: row.order_id || undefined,
    fillId: row.fill_id || undefined,
    executionStatus: row.execution_status,
    opportunityId: row.opportunity_id || undefined,
    planId: row.plan_id || undefined,
    notes: row.notes || undefined,
    adjustmentMode: row.adjustment_mode || undefined,
    adjustmentAmount: row.adjustment_amount ?? undefined,
    targetLotId: row.target_lot_id || undefined,
    fromLocationId: row.from_location_id ?? undefined,
    toLocationId: row.to_location_id ?? undefined,
    recordState: row.record_state,
    verificationStatus: row.verification_status,
    feeStatus: row.fee_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verifiedAt: row.verified_at || undefined,
    rejectedReason: row.rejected_reason || undefined,
    supersedesRecordId: row.supersedes_record_id || undefined,
    reversesRecordId: row.reverses_record_id || undefined,
    fees: fees.map((fee) => ({
      feeId: fee.fee_id,
      feeKind: fee.fee_kind,
      amount: fee.amount,
      treatment: fee.treatment,
      evidenceId: fee.evidence_id || undefined,
      notes: fee.notes || undefined,
    })),
  };
}

function insertEvent(
  db: Db,
  characterId: number,
  recordId: string,
  eventType: string,
  actorType: ActorType,
  actorId: string | null,
  before: unknown,
  after: unknown,
  reason?: string,
): void {
  db.prepare(`
    INSERT INTO real_trade_events (character_id, record_id, event_type, actor_type, actor_id, before_json, after_json, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(characterId, recordId, eventType, actorType, actorId, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), reason ?? null);
}

export class P93LedgerService {
  static list(
    db: Db,
    characterId: number,
    filters: { state?: string; verification?: string; direction?: string; sourceType?: string; typeId?: number; limit?: number; offset?: number } = {},
  ): { records: P93Record[]; total: number } {
    const where = ['character_id = ?'];
    const params: unknown[] = [characterId];
    if (filters.state) { where.push('record_state = ?'); params.push(filters.state); }
    if (filters.verification) { where.push('verification_status = ?'); params.push(filters.verification); }
    if (filters.direction) { where.push('direction = ?'); params.push(filters.direction); }
    if (filters.sourceType) { where.push('source_type = ?'); params.push(filters.sourceType); }
    if (filters.typeId) { where.push('type_id = ?'); params.push(filters.typeId); }
    const sql = where.join(' AND ');
    const limit = Math.max(1, Math.min(500, filters.limit ?? 100));
    const offset = Math.max(0, filters.offset ?? 0);
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM real_trade_records WHERE ${sql}`).get(...params) as any)?.n || 0);
    const rows = db.prepare(`
      SELECT * FROM real_trade_records WHERE ${sql}
      ORDER BY trade_time DESC, created_at DESC, record_id DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];
    return { records: rows.map((row) => mapRecord(db, row)), total };
  }

  static get(db: Db, characterId: number, recordId: string): P93Record | null {
    const row = db.prepare('SELECT * FROM real_trade_records WHERE character_id = ? AND record_id = ?').get(characterId, recordId) as any;
    return row ? mapRecord(db, row) : null;
  }

  static recordManual(db: Db, characterId: number, input: P93RecordInput, actor = 'user'): P93Record {
    assertHumanActor(actor);
    return this.upsert(db, characterId, input, 'USER', actor);
  }

  static upsert(
    db: Db,
    characterId: number,
    input: P93RecordInput,
    actorType: ActorType,
    actorId: string | null,
  ): P93Record {
    if (actorType === 'USER') assertHumanActor(actorId ?? '');
    validateInput(input);
    const hash = recordHash(input);
    if (input.sourceHash && input.sourceHash !== hash) {
      throw new Error('sourceHash 与交易事实不一致，拒绝登记。');
    }
    const existing = db.prepare('SELECT * FROM real_trade_records WHERE character_id = ? AND ledger_key = ?')
      .get(characterId, input.ledgerKey) as any;
    if (existing) {
      if (existing.source_hash !== hash) throw new Error('相同 ledgerKey 已用于不同交易事实，拒绝重复登记。');
      return mapRecord(db, existing);
    }
    const recordId = 'REALTRADE-' + randomUUID();
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO real_trade_records (
          record_id, character_id, ledger_key, record_state, verification_status, trade_kind, direction,
          type_id, location_id, quantity, unit_price, fee_status, trade_time, source_type, source_ref,
          source_hash, order_id, fill_id, execution_status, opportunity_id, plan_id, notes,
          adjustment_mode, adjustment_amount, target_lot_id, from_location_id, to_location_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        characterId,
        input.ledgerKey,
        'DRAFT',
        'PENDING',
        input.tradeKind,
        input.direction,
        input.typeId,
        input.locationId,
        input.quantity,
        input.unitPrice,
        input.feeStatus ?? 'UNKNOWN',
        normalizeIso(input.tradeTime),
        input.sourceType,
        input.sourceRef ?? null,
        hash,
        input.orderId ?? null,
        input.fillId ?? null,
        input.executionStatus ?? (input.tradeKind === 'PARTIAL_FILL' ? 'PARTIAL_FILL' : input.tradeKind === 'MULTI_BATCH_FILL' ? 'MULTI_BATCH' : input.tradeKind === 'INVENTORY_TRANSFER' ? 'TRANSFER' : input.tradeKind === 'COST_ADJUSTMENT' ? 'ADJUSTMENT' : 'MANUAL_ENTRY'),
        input.opportunityId ?? null,
        input.planId ?? null,
        input.notes ?? null,
        input.adjustmentMode ?? null,
        input.adjustmentAmount ?? null,
        input.targetLotId ?? null,
        input.fromLocationId ?? null,
        input.toLocationId ?? null,
      );
      for (const fee of input.fees ?? []) {
        db.prepare(`
          INSERT INTO real_trade_fees (fee_id, record_id, fee_kind, amount, treatment, evidence_id, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('FEE-' + randomUUID(), recordId, fee.feeKind, fee.amount, fee.treatment, fee.evidenceId ?? null, fee.notes ?? null);
      }
      if (!input.draft) {
        db.prepare(`
          UPDATE real_trade_records
          SET record_state = 'ACTIVE', verification_status = 'USER_REPORTED', updated_at = datetime('now')
          WHERE record_id = ? AND character_id = ?
        `).run(recordId, characterId);
      }
      insertEvent(db, characterId, recordId, input.draft ? 'draft_created' : 'record_created', actorType, actorId, null, input);
    });
    tx();
    return this.get(db, characterId, recordId)!;
  }

  static updateDraft(
    db: Db,
    characterId: number,
    recordId: string,
    patch: Partial<P93RecordInput>,
    actor = 'user',
  ): P93Record {
    assertHumanActor(actor);
    const existing = db.prepare('SELECT * FROM real_trade_records WHERE character_id = ? AND record_id = ?').get(characterId, recordId) as any;
    if (!existing) throw new Error('交易记录不存在。');
    if (existing.record_state !== 'DRAFT') throw new Error('仅草稿记录可以编辑；已核实记录请使用更正或冲正。');
    const existingRecord = mapRecord(db, existing);
    const next: P93RecordInput = {
      ledgerKey: existing.ledger_key,
      tradeKind: patch.tradeKind ?? existing.trade_kind,
      direction: patch.direction ?? existing.direction,
      typeId: patch.typeId ?? existing.type_id,
      locationId: patch.locationId ?? existing.location_id,
      quantity: patch.quantity ?? existing.quantity,
      unitPrice: patch.unitPrice ?? existing.unit_price,
      tradeTime: patch.tradeTime ?? existing.trade_time,
      sourceType: patch.sourceType ?? existing.source_type,
      sourceRef: patch.sourceRef ?? existing.source_ref ?? undefined,
      orderId: patch.orderId ?? existing.order_id ?? undefined,
      fillId: patch.fillId ?? existing.fill_id ?? undefined,
      executionStatus: patch.executionStatus ?? existing.execution_status,
      opportunityId: patch.opportunityId ?? existing.opportunity_id ?? undefined,
      planId: patch.planId ?? existing.plan_id ?? undefined,
      notes: patch.notes ?? existing.notes ?? undefined,
      feeStatus: patch.feeStatus ?? existing.fee_status,
      fees: patch.fees ?? existingRecord.fees,
      adjustmentMode: patch.adjustmentMode ?? existing.adjustment_mode ?? undefined,
      adjustmentAmount: patch.adjustmentAmount ?? existing.adjustment_amount ?? undefined,
      targetLotId: patch.targetLotId ?? existing.target_lot_id ?? undefined,
      fromLocationId: patch.fromLocationId ?? existing.from_location_id ?? undefined,
      toLocationId: patch.toLocationId ?? existing.to_location_id ?? undefined,
    };
    validateInput(next);
    const nextHash = recordHash(next);
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE real_trade_records
        SET trade_kind = ?, direction = ?, type_id = ?, location_id = ?, quantity = ?, unit_price = ?,
            trade_time = ?, source_type = ?, source_ref = ?, source_hash = ?, order_id = ?, fill_id = ?, execution_status = ?,
            opportunity_id = ?, plan_id = ?, notes = ?, fee_status = ?, adjustment_mode = ?, adjustment_amount = ?,
            target_lot_id = ?, from_location_id = ?, to_location_id = ?, updated_at = datetime('now')
        WHERE record_id = ? AND character_id = ? AND record_state = 'DRAFT'
      `).run(
        next.tradeKind, next.direction, next.typeId, next.locationId, next.quantity, next.unitPrice,
        normalizeIso(next.tradeTime), next.sourceType, next.sourceRef ?? null, nextHash, next.orderId ?? null,
        next.fillId ?? null, next.executionStatus ?? 'MANUAL_ENTRY', next.opportunityId ?? null,
        next.planId ?? null, next.notes ?? null, next.feeStatus ?? 'UNKNOWN', next.adjustmentMode ?? null,
        next.adjustmentAmount ?? null, next.targetLotId ?? null, next.fromLocationId ?? null,
        next.toLocationId ?? null, recordId, characterId,
      );
      if (patch.fees) {
        db.prepare('DELETE FROM real_trade_fees WHERE record_id = ?').run(recordId);
        for (const fee of patch.fees) {
          db.prepare(`
            INSERT INTO real_trade_fees (fee_id, record_id, fee_kind, amount, treatment, evidence_id, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run('FEE-' + randomUUID(), recordId, fee.feeKind, fee.amount, fee.treatment, fee.evidenceId ?? null, fee.notes ?? null);
        }
      }
      insertEvent(db, characterId, recordId, 'draft_updated', 'USER', actor, existing, next);
    });
    tx();
    return this.get(db, characterId, recordId)!;
  }

  static addEvidence(db: Db, characterId: number, input: P93EvidenceInput): P93Evidence {
    if (!['ESI_WALLET_LOG', 'ESI_MARKET_ORDER', 'ESI_ASSET_SNAPSHOT', 'ASSET_CHANGE', 'USER_ATTACHMENT', 'USER_CONFIRMATION'].includes(input.evidenceType)) {
      throw new Error('证据类型无效。');
    }
    if (!input.sourceSystem || input.sourceSystem.length > 80) throw new Error('证据来源系统必填且长度受控。');
    if (!input.payloadHash || input.payloadHash.length < 8 || input.payloadHash.length > 256) throw new Error('证据内容哈希无效。');
    const status = input.initialStatus ?? 'PENDING';
    if (!['VERIFIED', 'USER_REPORTED', 'PENDING', 'CONFLICT', 'REJECTED'].includes(status)) throw new Error('证据状态无效。');
    const evidenceId = 'EVID-' + randomUUID();
    const sourceRef = input.sourceRef ?? null;
    const existing = sourceRef
      ? db.prepare('SELECT * FROM real_trade_evidence WHERE character_id = ? AND source_system = ? AND source_ref = ?')
        .get(characterId, input.sourceSystem, sourceRef) as any
      : undefined;
    if (existing) {
      if (existing.payload_hash !== input.payloadHash) throw new Error('相同证据来源已登记不同内容。');
      return {
        evidenceId: existing.evidence_id,
        characterId: existing.character_id,
        evidenceType: existing.evidence_type,
        sourceSystem: existing.source_system,
        sourceRef: existing.source_ref || undefined,
        capturedAt: existing.captured_at,
        payloadHash: existing.payload_hash,
        summary: existing.summary || undefined,
        metadata: JSON.parse(existing.metadata_json || '{}'),
        status: existing.status,
        createdAt: existing.created_at,
      };
    }
    db.prepare(`
      INSERT INTO real_trade_evidence
        (evidence_id, character_id, evidence_type, source_system, source_ref, captured_at, payload_hash, summary, metadata_json, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evidenceId,
      characterId,
      input.evidenceType,
      input.sourceSystem,
      sourceRef,
      normalizeIso(input.capturedAt),
      input.payloadHash,
      input.summary ?? null,
      JSON.stringify(input.metadata ?? {}),
      status,
    );
    return this.getEvidence(db, characterId, evidenceId)!;
  }

  static getEvidence(db: Db, characterId: number, evidenceId: string): P93Evidence | null {
    const row = db.prepare('SELECT * FROM real_trade_evidence WHERE character_id = ? AND evidence_id = ?').get(characterId, evidenceId) as any;
    if (!row) return null;
    return {
      evidenceId: row.evidence_id,
      characterId: row.character_id,
      evidenceType: row.evidence_type,
      sourceSystem: row.source_system,
      sourceRef: row.source_ref || undefined,
      capturedAt: row.captured_at,
      payloadHash: row.payload_hash,
      summary: row.summary || undefined,
      metadata: JSON.parse(row.metadata_json || '{}'),
      status: row.status,
      createdAt: row.created_at,
    };
  }

  static setEvidenceStatus(
    db: Db,
    characterId: number,
    evidenceId: string,
    status: P93VerificationStatus,
    actor = 'user',
    reason?: string,
  ): P93Evidence {
    assertHumanActor(actor);
    if (!['VERIFIED', 'USER_REPORTED', 'PENDING', 'CONFLICT', 'REJECTED'].includes(status)) throw new Error('证据状态无效。');
    const existing = this.getEvidence(db, characterId, evidenceId);
    if (!existing) throw new Error('证据不存在。');
    if (existing.status === 'VERIFIED' && status !== 'VERIFIED') throw new Error('已核实证据不可降级或删除。');
    const tx = db.transaction(() => {
      db.prepare('UPDATE real_trade_evidence SET status = ? WHERE character_id = ? AND evidence_id = ?')
        .run(status, characterId, evidenceId);
      for (const link of db.prepare('SELECT record_id FROM real_trade_evidence_links WHERE evidence_id = ?').all(evidenceId) as any[]) {
        insertEvent(db, characterId, link.record_id, 'evidence_status_changed', 'USER', actor, existing, { status }, reason);
      }
    });
    tx();
    return this.getEvidence(db, characterId, evidenceId)!;
  }

  static linkEvidence(
    db: Db,
    characterId: number,
    recordId: string,
    evidenceId: string,
    relation: 'PRIMARY' | 'CORROBORATING' | 'CONFLICTING' | 'ADJUSTMENT',
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM',
    notes?: string,
    actorType: ActorType = 'USER',
    actorId = 'user',
  ): void {
    if (actorType === 'USER') assertHumanActor(actorId ?? '');
    if (actorType === 'ESI_SYNC' && actorId !== 'esi-wallet-sync') {
      throw new Error('未知的 ESI 同步身份。');
    }
    const record = db.prepare(`
      SELECT record_id, record_state, source_type, source_ref
      FROM real_trade_records WHERE character_id = ? AND record_id = ?
    `).get(characterId, recordId) as any;
    const evidence = db.prepare(`
      SELECT evidence_id, evidence_type, source_system, source_ref, status
      FROM real_trade_evidence WHERE character_id = ? AND evidence_id = ?
    `).get(characterId, evidenceId) as any;
    if (!record || !evidence) throw new Error('交易或证据不存在。');
    if (['VERIFIED', 'REVERSED', 'CORRECTED'].includes(record.record_state)) {
      throw new Error('已核实或终态记录的证据关系不可原地变更；请使用更正或冲正。');
    }
    if (
      evidence.evidence_type === 'ESI_WALLET_LOG'
      && ['PRIMARY', 'CORROBORATING'].includes(relation)
      && record.source_type === 'ESI_WALLET_TRANSACTION'
      && (!record.source_ref || evidence.source_ref !== record.source_ref)
    ) {
      throw new Error('ESI 钱包证据与交易来源引用不匹配，拒绝建立核实关系。');
    }
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO real_trade_evidence_links (evidence_id, record_id, relation, confidence, notes)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(evidence_id, record_id) DO UPDATE SET relation = excluded.relation, confidence = excluded.confidence, notes = excluded.notes
      `).run(evidenceId, recordId, relation, confidence, notes ?? null);
      insertEvent(db, characterId, recordId, 'evidence_linked', actorType, actorId, null, { evidenceId, relation, confidence }, notes);
    });
    tx();
  }

  static verify(db: Db, characterId: number, recordId: string, actor = 'user', reason?: string, actorType: ActorType = 'USER'): P93Record {
    assertHumanActor(actor);
    const existing = db.prepare('SELECT * FROM real_trade_records WHERE character_id = ? AND record_id = ?').get(characterId, recordId) as any;
    if (!existing) throw new Error('交易记录不存在。');
    if (existing.record_state === 'VERIFIED') return mapRecord(db, existing);
    if (existing.record_state !== 'ACTIVE' && existing.record_state !== 'DRAFT') throw new Error('当前状态不可核实。');
    const conflicting = db.prepare(`
      SELECT e.evidence_id FROM real_trade_evidence e
      JOIN real_trade_evidence_links l ON l.evidence_id = e.evidence_id
      WHERE e.character_id = ? AND l.record_id = ?
        AND e.status IN ('VERIFIED', 'CONFLICT') AND l.relation = 'CONFLICTING'
      LIMIT 1
    `).get(characterId, recordId);
    if (conflicting) throw new Error('存在已核实或冲突证据，不能把交易提升为已核实。');
    const verifiedEvidence = db.prepare(`
      SELECT e.evidence_id FROM real_trade_evidence e
      JOIN real_trade_evidence_links l ON l.evidence_id = e.evidence_id
      WHERE e.character_id = ? AND l.record_id = ?
        AND e.status = 'VERIFIED' AND l.relation IN ('PRIMARY', 'CORROBORATING')
        AND (
          e.evidence_type IN ('USER_ATTACHMENT', 'USER_CONFIRMATION')
          OR (
            e.evidence_type = 'ESI_WALLET_LOG'
            AND e.source_system = 'ESI_WALLET_TRANSACTIONS'
            AND ? = 'ESI_WALLET_TRANSACTION'
            AND e.source_ref = ?
          )
        )
      LIMIT 1
    `).get(characterId, recordId, existing.source_type, existing.source_ref ?? null);
    if (!verifiedEvidence) throw new Error('缺少已核实证据或与交易事实匹配的已核实证据，不能把用户申报提升为已核实。');
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE real_trade_records
        SET record_state = 'VERIFIED', verification_status = 'VERIFIED', verified_at = datetime('now'), updated_at = datetime('now')
        WHERE record_id = ? AND character_id = ?
      `).run(recordId, characterId);
      insertEvent(db, characterId, recordId, 'record_verified', actorType, actor, existing, { verificationStatus: 'VERIFIED' }, reason);
    });
    tx();
    return this.get(db, characterId, recordId)!;
  }

  static setVerification(
    db: Db,
    characterId: number,
    recordId: string,
    status: P93VerificationStatus,
    actor = 'user',
    reason?: string,
  ): P93Record {
    assertHumanActor(actor);
    const existing = db.prepare('SELECT * FROM real_trade_records WHERE character_id = ? AND record_id = ?').get(characterId, recordId) as any;
    if (!existing) throw new Error('交易记录不存在。');
    if (status === 'VERIFIED') return this.verify(db, characterId, recordId, actor, reason);
    if (existing.record_state === 'REJECTED' || existing.record_state === 'REVERSED' || existing.record_state === 'CORRECTED') {
      throw new Error('终态记录不能重新进入待核实状态。');
    }
    const nextState = status === 'REJECTED' ? 'REJECTED' : existing.record_state === 'DRAFT' ? 'DRAFT' : 'ACTIVE';
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE real_trade_records
        SET verification_status = ?, record_state = ?, rejected_reason = ?, updated_at = datetime('now')
        WHERE record_id = ? AND character_id = ?
      `).run(status, nextState, status === 'REJECTED' ? reason ?? '人工驳回' : null, recordId, characterId);
      insertEvent(db, characterId, recordId, 'verification_changed', 'USER', actor, existing, { verificationStatus: status }, reason);
    });
    tx();
    return this.get(db, characterId, recordId)!;
  }

  static reverse(db: Db, characterId: number, recordId: string, actor = 'user', reason: string): P93Record {
    assertHumanActor(actor);
    if (!reason.trim()) throw new Error('冲正必须填写原因。');
    const existing = db.prepare('SELECT * FROM real_trade_records WHERE character_id = ? AND record_id = ?').get(characterId, recordId) as any;
    if (!existing) throw new Error('交易记录不存在。');
    if (existing.record_state === 'REVERSED') return mapRecord(db, existing);
    if (existing.record_state !== 'VERIFIED' && existing.record_state !== 'ACTIVE') throw new Error('仅活动或已核实记录可以冲正。');
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE real_trade_records
        SET record_state = 'REVERSED', reverses_record_id = ?, updated_at = datetime('now')
        WHERE record_id = ? AND character_id = ?
      `).run(recordId, recordId, characterId);
      insertEvent(db, characterId, recordId, 'record_reversed', 'USER', actor, existing, { recordState: 'REVERSED' }, reason);
    });
    tx();
    return this.get(db, characterId, recordId)!;
  }

  static correction(
    db: Db,
    characterId: number,
    originalRecordId: string,
    input: P93RecordInput,
    actor = 'user',
    reason: string,
  ): P93Record {
    assertHumanActor(actor);
    if (!reason.trim()) throw new Error('更正必须填写原因。');
    const original = db.prepare('SELECT * FROM real_trade_records WHERE character_id = ? AND record_id = ?').get(characterId, originalRecordId) as any;
    if (!original) throw new Error('原交易记录不存在。');
    if (original.record_state === 'DRAFT') throw new Error('草稿请直接编辑，不需要更正流程。');
    if (['REJECTED', 'REVERSED', 'CORRECTED'].includes(original.record_state)) throw new Error('终态记录不能再更正。');
    const tx = db.transaction(() => {
      const corrected = this.upsert(db, characterId, { ...input, draft: true }, 'USER', actor);
      db.prepare(`
        UPDATE real_trade_records
        SET record_state = 'CORRECTED', supersedes_record_id = ?, updated_at = datetime('now')
        WHERE record_id = ? AND character_id = ?
      `).run(corrected.recordId, originalRecordId, characterId);
      db.prepare(`
        UPDATE real_trade_records
        SET supersedes_record_id = ?, updated_at = datetime('now')
        WHERE record_id = ? AND character_id = ?
      `).run(originalRecordId, corrected.recordId, characterId);
      insertEvent(db, characterId, originalRecordId, 'record_corrected', 'USER', actor, original, { correctedRecordId: corrected.recordId }, reason);
      return corrected;
    });
    const corrected = tx();
    return this.get(db, characterId, corrected.recordId)!;
  }

  static summary(db: Db, characterId: number): Record<string, unknown> {
    const rows = db.prepare(`
      SELECT record_state, verification_status, direction, COUNT(*) AS count
      FROM real_trade_records WHERE character_id = ?
      GROUP BY record_state, verification_status, direction
    `).all(characterId) as any[];
    return { rows, rawRecordCount: rows.reduce((sum, row) => sum + Number(row.count || 0), 0) };
  }
}