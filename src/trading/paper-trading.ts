import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import type { FeeContext, OrderBookLevel, StrategyType, TradeOpportunity } from './types.js';
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
    });
    tx();
  }

  /**
   * Log an identified trade opportunity BEFORE any execution happens.
   */
  public static logOpportunity(db: Db, opp: TradeOpportunity): string {
    const oppId = 'OPP-' + Date.now() + '-' + randomUUID().slice(0, 8);
    const outcome = (opp.opportunityRating === 'D' || opp.riskVetoReason) ? 'vetoed' : 'pending';

    db.prepare(`
      INSERT INTO trade_opportunities_log (
        opportunity_id, strategy_type, type_id, region_id, detected_at,
        expected_buy_price, expected_sell_price, proposed_quantity, expected_fees,
        expected_net_profit, expected_roi, risk_rating, rejection_reason,
        data_quality_json, outcome_status
      ) VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      oppId,
      opp.strategy,
      opp.typeId,
      opp.buyStationId,
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
      idempotencyKey?: string;
      feeCtx?: FeeContext;
    },
  ): { success: boolean; orderId?: string; error?: string } {
    const { characterId, typeId, strategyType, orderType, price, quantity, opportunityId, idempotencyKey } = params;

    if (price <= 0 || quantity <= 0 || !Number.isFinite(price) || !Number.isFinite(quantity)) {
      return { success: false, error: '订单价格与数量必须为大于零的合法有限数值。' };
    }

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
          return {
            success: false,
            error: '【幂等冲突】相同 idempotencyKey (' + idempotencyKey + ') 不能用于不同参数的订单！已有订单参数: typeId=' + existing.type_id + ', price=' + existing.price + ', qty=' + existing.quantity,
          };
        }
        return { success: true, orderId: existing.order_id };
      }
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
      ? Math.max(100.0, price * quantity * FeeEngine.calculateRates(feeCtx).brokerFeeRate)
      : Math.max(100.0, price * quantity * (FeeEngine.calculateRates(feeCtx).brokerFeeRate + FeeEngine.calculateRates(feeCtx).salesTaxRate));

    const totalRequiredIsk = price * quantity + estFees;
    const orderId = 'PT-ORD-' + Date.now() + '-' + randomUUID().slice(0, 8);

    let success = false;
    let errReason: string | undefined;

    const tx = db.transaction(() => {
      if (orderType === 'buy') {
        if (account.availableCash < totalRequiredIsk) {
          errReason = `虚拟可用资金不足：需要 ${Math.round(totalRequiredIsk).toLocaleString()} ISK，当前可用 ${Math.round(account.availableCash).toLocaleString()} ISK。`;
          return;
        }

        const newBal = account.availableCash - totalRequiredIsk;
        const newEscrow = account.escrowLocked + totalRequiredIsk;
        db.prepare(`
          UPDATE paper_trading_accounts
          SET available_cash = ?,
              escrow_locked = ?,
              updated_at = datetime('now')
          WHERE account_id = ?
        `).run(newBal, newEscrow, account.accountId);

        db.prepare(`
          INSERT INTO paper_trading_journal (account_id, order_id, entry_type, amount, balance_after, escrow_after)
          VALUES (?, ?, 'escrow_lock', ?, ?, ?)
        `).run(account.accountId, orderId, totalRequiredIsk, newBal, newEscrow);
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
        INSERT INTO paper_trading_orders (order_id, account_id, opportunity_id, idempotency_key, character_id, type_id, strategy_type, order_type, price, quantity, filled_quantity, status, fees_paid, escrow_locked, fee_reserved, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'open', 0, ?, ?, datetime('now'), datetime('now'))
      `).run(
        orderId, account.accountId, opportunityId || null, idempotencyKey || null,
        characterId, typeId, strategyType, orderType, price, quantity,
        orderType === 'buy' ? totalRequiredIsk : 0,
        orderType === 'buy' ? estFees : 0,
      );

      success = true;
    });

    tx();
    return { success, orderId: success ? orderId : undefined, error: errReason };
  }

  /**
   * Cancel an open virtual order and release locked escrow
   */
  public static cancelVirtualOrder(db: Db, orderId: string): boolean {
    const order = db.prepare('SELECT * FROM paper_trading_orders WHERE order_id = ?').get(orderId) as any;
    if (!order) return false;

    const allowed = VALID_STATE_TRANSITIONS[order.status] || [];
    if (!allowed.includes('cancelled')) {
      return false;
    }

    const unfilledQty = order.quantity - order.filled_quantity;
    const tx = db.transaction(() => {
      if (order.order_type === 'buy' && unfilledQty > 0) {
        const acc = db.prepare('SELECT available_cash, escrow_locked FROM paper_trading_accounts WHERE account_id = ?').get(order.account_id) as any;
        // Refund exactly the unfilled cash portion plus any remaining unused fee buffer in escrow
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

      db.prepare("UPDATE paper_trading_orders SET status = 'cancelled', escrow_locked = 0, fee_reserved = 0, updated_at = datetime('now') WHERE order_id = ?").run(orderId);
    });

    tx();
    return true;
  }

  /**
   * Simulate order execution against a discrete orderbook snapshot with state transition guardrails
   */
  public static executeVirtualOrderAgainstBook(
    db: Db,
    orderId: string,
    orderbookLevels: OrderBookLevel[],
    feeCtx?: FeeContext,
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

    const sim = order.order_type === 'buy'
      ? OrderBookSimulator.simulateBuy(orderbookLevels, neededQty)
      : OrderBookSimulator.simulateSell(orderbookLevels, neededQty);

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

    const tx = db.transaction(() => {
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
      const feeForOrder = order.order_type === 'buy' ? buyerFee : sellerFee;

      if (order.order_type === 'buy') {
        const paperPosId = 'PT-POS-' + Date.now() + '-' + randomUUID().slice(0, 8);
        db.prepare(`
          INSERT INTO paper_trading_positions (paper_id, character_id, type_id, location_id, quantity, cost_price, strategy_type, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'holding', datetime('now'))
        `).run(paperPosId, order.character_id, order.type_id, 60003760, filledNow, sim.weightedAvgPrice, order.strategy_type);

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
        const grossRev = sim.totalGrossIsk;
        const netRev = grossRev - sellerFee;
        const estCost = filledNow * order.price;
        const pnl = netRev - estCost;

        const acc = db.prepare('SELECT available_cash, escrow_locked FROM paper_trading_accounts WHERE account_id = ?').get(order.account_id) as any;
        const balanceAfterRevenue = acc.available_cash + grossRev;

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

        const newBal = balanceAfterRevenue - sellerFee;
        db.prepare(`
          UPDATE paper_trading_accounts
          SET available_cash = ?,
              total_realized_pnl = total_realized_pnl + ?,
              total_fees_paid = total_fees_paid + ?,
              updated_at = datetime('now')
          WHERE account_id = ?
        `).run(newBal, pnl, sellerFee, order.account_id);

        db.prepare(`
          INSERT INTO paper_trading_journal (account_id, order_id, entry_type, amount, balance_after, escrow_after)
          VALUES (?, ?, 'fee_payment', ?, ?, ?)
        `).run(order.account_id, orderId, sellerFee, newBal, acc.escrow_locked);
      }

      db.prepare(`
        UPDATE paper_trading_orders
        SET filled_quantity = ?,
            status = ?,
            fees_paid = fees_paid + ?,
            escrow_locked = CASE WHEN order_type = 'buy' THEN max(0, escrow_locked - ?) ELSE 0 END,
            fee_reserved = CASE WHEN order_type = 'buy' THEN max(0, fee_reserved - ?) ELSE 0 END,
            updated_at = datetime('now')
        WHERE order_id = ?
      `).run(
        newTotalFilled,
        newStatus,
        feeForOrder,
        order.order_type === 'buy' ? sim.totalGrossIsk + feeForOrder : 0,
        order.order_type === 'buy' ? feeForOrder : 0,
        orderId,
      );

      if (order.opportunity_id) {
        const oppRow = db.prepare('SELECT * FROM trade_opportunities_log WHERE opportunity_id = ?').get(order.opportunity_id) as any;
        if (oppRow) {
          const actualPnl = isFullyFilled ? (oppRow.expected_net_profit * (newTotalFilled / order.quantity)) : 0;
          const variance = actualPnl - oppRow.expected_net_profit;
          db.prepare(`
            UPDATE trade_opportunities_log
            SET outcome_status = ?,
                actual_simulated_pnl = ?,
                prediction_variance = ?
            WHERE opportunity_id = ?
          `).run(isFullyFilled ? 'simulated_filled' : 'simulated_partial', actualPnl, variance, order.opportunity_id);
        }
      }
    });

    tx();
    return { filledQty: filledNow, avgPrice: sim.weightedAvgPrice, status: newStatus };
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

    for (const r of rows) {
      const bestBuyRow = db.prepare(`
        SELECT max(price) as best_buy FROM market_orders
        WHERE type_id = ? AND location_id = ? AND is_buy_order = 1
      `).get(r.type_id, r.location_id) as any;

      const currentPrice = bestBuyRow?.best_buy || r.cost_price;
      const invested = r.cost_price * r.quantity;
      const val = currentPrice * r.quantity;
      const unPnl = val * 0.94975 - invested; // 5.025% sales tax

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

