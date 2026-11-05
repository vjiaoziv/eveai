import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/db/migrations.js';
import type { Db } from '../../../src/db/sqlite.js';
import type { AssetLineage } from '../../../src/assets/asset-lineage.js';
import { P93FifoService } from '../../../src/trading/p9-3-fifo-service.js';
import { P93LedgerService } from '../../../src/trading/p9-3-ledger-service.js';
import { buildP9AnalysisPrompt } from '../../../src/trading/p9-ai-analysis.js';
import { P93ReconciliationService } from '../../../src/trading/p9-3-reconciliation-service.js';
import { P93AuditService } from '../../../src/trading/p9-3-audit-service.js';
import type { P93RecordInput } from '../../../src/trading/p9-3-types.js';
import { testAssetLineage } from '../../helpers/asset-lineage.js';

const CHARACTER_ID = 9_833_802;
const TYPE_ID = 34;
const LOCATION_ID = 60_003_760;
const OWNER_A = testAssetLineage(CHARACTER_ID, {
  ownerUserId: 7_001,
  ownerChatId: 8_001,
  bindingEpoch: 1,
  bindingDigest: 'owner-a-binding',
});
const OWNER_B = testAssetLineage(CHARACTER_ID, {
  ownerUserId: 7_002,
  ownerChatId: 8_002,
  bindingEpoch: 1,
  bindingDigest: 'owner-b-binding',
});

let db: Db;
let transactionSequence = 9_900_000;

function tradeInput(overrides: Partial<P93RecordInput> & { ledgerKey: string }): P93RecordInput {
  return {
    tradeKind: 'BUY',
    direction: 'BUY',
    typeId: TYPE_ID,
    locationId: LOCATION_ID,
    quantity: 10,
    unitPrice: 10,
    tradeTime: '2026-01-01T00:00:00.000Z',
    sourceType: 'USER_MANUAL_ENTRY',
    feeStatus: 'COMPLETE',
    draft: false,
    ...overrides,
  };
}

function verifyOwnerless(recordId: string): void {
  const record = P93LedgerService.get(db, CHARACTER_ID, recordId);
  if (!record) throw new Error('test record missing');
  if (record.recordState === 'DRAFT') {
    P93LedgerService.submitDraft(db, CHARACTER_ID, recordId, 'user:test');
  }
  const transactionId = transactionSequence++;
  const evidence = P93LedgerService.addEvidence(db, CHARACTER_ID, {
    evidenceType: 'ESI_WALLET_LOG',
    sourceSystem: 'ESI_WALLET_TRANSACTIONS',
    sourceRef: `esi-wallet:${transactionId}`,
    capturedAt: record.tradeTime,
    payloadHash: `owner-a-payload-${transactionId}`,
    summary: 'owner A private evidence',
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
  }, 'ESI_SYNC');
  P93LedgerService.linkEvidence(
    db,
    CHARACTER_ID,
    recordId,
    evidence.evidenceId,
    'PRIMARY',
    'HIGH',
    undefined,
    'USER',
    'user:test',
  );
  P93LedgerService.verify(db, CHARACTER_ID, recordId, 'user:test');
}

function assignRecordOwner(recordId: string, lineage: AssetLineage): void {
  db.prepare(`
    UPDATE real_trade_records
    SET owner_user_id = ?, owner_chat_id = ?, binding_epoch = ?, binding_digest = ?
    WHERE character_id = ? AND record_id = ?
  `).run(
    lineage.ownerUserId,
    lineage.ownerChatId,
    lineage.bindingEpoch,
    lineage.bindingDigest,
    CHARACTER_ID,
    recordId,
  );
}

function createOwnerATrade(
  ledgerKey: string,
  overrides: Partial<P93RecordInput> = {},
): string {
  const record = P93LedgerService.recordManual(
    db,
    CHARACTER_ID,
    tradeInput({ ledgerKey, ...overrides }),
    'user:test',
  );
  verifyOwnerless(record.recordId);
  assignRecordOwner(record.recordId, OWNER_A);
  return record.recordId;
}

function insertOwnerBSnapshot(): void {
  db.prepare(`
    INSERT INTO real_asset_snapshots
      (snapshot_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       started_at, completed_at, status, total_items, total_unique_types, total_locations,
       total_quantity, data_hash, is_latest)
    VALUES ('SNAP-OWNER-B', ?, ?, ?, ?, ?, '2026-01-03T12:00:00.000Z',
            '2026-01-03T12:00:01.000Z', 'COMPLETED', 1, 1, 1, 10, 'owner-b-hash', 1)
  `).run(
    CHARACTER_ID,
    OWNER_B.ownerUserId,
    OWNER_B.ownerChatId,
    OWNER_B.bindingEpoch,
    OWNER_B.bindingDigest,
  );
  db.prepare(`
    INSERT INTO real_asset_snapshot_items
      (snapshot_id, item_id, type_id, quantity, location_id, raw_json)
    VALUES ('SNAP-OWNER-B', 1, ?, 10, ?, '{}')
  `).run(TYPE_ID, LOCATION_ID);
}

function ensureOwnerBCalculation(): void {
  P93FifoService.recalculate(db, CHARACTER_ID, OWNER_B);
  db.prepare(`
    UPDATE real_calculation_runs SET completed_at = '2026-01-04T00:00:00.000Z'
    WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ?
  `).run(CHARACTER_ID, OWNER_B.ownerUserId, OWNER_B.ownerChatId, OWNER_B.bindingEpoch);
}

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertOwnerBSnapshot();
});

afterEach(() => {
  (db as unknown as Database.Database).close();
});

describe('P9.3.3.8 reconciliation ownership isolation', () => {
  it('does not use another owner FIFO calculation or lots when the current owner has none', () => {
    createOwnerATrade('owner-a-private-buy', { sourceRef: 'duplicate-source' });
    P93FifoService.recalculate(db, CHARACTER_ID, OWNER_A);

    expect(() => P93ReconciliationService.run(db, CHARACTER_ID, OWNER_B))
      .toThrow('缺少已完成的 FIFO 计算，不能执行真实资产对账。');
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM real_reconciliation_runs
      WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ?
    `).get(CHARACTER_ID, OWNER_B.ownerUserId, OWNER_B.ownerChatId)).toEqual({ n: 0 });
  });

  it('does not inherit another owner lots or duplicate-source cases into the current reconciliation', () => {
    createOwnerATrade('owner-a-private-buy', { sourceRef: 'duplicate-source' });
    const duplicate = P93LedgerService.recordManual(db, CHARACTER_ID, tradeInput({
      ledgerKey: 'owner-a-duplicate-source',
      sourceRef: 'duplicate-source',
    }), 'user:test');
    assignRecordOwner(duplicate.recordId, OWNER_A);
    P93FifoService.recalculate(db, CHARACTER_ID, OWNER_A);
    db.prepare(`
      UPDATE real_calculation_runs SET completed_at = '2026-01-03T00:00:00.000Z'
      WHERE character_id = ? AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ?
    `).run(CHARACTER_ID, OWNER_A.ownerUserId, OWNER_A.ownerChatId, OWNER_A.bindingEpoch);
    ensureOwnerBCalculation();

    const result = P93ReconciliationService.run(db, CHARACTER_ID, OWNER_B) as any;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      type_id: TYPE_ID,
      ledger_quantity: 0,
      asset_quantity: 10,
      ledger_cost: null,
      status: 'UNKNOWN_SOURCE',
    });
    expect(result.cases).toEqual([]);
    expect(result.run.summary.duplicateSourceReferences).toBe(0);
    expect(result.run.summary.itemCount).toBe(1);
  });

  it('does not include another owner trades or FIFO lots in the current AI analysis payload', () => {
    const privateRecordId = createOwnerATrade('owner-a-ai-private', { sourceRef: 'owner-a-ai-private' });
    P93FifoService.recalculate(db, CHARACTER_ID, OWNER_A);

    const built = buildP9AnalysisPrompt(db, CHARACTER_ID, OWNER_B, { mode: 'daily' });
    expect(built.prompt).not.toContain(privateRecordId);
    expect(built.prompt).not.toContain('owner-a-ai-private');
    expect(built.prompt).toContain('"active_lots": 0');
    expect(built.prompt).toContain('"unknown_cost_lots": 0');
  });

  it('does not let another owner later verified trade make the current reconciliation stale', () => {
    createOwnerATrade('owner-a-before-snapshot', { sourceRef: 'before-snapshot' });
    P93FifoService.recalculate(db, CHARACTER_ID, OWNER_A);
    const laterRecordId = createOwnerATrade('owner-a-after-snapshot', {
      sourceRef: 'after-snapshot',
      tradeTime: '2026-01-05T00:00:00.000Z',
    });
    ensureOwnerBCalculation();

    const result = P93ReconciliationService.run(db, CHARACTER_ID, OWNER_B) as any;
    expect(result.run.summary.timeBasis).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(laterRecordId);
    expect(result.run.summary.firstLaterRecordId).toBeUndefined();
  });
  it('keeps reconciliation history visible after a same-owner scope refresh changes only binding_digest', () => {
    db.prepare(`
      INSERT INTO real_reconciliation_runs
        (run_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
         snapshot_id, calculation_run_id, status, created_at, completed_at, summary_json)
      VALUES ('RECON-SCOPE-REFRESH', ?, ?, ?, ?, ?, 'SNAP-OWNER-B', 'CALC-SCOPE-REFRESH',
              'MATCHED', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:01.000Z',
              '{"itemCount":1}')
    `).run(
      CHARACTER_ID,
      OWNER_A.ownerUserId,
      OWNER_A.ownerChatId,
      OWNER_A.bindingEpoch,
      OWNER_A.bindingDigest,
    );

    const refreshed = testAssetLineage(CHARACTER_ID, {
      ownerUserId: OWNER_A.ownerUserId,
      ownerChatId: OWNER_A.ownerChatId,
      bindingEpoch: OWNER_A.bindingEpoch,
      bindingDigest: 'owner-a-refreshed-scope-digest',
    });

    expect(P93ReconciliationService.get(db, CHARACTER_ID, refreshed, 'RECON-SCOPE-REFRESH'))
      .toMatchObject({ run: { run_id: 'RECON-SCOPE-REFRESH', status: 'MATCHED' } });
    expect(P93ReconciliationService.latest(db, CHARACTER_ID, refreshed))
      .toMatchObject({ run: { run_id: 'RECON-SCOPE-REFRESH' } });
    expect(P93AuditService.reconciliationRuns(db, CHARACTER_ID, refreshed)
      .map((row) => row.run_id)).toContain('RECON-SCOPE-REFRESH');

    expect(P93ReconciliationService.get(db, CHARACTER_ID, OWNER_B, 'RECON-SCOPE-REFRESH')).toBeNull();
    expect(P93AuditService.reconciliationRuns(db, CHARACTER_ID, OWNER_B)).toEqual([]);
  });

  it('filters AI-analysis trade fees and FIFO consumptions by the current owner lineage', () => {
    const createVerifiedSell = (
      owner: AssetLineage,
      ledgerKey: string,
      feeAmount: number,
      realizedPnl: number,
    ): string => {
      const draft = P93LedgerService.recordManual(db, CHARACTER_ID, tradeInput({
        ledgerKey,
        tradeKind: 'SELL',
        direction: 'SELL',
        quantity: 1,
        unitPrice: 50,
        sourceRef: ledgerKey,
        draft: true,
      }), 'user:test');
      db.prepare(`
        INSERT INTO real_trade_fees
          (fee_id, record_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
           fee_kind, amount, treatment)
        VALUES (?, ?, ?, ?, ?, ?, 'BROKER', ?, 'SELL_EXPENSE')
      `).run(
        `fee-${ledgerKey}`,
        draft.recordId,
        owner.ownerUserId,
        owner.ownerChatId,
        owner.bindingEpoch,
        owner.bindingDigest,
        feeAmount,
      );
      verifyOwnerless(draft.recordId);
      assignRecordOwner(draft.recordId, owner);
      db.prepare(`
        INSERT INTO real_fifo_consumptions
          (consumption_id, character_id, owner_user_id, owner_chat_id, binding_epoch,
           binding_digest, sell_record_id, lot_id, type_id, location_id, quantity,
           unit_cost, allocated_sell_fees, realized_pnl, pnl_status, calculation_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 10, ?, ?, 'CALCULATED', 'p9-test')
      `).run(
        `consumption-${ledgerKey}`,
        CHARACTER_ID,
        owner.ownerUserId,
        owner.ownerChatId,
        owner.bindingEpoch,
        owner.bindingDigest,
        draft.recordId,
        `lot-${ledgerKey}`,
        TYPE_ID,
        LOCATION_ID,
        feeAmount,
        realizedPnl,
      );
      return draft.recordId;
    };

    const privateRecordId = createVerifiedSell(OWNER_A, 'owner-a-child-private', 11_111, 77_777);
    const visibleRecordId = createVerifiedSell(OWNER_B, 'owner-b-child-visible', 3, 20);

    const built = buildP9AnalysisPrompt(db, CHARACTER_ID, OWNER_B, { mode: 'daily' });
    expect(built.prompt).toContain(visibleRecordId);
    expect(built.prompt).toContain('"fee": 3');
    expect(built.prompt).toContain('"realized_pnl": 20');
    expect(built.prompt).not.toContain(privateRecordId);
    expect(built.prompt).not.toContain('"fee": 11111');
    expect(built.prompt).not.toContain('"realized_pnl": 77777');
  });

});
