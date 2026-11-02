export type CloneState = 'alpha' | 'omega';

export interface PilotTradingSkills {
  accounting: number;         // Level 0-5 (Alpha max 3)
  brokerRelations: number;    // Level 0-5 (Alpha max 3)
  advancedBrokerRelations: number; // Level 0-5 (Alpha 0)
  factionStanding?: number;   // -10.0 to 10.0
  corpStanding?: number;      // -10.0 to 10.0
}

export interface FeeRates {
  salesTaxRate: number;       // e.g. 0.05025 (5.025% for Accounting III)
  brokerFeeRate: number;      // e.g. 0.0210 (2.10% for Broker Relations III in NPC)
  relistFeeRate: number;      // fee applied on order modification
  sccSurchargeRate?: number;  // 0.005 (0.5% statutory SCC fee in Upwell structures)
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
  issued?: string;
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

export interface StressTestScenario {
  scenario: string;
  projectedSellPrice: number;
  projectedGrossRevenue: number;
  netProfit: number;
  roiPct: number;
}

export interface StressTestResults {
  priceDrop5Pct: StressTestScenario;
  priceDrop10Pct: StressTestScenario;
  priceDrop20Pct: StressTestScenario;
  bidEvaporation: StressTestScenario;
}

export interface DataQualityMetrics {
  originSnapshotAgeMinutes: number;
  destSnapshotAgeMinutes: number;
  timestampSkewMinutes: number;
  isStale: boolean;
  hasDepthMismatch: boolean;
}

export type OpportunityRating = 'A' | 'B' | 'C' | 'D';

export interface PipelineVerificationCredential {
  credentialId: string;
  characterId: number;
  opportunityId?: string;
  typeId: number;
  strategy: StrategyType;
  buyStationId: number;
  sellStationId: number;
  suggestedBuyPrice: number;
  suggestedSellPrice: number;
  suggestedQuantity: number;
  capitalRequired: number;
  expectedNetProfit: number;
  opportunityRating: OpportunityRating;
  marketSnapshotHash: string;
  verifiedAt: string;
  expiresAt: string;
  nonce: string;
  keyId: string;
  signature: string;
}

export interface TradeOpportunity {
  typeId: number;
  typeName: string;
  zhName?: string;
  groupName?: string;
  categoryId?: number;
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
  opportunityRating?: OpportunityRating;
  riskVetoReason?: string;
  stressTest?: StressTestResults;
  dataQuality?: DataQualityMetrics;
  pipelineCredential?: PipelineVerificationCredential;
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
  status: 'draft' | 'approved' | 'rejected' | 'executed_manually' | 'expired' | 'closed' | 'audit_revoked';
  revokedReason?: string;
  createdAt: string;
  expiresAt: string;
  executedAt?: string;
  actualBuyPrice?: number;
  actualSellPrice?: number;
  actualProfit?: number;
}


