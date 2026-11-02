import type { CloneState, FeeContext, FeeRates, PilotTradingSkills } from './types.js';

export const BASE_SALES_TAX_RATE = 0.08;      // 8.0% baseline
export const ACCOUNTING_REDUCTION_PER_LEVEL = 0.11; // 11% reduction per level
export const NPC_BASE_BROKER_FEE_RATE = 0.03; // 3.0% baseline NPC fee
export const BROKER_RELATIONS_REDUCTION = 0.003; // 0.3% reduction per level
export const FACTION_STANDING_REDUCTION = 0.0003; // 0.03% reduction per standing point
export const CORP_STANDING_REDUCTION = 0.0002;    // 0.02% reduction per standing point
export const NPC_BROKER_FEE_FLOOR = 0.01;     // 1.0% minimum floor in NPC stations
export const STRUCTURE_BROKER_FEE_FLOOR = 0.005; // 0.5% minimum floor in Upwell structures

export const ALPHA_DEFAULT_SKILLS: PilotTradingSkills = {
  accounting: 3,         // Alpha cap is level 3
  brokerRelations: 3,    // Alpha cap is level 3
  advancedBrokerRelations: 0, // Alpha cannot train
  factionStanding: 0,
  corpStanding: 0,
};

export const OMEGA_DEFAULT_SKILLS: PilotTradingSkills = {
  accounting: 5,
  brokerRelations: 5,
  advancedBrokerRelations: 4,
  factionStanding: 0,
  corpStanding: 0,
};

export class FeeEngine {
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
    // Formula: 8.0% * (1 - 0.11 * level)
    const salesTaxRate = Math.max(0, BASE_SALES_TAX_RATE * (1 - ACCOUNTING_REDUCTION_PER_LEVEL * accountingLevel));

    // 2. Broker Fee
    let brokerFeeRate: number;
    if (ctx.facility === 'upwell_structure') {
      const customRate = ctx.customStructureBrokerFee !== undefined ? ctx.customStructureBrokerFee : 0.01;
      brokerFeeRate = Math.max(STRUCTURE_BROKER_FEE_FLOOR, customRate);
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
    // Relist fee applies when modifying an order; base is brokerFeeRate, reduced by Advanced Broker Relations (Omega only)
    const advLevel = ctx.clone === 'alpha' ? 0 : Math.max(0, Math.min(5, skills.advancedBrokerRelations || 0));
    const relistFeeRate = brokerFeeRate * Math.max(0.5, 1 - 0.1 * advLevel);

    return {
      salesTaxRate: Math.round(salesTaxRate * 10_000) / 10_000,
      brokerFeeRate: Math.round(brokerFeeRate * 10_000) / 10_000,
      relistFeeRate: Math.round(relistFeeRate * 10_000) / 10_000,
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
    // If placing buy order, buyer pays broker fee upfront.
    // If immediate buy (eating a sell order), buyer pays 0 fee.
    const buyerBrokerFee = buyType === 'place_buy_order' ? grossCost * buyRates.brokerFeeRate : 0;
    const netCost = grossCost + buyerBrokerFee + haulingCost;

    // Seller fees:
    // If placing sell order, seller pays broker fee upfront + sales tax when sold.
    // If immediate sell (eating a buy order), seller pays 0 broker fee, but pays sales tax.
    const sellerBrokerFee = sellType === 'place_sell_order' ? grossRevenue * sellRates.brokerFeeRate : 0;
    const salesTax = grossRevenue * sellRates.salesTaxRate;
    const netRevenue = grossRevenue - sellerBrokerFee - salesTax;

    const totalFees = buyerBrokerFee + sellerBrokerFee + salesTax + haulingCost;
    const netProfit = netRevenue - netCost;
    const netMarginPct = netCost > 0 ? (netProfit / netCost) * 100 : 0;
    const roiPct = netCost > 0 ? (netProfit / netCost) * 100 : 0;

    // Break-even sell price calculation:
    // netRevenue = sellPrice * quantity * (1 - sellerBrokerFeeRate - salesTaxRate) >= netCost
    const effectiveSellMultiplier = 1 - (sellType === 'place_sell_order' ? sellRates.brokerFeeRate : 0) - sellRates.salesTaxRate;
    const breakEvenSellPrice = effectiveSellMultiplier > 0 && quantity > 0
      ? (netCost / quantity) / effectiveSellMultiplier
      : 0;

    return {
      buyType,
      sellType,
      quantity,
      grossCost,
      grossRevenue,
      buyerBrokerFee: Math.round(buyerBrokerFee * 100) / 100,
      sellerBrokerFee: Math.round(sellerBrokerFee * 100) / 100,
      salesTax: Math.round(salesTax * 100) / 100,
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