import type { Db } from '../db/sqlite.js';
import { clampPositiveInteger } from '../util/query-bounds.js';

export class P93AuditService {
  static events(db: Db, characterId: number, recordId?: string, limit = 200): any[] {
    const where = ['character_id = ?'];
    const params: unknown[] = [characterId];
    if (recordId) { where.push('record_id = ?'); params.push(recordId); }
    return db.prepare(`
      SELECT * FROM real_trade_events
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, event_id DESC LIMIT ?
    `).all(...params, clampPositiveInteger(limit, 200, 1000));
  }

  static calculationRuns(db: Db, characterId: number, limit = 50): any[] {
    const rows = db.prepare(`
      SELECT * FROM real_calculation_runs
      WHERE character_id = ?
      ORDER BY started_at DESC, run_id DESC LIMIT ?
    `).all(characterId, clampPositiveInteger(limit, 50, 200)) as any[];
    return rows.map((row) => ({ ...row, differences: JSON.parse(row.differences_json || '{}') }));
  }

  static reconciliationRuns(db: Db, characterId: number, limit = 50): any[] {
    const rows = db.prepare(`
      SELECT * FROM real_reconciliation_runs
      WHERE character_id = ?
      ORDER BY created_at DESC, run_id DESC LIMIT ?
    `).all(characterId, clampPositiveInteger(limit, 50, 200)) as any[];
    return rows.map((row) => ({ ...row, summary: JSON.parse(row.summary_json || '{}') }));
  }

  static integrityCheck(db: Db, characterId?: number): { ok: boolean; findings: string[] } {
    const findings: string[] = [];
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity[0]?.integrity_check !== 'ok') findings.push(`SQLite integrity_check=${integrity[0]?.integrity_check ?? 'unknown'}`);
    const requiredTriggers = [
      'real_trade_records_no_delete',
      'real_trade_records_immutable_facts',
      'real_trade_records_insert_unverified',
      'real_trade_records_draft_cannot_verify',
      'real_trade_records_verified_no_downgrade',
      'real_trade_records_fee_adjustment_cannot_verify',
      'real_trade_records_verify_matching_evidence',
      'real_trade_records_verify_conflicts',
      'real_trade_events_insert_valid_record',
      'real_trade_events_append_only_update',
      'real_trade_events_append_only_delete',
      'real_trade_evidence_verified_immutable_update',
      'real_trade_evidence_verified_immutable_delete',
      'real_trade_fees_non_draft_insert',
      'real_trade_fees_non_draft_update',
      'real_trade_fees_non_draft_delete',
      'real_trade_evidence_links_immutable_insert',
      'real_trade_evidence_links_single_esi_support_insert',
      'real_trade_evidence_links_single_esi_support_update',
      'real_trade_evidence_links_immutable_update',
      'real_trade_evidence_links_immutable_delete',
    ];
    const triggers = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger'
    `).all() as Array<{ name: string }>;
    const triggerNames = new Set(triggers.map((row) => row.name));
    const missingTriggers = requiredTriggers.filter((name) => !triggerNames.has(name));
    if (missingTriggers.length > 0) findings.push(`P9.3 财务审计触发器不完整：${missingTriggers.join(', ')}`);
    const scope = characterId ?? null;
    const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeyViolations.length > 0) findings.push(`SQLite foreign_key_check 发现 ${foreignKeyViolations.length} 条违规。`);
    const paperRows = Number((db.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE is_paper <> 0 AND (? IS NULL OR character_id = ?)').get(scope, scope) as any)?.n || 0);
    if (paperRows !== 0) findings.push('REAL 账本中发现 PAPER 标记记录。');
    const verifiedFeeAdjustments = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM real_trade_records
      WHERE trade_kind = 'FEE_ADJUSTMENT'
        AND (record_state = 'VERIFIED' OR verification_status = 'VERIFIED')
        AND (? IS NULL OR character_id = ?)
    `).get(scope, scope) as any)?.n || 0);
    if (verifiedFeeAdjustments > 0) findings.push(`发现 ${verifiedFeeAdjustments} 条已核实 FEE_ADJUSTMENT；费用归属口径未定义，必须撤销核实状态。`);
    const duplicateEsiSupport = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT l.evidence_id
        FROM real_trade_evidence_links l
        JOIN real_trade_evidence e ON e.evidence_id = l.evidence_id
        JOIN real_trade_records r ON r.record_id = l.record_id AND r.character_id = e.character_id
        WHERE e.evidence_type IN ('ESI_WALLET_LOG', 'ESI_MARKET_ORDER', 'ESI_ASSET_SNAPSHOT', 'ASSET_CHANGE')
          AND l.relation IN ('PRIMARY', 'CORROBORATING')
          AND (? IS NULL OR e.character_id = ?)
        GROUP BY l.evidence_id
        HAVING COUNT(DISTINCT l.record_id) > 1
      )
    `).get(scope, scope) as any)?.n || 0);
    if (duplicateEsiSupport > 0) findings.push(`发现 ${duplicateEsiSupport} 条 ESI 证据被重复用于支持多条交易。`);
    const orphanVerified = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM real_trade_records r
      WHERE r.record_state = 'VERIFIED' AND r.verification_status = 'VERIFIED'
        AND (? IS NULL OR r.character_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM real_trade_evidence_links l
          JOIN real_trade_evidence e ON e.evidence_id = l.evidence_id
          WHERE l.record_id = r.record_id AND e.character_id = r.character_id
            AND e.status = 'VERIFIED' AND l.relation IN ('PRIMARY', 'CORROBORATING')
            AND (
              (
                r.trade_kind IN ('BUY', 'SELL', 'PARTIAL_FILL', 'MULTI_BATCH_FILL')
                AND e.evidence_type = 'ESI_WALLET_LOG'
                AND e.source_system = 'ESI_WALLET_TRANSACTIONS'
                AND e.source_ref IS NOT NULL
                AND (r.source_ref IS NULL OR r.source_ref NOT LIKE 'esi-wallet:%' OR e.source_ref = r.source_ref)
                AND json_valid(e.metadata_json)
                AND CAST(json_extract(e.metadata_json, '$.transactionId') AS TEXT) = substr(e.source_ref, 12)
                AND CAST(json_extract(e.metadata_json, '$.typeId') AS INTEGER) = r.type_id
                AND CAST(json_extract(e.metadata_json, '$.quantity') AS INTEGER) = r.quantity
                AND ABS(CAST(json_extract(e.metadata_json, '$.unitPrice') AS REAL) - r.unit_price) <= 0.005
                AND CAST(json_extract(e.metadata_json, '$.locationId') AS INTEGER) = r.location_id
                AND (
                  (json_extract(e.metadata_json, '$.isBuy') = 1 AND r.direction = 'BUY')
                  OR (json_extract(e.metadata_json, '$.isBuy') = 0 AND r.direction = 'SELL')
                )
                AND datetime(json_extract(e.metadata_json, '$.tradeTime')) = datetime(r.trade_time)
              )
              OR (
                r.trade_kind = 'INVENTORY_TRANSFER'
                AND e.evidence_type IN ('ESI_ASSET_SNAPSHOT', 'ASSET_CHANGE')
                AND (r.source_ref IS NULL OR r.source_ref NOT LIKE 'asset-%' OR e.source_ref = r.source_ref)
                AND json_valid(e.metadata_json)
                AND CAST(json_extract(e.metadata_json, '$.typeId') AS INTEGER) = r.type_id
                AND CAST(json_extract(e.metadata_json, '$.quantity') AS INTEGER) = r.quantity
                AND CAST(json_extract(e.metadata_json, '$.fromLocationId') AS INTEGER) = r.from_location_id
                AND CAST(json_extract(e.metadata_json, '$.toLocationId') AS INTEGER) = r.to_location_id
                AND datetime(COALESCE(json_extract(e.metadata_json, '$.tradeTime'), json_extract(e.metadata_json, '$.capturedAt'))) = datetime(r.trade_time)
              )
              OR (
                r.trade_kind IN ('FEE_ADJUSTMENT', 'COST_ADJUSTMENT')
                AND e.evidence_type IN ('USER_ATTACHMENT', 'USER_CONFIRMATION')
              )
            )
        )
    `).get(scope, scope) as any)?.n || 0);
    if (orphanVerified > 0) findings.push(`发现 ${orphanVerified} 条无匹配已核实证据的 VERIFIED 交易。`);
    const invalidLots = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM real_fifo_lots
      WHERE (? IS NULL OR character_id = ?)
        AND (
          remaining_quantity > original_quantity
          OR remaining_cost < 0
          OR unit_cost < 0
          OR (cost_status = 'KNOWN' AND remaining_quantity > 0 AND remaining_cost IS NULL)
        )
    `).get(scope, scope) as any)?.n || 0);
    if (invalidLots > 0) findings.push(`FIFO 批次剩余数量或成本状态非法：${invalidLots} 条。`);
    const orphanLots = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM real_fifo_lots l
      WHERE (? IS NULL OR l.character_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM real_trade_records r
          WHERE r.record_id = l.source_record_id AND r.character_id = l.character_id
        )
    `).get(scope, scope) as any)?.n || 0);
    if (orphanLots > 0) findings.push(`FIFO 批次缺少同角色来源交易：${orphanLots} 条。`);
    const invalidConsumptions = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT c.sell_record_id
        FROM real_fifo_consumptions c
        LEFT JOIN real_trade_records r
          ON r.record_id = c.sell_record_id AND r.character_id = c.character_id
        WHERE (? IS NULL OR c.character_id = ?)
        GROUP BY c.sell_record_id
        HAVING r.record_id IS NULL
          OR r.direction <> 'SELL'
          OR SUM(c.quantity) > r.quantity
      )
    `).get(scope, scope) as any)?.n || 0);
    if (invalidConsumptions > 0) findings.push(`FIFO 消耗数量或卖出归属非法：${invalidConsumptions} 组。`);
    const orphanConsumptions = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM real_fifo_consumptions c
      WHERE (? IS NULL OR c.character_id = ?)
        AND c.lot_id <> 'UNKNOWN_SOURCE'
        AND NOT EXISTS (
          SELECT 1 FROM real_fifo_lots l
          WHERE l.lot_id = c.lot_id AND l.character_id = c.character_id
        )
    `).get(scope, scope) as any)?.n || 0);
    if (orphanConsumptions > 0) findings.push(`FIFO 消耗引用不存在或跨角色的批次：${orphanConsumptions} 条。`);
    const duplicateConsumptions = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT sell_record_id, lot_id FROM real_fifo_consumptions
        WHERE (? IS NULL OR character_id = ?)
        GROUP BY sell_record_id, lot_id HAVING COUNT(*) > 1
      )
    `).get(scope, scope) as any)?.n || 0);
    if (duplicateConsumptions > 0) findings.push('FIFO 消耗记录存在重复扣减。');
    return { ok: findings.length === 0, findings };
  }
}
