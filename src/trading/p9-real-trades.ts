import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import type { UserContext } from '../auth/user-resolver.js';
import { callEsiOperation } from '../eve/esi-client.js';
import type { P9PlanStatus, P9RealTrade, P9RealTradeInput } from './p9-types.js';
import { canTransitionP9Plan } from './p9-types.js';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeTradeTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('交易时间必须是有效 ISO 时间。');
  return new Date(parsed).toISOString();
}

function mapTrade(row: any): P9RealTrade {
  return {
    tradeId: row.trade_id,
    characterId: row.character_id,
    clientKey: row.client_key,
    externalId: row.external_id || undefined,
    opportunityId: row.opportunity_id || undefined,
    planId: row.plan_id || undefined,
    direction: row.direction,
    typeId: row.type_id,
    locationId: row.location_id,
    quantity: row.quantity,
    price: row.price,
    fee: row.fee,
    tradeTime: row.trade_time,
    source: row.source,
    confirmed: Boolean(row.confirmed),
    notes: row.notes || undefined,
    realizedPnl: row.realized_pnl,
    pnlStatus: row.pnl_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateTradeInput(input: P9RealTradeInput): void {
  if (!input.clientKey || input.clientKey.length > 160) throw new Error('clientKey 必填且长度受控。');
  if (input.direction !== 'buy' && input.direction !== 'sell') throw new Error('direction 必须是 buy 或 sell。');
  if (!Number.isSafeInteger(input.typeId) || input.typeId <= 0) throw new Error('typeId 无效。');
  if (!Number.isSafeInteger(input.locationId) || input.locationId <= 0) throw new Error('locationId 无效。');
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new Error('quantity 必须是正整数。');
  if (!Number.isFinite(input.price) || input.price < 0) throw new Error('price 必须是非负数。');
  if (input.fee != null && (!Number.isFinite(input.fee) || input.fee < 0)) throw new Error('fee 必须是非负数。');
  normalizeTradeTime(input.tradeTime);
}

function derivePlanStatus(plan: any, trades: any[]): P9PlanStatus {
  const buyQty = trades.filter((row) => row.direction === 'buy').reduce((sum, row) => sum + Number(row.quantity), 0);
  const sellQty = trades.filter((row) => row.direction === 'sell').reduce((sum, row) => sum + Number(row.quantity), 0);
  if (sellQty >= Number(plan.quantity) && buyQty >= Number(plan.quantity)) return 'CLOSED';
  if (sellQty > 0 && sellQty < buyQty) return 'PARTIALLY_EXITED';
  if (buyQty >= Number(plan.quantity) && sellQty === 0) return 'HOLDING';
  if (buyQty > 0 && buyQty < Number(plan.quantity)) return 'PARTIALLY_EXECUTED';
  if (buyQty > 0) return 'EXECUTED';
  return 'PLANNED';
}

function advancePlan(db: Db, characterId: number, planId: string): void {
  const plan = db.prepare('SELECT * FROM p9_trade_plans WHERE plan_id = ? AND character_id = ?').get(planId, characterId) as any;
  if (!plan) return;
  const trades = db.prepare('SELECT direction, quantity FROM p9_real_trades WHERE character_id = ? AND plan_id = ?').all(characterId, planId) as any[];
  const target = derivePlanStatus(plan, trades);
  let status = plan.status as P9PlanStatus;
  let guard = 0;
  while (status !== target && guard < 12) {
    const candidates: P9PlanStatus[] = ['USER_CONFIRMED', 'PARTIALLY_EXECUTED', 'EXECUTED', 'HOLDING', 'PARTIALLY_EXITED', 'CLOSED'];
    const next = candidates.find((candidate) => canTransitionP9Plan(status, candidate) && (
      candidate === target
      || candidates.indexOf(candidate) < candidates.indexOf(target)
    ));
    if (!next) break;
    db.prepare(`UPDATE p9_trade_plans SET status = ?, updated_at = datetime('now') WHERE plan_id = ?`).run(next, planId);
    db.prepare(`
      INSERT INTO p9_trade_audit_events (character_id, plan_id, action, before_json, after_json, actor)
      VALUES (?, ?, 'plan_status_auto', ?, ?, 'system')
    `).run(characterId, planId, JSON.stringify({ status }), JSON.stringify({ status: next, trigger: 'real_trade_recorded' }));
    status = next;
    guard += 1;
  }
}
function rebuildInventoryAndPnl(db: Db, characterId: number): void {
  db.prepare('DELETE FROM p9_inventory_moves WHERE character_id = ?').run(characterId);
  db.prepare(`DELETE FROM p9_inventory_lots WHERE character_id = ? AND source = 'trade'`).run(characterId);
  db.prepare(`
    UPDATE p9_inventory_lots
    SET quantity = original_quantity, updated_at = datetime('now')
    WHERE character_id = ? AND source = 'manual'
  `).run(characterId);
  db.prepare(`
    UPDATE p9_real_trades
    SET realized_pnl = NULL, pnl_status = 'PENDING', updated_at = datetime('now')
    WHERE character_id = ?
  `).run(characterId);

  const trades = db.prepare(`
    SELECT * FROM p9_real_trades
    WHERE character_id = ?
    ORDER BY trade_time, rowid
  `).all(characterId) as any[];

  for (const trade of trades) {
    if (trade.direction === 'buy') {
      const grossCost = Number(trade.price) * Number(trade.quantity) + Number(trade.fee || 0);
      const costPerUnit = grossCost / Number(trade.quantity);
      const lotId = 'P9LOT-' + trade.trade_id;
      db.prepare(`
        INSERT INTO p9_inventory_lots
          (lot_id, character_id, item_id, type_id, location_id, quantity, original_quantity,
           cost_per_unit, cost_status, source, acquired_at, trade_id, opportunity_id, notes)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'CONFIRMED', 'trade', ?, ?, ?, ?)
      `).run(
        lotId,
        characterId,
        trade.type_id,
        trade.location_id,
        trade.quantity,
        trade.quantity,
        costPerUnit,
        trade.trade_time,
        trade.trade_id,
        trade.opportunity_id || null,
        trade.notes || null,
      );
      db.prepare(`UPDATE p9_real_trades SET pnl_status = 'PENDING', updated_at = datetime('now') WHERE trade_id = ?`).run(trade.trade_id);
      continue;
    }

    let remaining = Number(trade.quantity);
    let knownPnl = 0;
    let unknown = false;
    const locationLots = db.prepare(`
      SELECT * FROM p9_inventory_lots
      WHERE character_id = ? AND type_id = ? AND location_id = ? AND quantity > 0
      ORDER BY acquired_at, lot_id
    `).all(characterId, trade.type_id, trade.location_id) as any[];

    for (const lot of locationLots) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(lot.quantity));
      const cost = lot.cost_per_unit == null ? null : Number(lot.cost_per_unit);
      const feeUnknown = trade.fee_status === 'UNKNOWN';
      const allocatedFee = Number(trade.fee || 0) * (take / Number(trade.quantity));
      const movePnl = cost == null || feeUnknown
        ? null
        : round2(Number(trade.price) * take - cost * take - allocatedFee);
      if (movePnl == null) unknown = true;
      else knownPnl += movePnl;
      db.prepare(`
        INSERT INTO p9_inventory_moves
          (character_id, trade_id, lot_id, type_id, quantity, cost_per_unit, exit_price,
           allocated_fee, realized_pnl, pnl_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        characterId,
        trade.trade_id,
        lot.lot_id,
        trade.type_id,
        take,
        cost,
        trade.price,
        round2(allocatedFee),
        movePnl,
        movePnl == null ? 'UNKNOWN_COST' : 'CALCULATED',
      );
      remaining -= take;
      const nextQty = Number(lot.quantity) - take;
      db.prepare('UPDATE p9_inventory_lots SET quantity = ?, updated_at = datetime(\'now\') WHERE lot_id = ?')
        .run(nextQty, lot.lot_id);
    }

    if (remaining > 0) {
      unknown = true;
      const allocatedFee = Number(trade.fee || 0) * (remaining / Number(trade.quantity));
      db.prepare(`
        INSERT INTO p9_inventory_moves
          (character_id, trade_id, lot_id, type_id, quantity, cost_per_unit, exit_price,
           allocated_fee, realized_pnl, pnl_status)
        VALUES (?, ?, 'MISSING-INVENTORY', ?, ?, NULL, ?, ?, NULL, 'UNKNOWN_COST')
      `).run(characterId, trade.trade_id, trade.type_id, remaining, trade.price, round2(allocatedFee));
    }

    db.prepare(`
      UPDATE p9_real_trades
      SET realized_pnl = ?, pnl_status = ?, updated_at = datetime('now')
      WHERE trade_id = ?
    `).run(
      unknown ? null : round2(knownPnl),
      unknown ? 'UNKNOWN_COST' : 'CALCULATED',
      trade.trade_id,
    );
  }
}

export class P9RealTradeService {
  public static list(db: Db, characterId: number, filters: { direction?: string; source?: string; limit?: number; offset?: number } = {}) {
    const where = ['character_id = ?'];
    const params: unknown[] = [characterId];
    if (filters.direction) {
      where.push('direction = ?');
      params.push(filters.direction);
    }
    if (filters.source) {
      where.push('source = ?');
      params.push(filters.source);
    }
    const limit = Math.max(1, Math.min(500, filters.limit || 100));
    const offset = Math.max(0, filters.offset || 0);
    const sql = where.join(' AND ');
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM p9_real_trades WHERE ${sql}`).get(...params) as any)?.n || 0);
    const rows = db.prepare(`
      SELECT * FROM p9_real_trades WHERE ${sql}
      ORDER BY trade_time DESC, rowid DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];
    return { trades: rows.map(mapTrade), total };
  }

  public static recordManual(db: Db, characterId: number, input: P9RealTradeInput): P9RealTrade {
    validateTradeInput(input);
    const existing = db.prepare('SELECT * FROM p9_real_trades WHERE character_id = ? AND client_key = ?')
      .get(characterId, input.clientKey) as any;
    if (existing) {
      const same = existing.direction === input.direction
        && Number(existing.type_id) === input.typeId
        && Number(existing.location_id) === input.locationId
        && Number(existing.quantity) === input.quantity
        && Number(existing.price) === input.price
        && normalizeTradeTime(existing.trade_time) === normalizeTradeTime(input.tradeTime);
      if (!same) throw new Error('相同 clientKey 已用于不同交易参数，拒绝重复记账。');
      return mapTrade(existing);
    }
    if (input.opportunityId && !db.prepare('SELECT 1 FROM p9_real_opportunities WHERE opportunity_id = ? AND character_id = ?').get(input.opportunityId, characterId)) {
      throw new Error('关联机会不存在。');
    }
    if (input.planId && !db.prepare('SELECT 1 FROM p9_trade_plans WHERE plan_id = ? AND character_id = ?').get(input.planId, characterId)) {
      throw new Error('关联交易方案不存在。');
    }

    const tradeId = 'P9TRADE-' + Date.now() + '-' + randomUUID().slice(0, 8);
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO p9_real_trades
          (trade_id, character_id, client_key, opportunity_id, plan_id, direction, type_id,
           location_id, quantity, price, fee, fee_status, trade_time, source, confirmed, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, 'manual', ?, ?)
      `).run(
        tradeId,
        characterId,
        input.clientKey,
        input.opportunityId || null,
        input.planId || null,
        input.direction,
        input.typeId,
        input.locationId,
        input.quantity,
        input.price,
        input.fee ?? 0,
        normalizeTradeTime(input.tradeTime),
        input.confirmed === false ? 0 : 1,
        input.notes || null,
      );
      db.prepare(`
        INSERT INTO p9_trade_audit_events (character_id, trade_id, action, after_json, actor)
        VALUES (?, ?, 'manual_trade_created', ?, 'user')
      `).run(characterId, tradeId, JSON.stringify(input));
      rebuildInventoryAndPnl(db, characterId);
      if (input.planId) advancePlan(db, characterId, input.planId);
    });
    tx();
    return mapTrade(db.prepare('SELECT * FROM p9_real_trades WHERE trade_id = ?').get(tradeId) as any);
  }
  public static updateManual(
    db: Db,
    characterId: number,
    tradeId: string,
    patch: Partial<P9RealTradeInput> & { feeStatus?: 'CONFIRMED' | 'UNKNOWN' },
  ): P9RealTrade {
    const existing = db.prepare('SELECT * FROM p9_real_trades WHERE trade_id = ? AND character_id = ?').get(tradeId, characterId) as any;
    if (!existing) throw new Error('交易记录不存在。');
    if (existing.source !== 'manual') throw new Error('ESI 来源记录不可静默覆盖，请通过同步状态说明差异。');
    const next: P9RealTradeInput = {
      clientKey: existing.client_key,
      direction: patch.direction ?? existing.direction,
      typeId: Number(patch.typeId ?? existing.type_id),
      locationId: Number(patch.locationId ?? existing.location_id),
      quantity: Number(patch.quantity ?? existing.quantity),
      price: Number(patch.price ?? existing.price),
      fee: Number(patch.fee ?? existing.fee),
      tradeTime: patch.tradeTime ?? existing.trade_time,
      opportunityId: patch.opportunityId ?? existing.opportunity_id ?? undefined,
      planId: patch.planId ?? existing.plan_id ?? undefined,
      notes: patch.notes ?? existing.notes ?? undefined,
      confirmed: patch.confirmed ?? Boolean(existing.confirmed),
    };
    validateTradeInput(next);
    if (next.opportunityId && !db.prepare('SELECT 1 FROM p9_real_opportunities WHERE opportunity_id = ? AND character_id = ?').get(next.opportunityId, characterId)) {
      throw new Error('关联机会不存在。');
    }
    if (next.planId && !db.prepare('SELECT 1 FROM p9_trade_plans WHERE plan_id = ? AND character_id = ?').get(next.planId, characterId)) {
      throw new Error('关联交易方案不存在。');
    }
    const feeStatus = patch.feeStatus ?? existing.fee_status;
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE p9_real_trades
        SET opportunity_id = ?, plan_id = ?, direction = ?, type_id = ?, location_id = ?,
            quantity = ?, price = ?, fee = ?, fee_status = ?, trade_time = ?,
            confirmed = ?, notes = ?, updated_at = datetime('now')
        WHERE trade_id = ? AND character_id = ? AND source = 'manual'
      `).run(
        next.opportunityId || null,
        next.planId || null,
        next.direction,
        next.typeId,
        next.locationId,
        next.quantity,
        next.price,
        next.fee ?? 0,
        feeStatus,
        normalizeTradeTime(next.tradeTime),
        next.confirmed === false ? 0 : 1,
        next.notes || null,
        tradeId,
        characterId,
      );
      db.prepare(`
        INSERT INTO p9_trade_audit_events (character_id, trade_id, action, before_json, after_json, actor)
        VALUES (?, ?, 'manual_trade_updated', ?, ?, 'user')
      `).run(characterId, tradeId, JSON.stringify(existing), JSON.stringify(next));
      rebuildInventoryAndPnl(db, characterId);
      if (next.planId) advancePlan(db, characterId, next.planId);
    });
    tx();
    return mapTrade(db.prepare('SELECT * FROM p9_real_trades WHERE trade_id = ?').get(tradeId) as any);
  }

  public static summary(db: Db, characterId: number) {
    const stats = db.prepare(`
      SELECT
        COUNT(*) AS count,
        SUM(CASE WHEN direction = 'buy' THEN 1 ELSE 0 END) AS buys,
        SUM(CASE WHEN direction = 'sell' THEN 1 ELSE 0 END) AS sells,
        COALESCE(SUM(fee), 0) AS fees,
        COALESCE(SUM(CASE WHEN realized_pnl IS NOT NULL THEN realized_pnl ELSE 0 END), 0) AS knownPnl,
        SUM(CASE WHEN pnl_status = 'UNKNOWN_COST' THEN 1 ELSE 0 END) AS unknownPnlCount
      FROM p9_real_trades WHERE character_id = ?
    `).get(characterId) as any;
    const moves = db.prepare(`
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(CASE WHEN t.pnl_status = 'CALCULATED' AND m.realized_pnl IS NOT NULL THEN m.realized_pnl ELSE 0 END), 0) AS realized,
        SUM(CASE WHEN m.pnl_status = 'UNKNOWN_COST' THEN 1 ELSE 0 END) AS unknown
      FROM p9_inventory_moves m
      JOIN p9_real_trades t ON t.trade_id = m.trade_id
      WHERE m.character_id = ?
    `).get(characterId) as any;
    const sync = db.prepare('SELECT * FROM p9_esi_transaction_sync WHERE character_id = ?').get(characterId) as any;
    return {
      count: Number(stats?.count || 0),
      buyCount: Number(stats?.buys || 0),
      sellCount: Number(stats?.sells || 0),
      fees: round2(Number(stats?.fees || 0)),
      realizedNetPnl: round2(Number(moves?.realized || 0)),
      unknownCostMoveCount: Number(moves?.unknown || 0),
      tradeRowsWithUnknownPnl: Number(stats?.unknownPnlCount || 0),
      inventoryMoveCount: Number(moves?.count || 0),
      esiSync: sync
        ? { lastTransactionId: sync.last_transaction_id, lastSyncedAt: sync.last_synced_at, status: sync.status, error: sync.error }
        : { lastTransactionId: null, lastSyncedAt: null, status: 'never_synced', error: null },
    };
  }

  public static async syncEsiTransactions(
    db: Db,
    characterId: number,
    ctx: UserContext,
  ): Promise<{ imported: number; skipped: number; lastTransactionId: number | null; errors: string[] }> {
    const state = db.prepare('SELECT * FROM p9_esi_transaction_sync WHERE character_id = ?').get(characterId) as any;
    const lastId = Number(state?.last_transaction_id || 0);
    const result = await callEsiOperation<Array<Record<string, unknown>>>(
      db,
      'get_characters_character_id_wallet_transactions',
      { character_id: characterId },
      ctx,
      { maxPages: 10 },
    );
    if (!result.ok) {
      db.prepare(`
        INSERT INTO p9_esi_transaction_sync (character_id, status, error, last_synced_at)
        VALUES (?, 'error', ?, datetime('now'))
        ON CONFLICT(character_id) DO UPDATE SET status = 'error', error = excluded.error, last_synced_at = excluded.last_synced_at
      `).run(characterId, result.error);
      return { imported: 0, skipped: 0, lastTransactionId: lastId || null, errors: [result.error] };
    }

    const rows = Array.isArray(result.data) ? result.data : [];
    const ordered = rows
      .map((row) => ({
        transactionId: Number(row.transaction_id),
        date: String(row.date || ''),
        typeId: Number(row.type_id),
        quantity: Number(row.quantity),
        price: Number(row.price),
        isBuy: Boolean(row.is_buy),
        locationId: Number(row.station_id || row.location_id || 0),
        fee: typeof row.fee === 'number' ? Number(row.fee) : null,
      }))
      .filter((row) => Number.isSafeInteger(row.transactionId) && row.transactionId > 0 && row.typeId > 0 && row.quantity > 0)
      .sort((a, b) => a.transactionId - b.transactionId);

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];
    let newLastId = lastId;
    for (const row of ordered) {
      if (row.transactionId <= lastId) {
        skipped += 1;
        continue;
      }
      if (row.locationId <= 0 || !row.date || !Number.isFinite(row.price)) {
        errors.push(`ESI transaction ${row.transactionId} 缺少关键字段，未导入。`);
        continue;
      }
      try {
        this.recordManual(db, characterId, {
          clientKey: `esi:${row.transactionId}`,
          direction: row.isBuy ? 'buy' : 'sell',
          typeId: row.typeId,
          locationId: row.locationId,
          quantity: row.quantity,
          price: row.price,
          fee: row.fee ?? 0,
          tradeTime: row.date,
          notes: row.fee == null ? 'ESI 未返回 fee；费用状态未知，实际盈亏不得当作已确认。' : 'ESI wallet transactions',
          confirmed: true,
        });
        if (row.fee == null) {
          db.prepare(`UPDATE p9_real_trades SET fee_status = 'UNKNOWN', pnl_status = 'UNKNOWN_COST' WHERE character_id = ? AND client_key = ?`)
            .run(characterId, `esi:${row.transactionId}`);
          rebuildInventoryAndPnl(db, characterId);
          db.prepare(`UPDATE p9_real_trades SET fee_status = 'UNKNOWN' WHERE character_id = ? AND client_key = ?`)
            .run(characterId, `esi:${row.transactionId}`);
        }
        db.prepare(`UPDATE p9_real_trades SET external_id = ?, source = 'esi', confirmed = 1 WHERE character_id = ? AND client_key = ?`)
          .run(`esi:${row.transactionId}`, characterId, `esi:${row.transactionId}`);
        imported += 1;
        newLastId = Math.max(newLastId, row.transactionId);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    db.prepare(`
      INSERT INTO p9_esi_transaction_sync (character_id, last_transaction_id, last_synced_at, status, error)
      VALUES (?, ?, datetime('now'), ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        last_transaction_id = MAX(COALESCE(p9_esi_transaction_sync.last_transaction_id, 0), excluded.last_transaction_id),
        last_synced_at = excluded.last_synced_at,
        status = excluded.status,
        error = excluded.error
    `).run(characterId, newLastId || null, errors.length > 0 ? 'error' : 'ok', errors.join('; ') || null);

    return { imported, skipped, lastTransactionId: newLastId || null, errors };
  }

  public static rebuild(db: Db, characterId: number): void {
    const tx = db.transaction(() => rebuildInventoryAndPnl(db, characterId));
    tx();
  }
}