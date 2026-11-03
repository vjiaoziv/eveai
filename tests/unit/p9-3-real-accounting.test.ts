import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrations.js';
import type { Db } from '../../src/db/sqlite.js';
import { P93AuditService } from '../../src/trading/p9-3-audit-service.js';
import { P93FifoService } from '../../src/trading/p9-3-fifo-service.js';
import { P93LedgerService } from '../../src/trading/p9-3-ledger-service.js';
import { P93ReconciliationService } from '../../src/trading/p9-3-reconciliation-service.js';
import type { P93RecordInput } from '../../src/trading/p9-3-types.js';

const CHARACTER = 930001;
let db: Db;

function input(overrides: Partial<P93RecordInput> & { ledgerKey: string; direction: 'BUY' | 'SELL' | 'NONE' }): P93RecordInput {
  return {
    tradeKind: overrides.direction === 'BUY' ? 'BUY' : overrides.direction === 'SELL' ? 'SELL' : 'INVENTORY_TRANSFER',
    typeId: 34,
    locationId: 60003760,
    quantity: 1,
    unitPrice: 1,
    tradeTime: '2026-01-01T00:00:00.000Z',
    sourceType: 'USER_MANUAL_ENTRY',
    feeStatus: 'COMPLETE',
    ...overrides,
  };
}

function verifyRecord(recordId: string, sourceRef = recordId): void {
  const evidence = P93LedgerService.addEvidence(db, CHARACTER, {
    evidenceType: 'USER_ATTACHMENT',
    sourceSystem: 'TEST',
    sourceRef,
    capturedAt: '2026-01-01T00:00:00.000Z',
    payloadHash: `hash-${sourceRef}`,
    summary: '测试证据',
    initialStatus: 'VERIFIED',
  });
  P93LedgerService.linkEvidence(db, CHARACTER, recordId, evidence.evidenceId, 'PRIMARY', 'HIGH');
  P93LedgerService.verify(db, CHARACTER, recordId);
}

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  (db as unknown as Database.Database).close();
});

describe('P9.3 real accounting ledger', () => {
  it('keeps manual entries unverified until evidence is linked and verified', () => {
    const first = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'idem-1', direction: 'BUY', quantity: 100, unitPrice: 10 }));
    const replay = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'idem-1', direction: 'BUY', quantity: 100, unitPrice: 10 }));
    expect(replay.recordId).toBe(first.recordId);
    expect(first.verificationStatus).toBe('USER_REPORTED');

    expect(() => P93LedgerService.verify(db, CHARACTER, first.recordId)).toThrow(/缺少已核实证据/);
    P93FifoService.recalculate(db, CHARACTER);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_fifo_lots WHERE character_id = ?').get(CHARACTER)).toEqual({ n: 0 });

    verifyRecord(first.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    const lots = db.prepare('SELECT * FROM real_fifo_lots WHERE character_id = ?').all(CHARACTER) as any[];
    expect(lots).toHaveLength(1);
    expect(lots[0].remaining_quantity).toBe(100);
  });

  it('uses FIFO across multiple buys and one sell with capitalized and selling fees', () => {
    const buy1 = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'fifo-buy-1', direction: 'BUY', quantity: 100, unitPrice: 10, tradeTime: '2026-01-01T00:00:00.000Z',
      fees: [{ feeKind: 'BROKER', amount: 100, treatment: 'CAPITALIZED' }],
    }));
    const buy2 = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'fifo-buy-2', direction: 'BUY', quantity: 50, unitPrice: 12, tradeTime: '2026-01-02T00:00:00.000Z',
    }));
    const sell = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'fifo-sell', direction: 'SELL', quantity: 120, unitPrice: 20, tradeTime: '2026-01-03T00:00:00.000Z',
      fees: [{ feeKind: 'TRANSACTION_TAX', amount: 120, treatment: 'SELL_EXPENSE' }],
    }));
    verifyRecord(buy1.recordId);
    verifyRecord(buy2.recordId);
    verifyRecord(sell.recordId);
    const run = P93FifoService.recalculate(db, CHARACTER) as any;

    expect(run.realized_pnl).toBe(940);
    const lots = db.prepare('SELECT * FROM real_fifo_lots WHERE character_id = ? ORDER BY acquired_at').all(CHARACTER) as any[];
    expect(lots[0].remaining_quantity).toBe(0);
    expect(lots[1].remaining_quantity).toBe(30);
    expect(lots[1].unit_cost).toBe(12);
    const consumptions = db.prepare('SELECT * FROM real_fifo_consumptions WHERE character_id = ? ORDER BY created_at').all(CHARACTER) as any[];
    expect(consumptions).toHaveLength(2);
    expect(consumptions.map((row) => row.quantity)).toEqual([100, 20]);
    expect(consumptions.reduce((sum, row) => sum + row.realized_pnl, 0)).toBe(940);
  });

  it('handles one buy and multiple partial sells', () => {
    const buy = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'partial-buy', direction: 'BUY', quantity: 100, unitPrice: 10 }));
    const sell1 = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'partial-sell-1', direction: 'SELL', quantity: 40, unitPrice: 15,
      fees: [{ feeKind: 'BROKER', amount: 40, treatment: 'SELL_EXPENSE' }],
    }));
    const sell2 = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'partial-sell-2', tradeKind: 'PARTIAL_FILL', direction: 'SELL', quantity: 60, unitPrice: 18,
      fees: [{ feeKind: 'BROKER', amount: 60, treatment: 'SELL_EXPENSE' }],
    }));
    verifyRecord(buy.recordId);
    verifyRecord(sell1.recordId);
    verifyRecord(sell2.recordId);
    const run = P93FifoService.recalculate(db, CHARACTER) as any;

    expect(run.realized_pnl).toBe(580);
    expect(db.prepare('SELECT remaining_quantity FROM real_fifo_lots WHERE character_id = ?').get(CHARACTER)).toEqual({ remaining_quantity: 0 });
  });

  it('keeps UNKNOWN cost and missing inventory out of confirmed realized P&L', () => {
    const buy = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'unknown-buy', direction: 'BUY', quantity: 10, unitPrice: 10, feeStatus: 'UNKNOWN',
    }));
    const sell = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'unknown-sell', direction: 'SELL', quantity: 10, unitPrice: 20 }));
    const oversell = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'missing-sell', direction: 'SELL', quantity: 5, unitPrice: 20 }));
    verifyRecord(buy.recordId);
    verifyRecord(sell.recordId);
    verifyRecord(oversell.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    const performance = P93FifoService.performance(db, CHARACTER);

    expect(performance.realizedPnl).toBeNull();
    expect(performance.unknownCostCount).toBeGreaterThanOrEqual(2);
    expect(performance.inventoryCost).toBeNull();
    const unknownSource = db.prepare("SELECT COUNT(*) AS n FROM real_fifo_consumptions WHERE lot_id = 'UNKNOWN_SOURCE'").get() as any;
    expect(unknownSource.n).toBe(1);
  });

  it('supports reversal/correction and blocks silent deletion or fact overwrites', () => {
    const trade = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'audit-buy', direction: 'BUY', quantity: 5, unitPrice: 100 }));
    verifyRecord(trade.recordId);
    expect(() => db.prepare('DELETE FROM real_trade_records WHERE record_id = ?').run(trade.recordId)).toThrow(/不得直接删除/);
    expect(() => db.prepare('UPDATE real_trade_records SET quantity = 999 WHERE record_id = ?').run(trade.recordId)).toThrow(/不可原地覆盖/);

    const corrected = P93LedgerService.correction(db, CHARACTER, trade.recordId, input({
      ledgerKey: 'audit-buy-corrected', direction: 'BUY', quantity: 6, unitPrice: 100,
    }), 'user:1', '更正数量');
    expect(corrected.supersedesRecordId).toBe(trade.recordId);
    const original = P93LedgerService.get(db, CHARACTER, trade.recordId)!;
    expect(original.recordState).toBe('CORRECTED');

    verifyRecord(corrected.recordId, corrected.recordId);
    P93LedgerService.reverse(db, CHARACTER, corrected.recordId, 'user:1', '错误录入');
    expect(P93LedgerService.get(db, CHARACTER, corrected.recordId)!.recordState).toBe('REVERSED');
    const events = P93AuditService.events(db, CHARACTER, corrected.recordId);
    expect(events.some((row) => row.event_type === 'record_reversed')).toBe(true);
  });

  it('separates REAL from PAPER and rejects AI mutation actors', () => {
    expect(() => P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'ai-1', direction: 'BUY' }), 'ai-agent')).toThrow(/AI/);
    expect(() => db.prepare(`
      INSERT INTO real_trade_records
        (record_id, character_id, ledger_key, trade_kind, direction, type_id, location_id, quantity, unit_price, trade_time, source_type, is_paper)
      VALUES ('PAPER-BAD', ?, 'paper-bad', 'BUY', 'BUY', 34, 1, 1, 1, datetime('now'), 'PAPER', 1)
    `).run(CHARACTER)).toThrow();
  });

  it('reconciles FIFO inventory with real asset snapshots and never converts asset changes into trades', () => {
    const buy = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'recon-buy', direction: 'BUY', quantity: 10, unitPrice: 10 }));
    verifyRecord(buy.recordId);
    P93FifoService.recalculate(db, CHARACTER);

    db.prepare(`
      INSERT INTO real_asset_snapshots
        (snapshot_id, character_id, started_at, completed_at, status, total_items, total_unique_types, total_locations, total_quantity, data_hash)
      VALUES ('SNAP-RECON-1', ?, datetime('now'), datetime('now'), 'COMPLETED', 1, 1, 1, 10, 'hash')
    `).run(CHARACTER);
    db.prepare(`
      INSERT INTO real_asset_snapshot_items
        (snapshot_id, item_id, type_id, quantity, location_id, raw_json)
      VALUES ('SNAP-RECON-1', 1, 34, 10, 60003760, '{}')
    `).run();

    const result = P93ReconciliationService.run(db, CHARACTER) as any;
    expect(result.items[0].status).toBe('MATCHED');
    expect(result.run.status).toBe('MATCHED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE character_id = ?').get(CHARACTER)).toEqual({ n: 1 });

    db.prepare(`
      INSERT INTO real_asset_snapshot_items
        (snapshot_id, item_id, type_id, quantity, location_id, raw_json)
      VALUES ('SNAP-RECON-1', 2, 6675, 3, 60003760, '{}')
    `).run();
    const second = P93ReconciliationService.run(db, CHARACTER) as any;
    expect(second.items.some((row: any) => row.status === 'UNKNOWN_SOURCE' && row.type_id === 6675)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE character_id = ?').get(CHARACTER)).toEqual({ n: 1 });
  });
});