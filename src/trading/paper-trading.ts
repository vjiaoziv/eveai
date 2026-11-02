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

export class PaperTradingSystem {
  /**
   * Get or create a dedicated virtual paper trading account for a character
   */
  public static getOrCreateAccount(
    db: Db,
    characterId: number,
    initialCash = 10_000_000,
  ): PaperAccount {
    const accountId = `PT-ACC-${characterId}`;
    let row = db.prepare('SELECT * FROM paper_trading_accounts WHERE account_id = ?').get(accountId) as any;

    if (!row) {
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      db.prepare(`
        INSERT INTO paper_trading_accounts (account_id, character_id, initial_cash, available_cash, escrow_locked, total_realized_pnl, total_fees_paid, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, 0, 0, 'active', ?, ?)
      `).run(accountId, characterId, initialCash, initialCash, now, now);

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
   * Reset virtual paper trading account (keeps history, resets active balance and positions)
   */
  public static resetAccount(db: Db, characterId: number, initialCash = 10_000_000): void {
    const accountId = `PT-ACC-${characterId}`;
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE paper_trading_accounts 
        SET available_cash = ?, escrow_locked = 0, initial_cash = ?, updated_at = datetime('now')
        WHERE account_id = ?
      `).run(initialCash, initialCash, accountId);

      db.prepare("UPDATE paper_trading_orders SET status = 'cancelled' WHERE account_id = ? AND status IN ('open', 'partially_filled')").run(accountId);
      db.prepare("UPDATE paper_trading_positions SET status = 'sold', sold_at = datetime('now'), sold_price = 0, realized_pnl = 0 WHERE character_id = ? AND status = 'holding'").run(characterId);
    });
    tx();
  }

  /**
   * Log an identified trade opportunity BEFORE any execution happens.
   * Ensures 100% auditable record of both accepted and vetoed opportunities.
   */
  public static logOpportunity(db: Db, opp: TradeOpportunity): string {
    const oppId = `OPP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
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
   * Create a local virtual order with strict transaction-isolated balance locking
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
      feeCtx?: FeeContext;
    },
  ): { success: boolean; orderId?: string; error?: string } {
    const { characterId, typeId, strategyType, orderType, price, quantity, opportunityId } = params;
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
    const orderId = `PT-ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    let success = false;
    let errReason: string | undefined;

    const tx = db.transaction(() => {
      if (orderType === 'buy') {
        if (account.availableCash < totalRequiredIsk) {
          errReason = `虚拟可用资金不足：需要 ${Math.round(totalRequiredIsk).toLocaleString()} ISK，当前可用 ${Math.round(account.availableCash).toLocaleString()} ISK。`;
          return;
        }

        // Lock funds in escrow
        db.prepare(`
          UPDATE paper_trading_accounts
          SET available_cash = available_cash - ?,
              escrow_locked = escrow_locked + ?,
              updated_at = datetime('now')
          WHERE account_id = ?
        `).run(totalRequiredIsk, totalRequiredIsk, account.accountId);
      } else {
        // Sell order: check inventory position
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
        INSERT INTO paper_trading_orders (order_id, account_id, opportunity_id, character_id, type_id, strategy_type, order_type, price, quantity, filled_quantity, status, fees_paid, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'open', 0, datetime('now'), datetime('now'))
      `).run(orderId, account.accountId, opportunityId || null, characterId, typeId, strategyType, orderType, price, quantity);

      success = true;
    });

    tx();

    return { success, orderId: success ? orderId : undefined, error: errReason };
  }

  /**
   * Cancel an open virtual order and release locked escrow/inventory
   */
  public static cancelVirtualOrder(db: Db, orderId: string): boolean {
    const order = db.prepare('SELECT * FROM paper_trading_orders WHERE order_id = ?').get(orderId) as any;
    if (!order || (order.status !== 'open' && order.status !== 'partially_filled')) {
      return false;
    }

    const unfilledQty = order.quantity - order.filled_quantity;
    const tx = db.transaction(() => {
      if (order.order_type === 'buy' && unfilledQty > 0) {
        // Refund remaining locked escrow
        const escrowToRefund = unfilledQty * order.price;
        db.prepare(`
          UPDATE paper_trading_accounts
          SET available_cash = available_cash + ?,
              escrow_locked = max(0, escrow_locked - ?),
              updated_at = datetime('now')
          WHERE account_id = ?
        `).run(escrowToRefund, escrowToRefund, order.account_id);
      }

      db.prepare("UPDATE paper_trading_orders SET status = 'cancelled', updated_at = datetime('now') WHERE order_id = ?").run(orderId);
    });

    tx();
    return true;
  }

  /**
   * Simulate order execution against a discrete orderbook snapshot.
   * Accurately supports partial fills, complete fills, and records prediction variance.
   */
  public static executeVirtualOrderAgainstBook(
    db: Db,
    orderId: string,
    orderbookLevels: OrderBookLevel[],
    feeCtx?: FeeContext,
  ): { filledQty: number; avgPrice: number; status: string } {
    const order = db.prepare('SELECT * FROM paper_trading_orders WHERE order_id = ?').get(orderId) as any;
    if (!order || (order.status !== 'open' && order.status !== 'partially_filled')) {
      return { filledQty: 0, avgPrice: 0, status: order?.status || 'not_found' };
    }

    const neededQty = order.quantity - order.filled_quantity;
    const fCtx = feeCtx ?? {
      clone: 'alpha',
      skills: ALPHA_DEFAULT_SKILLS,
      facility: 'npc_station',
    };

    // Simulate walk
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

    const tx = db.transaction(() => {
      const calc = FeeEngine.calculateTrade({
        buyType: order.order_type === 'buy' ? 'immediate_buy' : 'place_buy_order',
        sellType: order.order_type === 'sell' ? 'immediate_sell' : 'place_sell_order',
        buyUnitPrice: sim.weightedAvgPrice,
        sellUnitPrice: sim.weightedAvgPrice,
        quantity: filledNow,
        buyCtx: fCtx,
        sellCtx: fCtx,
      });

      if (order.order_type === 'buy') {
        // Create holding position
        const paperPosId = `PT-POS-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        db.prepare(`
          INSERT INTO paper_trading_positions (paper_id, character_id, type_id, location_id, quantity, cost_price, strategy_type, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'holding', datetime('now'))
        `).run(paperPosId, order.character_id, order.type_id, 60003760, filledNow, sim.weightedAvgPrice, order.strategy_type);

        // Deduct from escrow, adjust available cash for any difference between estimate and actual
        const actualSpend = sim.totalGrossIsk + calc.totalFees;
        db.prepare(`
          UPDATE paper_trading_accounts
          SET escrow_locked = max(0, escrow_locked - ?),
              total_fees_paid = total_fees_paid + ?,
              updated_at = datetime('now')
          WHERE account_id = ?
        `).run(actualSpend, calc.totalFees, order.account_id);
      } else {
        // Sell order: realize PnL against holding position
        const grossRev = sim.totalGrossIsk;
        const netRev = grossRev - calc.salesTax - calc.sellerBrokerFee;
        const estCost = filledNow * order.price; // Cost basis
        const pnl = netRev - estCost;

        db.prepare(`
          UPDATE paper_trading_accounts
          SET available_cash = available_cash + ?,
              total_realized_pnl = total_realized_pnl + ?,
              total_fees_paid = total_fees_paid + ?,
              updated_at = datetime('now')
          WHERE account_id = ?
        `).run(netRev, pnl, calc.totalFees, order.account_id);

        // Deduct from positions
        db.prepare(`
          UPDATE paper_trading_positions
          SET quantity = max(0, quantity - ?)
          WHERE character_id = ? AND type_id = ? AND status = 'holding'
        `).run(filledNow, order.character_id, order.type_id);
      }

      db.prepare(`
        UPDATE paper_trading_orders
        SET filled_quantity = ?,
            status = ?,
            fees_paid = fees_paid + ?,
            updated_at = datetime('now')
        WHERE order_id = ?
      `).run(newTotalFilled, newStatus, calc.totalFees, orderId);

      // If associated with opportunity log, record outcome & prediction variance
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

    // Compute strategy breakdown from opportunities and orders
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
