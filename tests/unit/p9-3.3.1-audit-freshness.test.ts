import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import type { Db } from '../../src/db/sqlite.js';
import { P93FifoService } from '../../src/trading/p9-3-fifo-service.js';
import { P93LedgerService } from '../../src/trading/p9-3-ledger-service.js';
import type { P93RecordInput } from '../../src/trading/p9-3-types.js';

const CHARACTER = 9331001;
let db: Database.Database;
let evidenceSequence = 9100;

function input(overrides: Partial<P93RecordInput> & { ledgerKey: string }): P93RecordInput {
  const direction = overrides.direction ?? 'BUY';
  return {
    tradeKind: overrides.tradeKind ?? (direction === 'BUY' ? 'BUY' : 'SELL'),
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

function verifyRecord(recordId: string): void {
  const record = P93LedgerService.get(db, CHARACTER, recordId);
  if (!record) throw new Error('record missing');
  if (record.recordState === 'DRAFT') P93LedgerService.submitDraft(db, CHARACTER, recordId, 'user:audit');
  const transactionId = evidenceSequence++;
  const evidence = P93LedgerService.addEvidence(db, CHARACTER, {
    evidenceType: 'ESI_WALLET_LOG',
    sourceSystem: 'ESI_WALLET_TRANSACTIONS',
    sourceRef: `esi-wallet:${transactionId}`,
    capturedAt: record.tradeTime,
    payloadHash: `audit-payload-${transactionId}`,
    summary: `audit evidence ${transactionId}`,
    initialStatus: 'PENDING',
    metadata: {
      transactionId,
      typeId: record.typeId,
      quantity: record.quantity,
      unitPrice: record.unitPrice,
      isBuy: record.direction === 'BUY',
      locationId: record.locationId,
      tradeTime: record.tradeTime,
    },
  }, 'ESI_SYNC');
  P93LedgerService.linkEvidence(
    db, CHARACTER, recordId, evidence.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:audit',
  );
  P93LedgerService.setEvidenceStatus(db, CHARACTER, evidence.evidenceId, 'VERIFIED', 'user:audit');
  P93LedgerService.verify(db, CHARACTER, recordId, 'user:audit');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-02T00:00:00.000Z'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('P9.3.3.1 independent FIFO freshness audit', () => {
  it('marks prior FIFO output STALE after verification, reversal, and correction workflows', () => {
    const buy = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'audit-freshness-buy', quantity: 10, unitPrice: 10,
    }), 'user:audit');
    verifyRecord(buy.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    expect(P93FifoService.performance(db, CHARACTER).freshness.status).toBe('CURRENT');

    vi.setSystemTime(new Date('2026-04-02T00:01:00.000Z'));
    const sell = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'audit-freshness-sell', direction: 'SELL', quantity: 3, unitPrice: 20,
      tradeTime: '2026-01-02T00:00:00.000Z',
    }), 'user:audit');
    verifyRecord(sell.recordId);
    expect(P93FifoService.performance(db, CHARACTER).freshness.status).toBe('STALE');

    P93FifoService.recalculate(db, CHARACTER);
    expect(P93FifoService.performance(db, CHARACTER).freshness.status).toBe('CURRENT');

    vi.setSystemTime(new Date('2026-04-02T00:02:00.000Z'));
    P93LedgerService.reverse(db, CHARACTER, sell.recordId, 'user:audit', 'audit reversal');
    expect(P93FifoService.performance(db, CHARACTER).freshness.status).toBe('STALE');

    P93FifoService.recalculate(db, CHARACTER);
    expect(P93FifoService.performance(db, CHARACTER).freshness.status).toBe('CURRENT');

    vi.setSystemTime(new Date('2026-04-02T00:03:00.000Z'));
    P93LedgerService.correction(db, CHARACTER, buy.recordId, input({
      ledgerKey: 'audit-freshness-buy-corrected', quantity: 10, unitPrice: 11,
    }), 'user:audit', 'audit correction');
    const afterCorrection = P93FifoService.performance(db, CHARACTER);
    expect(afterCorrection.freshness.status).toBe('STALE');
    expect(afterCorrection.freshness.message).toContain('晚于最近一次成功计算');
  });
});
