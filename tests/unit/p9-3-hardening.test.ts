import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrations.js';
import type { Db } from '../../src/db/sqlite.js';
import { P93AuditService } from '../../src/trading/p9-3-audit-service.js';
import { normalizeEsiWalletTransaction } from '../../src/trading/p9-3-evidence-service.js';
import { P93FifoService } from '../../src/trading/p9-3-fifo-service.js';
import { P93LedgerService } from '../../src/trading/p9-3-ledger-service.js';
import { P93ReconciliationService } from '../../src/trading/p9-3-reconciliation-service.js';
import type { P93EvidenceInput, P93RecordInput } from '../../src/trading/p9-3-types.js';

const CHARACTER = 930002;
let db: Db;

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

function evidence(
  recordId: string,
  overrides: Partial<P93EvidenceInput> = {},
) {
  const item = P93LedgerService.addEvidence(db, CHARACTER, {
    evidenceType: 'USER_ATTACHMENT',
    sourceSystem: 'TEST',
    sourceRef: `evidence-${recordId}`,
    capturedAt: '2026-01-01T00:00:00.000Z',
    payloadHash: `payload-${recordId}-${Math.random()}`,
    summary: 'isolated test evidence',
    initialStatus: 'PENDING',
    ...overrides,
  });
  return item;
}

function verifyRecord(recordId: string, overrides: Partial<P93EvidenceInput> = {}): void {
  const item = evidence(recordId, overrides);
  P93LedgerService.linkEvidence(db, CHARACTER, recordId, item.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test');
  P93LedgerService.setEvidenceStatus(db, CHARACTER, item.evidenceId, 'VERIFIED', 'user:test');
  P93LedgerService.verify(db, CHARACTER, recordId, 'user:test');
}

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  (db as unknown as Database.Database).close();
});

describe('P9.3.1 accounting hardening', () => {
  it('normalizes the ESI wallet transactions contract and never inserts synced facts as verified', () => {
    const row = normalizeEsiWalletTransaction({
      transaction_id: 101,
      date: '2026-01-01T00:00:00Z',
      type_id: 34,
      quantity: 5,
      unit_price: 12.34,
      is_buy: true,
      location_id: 60003760,
    });
    expect(row.unitPrice).toBe(12.34);

    const synced = P93LedgerService.upsert(db, CHARACTER, input({
      ledgerKey: 'esi-wallet:101',
      sourceType: 'ESI_WALLET_TRANSACTION',
      sourceRef: 'esi-wallet:101',
      quantity: 5,
      unitPrice: 12.34,
      feeStatus: 'UNKNOWN',
    }), 'ESI_SYNC', 'esi-wallet-sync');
    expect(synced.recordState).toBe('ACTIVE');
    expect(synced.verificationStatus).toBe('USER_REPORTED');
  });

  it('does not treat orders, snapshots or mismatched wallet evidence as a completed trade', () => {
    for (const evidenceType of ['ESI_MARKET_ORDER', 'ESI_ASSET_SNAPSHOT'] as const) {
      const trade = P93LedgerService.recordManual(db, CHARACTER, input({
        ledgerKey: `evidence-rules-${evidenceType}`,
      }), 'user:test');
      const item = evidence(trade.recordId, {
        evidenceType,
        sourceSystem: 'TEST_ESI',
        sourceRef: `${evidenceType}-${trade.recordId}`,
        initialStatus: 'VERIFIED',
      });
      P93LedgerService.linkEvidence(db, CHARACTER, trade.recordId, item.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test');
      expect(() => P93LedgerService.verify(db, CHARACTER, trade.recordId, 'user:test')).toThrow(/缺少已核实证据/);
    }
  });

  it('requires exact ESI wallet source references and still requires explicit human verification', () => {
    const trade = P93LedgerService.upsert(db, CHARACTER, input({
      ledgerKey: 'esi-wallet:202',
      sourceType: 'ESI_WALLET_TRANSACTION',
      sourceRef: 'esi-wallet:202',
      feeStatus: 'UNKNOWN',
    }), 'ESI_SYNC', 'esi-wallet-sync');
    const wrong = evidence(trade.recordId, {
      evidenceType: 'ESI_WALLET_LOG',
      sourceSystem: 'ESI_WALLET_TRANSACTIONS',
      sourceRef: 'esi-wallet:999',
      initialStatus: 'VERIFIED',
    });
    expect(() => P93LedgerService.linkEvidence(
      db, CHARACTER, trade.recordId, wrong.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test',
    )).toThrow(/不匹配/);

    const matching = evidence(trade.recordId, {
      evidenceType: 'ESI_WALLET_LOG',
      sourceSystem: 'ESI_WALLET_TRANSACTIONS',
      sourceRef: 'esi-wallet:202',
      initialStatus: 'VERIFIED',
    });
    P93LedgerService.linkEvidence(db, CHARACTER, trade.recordId, matching.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test');
    expect(P93LedgerService.get(db, CHARACTER, trade.recordId)!.verificationStatus).toBe('USER_REPORTED');
    expect(P93LedgerService.verify(db, CHARACTER, trade.recordId, 'user:test').verificationStatus).toBe('VERIFIED');
  });

  it('rejects all non-human actor identities, not just names containing ai/agent/model', () => {
    for (const actor of ['assistant', 'bot', 'llm', 'system', 'scheduler', 'esi-wallet-sync']) {
      expect(() => P93LedgerService.recordManual(
        db, CHARACTER, input({ ledgerKey: `actor-${actor}` }), actor,
      )).toThrow(/无权修改真实财务账本/);
    }
  });

  it('rejects caller-supplied source hashes and repairs the hash when a draft changes', () => {
    expect(() => P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'hash-tamper',
      sourceHash: 'deadbeef',
    }), 'user:test')).toThrow(/sourceHash/);

    const draft = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'hash-draft',
      draft: true,
      quantity: 10,
    }), 'user:test');
    P93LedgerService.updateDraft(db, CHARACTER, draft.recordId, { quantity: 11 }, 'user:test');
    expect(() => P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'hash-draft',
      quantity: 10,
    }), 'user:test')).toThrow(/相同 ledgerKey/);
  });

  it('protects fees and evidence links after verification and blocks direct verified writes', () => {
    const trade = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'trigger-trade',
      fees: [{ feeKind: 'BROKER', amount: 1, treatment: 'CAPITALIZED' }],
    }), 'user:test');
    verifyRecord(trade.recordId);

    expect(() => db.prepare('UPDATE real_trade_fees SET amount = 2 WHERE record_id = ?').run(trade.recordId)).toThrow(/费用不可修改/);
    expect(() => db.prepare('UPDATE real_trade_evidence_links SET relation = \'CONFLICTING\' WHERE record_id = ?').run(trade.recordId)).toThrow(/证据关系/);

    const pending = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'direct-verify' }), 'user:test');
    expect(() => db.prepare(`
      UPDATE real_trade_records
      SET record_state = 'VERIFIED', verification_status = 'VERIFIED'
      WHERE record_id = ?
    `).run(pending.recordId)).toThrow(/匹配的已核实证据/);
    expect(() => db.prepare('DELETE FROM real_trade_records WHERE record_id = ?').run(pending.recordId)).toThrow(/不得直接删除/);

    const foreignEvidence = P93LedgerService.addEvidence(db, CHARACTER + 1, {
      evidenceType: 'USER_ATTACHMENT', sourceSystem: 'TEST', sourceRef: 'foreign-evidence',
      capturedAt: '2026-01-01T00:00:00.000Z', payloadHash: 'foreign-payload', initialStatus: 'PENDING',
    });
    expect(() => db.prepare(`
      INSERT INTO real_trade_evidence_links (evidence_id, record_id, relation, confidence)
      VALUES (?, ?, 'PRIMARY', 'HIGH')
    `).run(foreignEvidence.evidenceId, pending.recordId)).toThrow(/同角色/);
    expect(() => db.prepare(`
      INSERT INTO real_trade_fees (fee_id, record_id, fee_kind, amount, treatment)
      VALUES ('ORPHAN-FEE', 'MISSING-RECORD', 'MANUAL', 1, 'UNKNOWN')
    `).run()).toThrow(/孤儿/);
    expect(() => db.prepare(`
      INSERT INTO real_trade_events (character_id, record_id, event_type, actor_type, actor_id)
      VALUES (?, 'MISSING-RECORD', 'bad', 'USER', 'user:test')
    `).run(CHARACTER)).toThrow(/同角色/);
    expect(P93AuditService.integrityCheck(db).ok).toBe(true);
  });

  it('allocates the exact sell-fee total across multiple FIFO lots and never reports unknown fees as zero', () => {
    const buy1 = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'fee-buy-1', quantity: 1 }), 'user:test');
    const buy2 = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'fee-buy-2', quantity: 1, tradeTime: '2026-01-02T00:00:00.000Z' }), 'user:test');
    const sell = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'fee-sell', direction: 'SELL', quantity: 2, unitPrice: 20, tradeTime: '2026-01-03T00:00:00.000Z',
      fees: [{ feeKind: 'BROKER', amount: 0.01, treatment: 'SELL_EXPENSE' }],
    }), 'user:test');
    verifyRecord(buy1.recordId);
    verifyRecord(buy2.recordId);
    verifyRecord(sell.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    const feeSum = db.prepare('SELECT SUM(allocated_sell_fees) AS n FROM real_fifo_consumptions WHERE sell_record_id = ?').get(sell.recordId) as any;
    expect(feeSum.n).toBeCloseTo(0.01, 8);
    expect(P93FifoService.performance(db, CHARACTER).totalFees).toBe(0.01);

    const unknown = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'unknown-fee', feeStatus: 'UNKNOWN' }), 'user:test');
    verifyRecord(unknown.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    expect(P93FifoService.performance(db, CHARACTER).totalFees).toBeNull();
  });

  it('produces a stable recalculation hash for unchanged verified facts', () => {
    const trade = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'stable-hash', quantity: 3 }), 'user:test');
    verifyRecord(trade.recordId);
    const first = P93FifoService.recalculate(db, CHARACTER) as any;
    const second = P93FifoService.recalculate(db, CHARACTER) as any;
    expect(first.after_hash).toBe(second.after_hash);
  });

  it('moves partial FIFO lots across locations without creating a purchase or duplicate cost', () => {
    const buy = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'transfer-buy', quantity: 10 }), 'user:test');
    const transfer = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'transfer-out',
      tradeKind: 'INVENTORY_TRANSFER',
      direction: 'NONE',
      quantity: 4,
      unitPrice: 0,
      locationId: 60003760,
      fromLocationId: 60003760,
      toLocationId: 60008494,
      tradeTime: '2026-01-02T00:00:00.000Z',
    }), 'user:test');
    verifyRecord(buy.recordId);
    verifyRecord(transfer.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    const afterTransfer = db.prepare(`
      SELECT location_id, SUM(remaining_quantity) AS quantity, SUM(remaining_cost) AS cost
      FROM real_fifo_lots WHERE character_id = ? GROUP BY location_id ORDER BY location_id
    `).all(CHARACTER) as any[];
    expect(afterTransfer).toEqual([
      { location_id: 60003760, quantity: 6, cost: 60 },
      { location_id: 60008494, quantity: 4, cost: 40 },
    ]);

    const sell = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'transfer-sell', direction: 'SELL', locationId: 60008494, quantity: 4, unitPrice: 20,
      tradeTime: '2026-01-03T00:00:00.000Z',
    }), 'user:test');
    verifyRecord(sell.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    const remaining = db.prepare('SELECT SUM(remaining_quantity) AS n FROM real_fifo_lots WHERE character_id = ? AND location_id = ?')
      .get(CHARACTER, 60008494) as any;
    expect(remaining.n).toBe(0);
  });

  it('marks reconciliation as required when duplicate source references create open cases', () => {
    const first = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'dup-1', sourceRef: 'same-source' }), 'user:test');
    const second = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'dup-2', sourceRef: 'same-source' }), 'user:test');
    verifyRecord(first.recordId);
    verifyRecord(second.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    db.prepare(`
      INSERT INTO real_asset_snapshots
        (snapshot_id, character_id, started_at, completed_at, status, total_items, total_unique_types, total_locations, total_quantity, data_hash)
      VALUES ('RECON-DUP', ?, datetime('now'), datetime('now'), 'COMPLETED', 1, 1, 1, 2, 'hash')
    `).run(CHARACTER);
    db.prepare(`
      INSERT INTO real_asset_snapshot_items (snapshot_id, item_id, type_id, quantity, location_id, raw_json)
      VALUES ('RECON-DUP', 1, 34, 2, 60003760, '{}')
    `).run();
    const result = P93ReconciliationService.run(db, CHARACTER) as any;
    expect(result.items.every((row: any) => row.status === 'MATCHED')).toBe(true);
    expect(result.cases.some((row: any) => row.case_kind === 'DUPLICATE_SOURCE_REFERENCE')).toBe(true);
    expect(result.run.status).toBe('RECONCILIATION_REQUIRED');
  });

  it('binds unrealized P&L to the latest completed snapshot and does not reuse an older valuation', () => {
    const trade = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'unrealized-buy', quantity: 1 }), 'user:test');
    verifyRecord(trade.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    db.prepare(`
      INSERT INTO real_asset_snapshots
        (snapshot_id, character_id, started_at, completed_at, status, total_items, total_unique_types, total_locations, total_quantity, data_hash)
      VALUES ('SNAP-OLD', ?, '2026-01-02T00:00:00Z', '2026-01-02T00:00:01Z', 'COMPLETED', 1, 1, 1, 1, 'old')
    `).run(CHARACTER);
    db.prepare(`
      INSERT INTO real_asset_snapshot_items (snapshot_id, item_id, type_id, quantity, location_id, raw_json)
      VALUES ('SNAP-OLD', 1, 34, 1, 60003760, '{}')
    `).run();
    db.prepare(`
      INSERT INTO real_asset_valuations
        (valuation_id, character_id, snapshot_id, hub_location_id, hub_region_id, market_snapshot_at, fee_model_version, status, created_at, completed_at, items_valued, items_unknown)
      VALUES ('VAL-OLD', ?, 'SNAP-OLD', 60003760, 10000002, '2026-01-02T00:00:00Z', 'test', 'COMPLETED', '2026-01-02T00:00:02Z', '2026-01-02T00:00:03Z', 1, 0)
    `).run(CHARACTER);
    db.prepare(`
      INSERT INTO real_asset_valuation_items
        (valuation_id, item_id, type_id, quantity, market_reference_value, bid_liquidation_net, ask_replacement_gross, ask_replacement_net)
      VALUES ('VAL-OLD', 1, 34, 1, 100, 90, 110, 108)
    `).run();
    db.prepare(`
      INSERT INTO real_asset_snapshots
        (snapshot_id, character_id, started_at, completed_at, status, total_items, total_unique_types, total_locations, total_quantity, data_hash)
      VALUES ('SNAP-NEW', ?, '2026-01-03T00:00:00Z', '2026-01-03T00:00:01Z', 'COMPLETED', 1, 1, 1, 1, 'new')
    `).run(CHARACTER);
    db.prepare(`
      INSERT INTO real_asset_snapshot_items (snapshot_id, item_id, type_id, quantity, location_id, raw_json)
      VALUES ('SNAP-NEW', 2, 34, 1, 60003760, '{}')
    `).run();
    const result = P93FifoService.unrealized(db, CHARACTER) as any;
    expect(result.snapshotId).toBe('SNAP-NEW');
    expect(result.valuationId).toBeNull();
    expect(result.perspectives.marketReference.status).toBe('N/A_NO_VALUATION');
    expect(result.unrealizedPnl).toBeNull();
  });
  it('computes profitable-trade ratio per sell record rather than per consumed lot', () => {
    const buy1 = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'ratio-buy-1', quantity: 1 }), 'user:test');
    const buy2 = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'ratio-buy-2', quantity: 1, tradeTime: '2026-01-02T00:00:00.000Z' }), 'user:test');
    const sell = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'ratio-sell', direction: 'SELL', quantity: 2, unitPrice: 20, tradeTime: '2026-01-03T00:00:00.000Z',
    }), 'user:test');
    verifyRecord(buy1.recordId);
    verifyRecord(buy2.recordId);
    verifyRecord(sell.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    expect(P93FifoService.performance(db, CHARACTER).profitableTradeRatio).toBe(1);
  });

  it('reverses a verified sale without deleting history and rebuilds FIFO inventory', () => {
    const buy = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'reverse-buy', quantity: 10 }), 'user:test');
    const sell = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'reverse-sell', direction: 'SELL', quantity: 4, unitPrice: 20, tradeTime: '2026-01-02T00:00:00.000Z',
    }), 'user:test');
    verifyRecord(buy.recordId);
    verifyRecord(sell.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    expect((db.prepare('SELECT SUM(remaining_quantity) AS n FROM real_fifo_lots WHERE character_id = ?').get(CHARACTER) as any).n).toBe(6);

    P93LedgerService.reverse(db, CHARACTER, sell.recordId, 'user:test', '隔离测试冲正');
    P93FifoService.recalculate(db, CHARACTER);
    expect((db.prepare('SELECT SUM(remaining_quantity) AS n FROM real_fifo_lots WHERE character_id = ?').get(CHARACTER) as any).n).toBe(10);
    expect(P93FifoService.performance(db, CHARACTER).realizedPnl).toBe(0);
    expect(P93LedgerService.get(db, CHARACTER, sell.recordId)!.recordState).toBe('REVERSED');
    expect(P93AuditService.events(db, CHARACTER, sell.recordId).some((row) => row.event_type === 'record_reversed')).toBe(true);
  });
  it('preserves total FIFO cost when unit cost has repeating decimals', () => {
    const buy = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'precision-buy', quantity: 3, unitPrice: 100 / 3,
    }), 'user:test');
    const sell = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'precision-sell', direction: 'SELL', quantity: 3, unitPrice: 50,
      tradeTime: '2026-01-02T00:00:00.000Z',
    }), 'user:test');
    verifyRecord(buy.recordId);
    verifyRecord(sell.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    expect(P93FifoService.performance(db, CHARACTER).realizedPnl).toBe(50);
  });
});