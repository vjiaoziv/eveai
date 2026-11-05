import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS } from './fee-engine.js';
import { getCharacterDatasetStatuses } from '../eve/character-sync.js';
import { assetLineagePredicate, type AssetLineage } from '../assets/asset-lineage.js';
import { activeOrders, assetLocations, locationItems, walletSummary } from '../web/profile-data.js';
import type { P9InventoryLot } from './p9-types.js';
import { P93FifoService } from './p9-3-fifo-service.js';
import { P93LedgerService } from './p9-3-ledger-service.js';
import { realLedgerLineagePredicate } from './p9-3-lineage.js';
import { p9LineagePredicate } from './p9-control-plane-lineage.js';

const DEFAULT_FEE_CONTEXT = {
  clone: 'alpha' as const,
  skills: ALPHA_DEFAULT_SKILLS,
  facility: 'npc_station' as const,
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseLot(row: any): P9InventoryLot {
  return {
    lotId: row.lot_id,
    characterId: row.character_id,
    itemId: row.item_id,
    typeId: row.type_id,
    locationId: row.location_id,
    quantity: row.quantity,
    originalQuantity: row.original_quantity,
    costPerUnit: row.cost_per_unit,
    costStatus: row.cost_status,
    source: row.source,
    acquiredAt: row.acquired_at,
    tradeId: row.trade_id || undefined,
    opportunityId: row.opportunity_id || undefined,
    notes: row.notes || undefined,
  };
}

function exitValue(db: Db, typeId: number, locationId: number, quantity: number): { gross: number; net: number; depthLimited: boolean } {
  let remaining = quantity;
  let gross = 0;
  const bids = db.prepare(`
    SELECT price, volume_remain FROM market_orders
    WHERE type_id = ? AND location_id = ? AND is_buy_order = 1 AND volume_remain > 0
    ORDER BY price DESC
  `).all(typeId, locationId) as any[];
  for (const bid of bids) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(bid.volume_remain));
    gross += take * Number(bid.price);
    remaining -= take;
  }
  if (remaining > 0) {
    // Without a bid the cost price is only a fallback reference, never a claim
    // that the item can be sold at that price.
    gross += remaining * 0;
  }
  const rates = FeeEngine.calculateRates(DEFAULT_FEE_CONTEXT);
  const net = gross * (1 - rates.salesTaxRate - rates.brokerFeeRate);
  return { gross: round2(gross), net: round2(net), depthLimited: remaining > 0 || bids.length === 0 };
}

export class P9RealPortfolioService {
  /** @deprecated Retired legacy writer. Production REAL writes must use P93LedgerService. */
  public static upsertManualLot(
    db: Db,
    characterId: number,
    input: {
      itemId?: number | null;
      typeId: number;
      locationId: number;
      quantity: number;
      costPerUnit?: number | null;
      acquiredAt?: string;
      notes?: string;
    },
  ): P9InventoryLot {
    if (!Number.isSafeInteger(input.typeId) || input.typeId <= 0) throw new Error('typeId 无效。');
    if (!Number.isSafeInteger(input.locationId) || input.locationId <= 0) throw new Error('locationId 无效。');
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new Error('库存数量必须为正整数。');
    if (input.costPerUnit != null && (!Number.isFinite(input.costPerUnit) || input.costPerUnit < 0)) {
      throw new Error('采购成本必须为非负数，或留空表示 UNKNOWN。');
    }
    const itemId = input.itemId ?? null;
    const existing = itemId == null
      ? undefined
      : db.prepare('SELECT * FROM p9_inventory_lots WHERE character_id = ? AND item_id = ?').get(characterId, itemId) as any;
    const now = new Date().toISOString();
    const costStatus = input.costPerUnit == null ? 'UNKNOWN' : 'CONFIRMED';

    if (existing) {
      db.prepare(`
        UPDATE p9_inventory_lots
        SET quantity = ?, original_quantity = ?, cost_per_unit = ?, cost_status = ?,
            location_id = ?, acquired_at = ?, notes = COALESCE(?, notes), updated_at = ?
        WHERE lot_id = ? AND character_id = ?
      `).run(
        input.quantity,
        Math.max(input.quantity, Number(existing.original_quantity || input.quantity)),
        input.costPerUnit ?? null,
        costStatus,
        input.locationId,
        input.acquiredAt || now,
        input.notes ?? null,
        now,
        existing.lot_id,
        characterId,
      );
      db.prepare(`
        INSERT INTO p9_trade_audit_events (character_id, lot_id, action, before_json, after_json, actor)
        VALUES (?, ?, 'manual_lot_updated', ?, ?, 'user')
      `).run(characterId, existing.lot_id, JSON.stringify(existing), JSON.stringify(input));
      return parseLot(db.prepare('SELECT * FROM p9_inventory_lots WHERE lot_id = ?').get(existing.lot_id) as any);
    }

    const lotId = 'P9LOT-' + Date.now() + '-' + randomUUID().slice(0, 8);
    db.prepare(`
      INSERT INTO p9_inventory_lots
        (lot_id, character_id, item_id, type_id, location_id, quantity, original_quantity,
         cost_per_unit, cost_status, source, acquired_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)
    `).run(
      lotId,
      characterId,
      itemId,
      input.typeId,
      input.locationId,
      input.quantity,
      input.quantity,
      input.costPerUnit ?? null,
      costStatus,
      input.acquiredAt || now,
      input.notes || null,
    );
    db.prepare(`
      INSERT INTO p9_trade_audit_events (character_id, lot_id, action, after_json, actor)
      VALUES (?, ?, 'manual_lot_created', ?, 'user')
    `).run(characterId, lotId, JSON.stringify(input));
    return parseLot(db.prepare('SELECT * FROM p9_inventory_lots WHERE lot_id = ?').get(lotId) as any);
  }

  public static overview(db: Db, characterId: number, lineage: AssetLineage) {
    const accounting = P93FifoService.performance(db, characterId, lineage);
    const ledgerSummary = P93LedgerService.summary(db, characterId, lineage);
    const ledgerOwnership = realLedgerLineagePredicate(null, lineage);
    const fifoLots = db.prepare(`
      SELECT COUNT(*) AS lot_count,
             SUM(CASE WHEN remaining_quantity > 0 THEN 1 ELSE 0 END) AS active_lot_count
      FROM real_fifo_lots
      WHERE character_id = ? AND ${ledgerOwnership.sql}
    `).get(characterId, ...ledgerOwnership.params) as any;
    const wallet = walletSummary(db, characterId);
    const orders = activeOrders(db, characterId, 500, 0);
    const sync = getCharacterDatasetStatuses(db, characterId, ['wallet', 'assets', 'orders']);
    const assetOwnership = assetLineagePredicate(null, lineage);
    const rawAssetCount = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM character_assets
      WHERE character_id = ? AND ${assetOwnership.sql}
    `).get(characterId, ...assetOwnership.params) as any)?.n || 0);
    const opportunityOwnership = p9LineagePredicate(null, lineage);
    const opportunities = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN state = 'ACTIONABLE' THEN 1 ELSE 0 END) AS actionable,
             SUM(CASE WHEN state = 'WATCHING' THEN 1 ELSE 0 END) AS watching,
             SUM(CASE WHEN state = 'STALE' OR state = 'EXPIRED' THEN 1 ELSE 0 END) AS stale
      FROM p9_real_opportunities
      WHERE character_id = ? AND ${opportunityOwnership.sql}
    `).get(characterId, ...opportunityOwnership.params) as any;

    return {
      wallet: {
        balance: wallet.balance,
        availableIsk: wallet.balance,
        syncedAt: sync.find((item) => item.dataset === 'wallet')?.synced_at || null,
      },
      funding: {
        availableIsk: wallet.balance,
        openOrderEscrow: orders.totals.escrowTotal,
        knownInventoryCost: accounting.inventoryCost,
        unknownInventoryExitValue: null,
        otherUnknown: null,
        note: 'REAL 财务指标来自 P9.3 已核实 FIFO；PAPER 不进入本统计。',
      },
      inventory: {
        lotCount: Number(fifoLots?.active_lot_count || 0),
        knownCost: accounting.inventoryCost,
        unknownLotCount: accounting.unknownOpenLotCount,
        unknownExitValue: null,
        rawAssetCount,
      },
      performance: {
        freshness: accounting.freshness,
        realizedNetPnl: accounting.realizedPnl,
        knownRealizedPnl: accounting.knownRealizedPnl,
        realizedMoveCount: accounting.deterministicSellCount,
        feesPaid: accounting.totalFees,
        unknownCostMoveCount: accounting.unknownCostCount,
        unknownConsumptionCount: accounting.unknownConsumptionCount,
        unknownOpenLotCount: accounting.unknownOpenLotCount,
        unknownCostSellCount: accounting.unknownCostSellCount,
        deterministicSellCount: accounting.deterministicSellCount,
        unrealizedPnl: accounting.unrealizedPnl,
        tradeCount: accounting.tradeCount,
        profitableTradeRatio: accounting.profitableTradeRatio,
        averageHoldingDays: accounting.averageHoldingDays,
      },
      ledger: {
        rows: ledgerSummary.rows,
        totals: ledgerSummary.totals,
      },
      opportunities: {
        total: Number(opportunities?.total || 0),
        actionable: Number(opportunities?.actionable || 0),
        watching: Number(opportunities?.watching || 0),
        staleOrExpired: Number(opportunities?.stale || 0),
      },
      sync: sync.map((item) => ({
        dataset: item.dataset,
        status: item.status,
        syncedAt: item.synced_at,
        expiresAt: item.expires_at,
        error: item.error,
      })),
      dataFreshness: {
        wallet: sync.find((item) => item.dataset === 'wallet')?.status || 'unknown',
        assets: sync.find((item) => item.dataset === 'assets')?.status || 'unknown',
        orders: sync.find((item) => item.dataset === 'orders')?.status || 'unknown',
      },
    };
  }

  public static inventory(db: Db, characterId: number, lineage: AssetLineage) {
    // The legacy p9_inventory_lots/p9_inventory_moves tables have no durable
    // owner lineage and are retired. This projection deliberately reads only
    // lineage-scoped ESI asset mirrors; financial cost comes from P93 FIFO.
    const locations = assetLocations(db, characterId, 200, 0, lineage).locations;
    const raw: Array<{ itemId: number; typeId: number; typeName: string | null; quantity: number; locationId: number }> = [];
    for (const location of locations) {
      const items = locationItems(db, characterId, location.locationId, 2000, 0, lineage).items;
      for (const item of items) {
        raw.push({
          itemId: item.itemId,
          typeId: item.typeId,
          typeName: item.typeName,
          quantity: item.quantity,
          locationId: location.locationId,
        });
      }
    }
    const rawRows = raw.map((item) => {
      const value = exitValue(db, item.typeId, item.locationId, item.quantity);
      return {
        itemId: item.itemId,
        typeId: item.typeId,
        typeName: item.typeName,
        locationId: item.locationId,
        quantity: item.quantity,
        confirmedCostPerUnit: null,
        costStatus: 'UNKNOWN',
        lotId: null,
        executableExitGross: value.gross,
        executableExitNet: value.net,
        depthLimited: value.depthLimited,
        unrealizedPnl: null,
        source: 'esi_character_assets',
      };
    });

    return { lots: [] as P9InventoryLot[], rawAssets: rawRows, totalRawAssets: rawRows.length };
  }

}
