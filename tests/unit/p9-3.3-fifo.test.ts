import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import type { Db } from '../../src/db/sqlite.js';
import { P93FifoService } from '../../src/trading/p9-3-fifo-service.js';
import { P93LedgerService } from '../../src/trading/p9-3-ledger-service.js';
import type { P93EvidenceInput, P93RecordInput } from '../../src/trading/p9-3-types.js';

const CHARACTER = 930033;
let db: Database.Database;
let evidenceSequence = 5000;

function input(overrides: Partial<P93RecordInput> & { ledgerKey: string }): P93RecordInput {
  const direction = overrides.direction ?? 'BUY';
  return {
    tradeKind: overrides.tradeKind ?? (direction === 'BUY' ? 'BUY' : direction === 'SELL' ? 'SELL' : 'INVENTORY_TRANSFER'),
    direction,
    typeId: 34,
    locationId: 60003760,
    quantity: 1,
    unitPrice: 10,
    tradeTime: '2026-01-01T00:00:00.000Z',
    sourceType: 'USER_MANUAL_ENTRY',
    feeStatus: 'COMPLETE',
    ...overrides,
  };
}

function addEvidenceFor(recordId: string, overrides: Partial<P93EvidenceInput> = {}) {
  const record = P93LedgerService.get(db, CHARACTER, recordId);
  if (!record) throw new Error('test record missing before evidence');
  const metadataTransactionId = Number(overrides.metadata?.transactionId ?? NaN);
  const transactionId = Number.isSafeInteger(metadataTransactionId) && metadataTransactionId > 0
    ? metadataTransactionId
    : evidenceSequence++;
  return P93LedgerService.addEvidence(db, CHARACTER, {
    evidenceType: 'ESI_WALLET_LOG',
    sourceSystem: 'ESI_WALLET_TRANSACTIONS',
    sourceRef: `esi-wallet:${transactionId}`,
    capturedAt: record.tradeTime,
    payloadHash: `payload-${transactionId}-${Math.random()}`,
    summary: 'isolated FIFO test evidence',
    initialStatus: 'PENDING',
    ...overrides,
    metadata: {
      transactionId,
      typeId: record.typeId,
      quantity: record.quantity,
      unitPrice: record.unitPrice,
      isBuy: record.direction === 'BUY',
      locationId: record.locationId,
      tradeTime: record.tradeTime,
      ...overrides.metadata,
    },
  }, 'ESI_SYNC');
}

function verifyRecord(recordId: string): void {
  const record = P93LedgerService.get(db, CHARACTER, recordId);
  if (!record) throw new Error('test record missing');
  if (record.recordState === 'DRAFT') P93LedgerService.submitDraft(db, CHARACTER, recordId, 'user:test');
  const item = addEvidenceFor(recordId);
  P93LedgerService.linkEvidence(db, CHARACTER, recordId, item.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test');
  P93LedgerService.setEvidenceStatus(db, CHARACTER, item.evidenceId, 'VERIFIED', 'user:test');
  P93LedgerService.verify(db, CHARACTER, recordId, 'user:test');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('P9.3.3 FIFO P&L and freshness semantics', () => {
  it('keeps realized P&L and win rate calculable when only open inventory cost is unknown', () => {
    const buyA = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'known-a-buy', typeId: 34, quantity: 10, unitPrice: 10,
    }), 'user:test');
    const sellA = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'known-a-sell', typeId: 34, direction: 'SELL', quantity: 5, unitPrice: 20,
      tradeTime: '2026-01-02T00:00:00.000Z',
    }), 'user:test');
    const buyB = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'unknown-b-open', typeId: 35, quantity: 3, unitPrice: 30, feeStatus: 'UNKNOWN',
      tradeTime: '2026-01-03T00:00:00.000Z',
    }), 'user:test');
    verifyRecord(buyA.recordId);
    verifyRecord(sellA.recordId);
    verifyRecord(buyB.recordId);
    P93FifoService.recalculate(db, CHARACTER);

    const performance = P93FifoService.performance(db, CHARACTER);
    expect(performance.realizedPnl).toBe(50);
    expect(performance.knownRealizedPnl).toBe(50);
    expect(performance.profitableTradeRatio).toBe(1);
    expect(performance.deterministicSellCount).toBe(1);
    expect(performance.unknownCostSellCount).toBe(0);
    expect(performance.unknownConsumptionCount).toBe(0);
    expect(performance.unknownOpenLotCount).toBe(1);
    expect(performance.inventoryCost).toBeNull();
    expect(performance.capitalOccupied).toBeNull();
  });

  it('makes full realized P&L unknown for an unknown-cost sale while preserving known partial P&L and sell counts', () => {
    const buyKnown = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'partial-known-buy', typeId: 34, quantity: 10, unitPrice: 10,
    }), 'user:test');
    const sellKnown = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'partial-known-sell', typeId: 34, direction: 'SELL', quantity: 5, unitPrice: 20,
      tradeTime: '2026-01-02T00:00:00.000Z',
    }), 'user:test');
    const buyUnknown = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'partial-unknown-buy', typeId: 35, quantity: 10, unitPrice: 10, feeStatus: 'UNKNOWN',
      tradeTime: '2026-01-03T00:00:00.000Z',
    }), 'user:test');
    const sellUnknown = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'partial-unknown-sell', typeId: 35, direction: 'SELL', quantity: 5, unitPrice: 20,
      tradeTime: '2026-01-04T00:00:00.000Z',
    }), 'user:test');
    verifyRecord(buyKnown.recordId);
    verifyRecord(sellKnown.recordId);
    verifyRecord(buyUnknown.recordId);
    verifyRecord(sellUnknown.recordId);
    P93FifoService.recalculate(db, CHARACTER);

    const performance = P93FifoService.performance(db, CHARACTER);
    expect(performance.realizedPnl).toBeNull();
    expect(performance.knownRealizedPnl).toBe(50);
    expect(performance.unknownCostSellCount).toBe(1);
    expect(performance.deterministicSellCount).toBe(1);
    expect(performance.profitableTradeRatio).toBe(1);
    expect(performance.unknownConsumptionCount).toBe(1);
  });

  it('excludes a sell spanning a known and unknown FIFO lot from deterministic win rate', () => {
    const buyKnown = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'mixed-known-buy', typeId: 34, quantity: 1, unitPrice: 10,
    }), 'user:test');
    const buyUnknown = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'mixed-unknown-buy', typeId: 34, quantity: 1, unitPrice: 20, feeStatus: 'UNKNOWN',
      tradeTime: '2026-01-02T00:00:00.000Z',
    }), 'user:test');
    const sell = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'mixed-sell', typeId: 34, direction: 'SELL', quantity: 2, unitPrice: 30,
      tradeTime: '2026-01-03T00:00:00.000Z',
    }), 'user:test');
    verifyRecord(buyKnown.recordId);
    verifyRecord(buyUnknown.recordId);
    verifyRecord(sell.recordId);
    P93FifoService.recalculate(db, CHARACTER);

    const performance = P93FifoService.performance(db, CHARACTER);
    expect(performance.realizedPnl).toBeNull();
    expect(performance.knownRealizedPnl).toBe(20);
    expect(performance.profitableTradeRatio).toBeNull();
    expect(performance.deterministicSellCount).toBe(0);
    expect(performance.unknownCostSellCount).toBe(1);
    expect(performance.singleTradePnl).toEqual([{ recordId: sell.recordId, pnl: null }]);
  });

  it('keeps FIFO result hashes stable across repeated recalculation of mixed known/unknown lots', () => {
    const buyKnown = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'stable-known-buy', typeId: 34, quantity: 2, unitPrice: 10,
    }), 'user:test');
    const buyUnknown = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'stable-unknown-buy', typeId: 34, quantity: 2, unitPrice: 20, feeStatus: 'UNKNOWN',
      tradeTime: '2026-01-02T00:00:00.000Z',
    }), 'user:test');
    const sell = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'stable-mixed-sell', typeId: 34, direction: 'SELL', quantity: 3, unitPrice: 30,
      tradeTime: '2026-01-03T00:00:00.000Z',
    }), 'user:test');
    verifyRecord(buyKnown.recordId);
    verifyRecord(buyUnknown.recordId);
    verifyRecord(sell.recordId);

    const first = P93FifoService.recalculate(db, CHARACTER) as any;
    const second = P93FifoService.recalculate(db, CHARACTER) as any;
    expect(first.after_hash).toBe(second.after_hash);
    expect(second.realized_pnl).toBe(40);
    expect(second.unknown_cost_count).toBe(1);
  });

  it('marks cached FIFO results STALE after an evidence status change and CURRENT only after explicit recalculation', () => {
    const buy = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'freshness-buy', quantity: 2, unitPrice: 10,
    }), 'user:test');
    const pending = addEvidenceFor(buy.recordId);
    P93LedgerService.linkEvidence(db, CHARACTER, buy.recordId, pending.evidenceId, 'CORROBORATING', 'MEDIUM');
    verifyRecord(buy.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    expect(P93FifoService.performance(db, CHARACTER).freshness.status).toBe('CURRENT');

    vi.setSystemTime(new Date('2026-04-01T00:01:00.000Z'));
    P93LedgerService.setEvidenceStatus(db, CHARACTER, pending.evidenceId, 'VERIFIED', 'user:test');
    const stale = P93FifoService.performance(db, CHARACTER);
    expect(stale.freshness.status).toBe('STALE');
    expect(stale.freshness.message).toContain('晚于最近一次成功计算');
    expect(stale.realizedPnl).toBe(0);

    vi.setSystemTime(new Date('2026-04-01T00:02:00.000Z'));
    P93FifoService.recalculate(db, CHARACTER);
    expect(P93FifoService.performance(db, CHARACTER).freshness.status).toBe('CURRENT');
  });

  it('marks the previous result STALE when the latest recalculation attempt failed', () => {
    const buy = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'failed-run-buy', quantity: 1, unitPrice: 10,
    }), 'user:test');
    verifyRecord(buy.recordId);
    P93FifoService.recalculate(db, CHARACTER);

    vi.setSystemTime(new Date('2026-04-01T00:03:00.000Z'));
    db.prepare(`
      INSERT INTO real_calculation_runs
        (run_id, character_id, calculation_version, status, started_at, completed_at, error)
      VALUES ('CALC-FAILED-TEST', ?, 'P9.3-FIFO-v1', 'FAILED', ?, ?, 'isolated failure')
    `).run(CHARACTER, '2026-04-01T00:03:00.000Z', '2026-04-01T00:03:00.500Z');

    const performance = P93FifoService.performance(db, CHARACTER);
    expect(performance.freshness.status).toBe('STALE');
    expect(performance.freshness.latestFailedCalculationAt).toBe('2026-04-01T00:03:00.500Z');
    expect(performance.freshness.message).toContain('重算失败');
  });
});
