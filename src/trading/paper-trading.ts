import type { Db } from '../db/sqlite.js';

export interface PaperPosition {
  paperId: string;
  characterId: number;
  typeId: number;
  typeName?: string;
  zhName?: string;
  locationId: number;
  quantity: number;
  costPrice: number;
  status: 'holding' | 'sold';
  createdAt: string;
  soldAt?: string;
  soldPrice?: number;
  realizedPnl?: number;
  currentPrice?: number;
  unrealizedPnl?: number;
}

export class PaperTradingSystem {
  /**
   * Open a virtual paper trade position (does not touch in-game assets)
   */
  public static openPosition(
    db: Db,
    characterId: number,
    typeId: number,
    locationId: number,
    quantity: number,
    costPrice: number,
  ): PaperPosition {
    const paperId = `PT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    db.prepare(`
      INSERT INTO paper_trading_positions (paper_id, character_id, type_id, location_id, quantity, cost_price, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'holding', ?)
    `).run(paperId, characterId, typeId, locationId, quantity, costPrice, now);

    return {
      paperId,
      characterId,
      typeId,
      locationId,
      quantity,
      costPrice,
      status: 'holding',
      createdAt: now,
    };
  }

  /**
   * Close a virtual paper trade position by selling into market
   */
  public static closePosition(
    db: Db,
    paperId: string,
    soldPrice: number,
  ): { success: boolean; realizedPnl: number } {
    const pos = db.prepare('SELECT * FROM paper_trading_positions WHERE paper_id = ?').get(paperId) as any;
    if (!pos || pos.status === 'sold') {
      return { success: false, realizedPnl: 0 };
    }

    const grossPnl = (soldPrice - pos.cost_price) * pos.quantity;
    // Account for ~5.36% sales tax on exit
    const exitTax = (soldPrice * pos.quantity) * 0.0536;
    const realizedPnl = Math.round((grossPnl - exitTax) * 100) / 100;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    db.prepare(`
      UPDATE paper_trading_positions
      SET status = 'sold', sold_at = ?, sold_price = ?, realized_pnl = ?
      WHERE paper_id = ?
    `).run(now, soldPrice, realizedPnl, paperId);

    return { success: true, realizedPnl };
  }

  /**
   * List all paper positions with live mark-to-market valuation
   */
  public static getPortfolio(
    db: Db,
    characterId: number,
  ): {
    positions: PaperPosition[];
    totalInvested: number;
    totalCurrentValue: number;
    totalUnrealizedPnl: number;
    totalRealizedPnl: number;
  } {
    const rows = db.prepare(`
      SELECT p.*, t.name as en_name, t.zh_name
      FROM paper_trading_positions p
      LEFT JOIN sde_types t ON p.type_id = t.type_id
      WHERE p.character_id = ?
      ORDER BY p.created_at DESC
    `).all(characterId) as any[];

    let totalInvested = 0;
    let totalCurrentValue = 0;
    let totalUnrealizedPnl = 0;
    let totalRealizedPnl = 0;

    const positions: PaperPosition[] = [];

    for (const r of rows) {
      if (r.status === 'sold') {
        totalRealizedPnl += r.realized_pnl || 0;
        positions.push({
          paperId: r.paper_id,
          characterId: r.character_id,
          typeId: r.type_id,
          typeName: r.en_name,
          zhName: r.zh_name,
          locationId: r.location_id,
          quantity: r.quantity,
          costPrice: r.cost_price,
          status: 'sold',
          createdAt: r.created_at,
          soldAt: r.sold_at,
          soldPrice: r.sold_price,
          realizedPnl: r.realized_pnl,
        });
      } else {
        // Mark-to-market using current Jita 4-4 sell order or order book
        const bestBuyRow = db.prepare(`
          SELECT max(price) as best_buy FROM market_orders
          WHERE type_id = ? AND location_id = ? AND is_buy_order = 1
        `).get(r.type_id, r.location_id) as any;

        const currentPrice = bestBuyRow?.best_buy || r.cost_price;
        const invested = r.cost_price * r.quantity;
        const val = currentPrice * r.quantity;
        const unPnl = val * (1 - 0.0536) - invested;

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
          status: 'holding',
          createdAt: r.created_at,
          currentPrice,
          unrealizedPnl: Math.round(unPnl * 100) / 100,
        });
      }
    }

    return {
      positions,
      totalInvested: Math.round(totalInvested * 100) / 100,
      totalCurrentValue: Math.round(totalCurrentValue * 100) / 100,
      totalUnrealizedPnl: Math.round(totalUnrealizedPnl * 100) / 100,
      totalRealizedPnl: Math.round(totalRealizedPnl * 100) / 100,
    };
  }
}