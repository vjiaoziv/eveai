import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import type { P93ReconciliationStatus } from './p9-3-types.js';

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
  static run(db: Db, characterId: number): Record<string, unknown> {
    const snapshot = db.prepare(`
      SELECT snapshot_id, completed_at FROM real_asset_snapshots
      WHERE character_id = ? AND status = 'COMPLETED'
      ORDER BY completed_at DESC, snapshot_id DESC LIMIT 1
    `).get(characterId) as any;
    if (!snapshot) throw new Error('缺少完整 ESI 资产快照，不能执行真实资产对账。');
    const calculation = db.prepare(`
      SELECT run_id FROM real_calculation_runs
      WHERE character_id = ? AND status = 'COMPLETED'
      ORDER BY completed_at DESC, run_id DESC LIMIT 1
    `).get(characterId) as any;
    const runId = 'RECON-' + randomUUID();
    db.prepare(`
      INSERT INTO real_reconciliation_runs (run_id, character_id, snapshot_id, calculation_run_id, status, created_at)
      VALUES (?, ?, ?, ?, 'RECONCILIATION_REQUIRED', datetime('now'))
    `).run(runId, characterId, snapshot.snapshot_id, calculation?.run_id ?? null);

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
      WHERE character_id = ? AND remaining_quantity > 0
      GROUP BY type_id, location_id
    `).all(characterId) as any[];
    const valuation = db.prepare(`
      SELECT si.type_id, si.location_id, SUM(vi.market_reference_value) AS value
      FROM real_asset_valuation_items vi
      JOIN real_asset_snapshot_items si ON si.item_id = vi.item_id AND si.snapshot_id = ?
      JOIN real_asset_valuations v ON v.valuation_id = vi.valuation_id
      WHERE v.character_id = ? AND v.status = 'COMPLETED'
        AND v.valuation_id = (SELECT valuation_id FROM real_asset_valuations
                              WHERE character_id = ? AND snapshot_id = ? AND status = 'COMPLETED'
                              ORDER BY created_at DESC, valuation_id DESC LIMIT 1)
      GROUP BY si.type_id, si.location_id
    `).all(snapshot.snapshot_id, characterId, characterId, snapshot.snapshot_id) as any[];


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
    const changes = db.prepare(`
      SELECT * FROM real_asset_changes
      WHERE character_id = ? AND source_class <> 'SOURCE_CONFIRMED'
      ORDER BY detected_at DESC LIMIT 500
    `).all(characterId) as any[];
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
        WHERE character_id = ? AND type_id = ?
          AND (location_id = ? OR from_location_id = ? OR to_location_id = ?)
          AND verification_status = 'VERIFIED'
          AND trade_time BETWEEN datetime(?, '-2 days') AND datetime(?, '+2 days')
          AND ((? = 1 AND direction = 'BUY') OR (? = 1 AND direction = 'SELL') OR trade_kind = 'INVENTORY_TRANSFER')
      `).get(
        characterId,
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
      WHERE character_id = ? AND source_ref IS NOT NULL
        AND record_state NOT IN ('REJECTED', 'REVERSED', 'CORRECTED')
      GROUP BY source_type, source_ref
      HAVING COUNT(*) > 1
    `).all(characterId) as any[];
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

    return this.get(db, characterId, runId)!;
  }

  static get(db: Db, characterId: number, runId: string): Record<string, unknown> | null {
    const run = db.prepare('SELECT * FROM real_reconciliation_runs WHERE character_id = ? AND run_id = ?').get(characterId, runId) as any;
    if (!run) return null;
    const items = db.prepare('SELECT * FROM real_reconciliation_items WHERE run_id = ? ORDER BY status, reconcile_key').all(runId) as any[];
    const cases = db.prepare('SELECT * FROM real_reconciliation_cases WHERE run_id = ? ORDER BY created_at DESC').all(runId) as any[];
    return {
      run: { ...run, summary: JSON.parse(run.summary_json || '{}') },
      items: items.map((row) => ({ ...row, details: JSON.parse(row.details_json || '{}') })),
      cases: cases.map((row) => ({ ...row, details: JSON.parse(row.details_json || '{}') })),
    };
  }

  static latest(db: Db, characterId: number): Record<string, unknown> | null {
    const run = db.prepare(`
      SELECT run_id FROM real_reconciliation_runs
      WHERE character_id = ?
      ORDER BY created_at DESC, run_id DESC LIMIT 1
    `).get(characterId) as any;
    return run ? this.get(db, characterId, run.run_id) : null;
  }
}