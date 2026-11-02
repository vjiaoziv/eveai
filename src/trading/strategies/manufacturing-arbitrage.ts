import type { Db } from '../../db/sqlite.js';
import { DataCenter } from '../data-center.js';

export interface ReprocessAnalysis {
  typeId: number;
  name: string;
  enName: string;
  portionSize: number;
  stationSellPrice: number;
  stationBuyPrice: number;
  reprocessYieldPct: number;
  minerals: Array<{
    typeId: number;
    name: string;
    quantity: number;
    unitBuyPrice: number;
    totalIsk: number;
  }>;
  totalMineralValue: number;
  recommendation: 'reprocess' | 'sell_direct' | 'hold';
  netDifferenceIsk: number;
  rationale: string;
}

export class ManufacturingArbitrageStrategy {
  /**
   * Analyze whether an item is worth reprocessing into minerals vs selling directly
   */
  public static analyzeReprocessing(
    db: Db,
    typeId: number,
    stationId = 60003760, // Default Jita 4-4
    regionId = 10000002,  // Default The Forge
    yieldPct = 0.50,      // Default 50% NPC base station yield
  ): ReprocessAnalysis | null {
    const meta = DataCenter.getItemMetadata(db, typeId);
    if (!meta) return null;

    const portionSize = meta.portion_size || 1;

    // 1. Get direct market prices at target station
    const orders = DataCenter.getOrderBook(db, regionId, typeId, stationId);
    const stationSellPrice = orders.sells[0]?.price || 0;
    const stationBuyPrice = orders.buys[0]?.price || 0;

    // 2. Get materials from SDE
    const matRow = db.prepare('SELECT data_json FROM sde_type_materials WHERE type_id = ?').get(typeId) as any;
    if (!matRow) return null;

    const matData = JSON.parse(matRow.data_json);
    const rawMaterials: Array<{ materialTypeID: number; quantity: number }> = matData.materials || [];
    if (rawMaterials.length === 0) return null;

    let totalMineralValue = 0;
    const mineralList: ReprocessAnalysis['minerals'] = [];

    for (const m of rawMaterials) {
      const mMeta = DataCenter.getItemMetadata(db, m.materialTypeID);
      const mOrders = DataCenter.getOrderBook(db, regionId, m.materialTypeID, stationId);
      const mBuyPrice = mOrders.buys[0]?.price || 0;
      const yieldedQty = Math.floor(m.quantity * yieldPct);
      const totalIsk = yieldedQty * mBuyPrice;
      totalMineralValue += totalIsk;

      mineralList.push({
        typeId: m.materialTypeID,
        name: mMeta?.zh_name || mMeta?.en_name || `Type ${m.materialTypeID}`,
        quantity: yieldedQty,
        unitBuyPrice: mBuyPrice,
        totalIsk,
      });
    }

    // 3. Compare with direct sell (after 5.36% sales tax on eat buy order)
    const netDirectBuyIsk = stationBuyPrice * (1 - 0.0536);
    let recommendation: 'reprocess' | 'sell_direct' | 'hold' = 'hold';
    let netDifferenceIsk = 0;
    let rationale = '';

    if (totalMineralValue > netDirectBuyIsk && totalMineralValue > 5_000) {
      recommendation = 'reprocess';
      netDifferenceIsk = Math.round(totalMineralValue - netDirectBuyIsk);
      rationale = `建议再处理解体：解体产出矿物按买单变现估值 ${Math.round(totalMineralValue).toLocaleString()} ISK，高于直接出售净收益 ${Math.round(netDirectBuyIsk).toLocaleString()} ISK（多赚 +${netDifferenceIsk.toLocaleString()} ISK）。`;
    } else if (stationBuyPrice > 0) {
      recommendation = 'sell_direct';
      netDifferenceIsk = Math.round(netDirectBuyIsk - totalMineralValue);
      rationale = `建议直接出售：当前买单可变现 ${Math.round(netDirectBuyIsk).toLocaleString()} ISK，高于解体矿物价值 ${Math.round(totalMineralValue).toLocaleString()} ISK（直接出售多赚 +${netDifferenceIsk.toLocaleString()} ISK）。`;
    } else {
      recommendation = 'hold';
      rationale = '当前空间站暂无买单，建议保留或挂单出售。';
    }

    return {
      typeId,
      name: meta.zh_name || meta.en_name,
      enName: meta.en_name,
      portionSize,
      stationSellPrice,
      stationBuyPrice,
      reprocessYieldPct: yieldPct,
      minerals: mineralList,
      totalMineralValue: Math.round(totalMineralValue),
      recommendation,
      netDifferenceIsk,
      rationale,
    };
  }
}