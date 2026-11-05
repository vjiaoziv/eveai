import type { Db } from '../db/sqlite.js';
import { DataCenter } from './data-center.js';
import { OrderBookSimulator } from './orderbook-simulator.js';
import { assetLineagePredicate, type AssetLineage } from '../assets/asset-lineage.js';

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
  inFlightCommittedIsk: number; // Committed to approved but unexecuted drafts
  liquidInventoryValue: number; // Realizable liquidation value against discrete orderbook depth
  illiquidInventoryValue: number; // Value of items with no active buy depth or fallback SDE base price
  specialAssetsCount: number;  // Count of special assets (BPCs, unpacked items, etc.)
  totalNetWorth: number;       // wallet + escrow + liquidInventory + illiquidInventory
  cashReserveRequired: number; // 20% of wallet balance
  investableCapital: number;   // walletBalance - cashReserveRequired - inFlightCommittedIsk
  singleItemCapIsk: number;    // 15% of investable capital
  categoryCapIsk: number;      // 30% of investable capital
}

export class PortfolioManager {
  /**
   * Calculate exact capital breakdown for a character, accounting for in-flight commitments,
   * realistic multi-level orderbook liquidation depth, and special asset isolation.
   */
  public static getCapitalBreakdown(
    db: Db,
    characterId: number,
    limits: PortfolioRiskLimits = DEFAULT_RISK_LIMITS,
    lineage?: AssetLineage,
  ): CapitalBreakdown {
    // 1. Read wallet balance
    const walletRow = db.prepare('SELECT balance FROM character_wallet WHERE character_id = ?').get(characterId) as any;
    const walletBalance = Number(walletRow?.balance || 0);

    // 2. Read buy order escrow (money already locked in active market buy orders)
    const escrowRow = db.prepare(`
      SELECT COALESCE(SUM(escrow), 0) as total_escrow
      FROM character_orders
      WHERE character_id = ? AND is_buy_order = 1
    `).get(characterId) as any;
    const escrowLocked = Number(escrowRow?.total_escrow || 0);

    // 3. Read in-flight approved trade drafts (committed capital awaiting manual in-game execution)
    const inFlightRow = db.prepare(`
      SELECT COALESCE(SUM(capital_required), 0) as committed_isk
      FROM trade_drafts
      WHERE character_id = ? AND status = 'approved' AND executed_at IS NULL
    `).get(characterId) as any;
    const inFlightCommittedIsk = Number(inFlightRow?.committed_isk || 0);

    // 4. Read all inventory items
    const ownership = lineage ? assetLineagePredicate('a', lineage) : null;
    const ownershipSql = ownership ? ` AND ${ownership.sql}` : '';
    const assetRows = db.prepare(`
      SELECT a.item_id, a.type_id, a.quantity, a.location_id, a.is_blueprint_copy,
             COALESCE(json_extract(t.data_json, '$.basePrice'), 0) as base_price
      FROM character_assets a
      LEFT JOIN sde_types t ON a.type_id = t.type_id
      WHERE a.character_id = ?${ownershipSql}
    `).all(characterId, ...(ownership?.params ?? [])) as any[];

    let liquidInventoryValue = 0;
    let illiquidInventoryValue = 0;
    let specialAssetsCount = 0;

    for (const item of assetRows) {
      // Isolate BPCs and non-marketable items
      if (item.is_blueprint_copy === 1) {
        specialAssetsCount += 1;
        // BPCs cannot be sold on regional market, zero liquidation value assigned
        continue;
      }

      // Check orderbook depth at Jita 4-4 (Hub location 60003760)
      const book = DataCenter.getOrderBook(db, 10000002, item.type_id, 60003760);
      if (book.buys.length > 0) {
        const sim = OrderBookSimulator.simulateSell(book.buys, item.quantity);
        liquidInventoryValue += sim.totalGrossIsk * 0.94975; // after 5.025% sales tax
        if (!sim.isComplete) {
          // Unfilled units assigned conservative base price
          illiquidInventoryValue += sim.unfilledQty * (item.base_price || 0);
        }
      } else {
        // No buy depth at all
        illiquidInventoryValue += (item.quantity || 1) * (item.base_price || 0);
      }
    }

    const totalNetWorth = walletBalance + escrowLocked + liquidInventoryValue + illiquidInventoryValue;
    const cashReserveRequired = Math.round(walletBalance * limits.cashReservePct * 100) / 100;
    const investableCapital = Math.max(
      0,
      Math.round((walletBalance - cashReserveRequired - inFlightCommittedIsk) * 100) / 100,
    );
    const singleItemCapIsk = Math.round(investableCapital * limits.singleItemMaxPct * 100) / 100;
    const categoryCapIsk = Math.round(investableCapital * limits.categoryMaxPct * 100) / 100;

    return {
      characterId,
      walletBalance,
      escrowLocked,
      inFlightCommittedIsk,
      liquidInventoryValue: Math.round(liquidInventoryValue * 100) / 100,
      illiquidInventoryValue: Math.round(illiquidInventoryValue * 100) / 100,
      specialAssetsCount,
      totalNetWorth: Math.round(totalNetWorth * 100) / 100,
      cashReserveRequired,
      investableCapital,
      singleItemCapIsk,
      categoryCapIsk,
    };
  }

  /**
   * Check whether a proposed trade opportunity violates risk management rules,
   * including cumulative holdings and category caps.
   */
  public static validateTradeRisk(
    breakdown: CapitalBreakdown,
    proposedCost: number,
    strategy: string,
    volumeM3: number,
    limits: PortfolioRiskLimits = DEFAULT_RISK_LIMITS,
    context?: {
      db?: Db;
      typeId?: number;
      categoryId?: number;
      assetLineage?: AssetLineage;
    },
  ): { allowed: boolean; reason?: string } {
    // 1. Available capital check
    if (proposedCost > breakdown.investableCapital) {
      return {
        allowed: false,
        reason: `超出可用投资资金上限：所需资金 ${Math.round(proposedCost).toLocaleString()} ISK，当前最大可投资金额 ${Math.round(breakdown.investableCapital).toLocaleString()} ISK（已扣除 20% 安全现金储备 ${Math.round(breakdown.cashReserveRequired).toLocaleString()} ISK 及在途审批资金 ${Math.round(breakdown.inFlightCommittedIsk).toLocaleString()} ISK）。`,
      };
    }

    // 2. High-sec anti-gank cargo value cap (Single check, redundancy removed)
    if (strategy === 'regional_hauling' && proposedCost > limits.maxHaulingCargoIsk) {
      return {
        allowed: false,
        reason: `触发高安防自杀强杀风控限制：T1 工业舰单趟货值不得超过 ${Math.round(limits.maxHaulingCargoIsk).toLocaleString()} ISK（当前提议 ${Math.round(proposedCost).toLocaleString()} ISK），请分批或换用高速护卫舰。`,
      };
    }

    // 3. Strategy-specific limit checks
    if (strategy === 'trend_following') {
      const trendCap = breakdown.investableCapital * limits.trendInvestMaxPct;
      if (proposedCost > trendCap) {
        return {
          allowed: false,
          reason: `触发趋势投机敞口限制（10%）：该笔投入 ${Math.round(proposedCost).toLocaleString()} ISK，趋势策略上限为 ${Math.round(trendCap).toLocaleString()} ISK。`,
        };
      }
    }

    // 4. Cumulative Single Item Exposure check (15%)
    let existingItemHoldingIsk = 0;
    if (context?.db && context?.typeId) {
      const ownership = context.assetLineage
        ? assetLineagePredicate(null, context.assetLineage)
        : null;
      const ownershipSql = ownership ? ` AND ${ownership.sql}` : '';
      // Existing inventory value
      const inventoryRow = context.db.prepare(`
        SELECT COALESCE(SUM(quantity), 0) as total_qty
        FROM character_assets
        WHERE character_id = ? AND type_id = ? AND is_blueprint_copy != 1${ownershipSql}
      `).get(breakdown.characterId, context.typeId, ...(ownership?.params ?? [])) as any;
      const existingQty = Number(inventoryRow?.total_qty || 0);

      // In-flight draft capital for same item
      const draftRow = context.db.prepare(`
        SELECT COALESCE(SUM(capital_required), 0) as committed_isk
        FROM trade_drafts
        WHERE character_id = ? AND type_id = ? AND status = 'approved' AND executed_at IS NULL
      `).get(breakdown.characterId, context.typeId) as any;
      const inFlightItemIsk = Number(draftRow?.committed_isk || 0);

      // Approximate unit price from proposed cost
      const estimatedUnitPrice = proposedCost / Math.max(1, volumeM3);
      existingItemHoldingIsk = existingQty * estimatedUnitPrice + inFlightItemIsk;
    }

    const totalItemExposure = existingItemHoldingIsk + proposedCost;
    if (totalItemExposure > breakdown.singleItemCapIsk) {
      return {
        allowed: false,
        reason: `超出单一物品持仓风控线（15%）：现有及在途持仓 ${Math.round(existingItemHoldingIsk).toLocaleString()} ISK，加上本次提议 ${Math.round(proposedCost).toLocaleString()} ISK，累计敞口 ${Math.round(totalItemExposure).toLocaleString()} ISK 超过单品上限 ${Math.round(breakdown.singleItemCapIsk).toLocaleString()} ISK。`,
      };
    }

    // 5. Cumulative Category Exposure check (30%)
    if (context?.db && context?.categoryId) {
      const ownership = context.assetLineage
        ? assetLineagePredicate('a', context.assetLineage)
        : null;
      const ownershipSql = ownership ? ` AND ${ownership.sql}` : '';
      const categoryRow = context.db.prepare(`
        SELECT COALESCE(SUM(a.quantity * COALESCE(json_extract(t.data_json, '$.basePrice'), 1000)), 0) as cat_val
        FROM character_assets a
        JOIN sde_types t ON a.type_id = t.type_id
        JOIN sde_groups g ON t.group_id = g.group_id
        WHERE a.character_id = ? AND g.category_id = ? AND a.is_blueprint_copy != 1${ownershipSql}
      `).get(breakdown.characterId, context.categoryId, ...(ownership?.params ?? [])) as any;
      const existingCategoryVal = Number(categoryRow?.cat_val || 0);

      if (existingCategoryVal + proposedCost > breakdown.categoryCapIsk) {
        return {
          allowed: false,
          reason: `超出工业品类持仓风控线（30%）：当前品类已有敞口 ${Math.round(existingCategoryVal).toLocaleString()} ISK，本次新增 ${Math.round(proposedCost).toLocaleString()} ISK，总额 ${Math.round(existingCategoryVal + proposedCost).toLocaleString()} ISK 超过品类上限 ${Math.round(breakdown.categoryCapIsk).toLocaleString()} ISK。`,
        };
      }
    }

    return { allowed: true };
  }
}
