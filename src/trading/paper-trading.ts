import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import type { FeeContext, FillModelMode, OrderBookLevel, StrategyType, TradeOpportunity } from './types.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS } from './fee-engine.js';
import { OrderBookSimulator } from './orderbook-simulator.js';

export interface PaperAccount {
  accountId: string;
  characterId: number;
  initialCash: number;
  availableCash: number;
  escrowLocked: number;
  totalRealizedPnl: number;
  totalFeesPaid: number;
  status: 'active' | 'paused' | 'stopped';
  createdAt: string;
  updatedAt: string;
}

export interface PaperOrder {
  orderId: string;
  accountId: string;
  opportunityId?: string;
  idempotencyKey?: string;
  characterId: number;
  typeId: number;
  strategyType: StrategyType;
  orderType: 'buy' | 'sell';
  price: number;
  quantity: number;
  filledQuantity: number;
  status: 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'expired';
  feesPaid: number;
  createdAt: string;
  updatedAt: string;
}

export interface PaperPosition {
  paperId: string;
  characterId: number;
  typeId: number;
  typeName?: string;
  zhName?: string;
  locationId: number;
  quantity: number;
  costPrice: number;
  strategyType: StrategyType;
  status: 'holding' | 'sold';
  createdAt: string;
  soldAt?: string;
  soldPrice?: number;
  realizedPnl?: number;
  currentPrice?: number;
  unrealizedPnl?: number;
}

export interface PaperStrategyPerformance {
  strategy: StrategyType;
  totalOpportunities: number;
  vetoedOpportunities: number;
  executedTrades: number;
  realizedPnlIsk: number;
  unrealizedPnlIsk: number;
  winRatePct: number;
  avgPredictionVarianceIsk: number;
}

const VALID_STATE_TRANSITIONS: Record<string, string[]> = {
  'open': ['partially_filled', 'filled', 'cancelled', 'expired'],
  'partially_filled': ['partially_filled', 'filled', 'cancelled', 'expired'],
  'filled': [], // Terminal
  'cancelled': [], // Terminal
  'expired': [], // Terminal
};

function feeForOrderForClaim(
  orderType: 'buy' | 'sell',
  sim: { weightedAvgPrice: number; filledQty: number },
  feeCtx: FeeContext,
): number {
  const calc = FeeEngine.calculateTrade({
    buyType: orderType === 'buy' ? 'place_buy_order' : 'immediate_buy',
    sellType: orderType === 'sell' ? 'place_sell_order' : 'immediate_sell',
    buyUnitPrice: sim.weightedAvgPrice,
    sellUnitPrice: sim.weightedAvgPrice,
    quantity: sim.filledQty,
    buyCtx: feeCtx,
    sellCtx: feeCtx,
  });
  return orderType === 'buy'
    ? calc.buyerBrokerFee
    : calc.sellerBrokerFee + calc.salesTax + (calc.sccSurcharge || 0);
}

export type PaperOrderLifecycleStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCEL_PENDING'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REJECTED';

export const PAPER_ORDER_STATE_TRANSITIONS: Record<PaperOrderLifecycleStatus, PaperOrderLifecycleStatus[]> = {
  CREATED: ['SUBMITTED', 'REJECTED'],
  SUBMITTED: ['OPEN', 'REJECTED'],
  OPEN: ['PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'EXPIRED', 'REJECTED'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'EXPIRED', 'REJECTED'],
  FILLED: [],
  CANCEL_PENDING: ['CANCELLED', 'OPEN', 'PARTIALLY_FILLED'],
  CANCELLED: [],
  EXPIRED: [],
  REJECTED: [],
};

export function canTransitionPaperOrderState(from: PaperOrderLifecycleStatus, to: PaperOrderLifecycleStatus): boolean {
  return (PAPER_ORDER_STATE_TRANSITIONS[from] || []).includes(to);
}

function recordPaperOrderStateEvent(
  db: Db,
  orderId: string,
  fromStatus: string | null,
  toStatus: string,
  reason?: string,
  metadata?: Record<string, unknown>,
): void {
  db.prepare(`
    INSERT INTO paper_order_state_events (order_id, from_status, to_status, reason, metadata_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(orderId, fromStatus, toStatus, reason || null, metadata ? JSON.stringify(metadata) : null);
}

function conservativeInventoryValue(db: Db, characterId: number): number {
  const rows = db.prepare(`
    SELECT type_id, location_id, quantity, cost_price
    FROM paper_trading_positions
    WHERE character_id = ? AND status = 'holding' AND quantity > 0
  `).all(characterId) as any[];
  let value = 0;
  for (const row of rows) {
    let remaining = Number(row.quantity);
    const bids = db.prepare(`
      SELECT price, volume_remain
      FROM market_orders
      WHERE type_id = ? AND location_id = ? AND is_buy_order = 1
      ORDER BY price DESC
    `).all(row.type_id, row.location_id) as any[];
    for (const bid of bids) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(bid.volume_remain));
      value += take * Number(bid.price);
      remaining -= take;
    }
    if (remaining > 0) value += remaining * Number(row.cost_price);
  }
  return Math.round(value * 100) / 100;
}

function recordPaperEquitySnapshot(
  db: Db,
  accountId: string,
  sourceEvent: string,
  sourceId?: string,
): void {
  const account = db.prepare('SELECT character_id, available_cash, escrow_locked FROM paper_trading_accounts WHERE account_id = ?').get(accountId) as any;
  if (!account) return;
  const inventoryCost = db.prepare(`
    SELECT COALESCE(SUM(quantity * cost_price), 0) AS value
    FROM paper_trading_positions
    WHERE character_id = ? AND status = 'holding'
  `).get(account.character_id) as any;
  const inventoryValue = conservativeInventoryValue(db, account.character_id);
  const totalEquity = Number(account.available_cash) + Number(account.escrow_locked) + inventoryValue;
  db.prepare(`
    INSERT INTO paper_equity_snapshots
      (account_id, available_cash, escrow_locked, inventory_cost, inventory_value, total_equity, source_event, source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    account.available_cash,
    account.escrow_locked,
    Number(inventoryCost?.value || 0),
    inventoryValue,
    totalEquity,
    sourceEvent,
    sourceId || null,
  );
}

export class PaperTradingSystem {
  /**
   * Get or create a dedicated virtual paper trading account for a character
   */
  public static getOrCreateAccount(
    db: Db,
    characterId: number,
    initialCash = 10_000_000,
  ): PaperAccount {
    const accountId = 'PT-ACC-' + characterId;
    let row = db.prepare('SELECT * FROM paper_trading_accounts WHERE account_id = ?').get(accountId) as any;

    if (!row) {
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      db.prepare(`
        INSERT INTO paper_trading_accounts (account_id, character_id, initial_cash, available_cash, escrow_locked, total_realized_pnl, total_fees_paid, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, 0, 0, 'active', ?, ?)
      `).run(accountId, characterId, initialCash, initialCash, now, now);

      db.prepare(`
        INSERT INTO paper_trading_journal (account_id, entry_type, amount, balance_after, escrow_after)
        VALUES (?, 'deposit', ?, ?, 0)
      `).run(accountId, initialCash, initialCash);
      recordPaperEquitySnapshot(db, accountId, 'account_created');

      row = db.prepare('SELECT * FROM paper_trading_accounts WHERE account_id = ?').get(accountId) as any;
    }

    return {
      accountId: row.account_id,
      characterId: row.character_id,
      initialCash: row.initial_cash,
      availableCash: row.available_cash,
      escrowLocked: row.escrow_locked,
      totalRealizedPnl: row.total_realized_pnl,
      totalFeesPaid: row.total_fees_paid,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Reconcile virtual account balance against double-entry assets and equity.
   * Total Assets (Cash + Escrow + Inventory Cost Basis) == Total Equity (Initial Cash + Realized PnL - Fees Paid).
   */
  public static verifyAccountBalance(db: Db, accountId: string): { isReconciled: boolean; discrepancy: number; actualTotal: number; expectedTotal: number } {
    const acc = db.prepare('SELECT * FROM paper_trading_accounts WHERE account_id = ?').get(accountId) as any;
    if (!acc) return { isReconciled: false, discrepancy: 0, actualTotal: 0, expectedTotal: 0 };

    const invRow = db.prepare("SELECT COALESCE(SUM(quantity * cost_price), 0) as cost_basis FROM paper_trading_positions WHERE character_id = ? AND status = 'holding'").get(acc.character_id) as any;
    const inventoryCostBasis = Number(invRow?.cost_basis || 0);

    const expectedTotal = acc.initial_cash + acc.total_realized_pnl - acc.total_fees_paid;
    const actualTotal = acc.available_cash + acc.escrow_locked + inventoryCostBasis;
    const discrepancy = Math.round((actualTotal - expectedTotal) * 100) / 100;

    return {
      isReconciled: Math.abs(discrepancy) < 0.05,
      discrepancy,
      actualTotal: Math.round(actualTotal * 100) / 100,
      expectedTotal: Math.round(expectedTotal * 100) / 100,
    };
  }

  /**
   * Reset virtual paper trading account (keeps history, resets active balance and positions)
   */
  public static resetAccount(db: Db, characterId: number, initialCash = 10_000_000): void {
    const accountId = 'PT-ACC-' + characterId;
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE paper_trading_accounts 
        SET available_cash = ?, escrow_locked = 0, initial_cash = ?, total_realized_pnl = 0, total_fees_paid = 0, updated_at = datetime('now')
        WHERE account_id = ?
      `).run(initialCash, initialCash, accountId);

      db.prepare("UPDATE paper_trading_orders SET status = 'cancelled' WHERE account_id = ? AND status IN ('open', 'partially_filled')").run(accountId);
      db.prepare("UPDATE paper_trading_positions SET status = 'sold', sold_at = datetime('now'), sold_price = 0, realized_pnl = 0 WHERE character_id = ? AND status = 'holding'").run(characterId);

      db.prepare(`
        INSERT INTO paper_trading_journal (account_id, entry_type, amount, balance_after, escrow_after)
        VALUES (?, 'deposit', ?, ?, 0)
      `).run(accountId, initialCash, initialCash);
      recordPaperEquitySnapshot(db, accountId, 'account_reset');
    });
    tx();
  }

  /**
   * Log an identified trade opportunity BEFORE any execution happens.
   */
  public static logOpportunity(db: Db, opp: TradeOpportunity): string {
    // The pipeline owns opportunityId; scanners may omit it and receive a
    // deterministic local id. Reusing the supplied id keeps scan -> draft ->
    // paper order -> fill traceable end to end.
    const oppId = opp.opportunityId || 'OPP-' + Date.now() + '-' + randomUUID().slice(0, 8);
    const outcome = opp.opportunityStatus
      || ((opp.opportunityRating === 'D' || opp.riskVetoReason) ? 'vetoed' : 'pending');
    const qty = Number(opp.suggestedQuantity || 0);
    const theoreticalGross = opp.theoreticalGrossProfit
      ?? opp.profitLayers?.theoreticalGrossProfit
      ?? ((opp.suggestedSellPrice - opp.suggestedBuyPrice) * qty);
    const executableGross = opp.executableGrossProfit
      ?? opp.profitLayers?.executableGrossProfit
      ?? null;
    const feeNet = opp.feeNetProfit
      ?? opp.profitLayers?.feeNetProfit
      ?? opp.expectedNetProfit;
    const comprehensive = opp.comprehensiveNetProfit
      ?? opp.profitLayers?.comprehensiveNetProfit
      ?? null;
    const comprehensiveStatus = opp.comprehensiveNetProfitStatus
      ?? opp.profitLayers?.comprehensiveNetProfitStatus
      ?? 'UNKNOWN';
    const unknownCosts = opp.unknownCosts
      ?? opp.profitLayers?.unknownCosts
      ?? ['capital_carry', 'inventory_carry', 'unfilled_loss', 'risk_discount'];
    const executableQuantity = opp.executableQuantity
      ?? opp.profitLayers?.executableQuantity
      ?? (executableGross === null ? null : qty);
    const buySnapshotId = opp.buySnapshotId || opp.marketSnapshotId || 'MSNAP-unknown-buy';
    const sellSnapshotId = opp.sellSnapshotId || opp.marketSnapshotId || 'MSNAP-unknown-sell';
    const profitLayers = {
      theoreticalGrossProfit: theoreticalGross,
      executableGrossProfit: executableGross,
      feeNetProfit: feeNet,
      comprehensiveNetProfit: comprehensive,
      comprehensiveNetProfitStatus: comprehensiveStatus,
      executableQuantity,
      unknownCosts,
    };

    db.prepare(`
      INSERT INTO trade_opportunities_log (
        opportunity_id, strategy_type, type_id, region_id, detected_at,
        expected_buy_price, expected_sell_price, proposed_quantity, expected_fees,
        expected_net_profit, expected_roi, risk_rating, rejection_reason,
        data_quality_json, outcome_status,
        buy_location_id, sell_location_id, buy_region_id, sell_region_id,
        buy_snapshot_id, sell_snapshot_id, buy_snapshot_timestamp, sell_snapshot_timestamp,
        fee_model_version, executable_quantity, theoretical_gross_profit,
        executable_gross_profit, fee_net_profit, comprehensive_net_profit,
        comprehensive_net_profit_status, profit_layers_json, capital_required,
        logistics_cost, opportunity_expires_at, opportunity_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      oppId,
      opp.strategy,
      opp.typeId,
      opp.buyStationId,
      opp.detectedAt || new Date().toISOString(),
      opp.suggestedBuyPrice,
      opp.suggestedSellPrice,
      opp.suggestedQuantity,
      opp.estimatedFees,
      opp.expectedNetProfit,
      opp.expectedRoiPct,
      opp.opportunityRating || 'B',
      opp.riskVetoReason || null,
      JSON.stringify(opp.dataQuality || {}),
      outcome,
      opp.buyLocationId ?? opp.buyStationId,
      opp.sellLocationId ?? opp.sellStationId,
      opp.buyRegionId ?? null,
      opp.sellRegionId ?? null,
      buySnapshotId,
      sellSnapshotId,
      opp.buySnapshotTimestamp || null,
      opp.sellSnapshotTimestamp || null,
      opp.feeModelVersion || null,
      executableQuantity,
      theoreticalGross,
      executableGross,
      feeNet,
      comprehensive,
      comprehensiveStatus,
      JSON.stringify(profitLayers),
      opp.capitalRequired,
      opp.haulingCost,
      opp.expiresAt || null,
      outcome,
    );

    return oppId;
  }

  /**
   * Create a local virtual order with strict transaction-isolated balance locking and idempotency protection
   */
  public static createVirtualOrder(
    db: Db,
    params: {
      characterId: number;
      typeId: number;
      strategyType: StrategyType;
      orderType: 'buy' | 'sell';
      price: number;
      quantity: number;
      opportunityId?: string;
      snapshotId?: string;
      idempotencyKey?: string;
      feeCtx?: FeeContext;
      fillMode?: FillModelMode;
    },
  ): { success: boolean; orderId?: string; error?: string } {
    const { characterId, typeId, strategyType, orderType, price, quantity, opportunityId, snapshotId, idempotencyKey } = params;

    if (price <= 0 || quantity <= 0 || !Number.isFinite(price) || !Number.isFinite(quantity)) {
      return { success: false, error: '订单价格与数量必须为大于零的合法有限数值。' };
    }

    const account = this.getOrCreateAccount(db, characterId);
    if (account.status !== 'active') {
      return { success: false, error: `模拟账户当前处于 ${account.status} 状态，禁止创建新订单。` };
    }

    const feeCtx = params.feeCtx ?? {
      clone: 'alpha',
      skills: ALPHA_DEFAULT_SKILLS,
      facility: 'npc_station',
    };

    const estFees = orderType === 'buy'
      ? Math.round(price * quantity * FeeEngine.calculateRates(feeCtx).brokerFeeRate * 100) / 100
      : Math.round(price * quantity * (FeeEngine.calculateRates(feeCtx).brokerFeeRate + FeeEngine.calculateRates(feeCtx).salesTaxRate) * 100) / 100;

    const totalRequiredIsk = price * quantity + estFees;
    const orderId = 'PT-ORD-' + Date.now() + '-' + randomUUID().slice(0, 8);

    let success = false;
    let resultOrderId = orderId;
    let errReason: string | undefined;

    const tx = db.transaction(() => {
      if (idempotencyKey) {
        const existing = db.prepare('SELECT * FROM paper_trading_orders WHERE idempotency_key = ?').get(idempotencyKey) as any;
        if (existing) {
          if (
            existing.type_id !== typeId ||
            existing.order_type !== orderType ||
            existing.price !== price ||
            existing.quantity !== quantity ||
            existing.character_id !== characterId
          ) {
            errReason = '【幂等冲突】相同 idempotencyKey (' + idempotencyKey + ') 不能用于不同参数的订单！';
            return;
          }
          resultOrderId = existing.order_id;
          success = true;
          return;
        }
      }

      const accountRow = db.prepare('SELECT account_id, status, available_cash, escrow_locked FROM paper_trading_accounts WHERE account_id = ?')
        .get(account.accountId) as any;
      if (!accountRow || accountRow.status !== 'active') {
        errReason = '模拟账户不可用，禁止创建新订单。';
        return;
      }

      if (orderType === 'buy') {
        const reserved = db.prepare(`
          UPDATE paper_trading_accounts
          SET available_cash = available_cash - ?,
              escrow_locked = escrow_locked + ?,
              updated_at = datetime('now')
          WHERE account_id = ? AND available_cash >= ?
        `).run(totalRequiredIsk, totalRequiredIsk, account.accountId, totalRequiredIsk);
        if (reserved.changes !== 1) {
          errReason = `虚拟可用资金不足：需要 ${Math.round(totalRequiredIsk).toLocaleString()} ISK，当前可用 ${Math.round(accountRow.available_cash).toLocaleString()} ISK。`;
          return;
        }

        const after = db.prepare('SELECT available_cash, escrow_locked FROM paper_trading_accounts WHERE account_id = ?')
          .get(account.accountId) as any;
        db.prepare(`
          INSERT INTO paper_trading_journal (account_id, order_id, entry_type, amount, balance_after, escrow_after)
          VALUES (?, ?, 'escrow_lock', ?, ?, ?)
        `).run(account.accountId, orderId, totalRequiredIsk, after.available_cash, after.escrow_locked);
      } else {
        const holding = db.prepare(`
          SELECT COALESCE(SUM(quantity), 0) as available_units
          FROM paper_trading_positions
          WHERE character_id = ? AND type_id = ? AND status = 'holding'
        `).get(characterId, typeId) as any;
        const currentHolding = Number(holding?.available_units || 0);
        if (currentHolding < quantity) {
          errReason = `模拟库存不足：拟卖出 ${quantity} 件，当前持仓仅 ${currentHolding} 件。`;
          return;
        }
      }

      db.prepare(`
        INSERT INTO paper_trading_orders (order_id, account_id, opportunity_id, snapshot_id, idempotency_key, character_id, type_id, strategy_type, order_type, price, quantity, filled_quantity, status, fees_paid, escrow_locked, fee_reserved, submitted_at, fill_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'open', 0, ?, ?, datetime('now'), ?, datetime('now'), datetime('now'))
      `).run(
        orderId, account.accountId, opportunityId || null, snapshotId || null, idempotencyKey || null,
        characterId, typeId, strategyType, orderType, price, quantity,
        orderType === 'buy' ? totalRequiredIsk : 0,
        orderType === 'buy' ? estFees : 0,
        params.fillMode || 'immediate',
      );
      recordPaperOrderStateEvent(db, orderId, null, 'CREATED', 'order_created');
      recordPaperOrderStateEvent(db, orderId, 'CREATED', 'SUBMITTED', 'order_submitted', { snapshotId: snapshotId || null });
      recordPaperOrderStateEvent(db, orderId, 'SUBMITTED', 'OPEN', 'order_accepted');

      success = true;
    });

    tx.immediate();
    if (success && resultOrderId === orderId) {
      recordPaperEquitySnapshot(db, account.accountId, 'order_created', orderId);
    }
    return { success, orderId: success ? resultOrderId : undefined, error: errReason };
  }

  /**
   * Cancel an open virtual order and release locked escrow
   */
  public static cancelVirtualOrder(db: Db, orderId: string): boolean {
    let applied = false;
    const tx = db.transaction(() => {
      const order = db.prepare('SELECT * FROM paper_trading_orders WHERE order_id = ?').get(orderId) as any;
      if (!order) return false;

      const allowed = VALID_STATE_TRANSITIONS[order.status] || [];
      if (!allowed.includes('cancelled')) return false;

      const transition = db.prepare(`
        UPDATE paper_trading_orders
        SET status = 'cancelled', escrow_locked = 0, fee_reserved = 0, updated_at = datetime('now')
        WHERE order_id = ? AND status = ? AND filled_quantity = ?
      `).run(orderId, order.status, order.filled_quantity);
      if (transition.changes !== 1) return false;
      recordPaperOrderStateEvent(db, orderId, order.status, 'CANCEL_PENDING', 'cancel_requested');
      recordPaperOrderStateEvent(db, orderId, 'CANCEL_PENDING', 'CANCELLED', 'cancel_confirmed');

      const unfilledQty = order.quantity - order.filled_quantity;
      if (order.order_type === 'buy' && unfilledQty > 0) {
        const acc = db.prepare('SELECT available_cash, escrow_locked FROM paper_trading_accounts WHERE account_id = ?').get(order.account_id) as any;
        const trackedRemainingEscrow = Number(order.escrow_locked || 0);
        const escrowToRefund = Math.min(
          acc.escrow_locked,
          trackedRemainingEscrow > 0 ? trackedRemainingEscrow : unfilledQty * order.price,
        );
        const newBal = acc.available_cash + escrowToRefund;
        const newEscrow = Math.max(0, acc.escrow_locked - escrowToRefund);

        db.prepare(`
          UPDATE paper_trading_accounts
          SET available_cash = ?,
              escrow_locked = ?,
              updated_at = datetime('now')
          WHERE account_id = ?
        `).run(newBal, newEscrow, order.account_id);

        db.prepare(`
          INSERT INTO paper_trading_journal (account_id, order_id, entry_type, amount, balance_after, escrow_after)
          VALUES (?, ?, 'escrow_release', ?, ?, ?)
        `).run(order.account_id, orderId, escrowToRefund, newBal, newEscrow);
      }

      applied = true;
      return true;
    });

    tx.immediate();
    if (applied) {
      const row = db.prepare('SELECT account_id FROM paper_trading_orders WHERE order_id = ?').get(orderId) as any;
      if (row) recordPaperEquitySnapshot(db, row.account_id, 'order_cancelled', orderId);
    }
    return applied;
  }

  /**
   * Expire an open/partially-filled order without filling the remainder.
   */
  public static expireVirtualOrder(db: Db, orderId: string, reason = 'order_expired'): boolean {
    const order = db.prepare('SELECT * FROM paper_trading_orders WHERE order_id = ?').get(orderId) as any;
    if (!order || !['open', 'partially_filled'].includes(order.status)) return false;
    let applied = false;
    const tx = db.transaction(() => {
      const transition = db.prepare(`
        UPDATE paper_trading_orders
        SET status = 'expired', escrow_locked = 0, fee_reserved = 0, updated_at = datetime('now')
        WHERE order_id = ? AND status = ? AND filled_quantity = ?
      `).run(orderId, order.status, order.filled_quantity);
      if (transition.changes !== 1) return false;
      recordPaperOrderStateEvent(db, orderId, order.status, 'EXPIRED', reason);
      if (order.order_type === 'buy') {
        const acc = db.prepare('SELECT available_cash, escrow_locked FROM paper_trading_accounts WHERE account_id = ?').get(order.account_id) as any;
        const refund = Math.min(Number(acc?.escrow_locked || 0), Number(order.escrow_locked || 0));
        if (refund > 0) {
          const newBal = Number(acc.available_cash) + refund;
          const newEscrow = Math.max(0, Number(acc.escrow_locked) - refund);
          db.prepare('UPDATE paper_trading_accounts SET available_cash = ?, escrow_locked = ?, updated_at = datetime(\'now\') WHERE account_id = ?')
            .run(newBal, newEscrow, order.account_id);
          db.prepare(`INSERT INTO paper_trading_journal (account_id, order_id, entry_type, amount, balance_after, escrow_after) VALUES (?, ?, 'escrow_release', ?, ?, ?)`)
            .run(order.account_id, orderId, refund, newBal, newEscrow);
        }
      }
      applied = true;
      return true;
    });
    tx.immediate();
    if (applied) recordPaperEquitySnapshot(db, order.account_id, 'order_expired', orderId);
    return applied;
  }

  /**
   * Simulate order execution against a discrete orderbook snapshot with state transition guardrails
   */
  public static executeVirtualOrderAgainstBook(
    db: Db,
    orderId: string,
    orderbookLevels: OrderBookLevel[],
    feeCtx?: FeeContext,
    options?: {
      mode?: FillModelMode;
      visibleQueueAheadQty?: number;
      maxFillRatio?: number;
      adversePriceBps?: number;
    },
  ): { filledQty: number; avgPrice: number; status: string } {
    const order = db.prepare('SELECT * FROM paper_trading_orders WHERE order_id = ?').get(orderId) as any;
    if (!order) {
      return { filledQty: 0, avgPrice: 0, status: 'not_found' };
    }

    const neededQty = order.quantity - order.filled_quantity;
    if (neededQty <= 0) {
      return { filledQty: 0, avgPrice: 0, status: order.status };
    }

    const fCtx = feeCtx ?? {
      clone: 'alpha',
      skills: ALPHA_DEFAULT_SKILLS,
      facility: 'npc_station',
    };

    const activeMode: FillModelMode = options?.mode || order.fill_mode || 'immediate';
    const normalizeFillResult = (result: {
      filledQty: number;
      unfilledQty: number;
      weightedAvgPrice: number;
      fills: Array<{ price: number; quantity: number }>;
    }, topOfBookPrice: number) => {
      const totalGrossIsk = result.fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0);
      const slippagePct = topOfBookPrice > 0
        ? (order.order_type === 'buy'
          ? ((result.weightedAvgPrice - topOfBookPrice) / topOfBookPrice) * 100
          : ((topOfBookPrice - result.weightedAvgPrice) / topOfBookPrice) * 100)
        : 0;
      return {
        requestedQty: neededQty,
        filledQty: result.filledQty,
        unfilledQty: result.unfilledQty,
        isComplete: result.unfilledQty === 0,
        totalGrossIsk: Math.round(totalGrossIsk * 100) / 100,
        weightedAvgPrice: result.weightedAvgPrice,
        topOfBookPrice,
        slippagePct: Math.round(slippagePct * 100) / 100,
        levelsConsumed: result.fills.length,
        effectiveOrders: result.fills.map((fill) => ({ price: fill.price, volume: fill.quantity })),
      };
    };

    const topOfBookPrice = orderbookLevels[0]?.price || 0;
    const sim = activeMode === 'limit_queue'
      ? normalizeFillResult(OrderBookSimulator.simulateLimitOrder({
        side: order.order_type,
        limitPrice: order.price,
        requestedQty: neededQty,
        counterpartyBook: orderbookLevels,
        visibleQueueAheadQty: options?.visibleQueueAheadQty ?? 0,
      }), topOfBookPrice)
      : activeMode === 'stress'
        ? normalizeFillResult(OrderBookSimulator.simulateStressFill({
          side: order.order_type,
          requestedQty: neededQty,
          currentBook: orderbookLevels,
          maxFillRatio: options?.maxFillRatio ?? 0.5,
          adversePriceBps: options?.adversePriceBps ?? 100,
        }), topOfBookPrice)
        : (order.order_type === 'buy'
          ? OrderBookSimulator.simulateBuy(orderbookLevels, neededQty)
          : OrderBookSimulator.simulateSell(orderbookLevels, neededQty));

    if (sim.filledQty === 0) {
      return { filledQty: 0, avgPrice: 0, status: order.status };
    }

    const filledNow = sim.filledQty;
    const newTotalFilled = order.filled_quantity + filledNow;
    const isFullyFilled = newTotalFilled >= order.quantity;
    const newStatus = isFullyFilled ? 'filled' : 'partially_filled';

    const allowed = VALID_STATE_TRANSITIONS[order.status] || [];
    if (!allowed.includes(newStatus)) {
      throw new Error('【状态机非法跳转】订单 ' + orderId + ' 状态无法由 ' + order.status + ' 迁移至 ' + newStatus);
    }

    let applied = false;
    const tx = db.transaction(() => {
      const currentOrder = db.prepare('SELECT * FROM paper_trading_orders WHERE order_id = ?').get(orderId) as any;
      if (
        !currentOrder
        || currentOrder.status !== order.status
        || currentOrder.filled_quantity !== order.filled_quantity
      ) {
        return false;
      }

      const claimed = db.prepare(`
        UPDATE paper_trading_orders
        SET filled_quantity = ?,
            status = ?,
            fees_paid = fees_paid + ?,
            escrow_locked = CASE WHEN order_type = 'buy' THEN max(0, escrow_locked - ?) ELSE 0 END,
            fee_reserved = CASE WHEN order_type = 'buy' THEN max(0, fee_reserved - ?) ELSE 0 END,
            updated_at = datetime('now')
        WHERE order_id = ? AND status = ? AND filled_quantity = ?
      `).run(
        newTotalFilled,
        newStatus,
        feeForOrderForClaim(currentOrder.order_type, sim, fCtx),
        currentOrder.order_type === 'buy' ? sim.totalGrossIsk + feeForOrderForClaim(currentOrder.order_type, sim, fCtx) : 0,
        currentOrder.order_type === 'buy' ? feeForOrderForClaim(currentOrder.order_type, sim, fCtx) : 0,
        orderId,
        order.status,
        order.filled_quantity,
      );
      if (claimed.changes !== 1) return false;

      const calc = FeeEngine.calculateTrade({
        buyType: order.order_type === 'buy' ? 'place_buy_order' : 'immediate_buy',
        sellType: order.order_type === 'sell' ? 'place_sell_order' : 'immediate_sell',
        buyUnitPrice: sim.weightedAvgPrice,
        sellUnitPrice: sim.weightedAvgPrice,
        quantity: filledNow,
        buyCtx: fCtx,
        sellCtx: fCtx,
      });

      const buyerFee = calc.buyerBrokerFee;
      const sellerFee = calc.sellerBrokerFee + calc.salesTax + (calc.sccSurcharge || 0);
      const totalFeesForOrder = order.order_type === 'buy' ? buyerFee : sellerFee;
      let feeAllocated = 0;
      let quantityFilled = 0;
      for (let fillIndex = 0; fillIndex < sim.effectiveOrders.length; fillIndex += 1) {
        const level = sim.effectiveOrders[fillIndex];
        quantityFilled += level.volume;
        const isLast = fillIndex === sim.effectiveOrders.length - 1;
        const levelGross = level.price * level.volume;
        const grossTotal = sim.totalGrossIsk || 1;
        const levelFees = isLast
          ? Math.round((totalFeesForOrder - feeAllocated) * 100) / 100
          : Math.round(totalFeesForOrder * (levelGross / grossTotal) * 100) / 100;
        feeAllocated = Math.round((feeAllocated + levelFees) * 100) / 100;
        db.prepare(`
          INSERT INTO paper_fills (
            fill_id, order_id, opportunity_id, snapshot_id, filled_at,
            price, quantity, fees, remaining_quantity, basis, model_version, created_at
          ) VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          'PT-FILL-' + randomUUID(),
          orderId,
          order.opportunity_id || null,
          order.snapshot_id || 'UNKNOWN',
          level.price,
          level.volume,
          levelFees,
          Math.max(0, filledNow - quantityFilled),
          activeMode === 'limit_queue'
            ? 'marketable_limit_queue'
            : activeMode === 'stress'
              ? 'stress_worsened_book'
              : 'counterparty_orderbook_level',
          activeMode === 'limit_queue'
            ? 'eveai-paper-fill-v1-limit-queue'
            : activeMode === 'stress'
              ? 'eveai-paper-fill-v1-stress'
              : 'eveai-paper-fill-v1-immediate',
        );
      }

      recordPaperOrderStateEvent(db, orderId, order.status, newStatus, 'fill_matched', {
        filledQty: filledNow,
        modelVersion: activeMode === 'limit_queue'
          ? 'eveai-paper-fill-v1-limit-queue'
          : activeMode === 'stress'
            ? 'eveai-paper-fill-v1-stress'
            : 'eveai-paper-fill-v1-immediate',
      });

      let sellCostBasis = 0;
      if (order.order_type === 'buy') {
        const oppLocationRow = order.opportunity_id
          ? db.prepare('SELECT buy_location_id FROM trade_opportunities_log WHERE opportunity_id = ?').get(order.opportunity_id) as any
          : undefined;
        const locationId = Number(oppLocationRow?.buy_location_id || 60003760);
        const paperPosId = 'PT-POS-' + Date.now() + '-' + randomUUID().slice(0, 8);
        db.prepare(`
          INSERT INTO paper_trading_positions (paper_id, character_id, type_id, location_id, quantity, cost_price, strategy_type, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'holding', datetime('now'))
        `).run(paperPosId, order.character_id, order.type_id, locationId, filledNow, sim.weightedAvgPrice, order.strategy_type);

        const actualSpend = sim.totalGrossIsk;
        const acc = db.prepare('SELECT available_cash, escrow_locked FROM paper_trading_accounts WHERE account_id = ?').get(order.account_id) as any;
        const escrowAfterSpend = Math.max(0, acc.escrow_locked - actualSpend);

        db.prepare(`
          UPDATE paper_trading_accounts
          SET escrow_locked = ?,
              updated_at = datetime('now')
          WHERE account_id = ?
        `).run(escrowAfterSpend, order.account_id);

        db.prepare(`
          INSERT INTO paper_trading_journal (account_id, order_id, entry_type, amount, balance_after, escrow_after)
          VALUES (?, ?, 'order_spend', ?, ?, ?)
        `).run(order.account_id, orderId, actualSpend, acc.available_cash, escrowAfterSpend);

        const escrowAfterFee = Math.max(0, escrowAfterSpend - buyerFee);
        db.prepare(`
          UPDATE paper_trading_accounts
          SET escrow_locked = ?,
              total_fees_paid = total_fees_paid + ?,
              updated_at = datetime('now')
          WHERE account_id = ?
        `).run(escrowAfterFee, buyerFee, order.account_id);

        db.prepare(`
          INSERT INTO paper_trading_journal (account_id, order_id, entry_type, amount, balance_after, escrow_after)
          VALUES (?, ?, 'fee_payment', ?, ?, ?)
        `).run(order.account_id, orderId, buyerFee, acc.available_cash, escrowAfterFee);
      } else {
        // FIFO inventory consumption: never value a sale at the order limit
        // price. Cost basis comes from the actual holding lots being exited.
        let remainingToSell = filledNow;
        const lots = db.prepare(`
          SELECT paper_id, quantity, cost_price
          FROM paper_trading_positions
          WHERE character_id = ? AND type_id = ? AND status = 'holding' AND quantity > 0
          ORDER BY created_at, paper_id
        `).all(order.character_id, order.type_id) as any[];
        const availableLots = lots.reduce((sum, lot) => sum + Number(lot.quantity), 0);
        if (availableLots < filledNow) return false;

        for (const lot of lots) {
          if (remainingToSell <= 0) break;
          const take = Math.min(remainingToSell, Number(lot.quantity));
          sellCostBasis += take * Number(lot.cost_price);
          remainingToSell -= take;
          db.prepare(`
            INSERT INTO paper_position_exits
              (order_id, paper_id, character_id, type_id, quantity, cost_price, exit_price, gross_pnl)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            orderId,
            lot.paper_id,
            order.character_id,
            order.type_id,
            take,
            lot.cost_price,
            sim.weightedAvgPrice,
            (sim.weightedAvgPrice - Number(lot.cost_price)) * take,
          );
          if (take === Number(lot.quantity)) {
            db.prepare(`
              UPDATE paper_trading_positions
              SET quantity = 0, status = 'sold', sold_at = datetime('now'), sold_price = ?, realized_pnl = ?
              WHERE paper_id = ? AND quantity = ?
            `).run(sim.weightedAvgPrice, (sim.weightedAvgPrice - Number(lot.cost_price)) * take, lot.paper_id, lot.quantity);
          } else {
            db.prepare('UPDATE paper_trading_positions SET quantity = quantity - ? WHERE paper_id = ? AND quantity = ?')
              .run(take, lot.paper_id, lot.quantity);
          }
        }

        const grossRev = sim.totalGrossIsk;
        const grossPnl = grossRev - sellCostBasis;
        const acc = db.prepare('SELECT available_cash, escrow_locked FROM paper_trading_accounts WHERE account_id = ?').get(order.account_id) as any;
        const balanceAfterRevenue = Number(acc.available_cash) + grossRev;

        db.prepare(`
          UPDATE paper_trading_accounts
          SET available_cash = ?,
              updated_at = datetime('now')
          WHERE account_id = ?
        `).run(balanceAfterRevenue, order.account_id);

        db.prepare(`
          INSERT INTO paper_trading_journal (account_id, order_id, entry_type, amount, balance_after, escrow_after)
          VALUES (?, ?, 'order_revenue', ?, ?, ?)
        `).run(order.account_id, orderId, grossRev, balanceAfterRevenue, acc.escrow_locked);

        db.prepare(`
          INSERT INTO paper_trading_journal (account_id, order_id, entry_type, amount, balance_after, escrow_after)
          VALUES (?, ?, 'realized_pnl', ?, ?, ?)
        `).run(order.account_id, orderId, grossPnl, balanceAfterRevenue, acc.escrow_locked);

        const newBal = balanceAfterRevenue - sellerFee;
        db.prepare(`
          UPDATE paper_trading_accounts
          SET available_cash = ?,
              total_realized_pnl = total_realized_pnl + ?,
              total_fees_paid = total_fees_paid + ?,
              updated_at = datetime('now')
          WHERE account_id = ?
        `).run(newBal, grossPnl, sellerFee, order.account_id);

        db.prepare(`
          INSERT INTO paper_trading_journal (account_id, order_id, entry_type, amount, balance_after, escrow_after)
          VALUES (?, ?, 'fee_payment', ?, ?, ?)
        `).run(order.account_id, orderId, sellerFee, newBal, acc.escrow_locked);
      }

      if (order.opportunity_id) {
        const oppRow = db.prepare('SELECT * FROM trade_opportunities_log WHERE opportunity_id = ?').get(order.opportunity_id) as any;
        if (oppRow) {
          let actualPnl: number | null = null;
          if (order.order_type === 'sell') {
            const opportunityFees = db.prepare(`
              SELECT COALESCE(SUM(fees_paid), 0) AS fees
              FROM paper_trading_orders
              WHERE opportunity_id = ?
            `).get(order.opportunity_id) as any;
            actualPnl = sim.totalGrossIsk - sellCostBasis - Number(opportunityFees?.fees || 0);
          }
          const variance = actualPnl === null ? null : actualPnl - Number(oppRow.expected_net_profit || 0);
          db.prepare(`
            UPDATE trade_opportunities_log
            SET outcome_status = ?,
                actual_simulated_pnl = ?,
                prediction_variance = ?,
                opportunity_status = ?
            WHERE opportunity_id = ?
          `).run(
            isFullyFilled ? 'simulated_filled' : 'simulated_partial',
            actualPnl,
            variance,
            isFullyFilled ? 'simulated_filled' : 'simulated_partial',
            order.opportunity_id,
          );
        }
      }

      applied = true;
      return true;
    });

    tx.immediate();
    if (applied) {
      recordPaperEquitySnapshot(db, order.account_id, newStatus === 'filled' ? 'order_filled' : 'order_partially_filled', orderId);
    }
    return applied
      ? { filledQty: filledNow, avgPrice: sim.weightedAvgPrice, status: newStatus }
      : { filledQty: 0, avgPrice: 0, status: 'conflict' };
  }

  /**
   * Retrieve comprehensive paper trading portfolio and performance metrics across the 6 strategies
   */
  public static getPortfolio(
    db: Db,
    characterId: number,
  ): {
    account: PaperAccount;
    positions: PaperPosition[];
    totalInvested: number;
    totalCurrentValue: number;
    totalUnrealizedPnl: number;
    totalRealizedPnl: number;
    strategyBreakdown: PaperStrategyPerformance[];
  } {
    const account = this.getOrCreateAccount(db, characterId);

    const rows = db.prepare(`
      SELECT p.*, t.name as en_name, COALESCE(json_extract(t.data_json, '$.name.zh'), t.name) as zh_name
      FROM paper_trading_positions p
      LEFT JOIN sde_types t ON p.type_id = t.type_id
      WHERE p.character_id = ? AND p.status = 'holding' AND p.quantity > 0
      ORDER BY p.created_at DESC
    `).all(characterId) as any[];

    let totalInvested = 0;
    let totalCurrentValue = 0;
    let totalUnrealizedPnl = 0;

    const positions: PaperPosition[] = [];

    const defaultRates = FeeEngine.calculateRates({
      clone: 'alpha',
      skills: ALPHA_DEFAULT_SKILLS,
      facility: 'npc_station',
    });
    for (const r of rows) {
      // Walk actual bid depth. A single best quote must never value the whole
      // position, and the liquidation estimate pays both sales tax and broker fee.
      let remaining = Number(r.quantity);
      let executableGross = 0;
      let weightedPriceSum = 0;
      const bids = db.prepare(`
        SELECT price, volume_remain FROM market_orders
        WHERE type_id = ? AND location_id = ? AND is_buy_order = 1
        ORDER BY price DESC
      `).all(r.type_id, r.location_id) as any[];
      for (const bid of bids) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, Number(bid.volume_remain));
        executableGross += take * Number(bid.price);
        weightedPriceSum += take * Number(bid.price);
        remaining -= take;
      }
      if (remaining > 0) {
        executableGross += remaining * Number(r.cost_price);
        weightedPriceSum += remaining * Number(r.cost_price);
      }
      const currentPrice = Number(r.quantity) > 0 ? weightedPriceSum / Number(r.quantity) : Number(r.cost_price);
      const invested = r.cost_price * r.quantity;
      const val = executableGross;
      const liquidationHaircut = defaultRates.salesTaxRate + defaultRates.brokerFeeRate;
      const unPnl = val * (1 - liquidationHaircut) - invested;

      totalInvested += invested;
      totalCurrentValue += val;
      totalUnrealizedPnl += unPnl;

      positions.push({
        paperId: r.paper_id,
        characterId: r.character_id,
        typeId: r.type_id,
        typeName: r.en_name,
        zhName: r.zh_name,
        locationId: r.location_id,
        quantity: r.quantity,
        costPrice: r.cost_price,
        strategyType: r.strategy_type || 'regional_hauling',
        status: 'holding',
        createdAt: r.created_at,
        currentPrice,
        unrealizedPnl: Math.round(unPnl * 100) / 100,
      });
    }

    const strategyTypes: StrategyType[] = [
      'regional_hauling',
      'station_arbitrage',
      'manufacturing_arbitrage',
      'trend_following',
      'event_driven',
      'market_making',
    ];

    const strategyBreakdown: PaperStrategyPerformance[] = strategyTypes.map(st => {
      const oppCount = db.prepare('SELECT count(*) as cnt FROM trade_opportunities_log WHERE strategy_type = ?').get(st) as any;
      const vetoCount = db.prepare("SELECT count(*) as cnt FROM trade_opportunities_log WHERE strategy_type = ? AND outcome_status = 'vetoed'").get(st) as any;
      const execCount = db.prepare("SELECT count(*) as cnt FROM paper_trading_orders WHERE strategy_type = ? AND status = 'filled'").get(st) as any;

      return {
        strategy: st,
        totalOpportunities: oppCount?.cnt || 0,
        vetoedOpportunities: vetoCount?.cnt || 0,
        executedTrades: execCount?.cnt || 0,
        realizedPnlIsk: 0,
        unrealizedPnlIsk: 0,
        winRatePct: 0,
        avgPredictionVarianceIsk: 0,
      };
    });

    return {
      account,
      positions,
      totalInvested: Math.round(totalInvested * 100) / 100,
      totalCurrentValue: Math.round(totalCurrentValue * 100) / 100,
      totalUnrealizedPnl: Math.round(totalUnrealizedPnl * 100) / 100,
      totalRealizedPnl: Math.round(account.totalRealizedPnl * 100) / 100,
      strategyBreakdown,
    };
  }
}

