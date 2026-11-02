import type { Db } from '../db/sqlite.js';
import type { CloneState, FeeContext, FeeRates, PilotTradingSkills } from './types.js';

export const BASE_SALES_TAX_RATE = 0.075;      // 7.5% CCP Current Baseline (reduced from 8.0%)
export const ACCOUNTING_REDUCTION_PER_LEVEL = 0.11; // 11% reduction per level
export const NPC_BASE_BROKER_FEE_RATE = 0.03; // 3.0% baseline NPC fee
export const BROKER_RELATIONS_REDUCTION = 0.003; // 0.3% reduction per level
export const FACTION_STANDING_REDUCTION = 0.0003; // 0.03% reduction per standing point
export const CORP_STANDING_REDUCTION = 0.0002;    // 0.02% reduction per standing point
export const NPC_BROKER_FEE_FLOOR = 0.01;     // 1.0% minimum floor in NPC stations
export const STRUCTURE_BROKER_FEE_FLOOR = 0.005; // 0.5% minimum floor in Upwell structures
export const STATUTORY_SCC_SURCHARGE_RATE = 0.005; // 0.5% mandatory SCC surcharge in Upwell structures
export const MINIMUM_BROKER_FEE_ISK = 100.0;  // EVE minimum 100 ISK broker fee per order

export const ALPHA_DEFAULT_SKILLS: PilotTradingSkills = {
  accounting: 3,         // Alpha cap is level 3 (Tax = 5.025%)
  brokerRelations: 3,    // Alpha cap is level 3 (Fee = 2.10%)
  advancedBrokerRelations: 0, // Alpha cannot train
  factionStanding: 0,
  corpStanding: 0,
};

export const OMEGA_DEFAULT_SKILLS: PilotTradingSkills = {
  accounting: 5,         // Omega max (Tax = 3.375%)
  brokerRelations: 5,    // Omega max (Fee = 1.50%)
  advancedBrokerRelations: 4,
  factionStanding: 0,
  corpStanding: 0,
};

export class FeeEngine {
  /**
   * Dynamically fetch pilot trading skills and standings from database
   */
  public static getSkillsForCharacter(db: Db, characterId: number): PilotTradingSkills {
    const skillRows = db.prepare(`
      SELECT skill_id, active_skill_level
      FROM character_skills
      WHERE character_id = ? AND skill_id IN (16622, 3446, 25739)
    `).all(characterId) as Array<{ skill_id: number; active_skill_level: number }>;

    let accounting = 0;
    let brokerRelations = 0;
    let advancedBrokerRelations = 0;

    for (const r of skillRows) {
      if (r.skill_id === 16622) accounting = r.active_skill_level;
      else if (r.skill_id === 3446) brokerRelations = r.active_skill_level;
      else if (r.skill_id === 25739) advancedBrokerRelations = r.active_skill_level;
    }

    return {
      accounting,
      brokerRelations,
      advancedBrokerRelations,
      factionStanding: 0,
      corpStanding: 0,
    };
  }

  /**
   * Calculate effective tax and fee rates based on pilot skills and facility.
   */
  public static calculateRates(ctx: FeeContext): FeeRates {
    const skills = ctx.skills;
    const accountingLevel = Math.max(0, Math.min(5, skills.accounting));
    const brokerRelationsLevel = Math.max(0, Math.min(5, skills.brokerRelations));
    const factionStanding = Math.max(-10, Math.min(10, skills.factionStanding || 0));
    const corpStanding = Math.max(-10, Math.min(10, skills.corpStanding || 0));

    // 1. Sales Tax
    // Formula: 7.5% * (1 - 0.11 * level)
    // Level 0: 7.5%, Level 3: 5.025%, Level 5: 3.375%
    const salesTaxRate = Math.max(0, BASE_SALES_TAX_RATE * (1 - ACCOUNTING_REDUCTION_PER_LEVEL * accountingLevel));

    // 2. Broker Fee
    let brokerFeeRate: number;
    let sccSurchargeRate = 0;
    if (ctx.facility === 'upwell_structure') {
      const customRate = ctx.customStructureBrokerFee !== undefined ? ctx.customStructureBrokerFee : 0.01;
      brokerFeeRate = Math.max(STRUCTURE_BROKER_FEE_FLOOR, customRate);
      sccSurchargeRate = STATUTORY_SCC_SURCHARGE_RATE;
    } else {
      // NPC Station
      // Formula: 3.0% - 0.3% * skill - 0.03% * faction - 0.02% * corp
      const rawRate = NPC_BASE_BROKER_FEE_RATE
        - BROKER_RELATIONS_REDUCTION * brokerRelationsLevel
        - FACTION_STANDING_REDUCTION * factionStanding
        - CORP_STANDING_REDUCTION * corpStanding;
      brokerFeeRate = Math.max(NPC_BROKER_FEE_FLOOR, rawRate);
    }

    // 3. Relist Fee
    const advLevel = ctx.clone === 'alpha' ? 0 : Math.max(0, Math.min(5, skills.advancedBrokerRelations || 0));
    const relistFeeRate = brokerFeeRate * Math.max(0.5, 1 - 0.1 * advLevel);

    return {
      salesTaxRate: Math.round(salesTaxRate * 100_000) / 100_000,
      brokerFeeRate: Math.round(brokerFeeRate * 100_000) / 100_000,
      relistFeeRate: Math.round(relistFeeRate * 100_000) / 100_000,
      sccSurchargeRate,
    };
  }

  /**
   * Calculate all fees and net totals for a planned transaction.
   */
  public static calculateTrade(params: {
    buyType: 'immediate_buy' | 'place_buy_order';
    sellType: 'immediate_sell' | 'place_sell_order';
    buyUnitPrice: number;
    sellUnitPrice: number;
    quantity: number;
    buyCtx: FeeContext;
    sellCtx: FeeContext;
    haulingCost?: number;
  }) {
    const { buyType, sellType, buyUnitPrice, sellUnitPrice, quantity, buyCtx, sellCtx, haulingCost = 0 } = params;

    const buyRates = this.calculateRates(buyCtx);
    const sellRates = this.calculateRates(sellCtx);

    const grossCost = buyUnitPrice * quantity;
    const grossRevenue = sellUnitPrice * quantity;

    // Buyer fees:
    // If placing buy order, buyer pays broker fee upfront (min 100 ISK floor).
    // If immediate buy (eating a sell order), buyer pays 0 fee.
    let buyerBrokerFee = 0;
    if (buyType === 'place_buy_order' && grossCost > 0) {
      buyerBrokerFee = Math.max(MINIMUM_BROKER_FEE_ISK, grossCost * buyRates.brokerFeeRate);
    }
    const netCost = grossCost + buyerBrokerFee + haulingCost;

    // Seller fees:
    // If placing sell order, seller pays broker fee upfront (min 100 ISK floor) + sales tax + SCC surcharge (Upwell).
    // If immediate sell (eating a buy order), seller pays 0 broker fee, but pays sales tax.
    let sellerBrokerFee = 0;
    if (sellType === 'place_sell_order' && grossRevenue > 0) {
      sellerBrokerFee = Math.max(MINIMUM_BROKER_FEE_ISK, grossRevenue * sellRates.brokerFeeRate);
    }
    const salesTax = grossRevenue * sellRates.salesTaxRate;
    const sccSurcharge = sellType === 'place_sell_order' && sellRates.sccSurchargeRate
      ? grossRevenue * sellRates.sccSurchargeRate
      : 0;

    const netRevenue = grossRevenue - sellerBrokerFee - salesTax - sccSurcharge;

    const totalFees = buyerBrokerFee + sellerBrokerFee + salesTax + sccSurcharge + haulingCost;
    const netProfit = netRevenue - netCost;
    const netMarginPct = netCost > 0 ? (netProfit / netCost) * 100 : 0;
    const roiPct = netCost > 0 ? (netProfit / netCost) * 100 : 0;

    // Break-even sell price calculation
    const effectiveSellMultiplier = 1
      - (sellType === 'place_sell_order' ? sellRates.brokerFeeRate + (sellRates.sccSurchargeRate || 0) : 0)
      - sellRates.salesTaxRate;
    const breakEvenSellPrice = effectiveSellMultiplier > 0 && quantity > 0
      ? (netCost / quantity) / effectiveSellMultiplier
      : 0;

    return {
      buyType,
      sellType,
      quantity,
      grossCost: Math.round(grossCost * 100) / 100,
      grossRevenue: Math.round(grossRevenue * 100) / 100,
      buyerBrokerFee: Math.round(buyerBrokerFee * 100) / 100,
      sellerBrokerFee: Math.round(sellerBrokerFee * 100) / 100,
      salesTax: Math.round(salesTax * 100) / 100,
      sccSurcharge: Math.round(sccSurcharge * 100) / 100,
      haulingCost,
      totalFees: Math.round(totalFees * 100) / 100,
      netCost: Math.round(netCost * 100) / 100,
      netRevenue: Math.round(netRevenue * 100) / 100,
      netProfit: Math.round(netProfit * 100) / 100,
      netMarginPct: Math.round(netMarginPct * 100) / 100,
      roiPct: Math.round(roiPct * 100) / 100,
      breakEvenSellPrice: Math.round(breakEvenSellPrice * 100) / 100,
    };
  }
}
