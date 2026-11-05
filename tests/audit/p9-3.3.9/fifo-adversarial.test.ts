import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import type { Db } from '../../../src/db/sqlite.js';
import { P93FifoService } from '../../../src/trading/p9-3-fifo-service.js';
import { P93LedgerService } from '../../../src/trading/p9-3-ledger-service.js';
import type { P93EvidenceInput, P93RecordInput } from '../../../src/trading/p9-3-types.js';

const CHARACTER = 9_941_001;
let db: Db;
let evidenceSequence = 70_000;

function recordInput(overrides: Partial<P93RecordInput> & { ledgerKey: string }): P93RecordInput {
  const direction = overrides.direction ?? 'BUY';
  return {
    tradeKind: overrides.tradeKind ?? (direction === 'BUY' ? 'BUY' : direction === 'SELL' ? 'SELL' : 'INVENTORY_TRANSFER'),
    direction,
    typeId: 34,
    locationId: 60_003_760,
    quantity: 1,
    unitPrice: 10,
    tradeTime: '2026-01-01T00:00:00.000Z',
    sourceType: 'USER_MANUAL_ENTRY',
    feeStatus: 'COMPLETE',
    ...overrides,
  };
}

function evidenceInput(recordId: string, overrides: Partial<P93EvidenceInput> = {}) {
  const record = P93LedgerService.get(db, CHARACTER, recordId);
  if (!record) throw new Error(`missing record ${recordId}`);
  const transactionId = evidenceSequence++;
  return P93LedgerService.addEvidence(db, CHARACTER, {
    evidenceType: 'ESI_WALLET_LOG',
    sourceSystem: 'ESI_WALLET_TRANSACTIONS',
    sourceRef: `esi-wallet:${transactionId}`,
    capturedAt: record.tradeTime,
    payloadHash: `p9339-payload-${transactionId}`,
    summary: `P9.3.3.9 independent evidence ${transactionId}`,
    initialStatus: 'PENDING',
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
    ...overrides,
  }, 'ESI_SYNC');
}

function verify(recordId: string): void {
  const record = P93LedgerService.get(db, CHARACTER, recordId);
  if (!record) throw new Error(`missing record ${recordId}`);
  if (record.recordState === 'DRAFT') P93LedgerService.submitDraft(db, CHARACTER, recordId, 'user:p9339');
  const evidence = evidenceInput(recordId);
  P93LedgerService.linkEvidence(db, CHARACTER, recordId, evidence.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:p9339');
  P93LedgerService.setEvidenceStatus(db, CHARACTER, evidence.evidenceId, 'VERIFIED', 'user:p9339');
  P93LedgerService.verify(db, CHARACTER, recordId, 'user:p9339');
}

function record(overrides: Partial<P93RecordInput> & { ledgerKey: string }) {
  return P93LedgerService.recordManual(db, CHARACTER, recordInput(overrides), 'user:p9339');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('P9.3.3.9 independent FIFO UNKNOWN-cost semantics', () => {
  it('keeps realized PnL and win rate current when only unsold inventory is unknown-cost', () => {
    const buy = record({ ledgerKey: 'p9339-known-buy-a', typeId: 34, quantity: 10, unitPrice: 10 });
    const sell = record({
      ledgerKey: 'p9339-known-sell-a', typeId: 34, direction: 'SELL', quantity: 5, unitPrice: 20,
      tradeTime: '2026-09-02T00:00:00.000Z',
    });
    const openUnknown = record({
      ledgerKey: 'p9339-open-unknown-b', typeId: 35, quantity: 3, unitPrice: 30, feeStatus: 'UNKNOWN',
      tradeTime: '2026-09-03T00:00:00.000Z',
    });
    verify(buy.recordId);
    verify(sell.recordId);
    verify(openUnknown.recordId);
    P93FifoService.recalculate(db, CHARACTER);

    const performance = P93FifoService.performance(db, CHARACTER);
    expect(performance).toMatchObject({
      realizedPnl: 50,
      knownRealizedPnl: 50,
      profitableTradeRatio: 1,
      deterministicSellCount: 1,
      unknownCostSellCount: 0,
      unknownConsumptionCount: 0,
      unknownOpenLotCount: 1,
      inventoryCost: null,
      capitalOccupied: null,
    });
    expect(P93FifoService.unrealized(db, CHARACTER).unrealizedPnl).toBeNull();
  });

  it('makes full realized PnL N/A when a completed sale has an unknown FIFO cost, while preserving known partial PnL', () => {
    const knownBuy = record({ ledgerKey: 'p9339-known-part-buy', typeId: 34, quantity: 10, unitPrice: 10 });
    const knownSell = record({
      ledgerKey: 'p9339-known-part-sell', typeId: 34, direction: 'SELL', quantity: 5, unitPrice: 20,
      tradeTime: '2026-09-02T00:00:00.000Z',
    });
    const unknownBuy = record({
      ledgerKey: 'p9339-unknown-part-buy', typeId: 35, quantity: 10, unitPrice: 10, feeStatus: 'UNKNOWN',
      tradeTime: '2026-09-03T00:00:00.000Z',
    });
    const unknownSell = record({
      ledgerKey: 'p9339-unknown-part-sell', typeId: 35, direction: 'SELL', quantity: 5, unitPrice: 20,
      tradeTime: '2026-09-04T00:00:00.000Z',
    });
    [knownBuy, knownSell, unknownBuy, unknownSell].forEach((row) => verify(row.recordId));
    P93FifoService.recalculate(db, CHARACTER);

    const performance = P93FifoService.performance(db, CHARACTER);
    expect(performance.realizedPnl).toBeNull();
    expect(performance.knownRealizedPnl).toBe(50);
    expect(performance.deterministicSellCount).toBe(1);
    expect(performance.unknownCostSellCount).toBe(1);
    expect(performance.profitableTradeRatio).toBe(1);
    expect(performance.unknownConsumptionCount).toBe(1);
    expect(performance.singleTradePnl).toEqual(expect.arrayContaining([
      { recordId: knownSell.recordId, pnl: 50 },
      { recordId: unknownSell.recordId, pnl: null },
    ]));
  });

  it('excludes a single sale spanning a known and UNKNOWN FIFO lot from deterministic win rate', () => {
    const known = record({ ledgerKey: 'p9339-mixed-known', typeId: 34, quantity: 1, unitPrice: 10 });
    const unknown = record({
      ledgerKey: 'p9339-mixed-unknown', typeId: 34, quantity: 1, unitPrice: 20,
      feeStatus: 'UNKNOWN', tradeTime: '2026-09-02T00:00:00.000Z',
    });
    const sell = record({
      ledgerKey: 'p9339-mixed-sell', typeId: 34, direction: 'SELL', quantity: 2, unitPrice: 30,
      tradeTime: '2026-09-03T00:00:00.000Z',
    });
    verify(known.recordId);
    verify(unknown.recordId);
    verify(sell.recordId);
    P93FifoService.recalculate(db, CHARACTER);

    const performance = P93FifoService.performance(db, CHARACTER);
    expect(performance.realizedPnl).toBeNull();
    expect(performance.knownRealizedPnl).toBe(20);
    expect(performance.deterministicSellCount).toBe(0);
    expect(performance.unknownCostSellCount).toBe(1);
    expect(performance.profitableTradeRatio).toBeNull();
    expect(performance.singleTradePnl).toEqual([{ recordId: sell.recordId, pnl: null }]);
  });

  it('produces a stable FIFO result hash across repeated recalculation', () => {
    const known = record({ ledgerKey: 'p9339-stable-known', typeId: 34, quantity: 2, unitPrice: 10 });
    const unknown = record({
      ledgerKey: 'p9339-stable-unknown', typeId: 34, quantity: 2, unitPrice: 20,
      feeStatus: 'UNKNOWN', tradeTime: '2026-09-02T00:00:00.000Z',
    });
    const sell = record({
      ledgerKey: 'p9339-stable-sell', typeId: 34, direction: 'SELL', quantity: 3, unitPrice: 30,
      tradeTime: '2026-09-03T00:00:00.000Z',
    });
    verify(known.recordId);
    verify(unknown.recordId);
    verify(sell.recordId);

    const first = P93FifoService.recalculate(db, CHARACTER) as any;
    const second = P93FifoService.recalculate(db, CHARACTER) as any;
    expect(first.after_hash).toBe(second.after_hash);
    expect(second.realized_pnl).toBe(40);
    expect(second.unknown_cost_count).toBe(1);
    expect(second.after_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('marks a verified buy result STALE after reversal and CURRENT only after explicit recalculation', () => {
    const buy = record({ ledgerKey: 'p9339-freshness-buy', quantity: 3, unitPrice: 12 });
    verify(buy.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    expect(P93FifoService.performance(db, CHARACTER).freshness.status).toBe('CURRENT');

    vi.setSystemTime(new Date('2026-09-01T00:01:00.000Z'));
    P93LedgerService.reverse(db, CHARACTER, buy.recordId, 'user:p9339', 'independent freshness reversal');
    expect(P93FifoService.performance(db, CHARACTER).freshness.status).toBe('STALE');

    P93FifoService.recalculate(db, CHARACTER);
    expect(P93FifoService.performance(db, CHARACTER).freshness.status).toBe('CURRENT');
  });

  it('keeps reversal and recalculation deterministic across five independent rounds', () => {
    db.close();

    for (let round = 1; round <= 5; round += 1) {
      db = new Database(':memory:') as unknown as Db;
      db.pragma('foreign_keys = ON');
      runMigrations(db);
      vi.setSystemTime(new Date(`2026-09-0${round}T00:00:00.000Z`));

      const buy = record({ ledgerKey: `p9339-five-round-buy-${round}`, quantity: 3, unitPrice: 12 });
      verify(buy.recordId);
      const first = P93FifoService.recalculate(db, CHARACTER) as any;
      expect(P93FifoService.performance(db, CHARACTER).freshness.status).toBe('CURRENT');

      vi.setSystemTime(new Date(`2026-09-0${round}T00:01:00.000Z`));
      P93LedgerService.reverse(db, CHARACTER, buy.recordId, 'user:p9339', `five-round reversal ${round}`);
      expect(P93FifoService.performance(db, CHARACTER).freshness.status).toBe('STALE');

      const reversed = P93FifoService.recalculate(db, CHARACTER) as any;
      const replayed = P93FifoService.recalculate(db, CHARACTER) as any;
      expect(reversed.after_hash).toBe(replayed.after_hash);
      expect(replayed.after_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(replayed.after_hash).not.toBe(first.after_hash);
      expect(P93FifoService.performance(db, CHARACTER).freshness.status).toBe('CURRENT');
      expect(P93LedgerService.get(db, CHARACTER, buy.recordId)).toMatchObject({
        recordId: buy.recordId,
        recordState: 'REVERSED',
        quantity: 3,
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM real_fifo_lots WHERE character_id = ?')
        .get(CHARACTER)).toEqual({ n: 0 });

      if (round < 5) db.close();
    }
  });
});
