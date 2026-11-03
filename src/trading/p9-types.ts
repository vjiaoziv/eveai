export type P9OpportunityState =
  | 'NEW'
  | 'WATCHING'
  | 'ACTIONABLE'
  | 'STALE'
  | 'EXPIRED'
  | 'REJECTED'
  | 'ARCHIVED';

export type P9PlanStatus =
  | 'PLANNED'
  | 'USER_CONFIRMED'
  | 'PARTIALLY_EXECUTED'
  | 'EXECUTED'
  | 'HOLDING'
  | 'PARTIALLY_EXITED'
  | 'CLOSED'
  | 'CANCELLED';

export interface P9Hub {
  locationId: number;
  regionId: number;
  name: string;
  enabled?: boolean;
}

export interface P9ScanSettings {
  characterId: number;
  hubs: P9Hub[];
  strategies: Array<'station_arbitrage' | 'regional_hauling'>;
  minNetProfit: number;
  minRoiPct: number;
  maxCapital: number;
  maxMarketAgeMinutes: number;
  maxResults: number;
  autoScanEnabled: boolean;
  autoScanIntervalMinutes: number;
  updatedAt: string;
}

export interface P9MarketObservation {
  bestBid: number | null;
  bestAsk: number | null;
  bidDepth: number;
  askDepth: number;
  bidLevels: Array<{ price: number; volume: number; issued?: string }>;
  askLevels: Array<{ price: number; volume: number; issued?: string }>;
  snapshotAt: string | null;
  snapshotExpiresAt: string | null;
  snapshotAgeMinutes: number | null;
  source: 'esi_market_orders';
  complete: boolean;
}

export interface P9Opportunity {
  opportunityId: string;
  characterId: number;
  scanKey: string;
  strategy: 'station_arbitrage' | 'regional_hauling';
  typeId: number;
  typeNameEn: string;
  typeNameZh?: string;
  buyLocationId: number;
  buyLocationName: string;
  sellLocationId: number;
  sellLocationName: string;
  buyRegionId: number;
  sellRegionId: number;
  buyPrice: number;
  sellPrice: number;
  suggestedQuantity: number;
  executableQuantity: number;
  purchaseAmount: number;
  salesRevenue: number;
  brokerFees: number;
  salesTax: number;
  otherFees: number;
  theoreticalGrossProfit: number;
  executableGrossProfit: number;
  feeNetProfit: number;
  comprehensiveNetProfit: number | null;
  comprehensiveStatus: 'CALCULATED' | 'UNKNOWN';
  capitalRequired: number;
  roiPct: number;
  logisticsCost: number | null;
  liquidity: 'A' | 'B' | 'C' | 'UNKNOWN';
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKED';
  riskFlags: string[];
  buySnapshotId: string;
  sellSnapshotId: string;
  buySnapshotAt: string | null;
  sellSnapshotAt: string | null;
  buySnapshotAgeMinutes: number | null;
  sellSnapshotAgeMinutes: number | null;
  dataSource: string;
  dataComplete: boolean;
  dataFresh: boolean;
  spreadDetected: boolean;
  marketExecutable: boolean;
  profitAfterKnownFees: boolean;
  logisticsKnown: boolean;
  overallProfitKnown: boolean;
  tradePlanComplete: boolean;
  calculationVersion: string;
  originalSnapshot: Record<string, unknown>;
  state: P9OpportunityState;
  detectedAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface P9TradePlan {
  planId: string;
  characterId: number;
  opportunityId: string;
  strategy: string;
  typeId: number;
  buyLocationId: number;
  sellLocationId: number;
  quantity: number;
  buyPrice: number;
  sellPrice: number;
  estimatedBuyCost: number;
  estimatedSellRevenue: number;
  estimatedFees: number;
  estimatedFeeNetProfit: number;
  estimatedComprehensiveProfit: number | null;
  comprehensiveStatus: 'CALCULATED' | 'UNKNOWN';
  capitalRequired: number;
  riskFlags: string[];
  validUntil: string;
  exitPlan?: string;
  notes?: string;
  status: P9PlanStatus;
  createdAt: string;
  updatedAt: string;
}

export interface P9RealTradeInput {
  clientKey: string;
  direction: 'buy' | 'sell';
  typeId: number;
  locationId: number;
  quantity: number;
  price: number;
  fee?: number;
  tradeTime: string;
  opportunityId?: string;
  planId?: string;
  notes?: string;
  confirmed?: boolean;
}

export interface P9RealTrade extends P9RealTradeInput {
  tradeId: string;
  characterId: number;
  externalId?: string;
  source: 'manual' | 'esi';
  realizedPnl: number | null;
  pnlStatus: 'PENDING' | 'CALCULATED' | 'UNKNOWN_COST';
  createdAt: string;
  updatedAt: string;
}

export interface P9InventoryLot {
  lotId: string;
  characterId: number;
  itemId: number | null;
  typeId: number;
  locationId: number;
  quantity: number;
  originalQuantity: number;
  costPerUnit: number | null;
  costStatus: 'CONFIRMED' | 'UNKNOWN';
  source: 'manual' | 'trade';
  acquiredAt: string;
  tradeId?: string;
  opportunityId?: string;
  notes?: string;
}

export const P9_OPPORTUNITY_TRANSITIONS: Record<P9OpportunityState, P9OpportunityState[]> = {
  NEW: ['WATCHING', 'ACTIONABLE', 'STALE', 'EXPIRED', 'REJECTED', 'ARCHIVED'],
  WATCHING: ['ACTIONABLE', 'STALE', 'EXPIRED', 'REJECTED', 'ARCHIVED'],
  ACTIONABLE: ['WATCHING', 'STALE', 'EXPIRED', 'REJECTED', 'ARCHIVED'],
  STALE: ['WATCHING', 'ACTIONABLE', 'EXPIRED', 'ARCHIVED'],
  EXPIRED: ['ARCHIVED', 'WATCHING'],
  REJECTED: ['ARCHIVED', 'WATCHING'],
  ARCHIVED: ['WATCHING'],
};

export const P9_PLAN_TRANSITIONS: Record<P9PlanStatus, P9PlanStatus[]> = {
  PLANNED: ['USER_CONFIRMED', 'CANCELLED'],
  USER_CONFIRMED: ['PARTIALLY_EXECUTED', 'EXECUTED', 'CANCELLED'],
  PARTIALLY_EXECUTED: ['EXECUTED', 'HOLDING', 'CANCELLED'],
  EXECUTED: ['HOLDING', 'PARTIALLY_EXITED', 'CLOSED'],
  HOLDING: ['PARTIALLY_EXITED', 'CLOSED'],
  PARTIALLY_EXITED: ['CLOSED', 'HOLDING'],
  CLOSED: [],
  CANCELLED: [],
};

export function canTransitionP9Opportunity(from: P9OpportunityState, to: P9OpportunityState): boolean {
  return P9_OPPORTUNITY_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionP9Plan(from: P9PlanStatus, to: P9PlanStatus): boolean {
  return P9_PLAN_TRANSITIONS[from]?.includes(to) ?? false;
}