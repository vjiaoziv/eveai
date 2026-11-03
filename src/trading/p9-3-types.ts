import type { Db } from '../db/sqlite.js';

export type P93VerificationStatus = 'VERIFIED' | 'USER_REPORTED' | 'PENDING' | 'CONFLICT' | 'REJECTED';
export type P93RecordState = 'DRAFT' | 'ACTIVE' | 'VERIFIED' | 'REJECTED' | 'REVERSED' | 'CORRECTED';
export type P93TradeKind =
  | 'BUY'
  | 'SELL'
  | 'PARTIAL_FILL'
  | 'MULTI_BATCH_FILL'
  | 'FEE_ADJUSTMENT'
  | 'COST_ADJUSTMENT'
  | 'INVENTORY_TRANSFER'
  | 'REVERSAL';
export type P93Direction = 'BUY' | 'SELL' | 'NONE';
export type P93FeeKind = 'BROKER' | 'TRANSACTION_TAX' | 'OTHER' | 'MANUAL';
export type P93FeeTreatment = 'CAPITALIZED' | 'SELL_EXPENSE' | 'PERIOD_EXPENSE' | 'UNRELATED' | 'UNKNOWN';
export type P93CostStatus = 'KNOWN' | 'PARTIAL' | 'UNKNOWN';
export type P93ReconciliationStatus =
  | 'MATCHED'
  | 'UNMATCHED'
  | 'PARTIAL_MATCH'
  | 'QUANTITY_MISMATCH'
  | 'VALUE_MISMATCH'
  | 'UNKNOWN_SOURCE'
  | 'RECONCILIATION_REQUIRED';

export interface P93FeeInput {
  feeKind: P93FeeKind;
  amount: number;
  treatment: P93FeeTreatment;
  evidenceId?: string;
  notes?: string;
}

export interface P93RecordInput {
  ledgerKey: string;
  tradeKind: P93TradeKind;
  direction: P93Direction;
  typeId: number;
  locationId: number;
  quantity: number;
  unitPrice: number;
  tradeTime: string;
  sourceType: string;
  sourceRef?: string;
  sourceHash?: string;
  orderId?: string;
  fillId?: string;
  executionStatus?: 'FULL_FILL' | 'PARTIAL_FILL' | 'MULTI_BATCH' | 'MANUAL_ENTRY' | 'ADJUSTMENT' | 'TRANSFER';
  opportunityId?: string;
  planId?: string;
  notes?: string;
  draft?: boolean;
  feeStatus?: 'COMPLETE' | 'UNKNOWN';
  fees?: P93FeeInput[];
  adjustmentMode?: 'INCREASE' | 'DECREASE';
  adjustmentAmount?: number;
  targetLotId?: string;
  fromLocationId?: number;
  toLocationId?: number;
}

export interface P93Record extends Omit<P93RecordInput, 'draft' | 'fees'> {
  recordId: string;
  characterId: number;
  recordState: P93RecordState;
  verificationStatus: P93VerificationStatus;
  grossAmount: number;
  feeStatus: 'COMPLETE' | 'UNKNOWN';
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  rejectedReason?: string;
  supersedesRecordId?: string;
  reversesRecordId?: string;
  fees: Array<P93FeeInput & { feeId: string }>;
}

export interface P93EvidenceInput {
  evidenceType: 'ESI_WALLET_LOG' | 'ESI_MARKET_ORDER' | 'ESI_ASSET_SNAPSHOT' | 'ASSET_CHANGE' | 'USER_ATTACHMENT' | 'USER_CONFIRMATION';
  sourceSystem: string;
  sourceRef?: string;
  capturedAt: string;
  payloadHash: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  initialStatus?: P93VerificationStatus;
}

export interface P93Evidence extends P93EvidenceInput {
  evidenceId: string;
  characterId: number;
  status: P93VerificationStatus;
  createdAt: string;
}

export interface P93FifoLot {
  lotId: string;
  characterId: number;
  typeId: number;
  locationId: number;
  sourceRecordId: string;
  originalQuantity: number;
  remainingQuantity: number;
  baseCost: number;
  capitalizedFees: number;
  unitCost: number | null;
  remainingCost: number | null;
  costStatus: P93CostStatus;
  acquiredAt: string;
  calculationVersion: string;
}

export interface P93Performance {
  realizedPnl: number | null;
  knownRealizedPnl: number;
  unrealizedPnl: number | null;
  totalFees: number | null;
  cumulativeBuyAmount: number;
  cumulativeSellAmount: number;
  inventoryCost: number | null;
  capitalOccupied: number | null;
  tradeCount: number;
  profitableTradeRatio: number | null;
  averageHoldingDays: number | null;
  singleTradePnl: Array<{ recordId: string; pnl: number | null }>;
  byType: Array<{ typeId: number; realizedPnl: number | null; tradeCount: number }>;
  byLocation: Array<{ locationId: number; realizedPnl: number | null; tradeCount: number }>;
  byStrategy: Array<{ strategy: string | null; realizedPnl: number | null; tradeCount: number }>;
  unknownCostCount: number;
}

export const P93_CALCULATION_VERSION = 'P9.3-FIFO-v1';

export function assertHumanActor(actor: string): void {
  // REAL accounting mutations are an explicit human responsibility. A deny
  // list is insufficient: labels such as assistant, bot, llm, system or
  // scheduler could otherwise bypass the old regex. Require the actor
  // identity to be `user` or `user:<stable-id>`.
  if (!/^user(?::[^\s]+)?$/.test(actor.trim())) {
    throw new Error('AI/自动代理或未明确的人类用户身份无权修改真实财务账本。');
  }
}

export function normalizeIso(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('时间必须是有效 ISO 时间。');
  return new Date(parsed).toISOString();
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function getLatestCalculationRun(db: Db, characterId: number): any | null {
  return db.prepare(`
    SELECT * FROM real_calculation_runs
    WHERE character_id = ? AND status = 'COMPLETED'
    ORDER BY completed_at DESC, run_id DESC LIMIT 1
  `).get(characterId) ?? null;
}