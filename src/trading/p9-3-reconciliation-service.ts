import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import type { P93ReconciliationStatus } from './p9-3-types.js';
import { clampNonNegativeInteger, clampPositiveInteger } from '../util/query-bounds.js';
import { assetLineagePredicate, type AssetLineage } from '../assets/asset-lineage.js';
import { realLedgerLineagePredicate } from './p9-3-lineage.js';

type ReconItem = {
  reconcile_key: string;
  type_id: number | null;
  location_id: number | null;
  ledger_quantity: number;
  asset_quantity: number;
  delta_quantity: number;
  ledger_cost: number | null;
  valuation_value: number | null;
  status: P93ReconciliationStatus;
  reason: string;
  details: Record<string, unknown>;
};

export class P93ReconciliationService {
  static run(db: Db, characterId: number, lineage: AssetLineage): Record<string, unknown> {
    const snapshotOwnership = assetLineagePredicate(null, lineage);
    const snapshot = db.prepare(`
      SELECT snapshot_id, completed_at FROM real_asset_snapshots
      WHERE character_id = ? AND status = 'COMPLETED' AND ${snapshotOwnership.sql}
      ORDER BY completed_at DESC, snapshot_id DESC LIMIT 1
    `).get(characterId, ...snapshotOwnership.params) as any;
    if (!snapshot) throw new Error('缺少完整 ESI 资产快照，不能执行真实资产对账。');
    if (!snapshot.completed_at) throw new Error('资产快照缺少完成时间，不能确定库存估值时点。');
    const ledgerOwnership = realLedgerLineagePredicate(null, lineage);
    const calculation = db.prepare(`
      SELECT run_id, completed_at FROM real_calculation_runs
      WHERE character_id = ? AND status = 'COMPLETED' AND ${ledgerOwnership.sql}
      ORDER BY completed_at DESC, run_id DESC LIMIT 1
    `).get(characterId, ...ledgerOwnership.params) as any;
    if (!calculation) throw new Error('缺少已完成的 FIFO 计算，不能执行真实资产对账。');
    const laterVerified = db.prepare(`
      SELECT record_id, trade_time, trade_kind
      FROM real_trade_records
      WHERE character_id = ? AND ${ledgerOwnership.sql} AND is_paper = 0
        AND record_state = 'VERIFIED' AND verification_status = 'VERIFIED'
        AND trade_kind IN ('BUY', 'SELL', 'PARTIAL_FILL', 'MULTI_BATCH_FILL',
                           'COST_ADJUSTMENT', 'INVENTORY_TRANSFER')
        AND julianday(trade_time) > julianday(?)
      ORDER BY trade_time, rowid
      LIMIT 1
    `).get(characterId, ...ledgerOwnership.params, snapshot.completed_at) as any;
    const runId = 'RECON-' + randomUUID();
    db.prepare(`
      INSERT INTO real_reconciliation_runs
        (run_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
         snapshot_id, calculation_run_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RECONCILIATION_REQUIRED', datetime('now'))
    `).run(
      runId,
      characterId,
      lineage.ownerUserId,
      lineage.ownerChatId,
      lineage.bindingEpoch,
      lineage.bindingDigest,
      snapshot.snapshot_id,
      calculation.run_id,
    );
    if (laterVerified) {
      db.prepare(`
        UPDATE real_reconciliation_runs
        SET status = 'RECONCILIATION_REQUIRED', completed_at = datetime('now'), summary_json = ?
        WHERE run_id = ?
      `).run(JSON.stringify({
        itemCount: 0,
        statusCounts: {},
        timeBasis: 'SNAPSHOT_INVENTORY_TIME_MISMATCH',
        snapshotCompletedAt: snapshot.completed_at,
        calculationRunId: calculation.run_id,
        firstLaterRecordId: laterVerified.record_id,
        firstLaterTradeTime: laterVerified.trade_time,
        firstLaterTradeKind: laterVerified.trade_kind,
        policy: '资产快照早于已核实交易时，当前 FIFO 库存不能代表快照时点；已拒绝数量对账，避免伪造差异。',
      }), runId);
      return this.get(db, characterId, lineage, runId)!;
    }

    const assetRows = db.prepare(`
      SELECT type_id, location_id, SUM(quantity) AS quantity, COUNT(*) AS item_count
      FROM real_asset_snapshot_items
      WHERE snapshot_id = ?
      GROUP BY type_id, location_id
    `).all(snapshot.snapshot_id) as any[];
    const ledgerRows = db.prepare(`
      SELECT type_id, location_id, SUM(remaining_quantity) AS quantity,
             SUM(COALESCE(remaining_cost, 0)) AS known_cost,
             SUM(CASE WHEN cost_status <> 'KNOWN' THEN 1 ELSE 0 END) AS unknown_cost_lots
      FROM real_fifo_lots
      WHERE character_id = ? AND ${ledgerOwnership.sql} AND remaining_quantity > 0
      GROUP BY type_id, location_id
    `).all(characterId, ...ledgerOwnership.params) as any[];
    const valuationOwnership = assetLineagePredicate('v', lineage);
    const latestValuationOwnership = assetLineagePredicate(null, lineage);
    const valuation = db.prepare(`
      SELECT si.type_id, si.location_id, SUM(vi.market_reference_value) AS value
      FROM real_asset_valuation_items vi
      JOIN real_asset_snapshot_items si ON si.item_id = vi.item_id AND si.snapshot_id = ?
      JOIN real_asset_valuations v ON v.valuation_id = vi.valuation_id
      WHERE v.character_id = ? AND v.status = 'COMPLETED' AND ${valuationOwnership.sql}
        AND v.valuation_id = (SELECT valuation_id FROM real_asset_valuations
                              WHERE character_id = ? AND snapshot_id = ? AND status = 'COMPLETED'
                                AND ${latestValuationOwnership.sql}
                              ORDER BY created_at DESC, valuation_id DESC LIMIT 1)
      GROUP BY si.type_id, si.location_id
    `).all(
      snapshot.snapshot_id,
      characterId,
      ...valuationOwnership.params,
      characterId,
      snapshot.snapshot_id,
      ...latestValuationOwnership.params,
    ) as any[];


    const key = (row: any) => `${row.type_id}:${row.location_id}`;
    const assetMap = new Map(assetRows.map((row) => [key(row), row]));
    const ledgerMap = new Map(ledgerRows.map((row) => [key(row), row]));
    const valuationMap = new Map(valuation.map((row) => [key(row), row]));
    const keys = [...new Set([...assetMap.keys(), ...ledgerMap.keys()])].sort();
    const items: ReconItem[] = [];

    for (const itemKey of keys) {
      const asset = assetMap.get(itemKey);
      const ledger = ledgerMap.get(itemKey);
      const assetQty = Number(asset?.quantity || 0);
      const ledgerQty = Number(ledger?.quantity || 0);
      const delta = ledgerQty - assetQty;
      const unknownCost = Number(ledger?.unknown_cost_lots || 0) > 0;
      let status: P93ReconciliationStatus;
      let reason: string;
      if (delta === 0 && assetQty === 0 && ledgerQty === 0) {
        status = 'MATCHED';
        reason = '账本与资产快照均为零。';
      } else if (delta === 0 && unknownCost) {
        status = 'VALUE_MISMATCH';
        reason = '数量匹配，但存在 UNKNOWN/部分未知成本。';
      } else if (delta === 0) {
        status = 'MATCHED';
        reason = '账本库存数量与 ESI 资产数量一致。';
      } else if (ledgerQty === 0 && assetQty > 0) {
        status = 'UNKNOWN_SOURCE';
        reason = '资产快照存在库存，但交易账本没有来源记录。';
      } else if (assetQty === 0 && ledgerQty > 0) {
        status = 'UNMATCHED';
        reason = '账本存在库存，但最新资产快照未发现对应资产。';
      } else {
        status = 'QUANTITY_MISMATCH';
        reason = '账本库存数量与资产快照数量不一致。';
      }
      const [typeId, locationId] = itemKey.split(':').map(Number);
      items.push({
        reconcile_key: itemKey,
        type_id: typeId,
        location_id: locationId,
        ledger_quantity: ledgerQty,
        asset_quantity: assetQty,
        delta_quantity: delta,
        ledger_cost: ledger ? (Number(ledger.known_cost) || 0) : null,
        valuation_value: valuationMap.get(itemKey)?.value == null ? null : Number(valuationMap.get(itemKey).value),
        status,
        reason,
        details: {
          unknownCostLots: Number(ledger?.unknown_cost_lots || 0),
          assetItemCount: Number(asset?.item_count || 0),
        },
      });
    }

    const insertItem = db.prepare(`
      INSERT INTO real_reconciliation_items
        (run_id, reconcile_key, type_id, location_id, ledger_quantity, asset_quantity,
         delta_quantity, ledger_cost, valuation_value, status, reason, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      insertItem.run(
        runId,
        item.reconcile_key,
        item.type_id,
        item.location_id,
        item.ledger_quantity,
        item.asset_quantity,
        item.delta_quantity,
        item.ledger_cost,
        item.valuation_value,
        item.status,
        item.reason,
        JSON.stringify(item.details),
      );
    }

    // Asset changes remain observations. They create review cases and never
    // become verified trades automatically.
    const changeOwnership = assetLineagePredicate(null, lineage);
    const changes = db.prepare(`
      SELECT * FROM real_asset_changes
      WHERE character_id = ? AND source_class <> 'SOURCE_CONFIRMED' AND ${changeOwnership.sql}
      ORDER BY detected_at DESC LIMIT 500
    `).all(characterId, ...changeOwnership.params) as any[];
    const insertCase = db.prepare(`
      INSERT INTO real_reconciliation_cases
        (case_id, run_id, character_id, case_kind, status, linked_record_id, linked_change_id, details_json, created_at)
      VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, datetime('now'))
    `);
    for (const change of changes) {
      const increase = change.change_type === 'ADDED' || change.change_type === 'QTY_INCREASED';
      const decrease = change.change_type === 'REMOVED' || change.change_type === 'QTY_DECREASED';
      const locationId = change.new_location_id ?? change.prev_location_id ?? 0;
      const matchCount = Number((db.prepare(`
        SELECT COUNT(*) AS n FROM real_trade_records
        WHERE character_id = ? AND ${ledgerOwnership.sql} AND type_id = ?
          AND (location_id = ? OR from_location_id = ? OR to_location_id = ?)
          AND verification_status = 'VERIFIED'
          AND trade_time BETWEEN datetime(?, '-2 days') AND datetime(?, '+2 days')
          AND ((? = 1 AND direction = 'BUY') OR (? = 1 AND direction = 'SELL') OR trade_kind = 'INVENTORY_TRANSFER')
      `).get(
        characterId,
        ...ledgerOwnership.params,
        change.type_id,
        locationId,
        locationId,
        locationId,
        change.detected_at,
        change.detected_at,
        increase ? 1 : 0,
        decrease ? 1 : 0,
      ) as any)?.n || 0);
      insertCase.run(
        'CASE-' + randomUUID(),
        runId,
        characterId,
        increase || decrease ? 'ASSET_CHANGE_WITHOUT_CONFIRMED_TRADE' : 'ASSET_CHANGE_REVIEW',
        null,
        change.change_id,
        JSON.stringify({ change, nearbyVerifiedRecordCount: matchCount }),
      );
    }

    const duplicates = db.prepare(`
      SELECT source_type, source_ref, COUNT(*) AS count, GROUP_CONCAT(record_id) AS record_ids
      FROM real_trade_records
      WHERE character_id = ? AND ${ledgerOwnership.sql} AND source_ref IS NOT NULL
        AND record_state NOT IN ('REJECTED', 'REVERSED', 'CORRECTED')
      GROUP BY source_type, source_ref
      HAVING COUNT(*) > 1
    `).all(characterId, ...ledgerOwnership.params) as any[];
    for (const duplicate of duplicates) {
      insertCase.run(
        'CASE-' + randomUUID(),
        runId,
        characterId,
        'DUPLICATE_SOURCE_REFERENCE',
        null,
        null,
        JSON.stringify(duplicate),
      );
    }

    const counts = items.reduce<Record<string, number>>((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    const openCaseCount = changes.length + duplicates.length;
    const status = items.every((item) => item.status === 'MATCHED') && openCaseCount === 0
      ? 'MATCHED'
      : 'RECONCILIATION_REQUIRED';
    db.prepare(`
      UPDATE real_reconciliation_runs
      SET status = ?, completed_at = datetime('now'), summary_json = ?
      WHERE run_id = ?
    `).run(status, JSON.stringify({
      itemCount: items.length,
      statusCounts: counts,
      duplicateSourceReferences: duplicates.length,
      assetChangeReviewCases: changes.length,
      policy: '资产变化不会自动生成已核实买卖交易。',
    }), runId);

    return this.get(db, characterId, lineage, runId)!;
  }

  static get(
    db: Db,
    characterId: number,
    lineage: AssetLineage,
    runId: string,
    query: { limit?: unknown; offset?: unknown } = {},
  ): Record<string, unknown> | null {
    const ownership = realLedgerLineagePredicate(null, lineage);
    const run = db.prepare(`
      SELECT * FROM real_reconciliation_runs
      WHERE character_id = ? AND run_id = ? AND ${ownership.sql}
    `).get(characterId, runId, ...ownership.params) as any;
    if (!run) return null;
    const limit = clampPositiveInteger(query.limit, 200, 500);
    const offset = clampNonNegativeInteger(query.offset);
    const itemTotal = Number((db.prepare('SELECT COUNT(*) AS n FROM real_reconciliation_items WHERE run_id = ?').get(runId) as any)?.n || 0);
    const caseTotal = Number((db.prepare('SELECT COUNT(*) AS n FROM real_reconciliation_cases WHERE run_id = ?').get(runId) as any)?.n || 0);
    const items = db.prepare(`
      SELECT * FROM real_reconciliation_items
      WHERE run_id = ?
      ORDER BY status, reconcile_key
      LIMIT ? OFFSET ?
    `).all(runId, limit, offset) as any[];
    const cases = db.prepare(`
      SELECT * FROM real_reconciliation_cases
      WHERE run_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(runId, limit, offset) as any[];
    return {
      run: { ...run, summary: JSON.parse(run.summary_json || '{}') },
      items: items.map((row) => ({ ...row, details: JSON.parse(row.details_json || '{}') })),
      cases: cases.map((row) => ({ ...row, details: JSON.parse(row.details_json || '{}') })),
      pagination: { limit, offset, itemTotal, caseTotal },
    };
  }

  static latest(
    db: Db,
    characterId: number,
    lineage: AssetLineage,
    query: { limit?: unknown; offset?: unknown } = {},
  ): Record<string, unknown> | null {
    const ownership = realLedgerLineagePredicate(null, lineage);
    const run = db.prepare(`
      SELECT run_id FROM real_reconciliation_runs
      WHERE character_id = ? AND ${ownership.sql}
      ORDER BY created_at DESC, run_id DESC LIMIT 1
    `).get(characterId, ...ownership.params) as any;
    return run ? this.get(db, characterId, lineage, run.run_id, query) : null;
  }
}
