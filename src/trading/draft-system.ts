import type { Db } from '../db/sqlite.js';
import type { TradeDraft, TradeOpportunity } from './types.js';

export class DraftSystem {
  /**
   * Generate next sequential draft ID (e.g. TR-2026-000001)
   */
  public static generateDraftId(db: Db): string {
    const year = new Date().getFullYear();
    const prefix = `TR-${year}-`;
    const lastRow = db.prepare(`
      SELECT draft_id FROM trade_drafts
      WHERE draft_id LIKE ?
      ORDER BY draft_id DESC LIMIT 1
    `).get(`${prefix}%`) as { draft_id: string } | undefined;

    let seq = 1;
    if (lastRow?.draft_id) {
      const parts = lastRow.draft_id.split('-');
      const num = parseInt(parts[2], 10);
      if (!isNaN(num)) seq = num + 1;
    }

    return `${prefix}${String(seq).padStart(6, '0')}`;
  }

  /**
   * Create and persist a new Trade Draft from an identified TradeOpportunity
   */
  public static createDraft(
    db: Db,
    characterId: number,
    opp: TradeOpportunity,
    validHours = 24,
  ): TradeDraft {
    // Stage 8 Guardrail: D-grade or vetoed opportunities can NEVER generate a draft in any pathway
    if (opp.opportunityRating === 'D' || opp.riskVetoReason) {
      throw new Error('【风控一票否决】该交易机会评级为 D (' + (opp.riskVetoReason || '高风险未通过') + ')，严禁生成交易订单草案！');
    }

    const draftId = this.generateDraftId(db);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + validHours * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    const draft: TradeDraft = {
      draftId,
      characterId,
      typeId: opp.typeId,
      typeName: opp.typeName,
      zhName: opp.zhName,
      strategy: opp.strategy,
      buyStationId: opp.buyStationId,
      sellStationId: opp.sellStationId,
      suggestedBuy: opp.suggestedBuyPrice,
      suggestedQty: opp.suggestedQuantity,
      suggestedSell: opp.suggestedSellPrice,
      estimatedFees: opp.estimatedFees,
      haulingCost: opp.haulingCost,
      expectedProfit: opp.expectedNetProfit,
      expectedRoi: opp.expectedRoiPct,
      capitalRequired: opp.capitalRequired,
      turnoverHours: opp.turnoverDays * 24,
      status: 'draft',
      createdAt: now.toISOString().replace('T', ' ').slice(0, 19),
      expiresAt,
    };

    db.prepare(`
      INSERT INTO trade_drafts (
        draft_id, character_id, type_id, strategy, buy_station_id, sell_station_id,
        suggested_buy, suggested_qty, suggested_sell, estimated_fees, hauling_cost,
        expected_profit, expected_roi, capital_required, turnover_hours, status,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      draft.draftId, draft.characterId, draft.typeId, draft.strategy, draft.buyStationId, draft.sellStationId,
      draft.suggestedBuy, draft.suggestedQty, draft.suggestedSell, draft.estimatedFees, draft.haulingCost,
      draft.expectedProfit, draft.expectedRoi, draft.capitalRequired, draft.turnoverHours, draft.status,
      draft.createdAt, draft.expiresAt
    );

    return draft;
  }

  /**
   * Update draft status (approve, reject, expire, audit_revoked)
   */
  public static updateStatus(
    db: Db,
    draftId: string,
    newStatus: 'approved' | 'rejected' | 'expired' | 'audit_revoked',
    reason?: string,
  ): boolean {
    const existing = db.prepare('SELECT status FROM trade_drafts WHERE draft_id = ?').get(draftId) as { status: string } | undefined;
    if (!existing) return false;

    // Security & Audit Invariant: an audit-revoked draft cannot be re-approved or altered
    if (existing.status === 'audit_revoked' && newStatus !== 'audit_revoked') {
      throw new Error(`【安全阻断】草案 ${draftId} 已被第二轮独立审计永久撤销 (audit_revoked)，禁止重新审批或变更状态！`);
    }

    const res = db.prepare(`
      UPDATE trade_drafts 
      SET status = ?, revoked_reason = COALESCE(?, revoked_reason) 
      WHERE draft_id = ?
    `).run(newStatus, reason || null, draftId);

    return res.changes > 0;
  }

  /**
   * Revoke a draft following independent audit findings, permanently blocking execution.
   */
  public static revokeDraftByAudit(
    db: Db,
    draftId: string,
    revocationReason: string,
  ): boolean {
    return this.updateStatus(db, draftId, 'audit_revoked', revocationReason);
  }

  /**
   * Record manual in-game execution with actual fill details.
   * Rejects execution if draft is audit_revoked or not in approved status.
   */
  public static recordManualExecution(
    db: Db,
    params: {
      draftId: string;
      actualBuyPrice: number;
      actualSellPrice: number;
      actualQuantity: number;
      actualFees: number;
      notes?: string;
    },
  ): boolean {
    const { draftId, actualBuyPrice, actualSellPrice, actualQuantity, actualFees, notes } = params;

    const existing = db.prepare('SELECT status, character_id, type_id FROM trade_drafts WHERE draft_id = ?').get(draftId) as any;
    if (!existing) return false;

    if (existing.status === 'audit_revoked') {
      throw new Error(`【交易阻断】草案 ${draftId} 已被独立审计撤销，判定为虚假价差高危交易，严禁记录或执行！`);
    }

    if (existing.status !== 'approved' && existing.status !== 'draft') {
      throw new Error(`【状态非法】草案 ${draftId} 当前状态为 ${existing.status}，未处于可执行状态。`);
    }

    const actualProfit = (actualSellPrice - actualBuyPrice) * actualQuantity - actualFees;

    const res = db.prepare(`
      UPDATE trade_drafts SET
        status = 'executed_manually',
        executed_at = datetime('now'),
        actual_buy_price = ?,
        actual_sell_price = ?,
        actual_profit = ?
      WHERE draft_id = ?
    `).run(actualBuyPrice, actualSellPrice, actualProfit, draftId);

    if (res.changes === 0) return false;

    db.prepare(`
      INSERT INTO trade_ledger (draft_id, character_id, type_id, action, quantity, price, fees, notes)
      VALUES (?, ?, ?, 'buy', ?, ?, ?, ?)
    `).run(draftId, existing.character_id, existing.type_id, actualQuantity, actualBuyPrice, actualFees, notes || 'Manual execution buy');

    db.prepare(`
      INSERT INTO trade_ledger (draft_id, character_id, type_id, action, quantity, price, fees, notes)
      VALUES (?, ?, ?, 'sell', ?, ?, ?, ?)
    `).run(draftId, existing.character_id, existing.type_id, actualQuantity, actualSellPrice, 0, notes || 'Manual execution sell');

    return true;
  }

  /**
   * Retrieve active drafts for a character, excluding revoked drafts when requesting active ones.
   */
  public static getDrafts(
    db: Db,
    characterId: number,
    statusFilter?: string,
  ): TradeDraft[] {
    let sql = 'SELECT * FROM trade_drafts WHERE character_id = ?';
    const params: any[] = [characterId];

    if (statusFilter === 'active') {
      sql += " AND status IN ('draft', 'approved')";
    } else if (statusFilter) {
      sql += ' AND status = ?';
      params.push(statusFilter);
    }
    sql += ' ORDER BY created_at DESC LIMIT 50';

    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map(r => ({
      draftId: r.draft_id,
      characterId: r.character_id,
      typeId: r.type_id,
      typeName: '',
      strategy: r.strategy,
      buyStationId: r.buy_station_id,
      sellStationId: r.sell_station_id,
      suggestedBuy: r.suggested_buy,
      suggestedQty: r.suggested_qty,
      suggestedSell: r.suggested_sell,
      estimatedFees: r.estimated_fees,
      haulingCost: r.hauling_cost,
      expectedProfit: r.expected_profit,
      expectedRoi: r.expected_roi,
      capitalRequired: r.capital_required,
      turnoverHours: r.turnover_hours,
      status: r.status,
      revokedReason: r.revoked_reason,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      executedAt: r.executed_at,
      actualBuyPrice: r.actual_buy_price,
      actualSellPrice: r.actual_sell_price,
      actualProfit: r.actual_profit,
    }));
  }
}


