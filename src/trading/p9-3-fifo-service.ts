import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import {
  P93_CALCULATION_VERSION,
  roundMoney,
  type P93CalculationFreshness,
  type P93Performance,
} from './p9-3-types.js';
import { assetLineagePredicate, type AssetLineage } from '../assets/asset-lineage.js';
import {
  realLedgerLineagePredicate,
  resolveRealLedgerLineage,
  type RealLedgerLineage,
} from './p9-3-lineage.js';
import { p9LineagePredicate } from './p9-control-plane-lineage.js';

type LotRow = {
  lot_id: string;
  type_id: number;
  location_id: number;
  source_record_id: string;
  original_quantity: number;
  remaining_quantity: number;
  base_cost: number;
  capitalized_fees: number;
  unit_cost: number | null;
  remaining_cost: number | null;
  cost_status: 'KNOWN' | 'PARTIAL' | 'UNKNOWN';
  acquired_at: string;
};

function roundUnitCost(value: number): number {
  return Math.round(value * 100000000) / 100000000;
}

function fifoPredicate(lineage: RealLedgerLineage | null): { sql: string; params: unknown[] } {
  if (lineage) return realLedgerLineagePredicate(null, lineage);
  return {
    sql: 'owner_user_id IS NULL AND owner_chat_id IS NULL AND binding_epoch = 0',
    params: [],
  };
}

function fifoAliasPredicate(
  alias: string,
  lineage: RealLedgerLineage | null,
): { sql: string; params: unknown[] } {
  if (lineage) return realLedgerLineagePredicate(alias, lineage);
  return {
    sql: `${alias}.owner_user_id IS NULL AND ${alias}.owner_chat_id IS NULL AND ${alias}.binding_epoch = 0`,
    params: [],
  };
}

function fifoLineageValues(
  lineage: RealLedgerLineage | null,
): [number | null, number | null, number, string] {
  return lineage
    ? [lineage.ownerUserId, lineage.ownerChatId, lineage.bindingEpoch, lineage.bindingDigest]
    : [null, null, 0, ''];
}

function latestCompletedRun(
  db: Db,
  characterId: number,
  lineage: RealLedgerLineage | null,
): any | null {
  const owner = fifoPredicate(lineage);
  return db.prepare(`
    SELECT * FROM real_calculation_runs
    WHERE character_id = ? AND status = 'COMPLETED' AND ${owner.sql}
    ORDER BY julianday(completed_at) DESC, rowid DESC LIMIT 1
  `).get(characterId, ...owner.params) ?? null;
}

function snapshotHash(db: Db, characterId: number, lineage: RealLedgerLineage | null): string {
  // IDs and row-creation timestamps are intentionally excluded: a full
  // recalculation recreates derived rows, and those implementation details
  // must not make an unchanged result look different.
  const lots = (db.prepare(`
    SELECT lot_id, type_id, location_id, source_record_id, original_quantity,
           remaining_quantity, base_cost, capitalized_fees, unit_cost, remaining_cost,
           cost_status, acquired_at, calculation_version
    FROM real_fifo_lots WHERE character_id = ? AND ${fifoPredicate(lineage).sql} ORDER BY lot_id
  `).all(characterId, ...fifoPredicate(lineage).params) as any[]).map((row) => [
    row.lot_id, row.type_id, row.location_id, row.source_record_id, row.original_quantity,
    row.remaining_quantity, row.base_cost, row.capitalized_fees, row.unit_cost, row.remaining_cost,
    row.cost_status, row.acquired_at, row.calculation_version,
  ]);
  const consumptions = (db.prepare(`
    SELECT sell_record_id, lot_id, type_id, location_id, quantity, unit_cost,
           allocated_sell_fees, realized_pnl, pnl_status, calculation_version
    FROM real_fifo_consumptions WHERE character_id = ? AND ${fifoPredicate(lineage).sql} ORDER BY sell_record_id, lot_id
  `).all(characterId, ...fifoPredicate(lineage).params) as any[]).map((row) => [
    row.sell_record_id, row.lot_id, row.type_id, row.location_id, row.quantity,
    row.unit_cost, row.allocated_sell_fees, row.realized_pnl, row.pnl_status,
    row.calculation_version,
  ]);
  return createHash('sha256').update(JSON.stringify({ lots, consumptions })).digest('hex');
}

function parseStoredUtc(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function calculationFreshness(
  db: Db,
  characterId: number,
  lineage: RealLedgerLineage | null,
): P93CalculationFreshness {
  const owner = fifoPredicate(lineage);
  const latestCalculation = db.prepare(`
    SELECT run_id, completed_at FROM real_calculation_runs
    WHERE character_id = ? AND status = 'COMPLETED' AND ${owner.sql}
    ORDER BY julianday(completed_at) DESC, rowid DESC LIMIT 1
  `).get(characterId, ...owner.params) as { run_id: string; completed_at: string | null } | undefined;
  const latestAttempt = db.prepare(`
    SELECT run_id, status, started_at, completed_at
    FROM real_calculation_runs
    WHERE character_id = ? AND ${owner.sql}
    ORDER BY julianday(started_at) DESC, rowid DESC
    LIMIT 1
  `).get(characterId, ...owner.params) as {
    run_id: string;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED';
    started_at: string;
    completed_at: string | null;
  } | undefined;
  const latestFact = db.prepare(`
    SELECT changed_at
    FROM (
      SELECT e.created_at AS changed_at
      FROM real_trade_events e
      JOIN real_trade_records r ON r.record_id = e.record_id AND r.character_id = e.character_id
      WHERE e.character_id = ? AND ${owner.sql.replace(/(^| AND )/g, '$1e.')} AND r.is_paper = 0
        AND r.record_state IN ('VERIFIED', 'REVERSED', 'CORRECTED')
        AND r.trade_kind IN ('BUY', 'SELL', 'PARTIAL_FILL', 'MULTI_BATCH_FILL', 'COST_ADJUSTMENT', 'INVENTORY_TRANSFER')
      UNION ALL
      SELECT r.updated_at AS changed_at
      FROM real_trade_records r
      WHERE r.character_id = ? AND ${owner.sql.replace(/(^| AND )/g, '$1r.')} AND r.is_paper = 0
        AND r.record_state IN ('VERIFIED', 'REVERSED', 'CORRECTED')
        AND r.trade_kind IN ('BUY', 'SELL', 'PARTIAL_FILL', 'MULTI_BATCH_FILL', 'COST_ADJUSTMENT', 'INVENTORY_TRANSFER')
    )
    ORDER BY julianday(changed_at) DESC
    LIMIT 1
  `).get(
    characterId, ...owner.params,
    characterId, ...owner.params,
  ) as { changed_at: string | null } | undefined;

  const latestCalculationAt = latestCalculation?.completed_at ?? null;
  const latestLedgerFactAt = latestFact?.changed_at ?? null;
  const latestFailedAt = latestAttempt?.status === 'FAILED'
    ? latestAttempt.completed_at ?? latestAttempt.started_at
    : null;
  const calculationMs = parseStoredUtc(latestCalculationAt);
  const factMs = parseStoredUtc(latestLedgerFactAt);
  const failedMs = parseStoredUtc(latestFailedAt);

  if (!latestCalculation) {
    return {
      status: 'NEVER_CALCULATED',
      latestCalculationAt: null,
      latestLedgerFactAt,
      latestFailedCalculationAt: latestFailedAt,
      message: '尚无成功的 FIFO 计算；不得把空结果视为当前完整核算。',
    };
  }
  if (factMs !== null && calculationMs !== null && factMs > calculationMs) {
    return {
      status: 'STALE',
      latestCalculationAt,
      latestLedgerFactAt,
      latestFailedCalculationAt: latestFailedAt,
      message: '账本事实或证据状态晚于最近一次成功计算；当前 FIFO 结果已过期，请人工触发重算。',
    };
  }
  if (failedMs !== null && calculationMs !== null && failedMs > calculationMs) {
    return {
      status: 'STALE',
      latestCalculationAt,
      latestLedgerFactAt,
      latestFailedCalculationAt: latestFailedAt,
      message: '最近一次 FIFO 重算失败；当前展示的是上一次有效结果，已标记过期。',
    };
  }
  return {
    status: 'CURRENT',
    latestCalculationAt,
    latestLedgerFactAt,
    latestFailedCalculationAt: latestFailedAt,
    message: 'FIFO 结果基于当前已核实 REAL 账本事实。',
  };
}

function feeTotals(db: Db, recordId: string): {
  capitalized: number;
  sellExpense: number;
  periodExpense: number;
  unrelated: number;
  unknown: number;
} {
  const rows = db.prepare('SELECT treatment, amount FROM real_trade_fees WHERE record_id = ?').all(recordId) as Array<{ treatment: string; amount: number }>;
  const out = { capitalized: 0, sellExpense: 0, periodExpense: 0, unrelated: 0, unknown: 0 };
  for (const row of rows) {
    const amount = Number(row.amount);
    if (row.treatment === 'CAPITALIZED') out.capitalized += amount;
    else if (row.treatment === 'SELL_EXPENSE') out.sellExpense += amount;
    else if (row.treatment === 'PERIOD_EXPENSE') out.periodExpense += amount;
    else if (row.treatment === 'UNRELATED') out.unrelated += amount;
    else out.unknown += amount;
  }
  return out;
}

export class P93FifoService {
  static freshness(
    db: Db,
    characterId: number,
    lineage?: RealLedgerLineage | null,
  ): P93CalculationFreshness {
    return calculationFreshness(db, characterId, resolveRealLedgerLineage(db, characterId, lineage));
  }

  static recalculate(
    db: Db,
    characterId: number,
    lineage?: RealLedgerLineage | null,
  ): Record<string, unknown> {
    const owner = resolveRealLedgerLineage(db, characterId, lineage);
    const ownerPredicate = fifoPredicate(owner);
    const lineageValues = fifoLineageValues(owner);
    const previousRun = latestCompletedRun(db, characterId, owner);
    const beforeHash = snapshotHash(db, characterId, owner);
    const runId = 'CALC-' + randomUUID();
    const startedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO real_calculation_runs
        (run_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
         calculation_version, status, started_at, previous_run_id, before_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?)
    `).run(
      runId,
      characterId,
      ...lineageValues,
      P93_CALCULATION_VERSION,
      startedAt,
      previousRun?.run_id ?? null,
      beforeHash,
    );

    try {
      const unsupportedFeeAdjustments = db.prepare(`
        SELECT COUNT(*) AS count FROM real_trade_records
        WHERE character_id = ? AND ${ownerPredicate.sql} AND is_paper = 0
          AND record_state = 'VERIFIED' AND verification_status = 'VERIFIED'
          AND trade_kind = 'FEE_ADJUSTMENT'
      `).get(characterId, ...ownerPredicate.params) as { count: number };
      if (unsupportedFeeAdjustments.count > 0) {
        throw new Error('FEE_ADJUSTMENT 尚未定义安全的费用归属口径，FIFO 重算已阻断。');
      }
      const tx = db.transaction(() => {
        db.prepare(`DELETE FROM real_fifo_consumptions WHERE character_id = ? AND ${ownerPredicate.sql}`)
          .run(characterId, ...ownerPredicate.params);
        db.prepare(`DELETE FROM real_fifo_lots WHERE character_id = ? AND ${ownerPredicate.sql}`)
          .run(characterId, ...ownerPredicate.params);

        const records = db.prepare(`
          SELECT * FROM real_trade_records
          WHERE character_id = ? AND ${ownerPredicate.sql} AND is_paper = 0
            AND record_state = 'VERIFIED' AND verification_status = 'VERIFIED'
            AND trade_kind IN ('BUY', 'SELL', 'PARTIAL_FILL', 'MULTI_BATCH_FILL', 'COST_ADJUSTMENT', 'INVENTORY_TRANSFER')
          ORDER BY trade_time, rowid
        `).all(characterId, ...ownerPredicate.params) as any[];

        for (const record of records) {
          const fees = feeTotals(db, record.record_id);
          const feeUnknown = record.fee_status === 'UNKNOWN' || fees.unknown > 0;
          const direction = record.direction;

          if (record.trade_kind === 'COST_ADJUSTMENT') {
            const lot = db.prepare(`SELECT * FROM real_fifo_lots
              WHERE lot_id = ? AND character_id = ? AND ${ownerPredicate.sql}`)
              .get(record.target_lot_id, characterId, ...ownerPredicate.params) as LotRow | undefined;
            if (!lot) throw new Error(`成本调整目标批次不存在：${record.target_lot_id}`);
            const delta = record.adjustment_mode === 'DECREASE'
              ? -Math.abs(Number(record.adjustment_amount))
              : Math.abs(Number(record.adjustment_amount));
            const remaining = Number(lot.remaining_quantity);
            if (remaining <= 0) throw new Error(`成本调整 ${record.record_id} 的目标批次已无剩余数量。`);
            if (lot.cost_status === 'UNKNOWN' || lot.remaining_cost == null) {
              throw new Error(`成本调整 ${record.record_id} 不能把 UNKNOWN 成本批次改为已知成本。`);
            }
            // base_cost records the original acquisition facts and is intentionally
            // not divided by the remaining quantity. The adjustable valuation basis
            // for an open lot is remaining_cost, which is reduced after FIFO sales
            // and transfers. Adjust that basis directly so a partial consumption
            // cannot inflate the remaining unit cost from the original full-lot cost.
            const nextRemainingCost = roundMoney(Number(lot.remaining_cost) + delta);
            if (nextRemainingCost < -1e-9) throw new Error(`成本调整 ${record.record_id} 会使批次成本变为负数。`);
            const safeRemainingCost = Math.max(0, nextRemainingCost);
            const nextUnit = safeRemainingCost / remaining;
            const nextCostStatus = feeUnknown ? 'PARTIAL' : lot.cost_status;
            db.prepare(`
              UPDATE real_fifo_lots
              SET unit_cost = ?, remaining_cost = ?, cost_status = ?, calculation_version = ?
              WHERE lot_id = ? AND character_id = ? AND ${ownerPredicate.sql}
            `).run(
              roundUnitCost(nextUnit),
              safeRemainingCost,
              nextCostStatus,
              P93_CALCULATION_VERSION,
              lot.lot_id,
              characterId,
              ...ownerPredicate.params,
            );
            continue;
          }

          if (record.trade_kind === 'INVENTORY_TRANSFER') {
            const fromLocationId = Number(record.from_location_id);
            const toLocationId = Number(record.to_location_id);
            let remaining = Number(record.quantity);
            let splitIndex = 0;
            const lots = db.prepare(`
              SELECT * FROM real_fifo_lots
              WHERE character_id = ? AND ${ownerPredicate.sql}
                AND type_id = ? AND location_id = ? AND remaining_quantity > 0
              ORDER BY acquired_at, lot_id
            `).all(characterId, ...ownerPredicate.params, record.type_id, fromLocationId) as LotRow[];
            for (const lot of lots) {
              if (remaining <= 0) break;
              const lotQuantity = Number(lot.remaining_quantity);
              const take = Math.min(remaining, lotQuantity);
              if (take === lotQuantity) {
                db.prepare(`
                  UPDATE real_fifo_lots SET location_id = ?, calculation_version = ?
                  WHERE lot_id = ? AND character_id = ? AND ${ownerPredicate.sql}
                `).run(toLocationId, P93_CALCULATION_VERSION, lot.lot_id, characterId, ...ownerPredicate.params);
              } else {
                const ratio = take / lotQuantity;
                const movedCost = lot.remaining_cost == null ? null : roundMoney(Number(lot.remaining_cost) * ratio);
                const keptCost = lot.remaining_cost == null || movedCost == null
                  ? null
                  : roundMoney(Number(lot.remaining_cost) - movedCost);
                const splitLotId = `LOT-${lot.source_record_id}-TRANSFER-${record.record_id}-${splitIndex++}`;
                db.prepare(`
                  UPDATE real_fifo_lots
                  SET remaining_quantity = ?, remaining_cost = ?, calculation_version = ?
                  WHERE lot_id = ? AND character_id = ? AND ${ownerPredicate.sql}
                `).run(
                  lotQuantity - take,
                  keptCost,
                  P93_CALCULATION_VERSION,
                  lot.lot_id,
                  characterId,
                  ...ownerPredicate.params,
                );
                db.prepare(`
                  INSERT INTO real_fifo_lots
                    (lot_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
                     type_id, location_id, source_record_id, original_quantity, remaining_quantity,
                     base_cost, capitalized_fees, unit_cost, remaining_cost, cost_status,
                     acquired_at, calculation_version)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                  splitLotId,
                  characterId,
                  ...lineageValues,
                  lot.type_id,
                  toLocationId,
                  lot.source_record_id,
                  take,
                  take,
                  movedCost ?? roundMoney(Number(lot.unit_cost ?? 0) * take),
                  0,
                  lot.unit_cost,
                  movedCost,
                  lot.cost_status,
                  lot.acquired_at,
                  P93_CALCULATION_VERSION,
                );
              }
              remaining -= take;
            }
            if (remaining > 0) {
              throw new Error(`库存转移 ${record.record_id} 在来源地点缺少 ${remaining} 个可用 FIFO 批次。`);
            }
            continue;
          }

          if (direction === 'BUY') {
            const baseCost = Number(record.gross_amount);
            const cost = baseCost + fees.capitalized;
            const quantity = Number(record.quantity);
            const unitCost = quantity > 0 ? cost / quantity : null;
            const costStatus = feeUnknown ? 'PARTIAL' : 'KNOWN';
            db.prepare(`
              INSERT INTO real_fifo_lots
                (lot_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
                 type_id, location_id, source_record_id, original_quantity, remaining_quantity,
                 base_cost, capitalized_fees, unit_cost, remaining_cost, cost_status,
                 acquired_at, calculation_version)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              'LOT-' + record.record_id,
              characterId,
              ...lineageValues,
              record.type_id,
              record.location_id,
              record.record_id,
              quantity,
              quantity,
              roundMoney(baseCost),
              roundMoney(fees.capitalized),
              unitCost == null ? null : roundUnitCost(unitCost),
              unitCost == null ? null : roundMoney(unitCost * quantity),
              costStatus,
              record.trade_time,
              P93_CALCULATION_VERSION,
            );
            continue;
          }

          if (direction === 'SELL') {
            let remaining = Number(record.quantity);
            let allocatedSellFeesTotal = 0;
            const totalSellFees = fees.sellExpense;
            const lots = db.prepare(`
              SELECT * FROM real_fifo_lots
              WHERE character_id = ? AND ${ownerPredicate.sql}
                AND type_id = ? AND location_id = ? AND remaining_quantity > 0
              ORDER BY acquired_at, lot_id
            `).all(characterId, ...ownerPredicate.params, record.type_id, record.location_id) as LotRow[];

            for (const lot of lots) {
              if (remaining <= 0) break;
              const lotQuantity = Number(lot.remaining_quantity);
              const take = Math.min(remaining, lotQuantity);
              const isFinalLot = remaining - take <= 0;
              const allocatedSellFees = isFinalLot
                ? roundMoney(totalSellFees - allocatedSellFeesTotal)
                : roundMoney(Number(record.quantity) > 0
                  ? totalSellFees * take / Number(record.quantity)
                  : 0);
              allocatedSellFeesTotal = roundMoney(allocatedSellFeesTotal + allocatedSellFees);
              const lotRemainingCost = lot.remaining_cost == null ? null : Number(lot.remaining_cost);
              const allocatedCost = lotRemainingCost == null
                ? null
                : take === lotQuantity ? roundMoney(lotRemainingCost) : roundMoney(lotRemainingCost * take / lotQuantity);
              const known = !feeUnknown && lot.cost_status === 'KNOWN' && lot.unit_cost != null && allocatedCost != null;
              const realized = known
                ? roundMoney(Number(record.unit_price) * take - allocatedCost - allocatedSellFees)
                : null;
              db.prepare(`
                INSERT INTO real_fifo_consumptions
                  (consumption_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
                   sell_record_id, lot_id, type_id, location_id, quantity, unit_cost,
                   allocated_sell_fees, realized_pnl, pnl_status, calculation_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                'CONS-' + randomUUID(),
                characterId,
                ...lineageValues,
                record.record_id,
                lot.lot_id,
                record.type_id,
                record.location_id,
                take,
                lot.unit_cost,
                roundMoney(allocatedSellFees),
                realized,
                realized == null ? 'UNKNOWN_COST' : 'CALCULATED',
                P93_CALCULATION_VERSION,
              );
              remaining -= take;
              const nextRemaining = lotQuantity - take;
              const nextRemainingCost = allocatedCost == null || lotRemainingCost == null
                ? null
                : roundMoney(lotRemainingCost - allocatedCost);
              db.prepare(`
                UPDATE real_fifo_lots
                SET remaining_quantity = ?, remaining_cost = ?, calculation_version = ?
                WHERE lot_id = ? AND character_id = ? AND ${ownerPredicate.sql}
              `).run(
                nextRemaining,
                nextRemainingCost,
                P93_CALCULATION_VERSION,
                lot.lot_id,
                characterId,
                ...ownerPredicate.params,
              );
            }

            if (remaining > 0) {
              const allocatedSellFees = roundMoney(totalSellFees - allocatedSellFeesTotal);
              db.prepare(`
                INSERT INTO real_fifo_consumptions
                  (consumption_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
                   sell_record_id, lot_id, type_id, location_id, quantity, unit_cost,
                   allocated_sell_fees, realized_pnl, pnl_status, calculation_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'UNKNOWN_SOURCE', ?, ?, ?, NULL, ?, NULL, 'UNKNOWN_COST', ?)
              `).run(
                'CONS-' + randomUUID(),
                characterId,
                ...lineageValues,
                record.record_id,
                record.type_id,
                record.location_id,
                remaining,
                roundMoney(allocatedSellFees),
                P93_CALCULATION_VERSION,
              );
            }
          }
        }

        const totals = db.prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN pnl_status = 'CALCULATED' THEN realized_pnl ELSE 0 END), 0) AS realized,
            SUM(CASE WHEN pnl_status = 'UNKNOWN_COST' THEN 1 ELSE 0 END) AS unknown_count
          FROM real_fifo_consumptions WHERE character_id = ? AND ${ownerPredicate.sql}
        `).get(characterId, ...ownerPredicate.params) as any;
        const afterHash = snapshotHash(db, characterId, owner);
        const before = previousRun ? {
          realizedPnl: previousRun.realized_pnl,
          unknownCostCount: previousRun.unknown_cost_count,
          afterHash: previousRun.after_hash,
        } : null;
        const after = {
          realizedPnl: roundMoney(Number(totals.realized || 0)),
          unknownCostCount: Number(totals.unknown_count || 0),
          afterHash,
        };
        db.prepare(`
          UPDATE real_calculation_runs
          SET status = 'COMPLETED', completed_at = ?, record_count = ?,
              realized_pnl = ?, unknown_cost_count = ?, after_hash = ?, differences_json = ?
          WHERE run_id = ? AND character_id = ? AND ${ownerPredicate.sql}
        `).run(
          new Date().toISOString(),
          records.length,
          after.realizedPnl,
          after.unknownCostCount,
          afterHash,
          JSON.stringify({ before, after }),
          runId,
          characterId,
          ...ownerPredicate.params,
        );
      });
      tx();
    } catch (error) {
      db.prepare(`
        UPDATE real_calculation_runs
        SET status = 'FAILED', completed_at = ?, error = ?
        WHERE run_id = ? AND character_id = ? AND ${ownerPredicate.sql}
      `).run(
        new Date().toISOString(),
        error instanceof Error ? error.message : String(error),
        runId,
        characterId,
        ...ownerPredicate.params,
      );
      throw error;
    }

    return db.prepare(`SELECT * FROM real_calculation_runs
      WHERE run_id = ? AND character_id = ? AND ${ownerPredicate.sql}`)
      .get(runId, characterId, ...ownerPredicate.params) as Record<string, unknown>;
  }

  static performance(
    db: Db,
    characterId: number,
    lineage?: AssetLineage | null,
  ): P93Performance {
    const owner = resolveRealLedgerLineage(db, characterId, lineage);
    const ownerPredicate = fifoPredicate(owner);
    const consumptionPredicate = fifoAliasPredicate('c', owner);
    const consumption = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN pnl_status = 'CALCULATED' THEN realized_pnl ELSE 0 END), 0) AS known_pnl,
        SUM(CASE WHEN pnl_status = 'UNKNOWN_COST' THEN 1 ELSE 0 END) AS unknown_count,
        COUNT(*) AS consumption_count
      FROM real_fifo_consumptions WHERE character_id = ? AND ${ownerPredicate.sql}
    `).get(characterId, ...ownerPredicate.params) as any;
    const trades = db.prepare(`
      SELECT
        COUNT(*) AS trade_count,
        COALESCE(SUM(CASE WHEN direction = 'BUY' THEN gross_amount ELSE 0 END), 0) AS buy_amount,
        COALESCE(SUM(CASE WHEN direction = 'SELL' THEN gross_amount ELSE 0 END), 0) AS sell_amount
      FROM real_trade_records
      WHERE character_id = ? AND ${ownerPredicate.sql}
        AND record_state = 'VERIFIED' AND verification_status = 'VERIFIED' AND is_paper = 0
        AND trade_kind IN ('BUY', 'SELL', 'PARTIAL_FILL', 'MULTI_BATCH_FILL')
    `).get(characterId, ...ownerPredicate.params) as any;
    const fees = db.prepare(`
      SELECT COALESCE(SUM(f.amount), 0) AS total,
             SUM(CASE WHEN f.treatment = 'UNKNOWN' THEN 1 ELSE 0 END) AS unknown_rows
      FROM real_trade_fees f
      JOIN real_trade_records r ON r.record_id = f.record_id
      WHERE r.character_id = ? AND ${fifoAliasPredicate('r', owner).sql}
        AND r.record_state = 'VERIFIED' AND r.verification_status = 'VERIFIED'
        AND r.is_paper = 0 AND r.fee_status = 'COMPLETE' AND f.treatment <> 'UNRELATED'
    `).get(characterId, ...fifoAliasPredicate('r', owner).params) as any;
    const unknownFeeTrades = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM real_trade_records
      WHERE character_id = ? AND ${ownerPredicate.sql}
        AND record_state = 'VERIFIED' AND verification_status = 'VERIFIED'
        AND is_paper = 0 AND fee_status = 'UNKNOWN'
    `).get(characterId, ...ownerPredicate.params) as any)?.n || 0);
    const lots = db.prepare(`
      SELECT
        COUNT(*) AS lot_count,
        COALESCE(SUM(CASE WHEN cost_status = 'KNOWN' THEN remaining_cost ELSE 0 END), 0) AS known_cost,
        SUM(CASE WHEN cost_status <> 'KNOWN' AND remaining_quantity > 0 THEN 1 ELSE 0 END) AS unknown_count,
        COALESCE(SUM(CASE WHEN cost_status = 'KNOWN' THEN remaining_cost ELSE 0 END), 0) AS capital
      FROM real_fifo_lots WHERE character_id = ? AND ${ownerPredicate.sql} AND remaining_quantity > 0
    `).get(characterId, ...ownerPredicate.params) as any;
    // Unknown sold cost invalidates realized P&L; unknown OPEN lots only
    // invalidate inventory valuation and capital occupation.
    const unknownConsumptionCount = Number(consumption?.unknown_count || 0);
    const unknownOpenLotCount = Number(lots?.unknown_count || 0);
    const unknownCostCount = unknownConsumptionCount + unknownOpenLotCount;
    const realizedPnl = unknownConsumptionCount > 0 ? null : roundMoney(Number(consumption?.known_pnl || 0));

    const sellStats = db.prepare(`
      WITH sell_pnl AS (
        SELECT c.sell_record_id,
               CASE WHEN SUM(CASE WHEN c.pnl_status = 'UNKNOWN_COST' THEN 1 ELSE 0 END) > 0 THEN NULL
                    ELSE SUM(c.realized_pnl) END AS pnl
        FROM real_fifo_consumptions c
        JOIN real_trade_records r ON r.record_id = c.sell_record_id
        WHERE c.character_id = ? AND ${consumptionPredicate.sql}
          AND r.record_state = 'VERIFIED'
          AND r.verification_status = 'VERIFIED' AND r.is_paper = 0 AND r.direction = 'SELL'
        GROUP BY c.sell_record_id
      )
      SELECT SUM(CASE WHEN pnl IS NOT NULL THEN 1 ELSE 0 END) AS deterministic_sell_count,
             SUM(CASE WHEN pnl IS NULL THEN 1 ELSE 0 END) AS unknown_cost_sell_count,
             SUM(CASE WHEN pnl IS NOT NULL AND pnl > 0 THEN 1 ELSE 0 END) AS profitable_sells
      FROM sell_pnl
    `).get(characterId, ...consumptionPredicate.params) as any;
    const deterministicSellCount = Number(sellStats?.deterministic_sell_count || 0);
    const unknownCostSellCount = Number(sellStats?.unknown_cost_sell_count || 0);
    const profitableTradeRatio = deterministicSellCount === 0
      ? null
      : Number(sellStats?.profitable_sells || 0) / deterministicSellCount;

    const holding = db.prepare(`
      SELECT AVG(julianday(s.trade_time) - julianday(b.trade_time)) AS days
      FROM real_fifo_consumptions c
      JOIN real_trade_records s ON s.record_id = c.sell_record_id
      JOIN real_fifo_lots l ON l.lot_id = c.lot_id
      JOIN real_trade_records b ON b.record_id = l.source_record_id
      WHERE c.character_id = ? AND ${consumptionPredicate.sql}
        AND c.pnl_status = 'CALCULATED'
    `).get(characterId, ...consumptionPredicate.params) as any;

    const group = (column: 'type_id' | 'location_id') => db.prepare(`
      SELECT ${column} AS key,
             COALESCE(SUM(CASE WHEN c.pnl_status = 'CALCULATED' THEN c.realized_pnl ELSE 0 END), 0) AS known_pnl,
             SUM(CASE WHEN c.pnl_status = 'UNKNOWN_COST' THEN 1 ELSE 0 END) AS unknown_count,
             COUNT(DISTINCT c.sell_record_id) AS trade_count
      FROM real_fifo_consumptions c
      WHERE c.character_id = ? AND ${consumptionPredicate.sql}
      GROUP BY ${column}
      ORDER BY key
    `).all(characterId, ...consumptionPredicate.params) as any[];

    const planOwnership = p9LineagePredicate('p', lineage);
    const opportunityOwnership = p9LineagePredicate('o', lineage);
    const byStrategy = db.prepare(`
      SELECT COALESCE(p.strategy, o.strategy) AS strategy,
             COALESCE(SUM(CASE WHEN c.pnl_status = 'CALCULATED' THEN c.realized_pnl ELSE 0 END), 0) AS known_pnl,
             SUM(CASE WHEN c.pnl_status = 'UNKNOWN_COST' THEN 1 ELSE 0 END) AS unknown_count,
             COUNT(DISTINCT c.sell_record_id) AS trade_count
      FROM real_fifo_consumptions c
      JOIN real_trade_records r ON r.record_id = c.sell_record_id
      LEFT JOIN p9_trade_plans p
        ON p.plan_id = r.plan_id AND ${planOwnership.sql}
      LEFT JOIN p9_real_opportunities o
        ON o.opportunity_id = r.opportunity_id AND ${opportunityOwnership.sql}
      WHERE c.character_id = ? AND ${consumptionPredicate.sql}
        AND r.is_paper = 0
      GROUP BY COALESCE(p.strategy, o.strategy)
      ORDER BY strategy
    `).all(
      ...planOwnership.params,
      ...opportunityOwnership.params,
      characterId,
      ...consumptionPredicate.params,
    ) as any[];

    const singleTradePnl = db.prepare(`
      SELECT c.sell_record_id AS recordId,
             CASE WHEN SUM(CASE WHEN c.pnl_status = 'UNKNOWN_COST' THEN 1 ELSE 0 END) > 0 THEN NULL
                  ELSE ROUND(SUM(c.realized_pnl), 2) END AS pnl
      FROM real_fifo_consumptions c
      JOIN real_trade_records r ON r.record_id = c.sell_record_id AND r.is_paper = 0
      WHERE c.character_id = ? AND ${consumptionPredicate.sql}
      GROUP BY c.sell_record_id
      ORDER BY recordId
    `).all(characterId, ...consumptionPredicate.params) as any[];

    return {
      freshness: calculationFreshness(db, characterId, owner),
      realizedPnl,
      knownRealizedPnl: roundMoney(Number(consumption?.known_pnl || 0)),
      unrealizedPnl: this.unrealized(db, characterId, lineage).unrealizedPnl as number | null,
      totalFees: unknownFeeTrades > 0 || Number(fees?.unknown_rows || 0) > 0 ? null : roundMoney(Number(fees?.total || 0)),
      cumulativeBuyAmount: roundMoney(Number(trades?.buy_amount || 0)),
      cumulativeSellAmount: roundMoney(Number(trades?.sell_amount || 0)),
      inventoryCost: unknownOpenLotCount > 0 ? null : roundMoney(Number(lots?.known_cost || 0)),
      capitalOccupied: unknownOpenLotCount > 0 ? null : roundMoney(Number(lots?.capital || 0)),
      tradeCount: Number(trades?.trade_count || 0),
      profitableTradeRatio,
      averageHoldingDays: holding?.days == null ? null : Number(holding.days),
      singleTradePnl,
      byType: group('type_id').map((row) => ({ typeId: row.key, realizedPnl: row.unknown_count ? null : roundMoney(row.known_pnl), tradeCount: row.trade_count })),
      byLocation: group('location_id').map((row) => ({ locationId: row.key, realizedPnl: row.unknown_count ? null : roundMoney(row.known_pnl), tradeCount: row.trade_count })),
      byStrategy: byStrategy.map((row) => ({ strategy: row.strategy ?? null, realizedPnl: row.unknown_count ? null : roundMoney(row.known_pnl), tradeCount: row.trade_count })),
      unknownConsumptionCount,
      unknownOpenLotCount,
      unknownCostSellCount,
      deterministicSellCount,
      unknownCostCount,
    };
  }

  static unrealized(
    db: Db,
    characterId: number,
    lineage?: AssetLineage | null,
  ): Record<string, unknown> {
    const owner = resolveRealLedgerLineage(db, characterId, lineage);
    const lotOwnership = fifoPredicate(owner);
    const lotRows = db.prepare(`
      SELECT type_id, location_id, SUM(remaining_quantity) AS quantity,
             SUM(COALESCE(remaining_cost, 0)) AS known_cost,
             SUM(CASE WHEN cost_status <> 'KNOWN' THEN 1 ELSE 0 END) AS unknown_lots
      FROM real_fifo_lots
      WHERE character_id = ? AND ${lotOwnership.sql} AND remaining_quantity > 0
      GROUP BY type_id, location_id
    `).all(characterId, ...lotOwnership.params) as any[];
    const costKnown = lotRows.every((row) => Number(row.unknown_lots || 0) === 0);
    const inventoryCost = costKnown ? roundMoney(lotRows.reduce((sum, row) => sum + Number(row.known_cost || 0), 0)) : null;

    const snapshotOwnership = owner
      ? assetLineagePredicate(null, owner)
      : { sql: 'owner_user_id IS NULL AND owner_chat_id IS NULL AND binding_epoch = 0', params: [] };
    const latestSnapshot = db.prepare(`
      SELECT snapshot_id FROM real_asset_snapshots
      WHERE character_id = ? AND status = 'COMPLETED' AND ${snapshotOwnership.sql}
      ORDER BY completed_at DESC, snapshot_id DESC LIMIT 1
    `).get(characterId, ...snapshotOwnership.params) as any;
    const valuationOwnership = snapshotOwnership;
    const latest = latestSnapshot ? db.prepare(`
      SELECT valuation_id, snapshot_id, market_snapshot_at, fee_model_version
      FROM real_asset_valuations
      WHERE character_id = ? AND snapshot_id = ? AND status = 'COMPLETED'
        AND ${valuationOwnership.sql}
      ORDER BY created_at DESC, valuation_id DESC LIMIT 1
    `).get(characterId, latestSnapshot.snapshot_id, ...valuationOwnership.params) as any : null;
    const valuationRows = latest ? db.prepare(`
      SELECT si.type_id, si.location_id, SUM(vi.quantity) AS quantity,
             SUM(vi.market_reference_value) AS market_reference_value,
             SUM(vi.bid_liquidation_net) AS bid_liquidation_net,
             SUM(vi.ask_replacement_gross) AS ask_replacement_gross,
             SUM(vi.ask_replacement_net) AS ask_replacement_net
      FROM real_asset_valuation_items vi
      JOIN real_asset_snapshot_items si ON si.item_id = vi.item_id AND si.snapshot_id = ?
      WHERE vi.valuation_id = ?
      GROUP BY si.type_id, si.location_id
    `).all(latest.snapshot_id, latest.valuation_id) as any[] : [];

    const mapKey = (row: any) => `${row.type_id}:${row.location_id}`;
    const lotMap = new Map(lotRows.map((row) => [mapKey(row), row]));
    const valMap = new Map(valuationRows.map((row) => [mapKey(row), row]));
    const quantityMatched = lotRows.length === valuationRows.length && [...lotMap.entries()]
      .every(([key, row]) => Number(valMap.get(key)?.quantity || 0) === Number(row.quantity || 0));

    const perspective = (field: 'market_reference_value' | 'bid_liquidation_net' | 'ask_replacement_gross' | 'ask_replacement_net') => {
      const valuation = valuationRows.length === 0 ? null : roundMoney(valuationRows.reduce((sum, row) => sum + Number(row[field] || 0), 0));
      return {
        label: {
          market_reference_value: '市场参考价值（非实际可变现价值）',
          bid_liquidation_net: '买单逐档清算净值',
          ask_replacement_gross: '卖单逐档重置总值',
          ask_replacement_net: '卖单逐档重置净值',
        }[field],
        valuation,
        costBasis: inventoryCost,
        unrealizedPnl: valuation != null && inventoryCost != null && quantityMatched ? roundMoney(valuation - inventoryCost) : null,
        status: valuation == null ? 'N/A_NO_VALUATION' : !quantityMatched ? 'N/A_QUANTITY_MISMATCH' : inventoryCost == null ? 'N/A_UNKNOWN_COST' : 'CALCULATED',
      };
    };

    return {
      valuationId: latest?.valuation_id ?? null,
      snapshotId: latestSnapshot?.snapshot_id ?? null,
      marketSnapshotAt: latest?.market_snapshot_at ?? null,
      feeModelVersion: latest?.fee_model_version ?? null,
      quantityMatched,
      inventoryCost,
      perspectives: {
        marketReference: perspective('market_reference_value'),
        bidLiquidationNet: perspective('bid_liquidation_net'),
        askReplacementGross: perspective('ask_replacement_gross'),
        askReplacementNet: perspective('ask_replacement_net'),
      },
      unrealizedPnl: quantityMatched && costKnown && valuationRows.length > 0
        ? roundMoney(Number(valuationRows.reduce((sum, row) => sum + Number(row.market_reference_value || 0), 0)) - Number(inventoryCost))
        : null,
    };
  }
}
