import type { Db } from '../db/sqlite.js';

export class P93AuditService {
  static events(db: Db, characterId: number, recordId?: string, limit = 200): any[] {
    const where = ['character_id = ?'];
    const params: unknown[] = [characterId];
    if (recordId) { where.push('record_id = ?'); params.push(recordId); }
    return db.prepare(`
      SELECT * FROM real_trade_events
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, event_id DESC LIMIT ?
    `).all(...params, Math.max(1, Math.min(1000, limit)));
  }

  static calculationRuns(db: Db, characterId: number, limit = 50): any[] {
    const rows = db.prepare(`
      SELECT * FROM real_calculation_runs
      WHERE character_id = ?
      ORDER BY started_at DESC, run_id DESC LIMIT ?
    `).all(characterId, Math.max(1, Math.min(200, limit))) as any[];
    return rows.map((row) => ({ ...row, differences: JSON.parse(row.differences_json || '{}') }));
  }

  static reconciliationRuns(db: Db, characterId: number, limit = 50): any[] {
    const rows = db.prepare(`
      SELECT * FROM real_reconciliation_runs
      WHERE character_id = ?
      ORDER BY created_at DESC, run_id DESC LIMIT ?
    `).all(characterId, Math.max(1, Math.min(200, limit))) as any[];
    return rows.map((row) => ({ ...row, summary: JSON.parse(row.summary_json || '{}') }));
  }

  static integrityCheck(db: Db): { ok: boolean; findings: string[] } {
    const findings: string[] = [];
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity[0]?.integrity_check !== 'ok') findings.push(`SQLite integrity_check=${integrity[0]?.integrity_check ?? 'unknown'}`);
    const requiredTriggers = [
      'real_trade_records_no_delete',
      'real_trade_records_immutable_facts',
      'real_trade_records_insert_unverified',
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
      'real_trade_evidence_links_immutable_update',
      'real_trade_evidence_links_immutable_delete',
    ];
    const triggers = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger'
    `).all() as Array<{ name: string }>;
    const triggerNames = new Set(triggers.map((row) => row.name));
    const missingTriggers = requiredTriggers.filter((name) => !triggerNames.has(name));
    if (missingTriggers.length > 0) findings.push(`P9.3 财务审计触发器不完整：${missingTriggers.join(', ')}`);
    const paperRows = Number((db.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE is_paper <> 0').get() as any)?.n || 0);
    if (paperRows !== 0) findings.push('REAL 账本中发现 PAPER 标记记录。');
    const orphanVerified = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM real_trade_records r
      WHERE r.record_state = 'VERIFIED' AND r.verification_status = 'VERIFIED'
        AND NOT EXISTS (
          SELECT 1 FROM real_trade_evidence_links l
          JOIN real_trade_evidence e ON e.evidence_id = l.evidence_id
          WHERE l.record_id = r.record_id AND e.character_id = r.character_id
            AND e.status = 'VERIFIED' AND l.relation IN ('PRIMARY', 'CORROBORATING')
            AND (
              e.evidence_type IN ('USER_ATTACHMENT', 'USER_CONFIRMATION')
              OR (
                e.evidence_type = 'ESI_WALLET_LOG'
                AND e.source_system = 'ESI_WALLET_TRANSACTIONS'
                AND r.source_type = 'ESI_WALLET_TRANSACTION'
                AND e.source_ref = r.source_ref
              )
            )
        )
    `).get() as any)?.n || 0);
    if (orphanVerified > 0) findings.push(`发现 ${orphanVerified} 条无匹配已核实证据的 VERIFIED 交易。`);
    const duplicateConsumptions = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT sell_record_id, lot_id FROM real_fifo_consumptions
        GROUP BY sell_record_id, lot_id HAVING COUNT(*) > 1
      )
    `).get() as any)?.n || 0);
    if (duplicateConsumptions > 0) findings.push('FIFO 消耗记录存在重复扣减。');
    return { ok: findings.length === 0, findings };
  }
}