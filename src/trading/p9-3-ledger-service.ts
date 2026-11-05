import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import {
  realLedgerLineageFromContext,
  realLedgerLineagePredicate,
  resolveRealLedgerLineage,
  type RealLedgerLineage,
} from './p9-3-lineage.js';
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

type LedgerScope = RealLedgerLineage | null;

function ledgerScope(db: Db, characterId: number, lineage?: RealLedgerLineage | null): LedgerScope {
  return resolveRealLedgerLineage(db, characterId, lineage);
}

function ledgerPredicate(scope: LedgerScope): { sql: string; params: unknown[] } {
  if (scope) return realLedgerLineagePredicate(null, scope);
  // Isolated service tests predating the owner lineage use ownerless fixtures.
  // Normal web routes always pass an explicit lineage, so this fallback cannot
  // expose real owner rows or ownerless legacy rows through authenticated APIs.
  return {
    sql: 'owner_user_id IS NULL AND owner_chat_id IS NULL AND binding_epoch = 0',
    params: [],
  };
}

function lineageInsertValues(scope: LedgerScope): [number | null, number | null, number, string] {
  return scope
    ? [scope.ownerUserId, scope.ownerChatId, scope.bindingEpoch, scope.bindingDigest]
    : [null, null, 0, ''];
}

/**
 * Re-read the live binding after BEGIN IMMEDIATE. Scope refresh may change the
 * digest, but it may not change the owner/chat/epoch authorization namespace.
 */
function revalidateLedgerLineage(
  db: Db,
  characterId: number,
  lineage: RealLedgerLineage,
): RealLedgerLineage {
  const current = realLedgerLineageFromContext(db, characterId, {
    userId: lineage.ownerUserId,
    chatId: lineage.ownerChatId ?? undefined,
    characterId,
  });
  if (
    current.ownerUserId !== lineage.ownerUserId
    || current.ownerChatId !== lineage.ownerChatId
    || current.bindingEpoch !== lineage.bindingEpoch
  ) {
    throw new Error('REAL 账本所有权或绑定上下文已变化，拒绝提交。');
  }
  return current;
}

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


type EvidenceTrust = 'USER' | 'ESI_SYNC';

function evidenceMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function metadataValue(metadata: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (metadata[key] !== undefined && metadata[key] !== null) return metadata[key];
  }
  return undefined;
}

function metadataInteger(metadata: Record<string, unknown>, ...keys: string[]): number | null {
  const value = Number(metadataValue(metadata, ...keys));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function metadataMoney(metadata: Record<string, unknown>, ...keys: string[]): number | null {
  const value = Number(metadataValue(metadata, ...keys));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function metadataTime(metadata: Record<string, unknown>, ...keys: string[]): string | null {
  const value = metadataValue(metadata, ...keys);
  if (typeof value !== 'string') return null;
  try { return normalizeIso(value); } catch { return null; }
}


function esiAssetEvidenceMismatch(record: any, evidence: any): string | null {
  if (!['ESI_ASSET_SNAPSHOT', 'ASSET_CHANGE'].includes(evidence.evidence_type)) return '证据类型不是资产快照或资产变化。';
  if (record.trade_kind !== 'INVENTORY_TRANSFER') return '资产快照或资产变化不能作为买卖成交的核实证据。';
  if (record.source_ref && String(record.source_ref).startsWith('asset-') && record.source_ref !== evidence.source_ref) return '来源引用不一致。';
  const metadata = evidenceMetadata(evidence.metadata_json || '{}');
  if (metadataInteger(metadata, 'typeId', 'type_id') !== Number(record.type_id)) return '物品类型不一致。';
  if (metadataInteger(metadata, 'quantity') !== Number(record.quantity)) return '数量不一致。';
  if (metadataInteger(metadata, 'fromLocationId', 'from_location_id') !== Number(record.from_location_id)) return '调出地点不一致。';
  if (metadataInteger(metadata, 'toLocationId', 'to_location_id') !== Number(record.to_location_id)) return '调入地点不一致。';
  const tradeTime = metadataTime(metadata, 'tradeTime', 'trade_time', 'capturedAt', 'captured_at');
  if (!tradeTime) return '资产证据缺少有效时间。';
  try {
    if (tradeTime !== normalizeIso(String(record.trade_time))) return '交易时间不一致。';
  } catch {
    return '交易时间无效。';
  }
  return null;
}

function esiWalletEvidenceMismatch(record: any, evidence: any): string | null {
  if (evidence.evidence_type !== 'ESI_WALLET_LOG') return '证据类型不是 ESI 钱包日志。';
  if (evidence.source_system !== 'ESI_WALLET_TRANSACTIONS') return '证据来源系统不是 ESI 钱包成交。';
  if (!evidence.source_ref) return 'ESI 钱包证据缺少 source_ref。';
  if (record.source_ref && String(record.source_ref).startsWith('esi-wallet:') && record.source_ref !== evidence.source_ref) return '来源引用不一致。';
  const metadata = evidenceMetadata(evidence.metadata_json || '{}');
  const sourceMatch = /^esi-wallet:(\d+)$/.exec(String(evidence.source_ref));
  if (!sourceMatch) return 'ESI 钱包证据 source_ref 格式无效。';
  const sourceTransactionId = Number(sourceMatch[1]);
  const transactionId = metadataInteger(metadata, 'transactionId', 'transaction_id');
  if (transactionId === null || transactionId !== sourceTransactionId) return '交易编号不一致。';
  if (metadataInteger(metadata, 'typeId', 'type_id') !== Number(record.type_id)) return '物品类型不一致。';
  if (metadataInteger(metadata, 'quantity') !== Number(record.quantity)) return '数量不一致。';
  const unitPrice = metadataMoney(metadata, 'unitPrice', 'unit_price');
  if (unitPrice === null || Math.round(unitPrice * 100) !== Math.round(Number(record.unit_price) * 100)) return '单价不一致。';
  if (metadataInteger(metadata, 'locationId', 'location_id') !== Number(record.location_id)) return '地点不一致。';
  const isBuy = metadataValue(metadata, 'isBuy', 'is_buy');
  if (typeof isBuy !== 'boolean' || isBuy !== (record.direction === 'BUY')) return '买卖方向不一致。';
  const tradeTime = metadataTime(metadata, 'tradeTime', 'trade_time', 'date');
  if (!tradeTime) return 'ESI 钱包证据缺少有效交易时间。';
  try {
    if (tradeTime !== normalizeIso(String(record.trade_time))) return '交易时间不一致。';
  } catch {
    return '交易时间无效。';
  }
  return null;
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
  if (input.tradeKind === 'REVERSAL') {
    throw new Error('REVERSAL 只能通过 P93LedgerService.reverse() 生成，不能作为普通交易登记。');
  }
  if (input.tradeKind === 'FEE_ADJUSTMENT') {
    throw new Error('FEE_ADJUSTMENT 尚未定义安全的费用归属口径，已暂停登记。');
  }
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
  if ((input.tradeKind === 'COST_ADJUSTMENT' || input.tradeKind === 'INVENTORY_TRANSFER')
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
  scope: LedgerScope = null,
): void {
  const [ownerUserId, ownerChatId, bindingEpoch, bindingDigest] = lineageInsertValues(scope);
  db.prepare(`
    INSERT INTO real_trade_events
      (character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       record_id, event_type, actor_type, actor_id, before_json, after_json, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    characterId,
    ownerUserId,
    ownerChatId,
    bindingEpoch,
    bindingDigest,
    recordId,
    eventType,
    actorType,
    actorId,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
    reason ?? null,
    new Date().toISOString(),
  );
}

export class P93LedgerService {
  static list(
    db: Db,
    characterId: number,
    filters: { state?: string; verification?: string; direction?: string; sourceType?: string; typeId?: number; limit?: number; offset?: number } = {},
    lineage?: RealLedgerLineage | null,
  ): { records: P93Record[]; total: number } {
    const scope = ledgerScope(db, characterId, lineage);
    const owner = ledgerPredicate(scope);
    const where = ['character_id = ?', owner.sql];
    const params: unknown[] = [characterId, ...owner.params];
    if (filters.state) { where.push('record_state = ?'); params.push(filters.state); }
    if (filters.verification) { where.push('verification_status = ?'); params.push(filters.verification); }
    if (filters.direction) { where.push('direction = ?'); params.push(filters.direction); }
    if (filters.sourceType) { where.push('source_type = ?'); params.push(filters.sourceType); }
    if (filters.typeId) { where.push('type_id = ?'); params.push(filters.typeId); }
    const sql = where.join(' AND ');
    const requestedLimit = filters.limit;
    const requestedOffset = filters.offset;
    const limit = Number.isSafeInteger(requestedLimit) && (requestedLimit ?? 0) > 0
      ? Math.min(requestedLimit as number, 500)
      : 100;
    const offset = Number.isSafeInteger(requestedOffset) && (requestedOffset ?? -1) >= 0
      ? Math.min(requestedOffset as number, 1_000_000)
      : 0;
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM real_trade_records WHERE ${sql}`).get(...params) as any)?.n || 0);
    const rows = db.prepare(`
      SELECT * FROM real_trade_records WHERE ${sql}
      ORDER BY trade_time DESC, created_at DESC, record_id DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];
    return { records: rows.map((row) => mapRecord(db, row)), total };
  }

  static get(
    db: Db,
    characterId: number,
    recordId: string,
    lineage?: RealLedgerLineage | null,
  ): P93Record | null {
    const owner = ledgerPredicate(ledgerScope(db, characterId, lineage));
    const row = db.prepare(`
      SELECT * FROM real_trade_records
      WHERE character_id = ? AND record_id = ? AND ${owner.sql}
    `).get(characterId, recordId, ...owner.params) as any;
    return row ? mapRecord(db, row) : null;
  }

  static recordManual(
    db: Db,
    characterId: number,
    input: P93RecordInput,
    actor = 'user',
    lineage?: RealLedgerLineage | null,
  ): P93Record {
    assertHumanActor(actor);
    if (input.sourceType.startsWith('ESI_') || input.sourceType === 'ASSET_CHANGE') {
      throw new Error('公共人工登记不能伪造 ESI 或资产变化证据来源；请使用对应同步或证据流程。');
    }
    return this.upsert(db, characterId, input, 'USER', actor, lineage);
  }

  static upsert(
    db: Db,
    characterId: number,
    input: P93RecordInput,
    actorType: ActorType,
    actorId: string | null,
    lineage?: RealLedgerLineage | null,
  ): P93Record {
    if (actorType === 'USER') {
      assertHumanActor(actorId ?? '');
      if (input.sourceType.startsWith('ESI_') || input.sourceType === 'ASSET_CHANGE') {
        throw new Error('公共人工登记不能伪造 ESI 或资产变化证据来源；请使用对应同步或证据流程。');
      }
    }
    validateInput(input);
    const hash = recordHash(input);
    if (input.sourceHash && input.sourceHash !== hash) {
      throw new Error('sourceHash 与交易事实不一致，拒绝登记。');
    }
    const owner = ledgerPredicate(ledgerScope(db, characterId, lineage));
    const existing = db.prepare(`
      SELECT * FROM real_trade_records
      WHERE character_id = ? AND ledger_key = ? AND ${owner.sql}
    `).get(characterId, input.ledgerKey, ...owner.params) as any;
    if (existing) {
      if (existing.source_hash !== hash) throw new Error('相同 ledgerKey 已用于不同交易事实，拒绝重复登记。');
      return mapRecord(db, existing);
    }
    const recordId = 'REALTRADE-' + randomUUID();
    const tx = db.transaction(() => {
      const scope = ledgerScope(db, characterId, lineage);
      if (scope) {
        // A read before BEGIN is only a fast idempotency check. Revalidate and
        // repeat deduplication after the write lock is held.
        const current = revalidateLedgerLineage(db, characterId, scope);
        const duplicate = db.prepare(`
          SELECT * FROM real_trade_records
          WHERE character_id = ? AND ledger_key = ?
            AND owner_user_id = ? AND owner_chat_id IS ? AND binding_epoch = ?
        `).get(characterId, input.ledgerKey, current.ownerUserId, current.ownerChatId, current.bindingEpoch) as any;
        if (duplicate) {
          if (duplicate.source_hash !== hash) throw new Error('相同 ledgerKey 已用于不同交易事实，拒绝重复登记。');
          return mapRecord(db, duplicate);
        }
      }
      const [ownerUserId, ownerChatId, bindingEpoch, bindingDigest] = lineageInsertValues(scope);
      db.prepare(`
        INSERT INTO real_trade_records (
          record_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
          ledger_key, record_state, verification_status, trade_kind, direction,
          type_id, location_id, quantity, unit_price, fee_status, trade_time, source_type, source_ref,
          source_hash, order_id, fill_id, execution_status, opportunity_id, plan_id, notes,
          adjustment_mode, adjustment_amount, target_lot_id, from_location_id, to_location_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        characterId,
        ownerUserId,
        ownerChatId,
        bindingEpoch,
        bindingDigest,
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
          INSERT INTO real_trade_fees
            (fee_id, record_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
             fee_kind, amount, treatment, evidence_id, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'FEE-' + randomUUID(), recordId, ownerUserId, ownerChatId, bindingEpoch, bindingDigest,
          fee.feeKind, fee.amount, fee.treatment, fee.evidenceId ?? null, fee.notes ?? null,
        );
      }
      if (!input.draft) {
        db.prepare(`
          UPDATE real_trade_records
          SET record_state = 'ACTIVE', verification_status = 'USER_REPORTED', updated_at = ?
          WHERE record_id = ? AND character_id = ?
            AND owner_user_id IS ? AND owner_chat_id IS ? AND binding_epoch = ?
        `).run(
          new Date().toISOString(), recordId, characterId,
          ownerUserId, ownerChatId, bindingEpoch,
        );
      }
      insertEvent(
        db, characterId, recordId, input.draft ? 'draft_created' : 'record_created',
        actorType, actorId, null, input, undefined, scope,
      );
      return null;
    });
    const duplicate = tx.immediate();
    return duplicate ?? this.get(db, characterId, recordId, lineage)!;
  }

  static updateDraft(
    db: Db,
    characterId: number,
    recordId: string,
    patch: Partial<P93RecordInput>,
    actor = 'user',
    lineage?: RealLedgerLineage | null,
  ): P93Record {
    assertHumanActor(actor);
    const owner = ledgerPredicate(ledgerScope(db, characterId, lineage));
    const existing = db.prepare(`
      SELECT * FROM real_trade_records
      WHERE character_id = ? AND record_id = ? AND ${owner.sql}
    `).get(characterId, recordId, ...owner.params) as any;
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
    if (next.sourceType.startsWith('ESI_') || next.sourceType === 'ASSET_CHANGE') {
      throw new Error('草稿更新不能伪造 ESI 或资产变化证据来源；请使用对应同步或证据流程。');
    }
    validateInput(next);
    const nextHash = recordHash(next);
    const tx = db.transaction(() => {
      const scope = ledgerScope(db, characterId, lineage);
      if (scope) revalidateLedgerLineage(db, characterId, scope);
      const [ownerUserId, ownerChatId, bindingEpoch, bindingDigest] = lineageInsertValues(scope);
      const ownerWhere = 'owner_user_id IS ? AND owner_chat_id IS ? AND binding_epoch = ?';
      db.prepare(`
        UPDATE real_trade_records
        SET trade_kind = ?, direction = ?, type_id = ?, location_id = ?, quantity = ?, unit_price = ?,
            trade_time = ?, source_type = ?, source_ref = ?, source_hash = ?, order_id = ?, fill_id = ?, execution_status = ?,
            opportunity_id = ?, plan_id = ?, notes = ?, fee_status = ?, adjustment_mode = ?, adjustment_amount = ?,
            target_lot_id = ?, from_location_id = ?, to_location_id = ?, updated_at = ?
        WHERE record_id = ? AND character_id = ? AND ${ownerWhere} AND record_state = 'DRAFT'
      `).run(
        next.tradeKind, next.direction, next.typeId, next.locationId, next.quantity, next.unitPrice,
        normalizeIso(next.tradeTime), next.sourceType, next.sourceRef ?? null, nextHash, next.orderId ?? null,
        next.fillId ?? null, next.executionStatus ?? 'MANUAL_ENTRY', next.opportunityId ?? null,
        next.planId ?? null, next.notes ?? null, next.feeStatus ?? 'UNKNOWN', next.adjustmentMode ?? null,
        next.adjustmentAmount ?? null, next.targetLotId ?? null, next.fromLocationId ?? null,
        next.toLocationId ?? null, new Date().toISOString(), recordId, characterId,
        ownerUserId, ownerChatId, bindingEpoch,
      );
      if (patch.fees) {
        db.prepare(`
          DELETE FROM real_trade_fees
          WHERE record_id = ? AND ${ownerWhere}
        `).run(recordId, ownerUserId, ownerChatId, bindingEpoch);
        for (const fee of patch.fees) {
          db.prepare(`
            INSERT INTO real_trade_fees
              (fee_id, record_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
               fee_kind, amount, treatment, evidence_id, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            'FEE-' + randomUUID(), recordId, ownerUserId, ownerChatId, bindingEpoch, bindingDigest,
            fee.feeKind, fee.amount, fee.treatment, fee.evidenceId ?? null, fee.notes ?? null,
          );
        }
      }
      insertEvent(db, characterId, recordId, 'draft_updated', 'USER', actor, existing, next, undefined, scope);
    });
    tx.immediate();
    return this.get(db, characterId, recordId, lineage)!;
  }

  static submitDraft(
    db: Db,
    characterId: number,
    recordId: string,
    actor = 'user',
    lineage?: RealLedgerLineage | null,
  ): P93Record {
    assertHumanActor(actor);
    const owner = ledgerPredicate(ledgerScope(db, characterId, lineage));
    const existing = db.prepare(`
      SELECT * FROM real_trade_records
      WHERE character_id = ? AND record_id = ? AND ${owner.sql}
    `).get(characterId, recordId, ...owner.params) as any;
    if (!existing) throw new Error('交易记录不存在。');
    if (existing.record_state === 'ACTIVE' && existing.verification_status === 'USER_REPORTED') {
      return mapRecord(db, existing);
    }
    if (existing.record_state !== 'DRAFT') throw new Error('仅草稿可以提交为待核实申报。');
    const tx = db.transaction(() => {
      const scope = ledgerScope(db, characterId, lineage);
      if (scope) revalidateLedgerLineage(db, characterId, scope);
      const [ownerUserId, ownerChatId, bindingEpoch] = lineageInsertValues(scope);
      db.prepare(`
        UPDATE real_trade_records
        SET record_state = 'ACTIVE', verification_status = 'USER_REPORTED', updated_at = ?
        WHERE record_id = ? AND character_id = ?
          AND owner_user_id IS ? AND owner_chat_id IS ? AND binding_epoch = ?
          AND record_state = 'DRAFT'
      `).run(new Date().toISOString(), recordId, characterId, ownerUserId, ownerChatId, bindingEpoch);
      insertEvent(db, characterId, recordId, 'draft_submitted', 'USER', actor, existing, {
        recordState: 'ACTIVE', verificationStatus: 'USER_REPORTED',
      }, undefined, scope);
    });
    tx.immediate();
    return this.get(db, characterId, recordId, lineage)!;
  }

  static addEvidence(
    db: Db,
    characterId: number,
    input: P93EvidenceInput,
    trust: EvidenceTrust = 'USER',
    lineage?: RealLedgerLineage | null,
  ): P93Evidence {
    const userTypes = ['USER_ATTACHMENT', 'USER_CONFIRMATION'];
    const syncTypes = ['ESI_WALLET_LOG', 'ESI_MARKET_ORDER', 'ESI_ASSET_SNAPSHOT', 'ASSET_CHANGE'];
    if (![...userTypes, ...syncTypes].includes(input.evidenceType)) throw new Error('证据类型无效。');
    if (trust === 'USER' && !userTypes.includes(input.evidenceType)) {
      throw new Error('公共接口只能登记用户附件或用户确认，不能伪造 ESI 证据。');
    }
    if (trust === 'ESI_SYNC' && !syncTypes.includes(input.evidenceType)) {
      throw new Error('同步接口只能登记 ESI 或资产变化证据。');
    }
    if (!input.sourceSystem || input.sourceSystem.length > 80) throw new Error('证据来源系统必填且长度受控。');
    if (!input.payloadHash || input.payloadHash.length < 8 || input.payloadHash.length > 256) throw new Error('证据内容哈希无效。');
    const status = input.initialStatus ?? 'PENDING';
    if (!['VERIFIED', 'USER_REPORTED', 'PENDING', 'CONFLICT', 'REJECTED'].includes(status)) throw new Error('证据状态无效。');
    if (trust === 'USER' && status === 'VERIFIED') {
      throw new Error('用户证据必须经过单独的人工核实动作，不能直接登记为已核实。');
    }
    const evidenceId = 'EVID-' + randomUUID();
    const sourceRef = input.sourceRef ?? null;
    const tx = db.transaction(() => {
      const scope = ledgerScope(db, characterId, lineage);
      if (scope) revalidateLedgerLineage(db, characterId, scope);
      const owner = ledgerPredicate(scope);
      const [ownerUserId, ownerChatId, bindingEpoch, bindingDigest] = lineageInsertValues(scope);
    const existing = sourceRef
      ? db.prepare(`
          SELECT * FROM real_trade_evidence
          WHERE character_id = ? AND source_system = ? AND source_ref = ? AND ${owner.sql}
        `).get(characterId, input.sourceSystem, sourceRef, ...owner.params) as any
      : undefined;
    if (existing) {
      if (existing.payload_hash !== input.payloadHash) throw new Error('相同证据来源已登记不同内容。');
      if (existing.evidence_type !== input.evidenceType) throw new Error('相同证据来源已登记为不同证据类型。');
      return this.getEvidence(db, characterId, existing.evidence_id, lineage)!;
    }
    db.prepare(`
      INSERT INTO real_trade_evidence
        (evidence_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
         evidence_type, source_system, source_ref, captured_at, payload_hash, summary, metadata_json, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evidenceId,
      characterId,
      ownerUserId,
      ownerChatId,
      bindingEpoch,
      bindingDigest,
      input.evidenceType,
      input.sourceSystem,
      sourceRef,
      normalizeIso(input.capturedAt),
      input.payloadHash,
      input.summary ?? null,
      JSON.stringify(input.metadata ?? {}),
      status,
    );
      return this.getEvidence(db, characterId, evidenceId, lineage)!;
    });
    return tx.immediate();
  }

  static getEvidence(
    db: Db,
    characterId: number,
    evidenceId: string,
    lineage?: RealLedgerLineage | null,
  ): P93Evidence | null {
    const owner = ledgerPredicate(ledgerScope(db, characterId, lineage));
    const row = db.prepare(`
      SELECT * FROM real_trade_evidence
      WHERE character_id = ? AND evidence_id = ? AND ${owner.sql}
    `).get(characterId, evidenceId, ...owner.params) as any;
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
    lineage?: RealLedgerLineage | null,
  ): P93Evidence {
    assertHumanActor(actor);
    if (!['VERIFIED', 'USER_REPORTED', 'PENDING', 'CONFLICT', 'REJECTED'].includes(status)) throw new Error('证据状态无效。');
    const existing = this.getEvidence(db, characterId, evidenceId, lineage);
    if (!existing) throw new Error('证据不存在。');
    if (existing.status === 'VERIFIED' && status !== 'VERIFIED') throw new Error('已核实证据不可降级或删除。');
    const tx = db.transaction(() => {
      const scope = ledgerScope(db, characterId, lineage);
      if (scope) revalidateLedgerLineage(db, characterId, scope);
      const owner = ledgerPredicate(scope);
      db.prepare(`
        UPDATE real_trade_evidence SET status = ?
        WHERE character_id = ? AND evidence_id = ? AND ${owner.sql}
      `).run(status, characterId, evidenceId, ...owner.params);
      for (const link of db.prepare('SELECT record_id FROM real_trade_evidence_links WHERE evidence_id = ?').all(evidenceId) as any[]) {
        insertEvent(db, characterId, link.record_id, 'evidence_status_changed', 'USER', actor, existing, { status }, reason, scope);
      }
    });
    tx.immediate();
    return this.getEvidence(db, characterId, evidenceId, lineage)!;
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
    lineage?: RealLedgerLineage | null,
  ): void {
    if (actorType === 'USER') assertHumanActor(actorId ?? '');
    if (actorType === 'ESI_SYNC' && actorId !== 'esi-wallet-sync') {
      throw new Error('未知的 ESI 同步身份。');
    }
    const owner = ledgerPredicate(ledgerScope(db, characterId, lineage));
    const record = db.prepare(`
      SELECT record_id, record_state, trade_kind, direction, type_id, location_id, quantity, unit_price,
             trade_time, source_type, source_ref, from_location_id, to_location_id
      FROM real_trade_records
      WHERE character_id = ? AND record_id = ? AND ${owner.sql}
    `).get(characterId, recordId, ...owner.params) as any;
    const evidence = db.prepare(`
      SELECT evidence_id, evidence_type, source_system, source_ref, status, metadata_json
      FROM real_trade_evidence
      WHERE character_id = ? AND evidence_id = ? AND ${owner.sql}
    `).get(characterId, evidenceId, ...owner.params) as any;
    if (!record || !evidence) throw new Error('交易或证据不存在。');
    if (['VERIFIED', 'REVERSED', 'CORRECTED'].includes(record.record_state)) {
      throw new Error('已核实或终态记录的证据关系不可原地变更；请使用更正或冲正。');
    }
    if (evidence.evidence_type === 'ESI_WALLET_LOG' && ['PRIMARY', 'CORROBORATING'].includes(relation)) {
      const mismatch = esiWalletEvidenceMismatch(record, evidence);
      if (mismatch) throw new Error(`ESI 钱包证据与交易事实不匹配：${mismatch}`);
    }
    if (['ESI_ASSET_SNAPSHOT', 'ASSET_CHANGE'].includes(evidence.evidence_type) && ['PRIMARY', 'CORROBORATING'].includes(relation)) {
      const mismatch = esiAssetEvidenceMismatch(record, evidence);
      if (mismatch) throw new Error(`资产证据与交易事实不匹配：${mismatch}`);
    }
    const esiSupportingEvidence = ['ESI_WALLET_LOG', 'ESI_MARKET_ORDER', 'ESI_ASSET_SNAPSHOT', 'ASSET_CHANGE'].includes(evidence.evidence_type);
    if (esiSupportingEvidence && ['PRIMARY', 'CORROBORATING'].includes(relation)) {
      const reused = db.prepare(`
        SELECT l.record_id FROM real_trade_evidence_links l
        WHERE l.evidence_id = ? AND l.record_id <> ? AND l.relation IN ('PRIMARY', 'CORROBORATING')
        LIMIT 1
      `).get(evidenceId, recordId);
      if (reused) throw new Error('同一 ESI 证据不能支持多条交易记录。');
    }
    const normalizedNotes = notes ?? null;
    const tx = db.transaction(() => {
      const scope = ledgerScope(db, characterId, lineage);
      if (scope) revalidateLedgerLineage(db, characterId, scope);
      const existingLink = db.prepare(`
        SELECT relation, confidence, notes
        FROM real_trade_evidence_links
        WHERE evidence_id = ? AND record_id = ?
      `).get(evidenceId, recordId) as { relation: string; confidence: string; notes: string | null } | undefined;

      if (!existingLink) {
        db.prepare(`
          INSERT INTO real_trade_evidence_links (evidence_id, record_id, relation, confidence, notes)
          VALUES (?, ?, ?, ?, ?)
        `).run(evidenceId, recordId, relation, confidence, normalizedNotes);
        insertEvent(
          db, characterId, recordId, 'evidence_linked', actorType, actorId, null,
          { evidenceId, relation, confidence }, notes, scope,
        );
        return;
      }

      if (
        existingLink.relation === relation
        && existingLink.confidence === confidence
        && existingLink.notes === normalizedNotes
      ) {
        return;
      }

      db.prepare(`
        UPDATE real_trade_evidence_links
        SET relation = ?, confidence = ?, notes = ?
        WHERE evidence_id = ? AND record_id = ?
      `).run(relation, confidence, normalizedNotes, evidenceId, recordId);
      insertEvent(
        db, characterId, recordId, 'evidence_link_updated', actorType, actorId,
        existingLink, { evidenceId, relation, confidence }, notes, scope,
      );
    });
    tx.immediate();
  }

  static verify(
    db: Db,
    characterId: number,
    recordId: string,
    actor = 'user',
    reason?: string,
    actorType: ActorType = 'USER',
    lineage?: RealLedgerLineage | null,
  ): P93Record {
    assertHumanActor(actor);
    const owner = ledgerPredicate(ledgerScope(db, characterId, lineage));
    const existing = db.prepare(`
      SELECT * FROM real_trade_records
      WHERE character_id = ? AND record_id = ? AND ${owner.sql}
    `).get(characterId, recordId, ...owner.params) as any;
    if (!existing) throw new Error('交易记录不存在。');
    if (existing.trade_kind === 'FEE_ADJUSTMENT') {
      throw new Error('FEE_ADJUSTMENT 尚未定义安全的费用归属口径，不能核实。');
    }
    if (existing.record_state === 'VERIFIED') return mapRecord(db, existing);
    if (existing.record_state !== 'ACTIVE') {
      throw new Error(existing.record_state === 'DRAFT'
        ? '草稿必须先提交为待核实申报，再关联证据并人工核实。'
        : '当前状态不可核实。');
    }
    const conflicting = db.prepare(`
      SELECT e.evidence_id FROM real_trade_evidence e
      JOIN real_trade_evidence_links l ON l.evidence_id = e.evidence_id
      WHERE e.character_id = ? AND l.record_id = ? AND ${owner.sql.replace(/(^| AND )/g, '$1e.')}
        AND e.status IN ('VERIFIED', 'CONFLICT') AND l.relation = 'CONFLICTING'
      LIMIT 1
    `).get(characterId, recordId, ...owner.params);
    if (conflicting) throw new Error('存在已核实或冲突证据，不能把交易提升为已核实。');
    const linkedEvidence = db.prepare(`
      SELECT e.evidence_id, e.evidence_type, e.source_system, e.source_ref, e.status, e.metadata_json
      FROM real_trade_evidence e
      JOIN real_trade_evidence_links l ON l.evidence_id = e.evidence_id
      WHERE e.character_id = ? AND l.record_id = ? AND ${owner.sql.replace(/(^| AND )/g, '$1e.')}
        AND e.status = 'VERIFIED' AND l.relation IN ('PRIMARY', 'CORROBORATING')
    `).all(characterId, recordId, ...owner.params) as any[];
    const tradingKinds = ['BUY', 'SELL', 'PARTIAL_FILL', 'MULTI_BATCH_FILL'];
    let matchingEvidence: any;
    if (tradingKinds.includes(existing.trade_kind)) {
      matchingEvidence = linkedEvidence.find((item) => (
        item.evidence_type === 'ESI_WALLET_LOG'
        && item.source_system === 'ESI_WALLET_TRANSACTIONS'
        && esiWalletEvidenceMismatch(existing, item) === null
      ));
    } else if (existing.trade_kind === 'INVENTORY_TRANSFER') {
      matchingEvidence = linkedEvidence.find((item) => (
        ['ESI_ASSET_SNAPSHOT', 'ASSET_CHANGE'].includes(item.evidence_type)
        && esiAssetEvidenceMismatch(existing, item) === null
      ));
    } else if (existing.trade_kind === 'FEE_ADJUSTMENT' || existing.trade_kind === 'COST_ADJUSTMENT') {
      matchingEvidence = linkedEvidence.find((item) => ['USER_ATTACHMENT', 'USER_CONFIRMATION'].includes(item.evidence_type));
    }
    if (!matchingEvidence) {
      const required = tradingKinds.includes(existing.trade_kind)
        ? '完全匹配的已核实 ESI 钱包证据'
        : existing.trade_kind === 'INVENTORY_TRANSFER'
          ? '完全匹配的已核实资产快照或资产变化证据'
          : '已核实的用户附件或确认';
      throw new Error(`缺少与交易事实${required}，不能把用户申报提升为已核实。`);
    }
    const reusedEvidence = db.prepare(`
      SELECT r.record_id
      FROM real_trade_evidence_links l
      JOIN real_trade_records r ON r.record_id = l.record_id AND r.character_id = ?
      WHERE l.evidence_id = ? AND l.record_id <> ?
        AND ${owner.sql.replace(/(^| AND )/g, '$1r.')}
        AND l.relation IN ('PRIMARY', 'CORROBORATING')
        AND r.record_state = 'VERIFIED'
      LIMIT 1
    `).get(characterId, matchingEvidence.evidence_id, recordId, ...owner.params);
    if (reusedEvidence) throw new Error('同一 ESI 证据已支持另一条已核实交易，不能重复核实。');
    const tx = db.transaction(() => {
      const scope = ledgerScope(db, characterId, lineage);
      if (scope) revalidateLedgerLineage(db, characterId, scope);
      const [ownerUserId, ownerChatId, bindingEpoch] = lineageInsertValues(scope);
      const changedAt = new Date().toISOString();
      db.prepare(`
        UPDATE real_trade_records
        SET record_state = 'VERIFIED', verification_status = 'VERIFIED', verified_at = ?, updated_at = ?
        WHERE record_id = ? AND character_id = ?
          AND owner_user_id IS ? AND owner_chat_id IS ? AND binding_epoch = ?
      `).run(changedAt, changedAt, recordId, characterId, ownerUserId, ownerChatId, bindingEpoch);
      insertEvent(
        db, characterId, recordId, 'record_verified', actorType, actor, existing,
        { verificationStatus: 'VERIFIED', evidenceId: matchingEvidence.evidence_id },
        reason, scope,
      );
    });
    tx.immediate();
    return this.get(db, characterId, recordId, lineage)!;
  }

  static setVerification(
    db: Db,
    characterId: number,
    recordId: string,
    status: P93VerificationStatus,
    actor = 'user',
    reason?: string,
    lineage?: RealLedgerLineage | null,
  ): P93Record {
    assertHumanActor(actor);
    if (status === 'VERIFIED') return this.verify(db, characterId, recordId, actor, reason, 'USER', lineage);
    const owner = ledgerPredicate(ledgerScope(db, characterId, lineage));
    const existing = db.prepare(`
      SELECT * FROM real_trade_records
      WHERE character_id = ? AND record_id = ? AND ${owner.sql}
    `).get(characterId, recordId, ...owner.params) as any;
    if (!existing) throw new Error('交易记录不存在。');
    if (existing.record_state === 'VERIFIED' || existing.verification_status === 'VERIFIED') {
      throw new Error('已核实交易不能降级；如需变更请使用冲正或更正流程。');
    }
    if (existing.record_state === 'REJECTED' || existing.record_state === 'REVERSED' || existing.record_state === 'CORRECTED') {
      throw new Error('终态记录不能重新进入待核实状态。');
    }
    const nextState = status === 'REJECTED' ? 'REJECTED' : existing.record_state === 'DRAFT' ? 'DRAFT' : 'ACTIVE';
    const tx = db.transaction(() => {
      const scope = ledgerScope(db, characterId, lineage);
      if (scope) revalidateLedgerLineage(db, characterId, scope);
      const [ownerUserId, ownerChatId, bindingEpoch] = lineageInsertValues(scope);
      const changedAt = new Date().toISOString();
      db.prepare(`
        UPDATE real_trade_records
        SET verification_status = ?, record_state = ?, rejected_reason = ?, updated_at = ?
        WHERE record_id = ? AND character_id = ?
          AND owner_user_id IS ? AND owner_chat_id IS ? AND binding_epoch = ?
      `).run(
        status, nextState, status === 'REJECTED' ? reason ?? '人工驳回' : null,
        changedAt, recordId, characterId, ownerUserId, ownerChatId, bindingEpoch,
      );
      insertEvent(db, characterId, recordId, 'verification_changed', 'USER', actor, existing, { verificationStatus: status }, reason, scope);
    });
    tx.immediate();
    return this.get(db, characterId, recordId, lineage)!;
  }

  static reverse(
    db: Db,
    characterId: number,
    recordId: string,
    actor = 'user',
    reason: string,
    lineage?: RealLedgerLineage | null,
  ): P93Record {
    assertHumanActor(actor);
    if (!reason.trim()) throw new Error('冲正必须填写原因。');
    const owner = ledgerPredicate(ledgerScope(db, characterId, lineage));
    const existing = db.prepare(`
      SELECT * FROM real_trade_records
      WHERE character_id = ? AND record_id = ? AND ${owner.sql}
    `).get(characterId, recordId, ...owner.params) as any;
    if (!existing) throw new Error('交易记录不存在。');
    if (existing.record_state === 'REVERSED') return mapRecord(db, existing);
    if (existing.record_state !== 'VERIFIED' && existing.record_state !== 'ACTIVE') throw new Error('仅活动或已核实记录可以冲正。');
    const tx = db.transaction(() => {
      const scope = ledgerScope(db, characterId, lineage);
      if (scope) revalidateLedgerLineage(db, characterId, scope);
      const [ownerUserId, ownerChatId, bindingEpoch] = lineageInsertValues(scope);
      const changedAt = new Date().toISOString();
      db.prepare(`
        UPDATE real_trade_records
        SET record_state = 'REVERSED', reverses_record_id = ?, updated_at = ?
        WHERE record_id = ? AND character_id = ?
          AND owner_user_id IS ? AND owner_chat_id IS ? AND binding_epoch = ?
      `).run(recordId, changedAt, recordId, characterId, ownerUserId, ownerChatId, bindingEpoch);
      insertEvent(db, characterId, recordId, 'record_reversed', 'USER', actor, existing, { recordState: 'REVERSED' }, reason, scope);
    });
    tx.immediate();
    return this.get(db, characterId, recordId, lineage)!;
  }

  static correction(
    db: Db,
    characterId: number,
    originalRecordId: string,
    input: P93RecordInput,
    actor = 'user',
    reason: string,
    lineage?: RealLedgerLineage | null,
  ): P93Record {
    assertHumanActor(actor);
    if (!reason.trim()) throw new Error('更正必须填写原因。');
    const owner = ledgerPredicate(ledgerScope(db, characterId, lineage));
    const original = db.prepare(`
      SELECT * FROM real_trade_records
      WHERE character_id = ? AND record_id = ? AND ${owner.sql}
    `).get(characterId, originalRecordId, ...owner.params) as any;
    if (!original) throw new Error('原交易记录不存在。');
    if (original.record_state === 'DRAFT') throw new Error('草稿请直接编辑，不需要更正流程。');
    if (['REJECTED', 'REVERSED', 'CORRECTED'].includes(original.record_state)) throw new Error('终态记录不能再更正。');
    if (input.ledgerKey === original.ledger_key) {
      throw new Error('更正必须使用新的 ledgerKey，不能复用原交易的 ledgerKey。');
    }
    const tx = db.transaction(() => {
      const scope = ledgerScope(db, characterId, lineage);
      if (scope) revalidateLedgerLineage(db, characterId, scope);
      const [ownerUserId, ownerChatId, bindingEpoch] = lineageInsertValues(scope);
      const corrected = this.upsert(db, characterId, { ...input, draft: true }, 'USER', actor, lineage);
      const changedAt = new Date().toISOString();
      db.prepare(`
        UPDATE real_trade_records
        SET record_state = 'CORRECTED', supersedes_record_id = ?, updated_at = ?
        WHERE record_id = ? AND character_id = ?
          AND owner_user_id IS ? AND owner_chat_id IS ? AND binding_epoch = ?
      `).run(
        corrected.recordId, changedAt, originalRecordId, characterId,
        ownerUserId, ownerChatId, bindingEpoch,
      );
      db.prepare(`
        UPDATE real_trade_records
        SET supersedes_record_id = ?, updated_at = ?
        WHERE record_id = ? AND character_id = ?
          AND owner_user_id IS ? AND owner_chat_id IS ? AND binding_epoch = ?
      `).run(
        originalRecordId, changedAt, corrected.recordId, characterId,
        ownerUserId, ownerChatId, bindingEpoch,
      );
      insertEvent(db, characterId, originalRecordId, 'record_corrected', 'USER', actor, original, { correctedRecordId: corrected.recordId }, reason, scope);
      return corrected;
    });
    const corrected = tx.immediate();
    return this.get(db, characterId, corrected.recordId, lineage)!;
  }

  static summary(
    db: Db,
    characterId: number,
    lineage?: RealLedgerLineage | null,
  ): Record<string, unknown> {
    const owner = ledgerPredicate(ledgerScope(db, characterId, lineage));
    const rows = db.prepare(`
      SELECT record_state, verification_status, direction, COUNT(*) AS count
      FROM real_trade_records WHERE character_id = ? AND ${owner.sql}
      GROUP BY record_state, verification_status, direction
    `).all(characterId, ...owner.params) as any[];
    return { rows, rawRecordCount: rows.reduce((sum, row) => sum + Number(row.count || 0), 0) };
  }
}
