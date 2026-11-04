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
let evidenceSequence = 1000;

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
  trust: 'USER' | 'ESI_SYNC' = 'USER',
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
  }, trust);
  return item;
}

function verifyRecord(recordId: string, overrides: Partial<P93EvidenceInput> = {}): void {
  const record = P93LedgerService.get(db, CHARACTER, recordId);
  if (!record) throw new Error('test record missing');
  if (record.recordState === 'DRAFT') P93LedgerService.submitDraft(db, CHARACTER, recordId, 'user:test');
  const transactionId = evidenceSequence++;
  const isTransfer = record.tradeKind === 'INVENTORY_TRANSFER';
  const item = isTransfer
    ? P93LedgerService.addEvidence(db, CHARACTER, {
      evidenceType: 'ESI_ASSET_SNAPSHOT',
      sourceSystem: 'ESI_ASSETS',
      sourceRef: `asset-snapshot:${transactionId}`,
      capturedAt: record.tradeTime,
      payloadHash: `asset-payload-${transactionId}-${Math.random()}`,
      summary: 'isolated matching asset transfer evidence',
      initialStatus: 'VERIFIED',
      metadata: {
        typeId: record.typeId,
        quantity: record.quantity,
        fromLocationId: record.fromLocationId,
        toLocationId: record.toLocationId,
        tradeTime: record.tradeTime,
      },
      ...overrides,
    }, 'ESI_SYNC')
    : P93LedgerService.addEvidence(db, CHARACTER, {
      evidenceType: 'ESI_WALLET_LOG',
      sourceSystem: 'ESI_WALLET_TRANSACTIONS',
      sourceRef: `esi-wallet:${transactionId}`,
      capturedAt: record.tradeTime,
      payloadHash: `esi-payload-${transactionId}-${Math.random()}`,
      summary: 'isolated matching ESI wallet evidence',
      initialStatus: 'VERIFIED',
      metadata: {
        transactionId,
        typeId: record.typeId,
        quantity: record.quantity,
        unitPrice: record.unitPrice,
        isBuy: record.direction === 'BUY',
        locationId: record.locationId,
        tradeTime: record.tradeTime,
      },
      ...overrides,
    }, 'ESI_SYNC');
  P93LedgerService.linkEvidence(db, CHARACTER, recordId, item.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test');
  P93LedgerService.verify(db, CHARACTER, recordId, 'user:test');
}

function verifyAdjustment(recordId: string): void {
  const item = evidence(recordId);
  P93LedgerService.linkEvidence(db, CHARACTER, recordId, item.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test');
  P93LedgerService.setEvidenceStatus(db, CHARACTER, item.evidenceId, 'VERIFIED', 'user:test', 'isolated test verification');
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
      }, 'ESI_SYNC');
      if (evidenceType === 'ESI_ASSET_SNAPSHOT') {
        expect(() => P93LedgerService.linkEvidence(
          db, CHARACTER, trade.recordId, item.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test',
        )).toThrow(/不能作为买卖成交/);
      } else {
        P93LedgerService.linkEvidence(db, CHARACTER, trade.recordId, item.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test');
        expect(() => P93LedgerService.verify(db, CHARACTER, trade.recordId, 'user:test')).toThrow(/ESI 钱包证据/);
      }
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
    }, 'ESI_SYNC');
    expect(() => P93LedgerService.linkEvidence(
      db, CHARACTER, trade.recordId, wrong.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test',
    )).toThrow(/不匹配/);

    const matching = evidence(trade.recordId, {
      evidenceType: 'ESI_WALLET_LOG',
      sourceSystem: 'ESI_WALLET_TRANSACTIONS',
      sourceRef: 'esi-wallet:202',
      initialStatus: 'VERIFIED',
      metadata: {
        transactionId: 202,
        typeId: trade.typeId,
        quantity: trade.quantity,
        unitPrice: trade.unitPrice,
        isBuy: true,
        locationId: trade.locationId,
        tradeTime: trade.tradeTime,
      },
    }, 'ESI_SYNC');
    P93LedgerService.linkEvidence(db, CHARACTER, trade.recordId, matching.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test');
    expect(P93LedgerService.get(db, CHARACTER, trade.recordId)!.verificationStatus).toBe('USER_REPORTED');
    expect(P93LedgerService.verify(db, CHARACTER, trade.recordId, 'user:test').verificationStatus).toBe('VERIFIED');
  });

  it('prevents public callers from fabricating ESI evidence and cannot verify with user confirmation alone', () => {
    expect(() => P93LedgerService.addEvidence(db, CHARACTER, {
      evidenceType: 'ESI_WALLET_LOG',
      sourceSystem: 'ESI_WALLET_TRANSACTIONS',
      sourceRef: 'esi-wallet:700',
      capturedAt: '2026-01-01T00:00:00.000Z',
      payloadHash: 'forged-esi-evidence',
    })).toThrow(/公共接口/);

    const trade = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'user-confirmation-only' }), 'user:test');
    const confirmation = evidence(trade.recordId, {
      evidenceType: 'USER_CONFIRMATION',
      sourceRef: `confirmation-${trade.recordId}`,
    });
    P93LedgerService.linkEvidence(db, CHARACTER, trade.recordId, confirmation.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test');
    P93LedgerService.setEvidenceStatus(db, CHARACTER, confirmation.evidenceId, 'VERIFIED', 'user:test');
    expect(() => P93LedgerService.verify(db, CHARACTER, trade.recordId, 'user:test')).toThrow(/ESI 钱包证据/);
  });

  it('rejects an ESI wallet evidence record whose facts differ even when sourceRef is reused', () => {
    const trade = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'esi-fact-mismatch',
      sourceRef: 'esi-wallet:701',
      quantity: 4,
      unitPrice: 10,
    }), 'user:test');
    const mismatched = evidence(trade.recordId, {
      evidenceType: 'ESI_WALLET_LOG',
      sourceSystem: 'ESI_WALLET_TRANSACTIONS',
      sourceRef: 'esi-wallet:701',
      initialStatus: 'VERIFIED',
      metadata: {
        transactionId: 701,
        typeId: trade.typeId,
        quantity: 5,
        unitPrice: trade.unitPrice,
        isBuy: true,
        locationId: trade.locationId,
        tradeTime: trade.tradeTime,
      },
    }, 'ESI_SYNC');
    expect(() => P93LedgerService.linkEvidence(
      db, CHARACTER, trade.recordId, mismatched.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test',
    )).toThrow(/数量不一致/);
  });

  it('rejects ESI wallet evidence whose source reference differs even when metadata facts match', () => {
    const trade = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'esi-source-ref-mismatch',
      sourceRef: 'esi-wallet:999',
      quantity: 4,
      unitPrice: 10,
    }), 'user:test');
    const mismatched = evidence(trade.recordId, {
      evidenceType: 'ESI_WALLET_LOG',
      sourceSystem: 'ESI_WALLET_TRANSACTIONS',
      sourceRef: 'esi-wallet:123',
      initialStatus: 'VERIFIED',
      metadata: {
        transactionId: 123,
        typeId: trade.typeId,
        quantity: trade.quantity,
        unitPrice: trade.unitPrice,
        isBuy: true,
        locationId: trade.locationId,
        tradeTime: trade.tradeTime,
      },
    }, 'ESI_SYNC');
    expect(() => P93LedgerService.linkEvidence(
      db, CHARACTER, trade.recordId, mismatched.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test',
    )).toThrow(/来源引用不一致/);
  });

  it('prevents one ESI wallet evidence from supporting multiple trade records', () => {
    const first = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'esi-evidence-first',
      sourceRef: 'esi-wallet:8124',
      quantity: 4,
      unitPrice: 10,
    }), 'user:test');
    const second = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'esi-evidence-second',
      sourceRef: 'esi-wallet:8124',
      quantity: 4,
      unitPrice: 10,
    }), 'user:test');
    const walletEvidence = evidence(first.recordId, {
      evidenceType: 'ESI_WALLET_LOG',
      sourceSystem: 'ESI_WALLET_TRANSACTIONS',
      sourceRef: 'esi-wallet:8124',
      initialStatus: 'VERIFIED',
      metadata: {
        transactionId: 8124,
        typeId: first.typeId,
        quantity: first.quantity,
        unitPrice: first.unitPrice,
        isBuy: true,
        locationId: first.locationId,
        tradeTime: first.tradeTime,
      },
    }, 'ESI_SYNC');
    P93LedgerService.linkEvidence(db, CHARACTER, first.recordId, walletEvidence.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test');
    expect(() => P93LedgerService.linkEvidence(
      db, CHARACTER, second.recordId, walletEvidence.evidenceId, 'CORROBORATING', 'HIGH', undefined, 'USER', 'user:test',
    )).toThrow(/同一 ESI 证据/);
    expect(() => db.prepare(`
      INSERT INTO real_trade_evidence_links (evidence_id, record_id, relation, confidence)
      VALUES (?, ?, 'CORROBORATING', 'HIGH')
    `).run(walletEvidence.evidenceId, second.recordId)).toThrow(/同一 ESI 证据/);
  });

  it('rejects asset evidence whose source reference differs even when transfer facts match', () => {
    const transfer = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'asset-source-ref-mismatch',
      tradeKind: 'INVENTORY_TRANSFER',
      direction: 'NONE',
      quantity: 2,
      unitPrice: 0,
      locationId: 60003760,
      fromLocationId: 60003760,
      toLocationId: 60008494,
      sourceRef: 'asset-a',
    }), 'user:test');
    const mismatched = evidence(transfer.recordId, {
      evidenceType: 'ESI_ASSET_SNAPSHOT',
      sourceSystem: 'ESI_ASSETS',
      sourceRef: 'asset-b',
      initialStatus: 'VERIFIED',
      metadata: {
        typeId: transfer.typeId,
        quantity: transfer.quantity,
        fromLocationId: transfer.fromLocationId,
        toLocationId: transfer.toLocationId,
        tradeTime: transfer.tradeTime,
      },
    }, 'ESI_SYNC');
    expect(() => P93LedgerService.linkEvidence(
      db, CHARACTER, transfer.recordId, mismatched.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test',
    )).toThrow(/来源引用不一致/);
  });

  it('does not allow a verified trade to be downgraded through the service or direct SQL', () => {
    const trade = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'verified-downgrade' }), 'user:test');
    verifyRecord(trade.recordId);
    expect(() => P93LedgerService.setVerification(db, CHARACTER, trade.recordId, 'PENDING', 'user:test')).toThrow(/不能降级/);
    expect(() => db.prepare(`
      UPDATE real_trade_records
      SET record_state = 'ACTIVE', verification_status = 'PENDING'
      WHERE record_id = ?
    `).run(trade.recordId)).toThrow(/不可降级/);
    expect(P93LedgerService.get(db, CHARACTER, trade.recordId)!.recordState).toBe('VERIFIED');
  });

  it('rejects reserved ESI and asset-change source types on the human entry path', () => {
    for (const sourceType of ['ESI_WALLET_TRANSACTION', 'ESI_MARKET_ORDER', 'ASSET_CHANGE']) {
      expect(() => P93LedgerService.recordManual(
        db, CHARACTER, input({ ledgerKey: `reserved-${sourceType}`, sourceType }), 'user:test',
      )).toThrow(/不能伪造/);
    }
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

  it('prevents draft updates from laundering ESI or asset-change source types', () => {
    const draft = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'draft-source-guard',
      draft: true,
    }), 'user:test');
    for (const sourceType of ['ESI_WALLET_TRANSACTION', 'ESI_ASSET_SNAPSHOT', 'ASSET_CHANGE']) {
      expect(() => P93LedgerService.updateDraft(db, CHARACTER, draft.recordId, {
        sourceType,
        sourceRef: 'esi-wallet:8123',
      }, 'user:test')).toThrow(/草稿更新不能伪造/);
    }
    expect(P93LedgerService.get(db, CHARACTER, draft.recordId)?.sourceType).toBe('USER_MANUAL_ENTRY');
  });

  it('requires an explicit draft submission before verification', () => {
    const draft = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'draft-submit-guard',
      draft: true,
    }), 'user:test');

    expect(() => P93LedgerService.verify(db, CHARACTER, draft.recordId, 'user:test')).toThrow(/草稿必须先提交/);
    expect(() => db.prepare(`
      UPDATE real_trade_records
      SET record_state = 'VERIFIED', verification_status = 'VERIFIED'
      WHERE record_id = ?
    `).run(draft.recordId)).toThrow(/草稿必须先提交/);

    const submitted = P93LedgerService.submitDraft(db, CHARACTER, draft.recordId, 'user:test');
    expect(submitted.recordState).toBe('ACTIVE');
    expect(submitted.verificationStatus).toBe('USER_REPORTED');
    expect(P93LedgerService.submitDraft(db, CHARACTER, draft.recordId, 'user:test').recordState).toBe('ACTIVE');
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
    `).run(pending.recordId)).toThrow(/完全匹配的已核实 ESI 钱包证据/);
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

  it('fails closed when audit guards are missing or corrupted financial facts exist', () => {
    const first = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'audit-first' }), 'user:test');
    const second = P93LedgerService.recordManual(db, CHARACTER, input({ ledgerKey: 'audit-second' }), 'user:test');
    const esiEvidence = P93LedgerService.addEvidence(db, CHARACTER, {
      evidenceType: 'ESI_WALLET_LOG',
      sourceSystem: 'ESI_WALLET_TRANSACTIONS',
      sourceRef: 'esi-wallet:900001',
      capturedAt: first.tradeTime,
      payloadHash: 'audit-esi-payload',
      initialStatus: 'VERIFIED',
      metadata: {
        transactionId: 900001,
        typeId: first.typeId,
        quantity: first.quantity,
        unitPrice: first.unitPrice,
        isBuy: true,
        locationId: first.locationId,
        tradeTime: first.tradeTime,
      },
    }, 'ESI_SYNC');
    db.prepare(`
      INSERT INTO real_trade_evidence_links (evidence_id, record_id, relation, confidence)
      VALUES (?, ?, 'PRIMARY', 'HIGH')
    `).run(esiEvidence.evidenceId, first.recordId);
    db.exec(`
      DROP TRIGGER real_trade_evidence_links_single_esi_support_insert;
      DROP TRIGGER real_trade_evidence_links_single_esi_support_update;
    `);
    db.prepare(`
      INSERT INTO real_trade_evidence_links (evidence_id, record_id, relation, confidence)
      VALUES (?, ?, 'CORROBORATING', 'HIGH')
    `).run(esiEvidence.evidenceId, second.recordId);

    db.prepare(`
      INSERT INTO real_trade_records
        (record_id, character_id, ledger_key, trade_kind, direction, type_id, location_id,
         quantity, unit_price, trade_time, source_type, record_state, verification_status)
      VALUES ('FEE-AUDIT', ?, 'fee-audit', 'FEE_ADJUSTMENT', 'NONE', 34, 60003760,
              0, 0, '2026-01-01T00:00:00.000Z', 'LEGACY', 'ACTIVE', 'USER_REPORTED')
    `).run(CHARACTER);
    const userEvidence = P93LedgerService.addEvidence(db, CHARACTER, {
      evidenceType: 'USER_ATTACHMENT',
      sourceSystem: 'TEST',
      sourceRef: 'fee-audit-evidence',
      capturedAt: '2026-01-01T00:00:00.000Z',
      payloadHash: 'fee-audit-payload',
      initialStatus: 'PENDING',
    });
    P93LedgerService.setEvidenceStatus(db, CHARACTER, userEvidence.evidenceId, 'VERIFIED', 'user:test');
    db.prepare(`
      INSERT INTO real_trade_evidence_links (evidence_id, record_id, relation, confidence)
      VALUES (?, 'FEE-AUDIT', 'PRIMARY', 'HIGH')
    `).run(userEvidence.evidenceId);
    db.exec('DROP TRIGGER real_trade_records_fee_adjustment_cannot_verify;');
    db.prepare(`
      UPDATE real_trade_records
      SET record_state = 'VERIFIED', verification_status = 'VERIFIED'
      WHERE record_id = 'FEE-AUDIT'
    `).run();

    const audit = P93AuditService.integrityCheck(db, CHARACTER);
    expect(audit.ok).toBe(false);
    expect(audit.findings.some((finding) => finding.includes('real_trade_evidence_links_single_esi_support_insert'))).toBe(true);
    expect(audit.findings.some((finding) => finding.includes('real_trade_records_fee_adjustment_cannot_verify'))).toBe(true);
    expect(audit.findings.some((finding) => finding.includes('已核实 FEE_ADJUSTMENT'))).toBe(true);
    expect(audit.findings.some((finding) => finding.includes('ESI 证据被重复用于支持多条交易'))).toBe(true);
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
  it('applies cost adjustments to the remaining cost after a partial sale', () => {
    const buy = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'adjust-buy', quantity: 10, unitPrice: 10,
    }), 'user:test');
    const sell = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'adjust-sell', direction: 'SELL', quantity: 4, unitPrice: 15,
      tradeTime: '2026-01-02T00:00:00.000Z',
    }), 'user:test');
    verifyRecord(buy.recordId);
    verifyRecord(sell.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    const lotId = `LOT-${buy.recordId}`;
    const adjustment = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'adjust-after-partial-sale',
      tradeKind: 'COST_ADJUSTMENT',
      direction: 'NONE',
      quantity: 0,
      unitPrice: 0,
      adjustmentMode: 'INCREASE',
      adjustmentAmount: 10,
      targetLotId: lotId,
      tradeTime: '2026-01-03T00:00:00.000Z',
    }), 'user:test');
    verifyAdjustment(adjustment.recordId);
    P93FifoService.recalculate(db, CHARACTER);

    const lot = db.prepare('SELECT * FROM real_fifo_lots WHERE lot_id = ? AND character_id = ?')
      .get(lotId, CHARACTER) as any;
    expect(lot.remaining_quantity).toBe(6);
    expect(lot.remaining_cost).toBe(70);
    expect(lot.unit_cost).toBeCloseTo(70 / 6, 8);
    expect(P93FifoService.performance(db, CHARACTER).realizedPnl).toBe(20);
  });

  it('applies cost adjustments to the remaining cost after a partial transfer', () => {
    const buy = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'adjust-transfer-buy', quantity: 10, unitPrice: 10,
    }), 'user:test');
    const transfer = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'adjust-transfer', tradeKind: 'INVENTORY_TRANSFER', direction: 'NONE',
      quantity: 4, unitPrice: 0, fromLocationId: 60003760, toLocationId: 60008494,
      tradeTime: '2026-01-02T00:00:00.000Z',
    }), 'user:test');
    verifyRecord(buy.recordId);
    verifyRecord(transfer.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    const splitLotId = `LOT-${buy.recordId}-TRANSFER-${transfer.recordId}-0`;
    const adjustment = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'adjust-transferred-lot',
      tradeKind: 'COST_ADJUSTMENT',
      direction: 'NONE',
      quantity: 0,
      unitPrice: 0,
      adjustmentMode: 'INCREASE',
      adjustmentAmount: 10,
      targetLotId: splitLotId,
      tradeTime: '2026-01-03T00:00:00.000Z',
    }), 'user:test');
    verifyAdjustment(adjustment.recordId);
    P93FifoService.recalculate(db, CHARACTER);

    const split = db.prepare('SELECT * FROM real_fifo_lots WHERE lot_id = ? AND character_id = ?')
      .get(splitLotId, CHARACTER) as any;
    expect(split.remaining_quantity).toBe(4);
    expect(split.remaining_cost).toBe(50);
    expect(split.unit_cost).toBe(12.5);
  });

  it('rejects cost adjustments that would overdraw the remaining lot cost', () => {
    const buy = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'adjust-overdraw-buy', quantity: 2, unitPrice: 10,
    }), 'user:test');
    verifyRecord(buy.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    const lotId = `LOT-${buy.recordId}`;
    const adjustment = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'adjust-overdraw', tradeKind: 'COST_ADJUSTMENT', direction: 'NONE',
      quantity: 0, unitPrice: 0, adjustmentMode: 'DECREASE', adjustmentAmount: 21,
      targetLotId: lotId, tradeTime: '2026-01-02T00:00:00.000Z',
    }), 'user:test');
    verifyAdjustment(adjustment.recordId);
    expect(() => P93FifoService.recalculate(db, CHARACTER)).toThrow(/变为负数/);
    expect(P93LedgerService.get(db, CHARACTER, buy.recordId)!.recordState).toBe('VERIFIED');
  });

  it('requires a correction to create a new ledger key and protects the original state', () => {
    const originalInput = input({ ledgerKey: 'correct-same-key', quantity: 5, unitPrice: 100 });
    const trade = P93LedgerService.recordManual(db, CHARACTER, originalInput, 'user:test');
    verifyRecord(trade.recordId);

    expect(() => P93LedgerService.correction(
      db, CHARACTER, trade.recordId, originalInput, 'user:test', '无效的原地更正',
    )).toThrow(/新的 ledgerKey/);
    expect(P93LedgerService.get(db, CHARACTER, trade.recordId)!.recordState).toBe('VERIFIED');
    expect((db.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE character_id = ?').get(CHARACTER) as any).n).toBe(1);
  });

  it('rejects public REVERSAL records and requires the audited reverse operation', () => {
    expect(() => P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'manual-reversal', tradeKind: 'REVERSAL', direction: 'NONE', quantity: 0,
    }), 'user:test')).toThrow(/reverse/);
  });

  it('refuses reconciliation when verified trades are newer than the asset snapshot', () => {
    const buy = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'recon-time-buy', quantity: 10,
    }), 'user:test');
    verifyRecord(buy.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    db.prepare(`
      INSERT INTO real_asset_snapshots
        (snapshot_id, character_id, started_at, completed_at, status, total_items, total_unique_types, total_locations, total_quantity, data_hash)
      VALUES ('SNAP-TIME-BASE', ?, '2026-01-02T00:00:00Z', '2026-01-02T00:00:01Z', 'COMPLETED', 1, 1, 1, 10, 'base')
    `).run(CHARACTER);
    db.prepare(`
      INSERT INTO real_asset_snapshot_items (snapshot_id, item_id, type_id, quantity, location_id, raw_json)
      VALUES ('SNAP-TIME-BASE', 1, 34, 10, 60003760, '{}')
    `).run();
    const sell = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'recon-time-later-sell', direction: 'SELL', quantity: 4, unitPrice: 15,
      tradeTime: '2026-01-03T00:00:00.000Z',
    }), 'user:test');
    verifyRecord(sell.recordId);
    P93FifoService.recalculate(db, CHARACTER);

    const result = P93ReconciliationService.run(db, CHARACTER) as any;
    expect(result.run.status).toBe('RECONCILIATION_REQUIRED');
    expect(result.items).toEqual([]);
    expect(result.run.summary.timeBasis).toBe('SNAPSHOT_INVENTORY_TIME_MISMATCH');
    expect(result.run.summary.firstLaterRecordId).toBe(sell.recordId);
  });

  it('detects impossible FIFO lot and consumption quantities in the audit integrity check', () => {
    const buy = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'integrity-buy', quantity: 3, unitPrice: 10,
    }), 'user:test');
    const sell = P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'integrity-sell', direction: 'SELL', quantity: 2, unitPrice: 15,
      tradeTime: '2026-01-02T00:00:00.000Z',
    }), 'user:test');
    verifyRecord(buy.recordId);
    verifyRecord(sell.recordId);
    P93FifoService.recalculate(db, CHARACTER);
    db.prepare(`
      UPDATE real_fifo_lots SET remaining_quantity = original_quantity + 1
      WHERE character_id = ? AND source_record_id = ?
    `).run(CHARACTER, buy.recordId);
    db.prepare(`
      UPDATE real_fifo_consumptions SET quantity = 99
      WHERE character_id = ? AND sell_record_id = ?
    `).run(CHARACTER, sell.recordId);

    const audit = P93AuditService.integrityCheck(db, CHARACTER);
    expect(audit.ok).toBe(false);
    expect(audit.findings.some((finding) => finding.includes('批次剩余数量'))).toBe(true);
    expect(audit.findings.some((finding) => finding.includes('FIFO 消耗数量'))).toBe(true);
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

  it('paginates reconciliation output with bounded query values and isolates runs by character', () => {
    db.prepare(`
      INSERT INTO real_reconciliation_runs
        (run_id, character_id, status, created_at, completed_at, summary_json)
      VALUES ('RECON-PAGE', ?, 'MATCHED', datetime('now'), datetime('now'), '{}')
    `).run(CHARACTER);
    const insertItem = db.prepare(`
      INSERT INTO real_reconciliation_items
        (run_id, reconcile_key, type_id, location_id, ledger_quantity, asset_quantity,
         delta_quantity, status, reason, details_json)
      VALUES ('RECON-PAGE', ?, 34, 60003760, ?, 0, ?, 'UNMATCHED', 'test', '{}')
    `);
    db.transaction(() => {
      for (let index = 0; index < 505; index += 1) {
        insertItem.run(`key-${String(index).padStart(4, '0')}`, index, index);
      }
      db.prepare(`
        INSERT INTO real_reconciliation_cases
          (case_id, run_id, character_id, case_kind, status, details_json, created_at)
        VALUES ('CASE-PAGE', 'RECON-PAGE', ?, 'DUPLICATE_SOURCE_REFERENCE', 'OPEN', '{}', datetime('now'))
      `).run(CHARACTER);
    })();

    const defaultPage = P93ReconciliationService.get(db, CHARACTER, 'RECON-PAGE') as any;
    expect(defaultPage.items).toHaveLength(200);
    expect(defaultPage.cases).toHaveLength(1);
    expect(defaultPage.pagination).toEqual({
      limit: 200,
      offset: 0,
      itemTotal: 505,
      caseTotal: 1,
    });

    const secondPage = P93ReconciliationService.get(db, CHARACTER, 'RECON-PAGE', { limit: '2', offset: '2' }) as any;
    expect(secondPage.items.map((row: any) => row.reconcile_key)).toEqual(['key-0002', 'key-0003']);
    expect(secondPage.pagination).toMatchObject({ limit: 2, offset: 2, itemTotal: 505, caseTotal: 1 });

    const invalid = P93ReconciliationService.get(db, CHARACTER, 'RECON-PAGE', {
      limit: '-5', offset: 'Infinity',
    }) as any;
    expect(invalid.pagination).toMatchObject({ limit: 200, offset: 0 });
    expect(P93ReconciliationService.get(db, CHARACTER, 'RECON-PAGE', { limit: '9999' }) as any)
      .toMatchObject({ pagination: { limit: 500 } });
    expect((P93ReconciliationService.get(db, CHARACTER, 'RECON-PAGE', { limit: '9999' }) as any).items).toHaveLength(500);
    expect(P93ReconciliationService.get(db, CHARACTER + 1, 'RECON-PAGE')).toBeNull();
  });

  it('fails closed instead of silently ignoring FEE_ADJUSTMENT records', () => {
    expect(() => P93LedgerService.recordManual(db, CHARACTER, input({
      ledgerKey: 'fee-adjustment-blocked',
      tradeKind: 'FEE_ADJUSTMENT',
      direction: 'NONE',
      quantity: 0,
      unitPrice: 0,
      feeStatus: 'COMPLETE',
      fees: [{ feeKind: 'MANUAL', amount: 5, treatment: 'PERIOD_EXPENSE' }],
    }), 'user:test')).toThrow(/尚未定义安全的费用归属口径/);

    db.prepare(`
      INSERT INTO real_trade_records
        (record_id, character_id, ledger_key, trade_kind, direction, type_id, location_id,
         quantity, unit_price, trade_time, source_type, record_state, verification_status)
      VALUES ('FEE-ACTIVE', ?, 'fee-active', 'FEE_ADJUSTMENT', 'NONE', 34, 60003760,
              0, 0, '2026-01-01T00:00:00.000Z', 'LEGACY', 'ACTIVE', 'USER_REPORTED')
    `).run(CHARACTER);
    expect(() => P93LedgerService.verify(db, CHARACTER, 'FEE-ACTIVE', 'user:test')).toThrow(/不能核实/);

    const feeEvidence = evidence('FEE-ACTIVE');
    P93LedgerService.linkEvidence(db, CHARACTER, 'FEE-ACTIVE', feeEvidence.evidenceId, 'PRIMARY', 'HIGH', undefined, 'USER', 'user:test');
    P93LedgerService.setEvidenceStatus(db, CHARACTER, feeEvidence.evidenceId, 'VERIFIED', 'user:test');
    expect(() => db.prepare(`
      UPDATE real_trade_records SET record_state = 'VERIFIED', verification_status = 'VERIFIED'
      WHERE record_id = 'FEE-ACTIVE'
    `).run()).toThrow(/FEE_ADJUSTMENT/);

    db.prepare('DROP TRIGGER real_trade_records_insert_unverified').run();
    db.prepare(`
      INSERT INTO real_trade_records
        (record_id, character_id, ledger_key, trade_kind, direction, type_id, location_id,
         quantity, unit_price, trade_time, source_type, record_state, verification_status)
      VALUES ('FEE-LEGACY-VERIFIED', ?, 'fee-legacy-verified', 'FEE_ADJUSTMENT', 'NONE', 34, 60003760,
              0, 0, '2026-01-01T00:00:00.000Z', 'LEGACY', 'VERIFIED', 'VERIFIED')
    `).run(CHARACTER);
    expect(() => P93FifoService.recalculate(db, CHARACTER)).toThrow(/FIFO 重算已阻断/);
  });
});
