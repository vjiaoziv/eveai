export type CloneState = 'alpha' | 'omega';

export interface PilotTradingSkills {
  accounting: number;         // Level 0-5 (Alpha max 3)
  brokerRelations: number;    // Level 0-5 (Alpha max 3)
  advancedBrokerRelations: number; // Level 0-5 (Alpha 0)
  factionStanding?: number;   // -10.0 to 10.0
  corpStanding?: number;      // -10.0 to 10.0
}

export interface FeeRates {
  salesTaxRate: number;       // e.g. 0.0536 (5.36%)
  brokerFeeRate: number;      // e.g. 0.0210 (2.10%)
  relistFeeRate: number;      // fee applied on order modification
}

export type FacilityType = 'npc_station' | 'upwell_structure';

export interface FeeContext {
  clone: CloneState;
  skills: PilotTradingSkills;
  facility: FacilityType;
  customStructureBrokerFee?: number; // In Upwell structures, owner-defined fee rate (0.005 ~ 0.03)
}

export interface OrderBookLevel {
  price: number;
  volumeRemain: number;
  orderId?: number;
  locationId?: number;
}

export interface FillSimulationResult {
  requestedQty: number;
  filledQty: number;
  unfilledQty: number;
  isComplete: boolean;
  totalGrossIsk: number;
  weightedAvgPrice: number;
  topOfBookPrice: number;
  slippagePct: number;
  levelsConsumed: number;
  effectiveOrders: Array<{ price: number; volume: number }>;
}

export interface TradeCalculation {
  buyType: 'immediate_buy' | 'place_buy_order';
  sellType: 'immediate_sell' | 'place_sell_order';
  quantity: number;
  grossCost: number;
  grossRevenue: number;
  buyerBrokerFee: number;
  sellerBrokerFee: number;
  salesTax: number;
  haulingCost: number;
  totalFees: number;
  netCost: number;
  netRevenue: number;
  netProfit: number;
  netMarginPct: number;
  roiPct: number;
  breakEvenSellPrice: number;
  isVolumeCapped: boolean;
  unfilledQuantity: number;
}

export type StrategyType = 
  | 'station_arbitrage'
  | 'regional_hauling'
  | 'market_making'
  | 'trend_following'
  | 'event_driven'
  | 'manufacturing_arbitrage';

export interface TradeOpportunity {
  typeId: number;
  typeName: string;
  zhName?: string;
  groupName?: string;
  volumeM3: number;
  strategy: StrategyType;
  buyStationId: number;
  buyStationName: string;
  sellStationId: number;
  sellStationName: string;
  suggestedBuyPrice: number;
  suggestedSellPrice: number;
  suggestedQuantity: number;
  capitalRequired: number;
  estimatedFees: number;
  haulingCost: number;
  expectedNetProfit: number;
  expectedRoiPct: number;
  dailyVolumeDest: number;
  turnoverDays: number;
  liquidityRating: 'A' | 'B' | 'C';
  riskScore: number;
  rationale: string;
}

export interface TradeDraft {
  draftId: string; // e.g. TR-2026-000001
  characterId: number;
  typeId: number;
  typeName: string;
  zhName?: string;
  strategy: StrategyType;
  buyStationId: number;
  sellStationId: number;
  suggestedBuy: number;
  suggestedQty: number;
  suggestedSell: number;
  estimatedFees: number;
  haulingCost: number;
  expectedProfit: number;
  expectedRoi: number;
  capitalRequired: number;
  turnoverHours: number;
  status: 'draft' | 'approved' | 'rejected' | 'executed_manually' | 'expired' | 'closed';
  createdAt: string;
  expiresAt: string;
  executedAt?: string;
  actualBuyPrice?: number;
  actualSellPrice?: number;
  actualProfit?: number;
}