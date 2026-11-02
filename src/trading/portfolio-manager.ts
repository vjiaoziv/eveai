import type { Db } from '../db/sqlite.js';

export interface PortfolioRiskLimits {
  cashReservePct: number;       // default 0.20 (20%)
  singleItemMaxPct: number;     // default 0.15 (15%)
  categoryMaxPct: number;       // default 0.30 (30%)
  trendInvestMaxPct: number;    // default 0.10 (10%)
  lowLiquidityMaxPct: number;   // default 0.10 (10%)
  maxStressLossPct: number;     // default 0.015 (1.5%)
  maxHaulingCargoIsk: number;   // default 50_000_000 (T1 hauler anti-gank cap)
}

export const DEFAULT_RISK_LIMITS: PortfolioRiskLimits = {
  cashReservePct: 0.20,
  singleItemMaxPct: 0.15,
  categoryMaxPct: 0.30,
  trendInvestMaxPct: 0.10,
  lowLiquidityMaxPct: 0.10,
  maxStressLossPct: 0.015,
  maxHaulingCargoIsk: 50_000_000,
};

export interface CapitalBreakdown {
  characterId: number;
  walletBalance: number;       // Cash in wallet
  escrowLocked: number;        // Locked in active buy orders
  inventoryEstimatedValue: number; // Estimated value of inventory
  totalNetWorth: number;       // wallet + escrow + inventory
  cashReserveRequired: number; // 20% of wallet balance
  investableCapital: number;   // walletBalance - cashReserveRequired
  singleItemCapIsk: number;    // 15% of investable capital
  categoryCapIsk: number;      // 30% of investable capital
}

export class PortfolioManager {
  /**
   * Calculate exact capital breakdown for a character, avoiding double counting.
   */
  public static getCapitalBreakdown(
    db: Db,
    characterId: number,
    limits: PortfolioRiskLimits = DEFAULT_RISK_LIMITS,
  ): CapitalBreakdown {
    // 1. Read wallet balance
    const walletRow = db.prepare('SELECT balance FROM character_wallet WHERE character_id = ?').get(characterId) as any;
    const walletBalance = Number(walletRow?.balance || 0);

    // 2. Read buy order escrow (money already locked in market)
    const escrowRow = db.prepare(`
      SELECT COALESCE(SUM(escrow), 0) as total_escrow
      FROM character_orders
      WHERE character_id = ? AND is_buy_order = 1
    `).get(characterId) as any;
    const escrowLocked = Number(escrowRow?.total_escrow || 0);

    // 3. Estimate inventory value
    const assetRows = db.prepare(`
      SELECT a.type_id, a.quantity,
             COALESCE(json_extract(t.data_json, '$.basePrice'), 0) as base_price
      FROM character_assets a
      LEFT JOIN sde_types t ON a.type_id = t.type_id
      WHERE a.character_id = ? AND a.is_blueprint_copy != 1
    `).all(characterId) as any[];

    let inventoryEstimatedValue = 0;
    for (const r of assetRows) {
      inventoryEstimatedValue += (r.quantity || 1) * (r.base_price || 0);
    }

    const totalNetWorth = walletBalance + escrowLocked + inventoryEstimatedValue;
    const cashReserveRequired = Math.round(walletBalance * limits.cashReservePct * 100) / 100;
    const investableCapital = Math.max(0, Math.round((walletBalance - cashReserveRequired) * 100) / 100);
    const singleItemCapIsk = Math.round(investableCapital * limits.singleItemMaxPct * 100) / 100;
    const categoryCapIsk = Math.round(investableCapital * limits.categoryMaxPct * 100) / 100;

    return {
      characterId,
      walletBalance,
      escrowLocked,
      inventoryEstimatedValue: Math.round(inventoryEstimatedValue * 100) / 100,
      totalNetWorth: Math.round(totalNetWorth * 100) / 100,
      cashReserveRequired,
      investableCapital,
      singleItemCapIsk,
      categoryCapIsk,
    };
  }

  /**
   * Check whether a proposed trade opportunity violates risk management rules.
   */
  public static validateTradeRisk(
    breakdown: CapitalBreakdown,
    proposedCost: number,
    strategy: string,
    volumeM3: number,
    limits: PortfolioRiskLimits = DEFAULT_RISK_LIMITS,
  ): { allowed: boolean; reason?: string } {
    if (proposedCost > breakdown.investableCapital) {
      return {
        allowed: false,
        reason: `超出可用投资资金上限：所需资金 ${Math.round(proposedCost).toLocaleString()} ISK，当前最大可投资金额 ${Math.round(breakdown.investableCapital).toLocaleString()} ISK（已扣除 20% 安全现金储备 ${Math.round(breakdown.cashReserveRequired).toLocaleString()} ISK）。`,
      };
    }

    if (strategy === 'regional_hauling' && proposedCost > limits.maxHaulingCargoIsk) {
      return {
        allowed: false,
        reason: `触发高安防自杀强杀风控限制：T1 工业舰单趟货值不得超过 ${Math.round(limits.maxHaulingCargoIsk).toLocaleString()} ISK（当前提议 ${Math.round(proposedCost).toLocaleString()} ISK），请分批或换用高速护卫舰。`,
      };
    }

    if (strategy === 'regional_hauling' && proposedCost > limits.maxHaulingCargoIsk) {
      return {
        allowed: false,
        reason: `触发高安防自杀强杀风控限制：T1 工业舰单趟货值不得超过 ${Math.round(limits.maxHaulingCargoIsk).toLocaleString()} ISK（当前提议 ${Math.round(proposedCost).toLocaleString()} ISK），请分批或换用高速护卫舰。`,
      };
    }

    if (proposedCost > breakdown.singleItemCapIsk) {
      return {
        allowed: false,
        reason: `超出单一物品持仓风控线（15%）：该笔投入 ${Math.round(proposedCost).toLocaleString()} ISK，单品上限为 ${Math.round(breakdown.singleItemCapIsk).toLocaleString()} ISK。`,
      };
    }

    return { allowed: true };
  }
}