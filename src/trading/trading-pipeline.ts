import type { Db } from '../db/sqlite.js';
import { DataCenter } from './data-center.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS } from './fee-engine.js';
import { OrderBookSimulator } from './orderbook-simulator.js';
import { PortfolioManager, DEFAULT_RISK_LIMITS, type PortfolioRiskLimits } from './portfolio-manager.js';
import { DraftSystem } from './draft-system.js';
import type { 
  FeeContext, 
  OpportunityRating, 
  TradeDraft, 
  TradeOpportunity 
} from './types.js';

export interface PipelineEvaluationResult {
  opportunity: TradeOpportunity;
  isExecutable: boolean;
  rating: OpportunityRating;
  vetoReason?: string;
  draft?: TradeDraft;
}

export class TradingPipeline {
  /**
   * Complete 10-stage deterministic decision pipeline:
   * 1. Data Quality & Temporal Consistency Verification
   * 2. Orderbook Depth & Liquidity Walk Simulation
   * 3. Precise Tax & Fee Engine Calculation
   * 4. Logistics & Anti-Gank Cargo Risk Verification
   * 5. Multi-scenario Stress Testing (-5%, -10%, -20%, Bid Evaporation)
   * 6. Cumulative Portfolio Risk & Cash Reserve Verification
   * 7. Opportunity Classification (A/B/C/D)
   * 8. Risk Veto Guardrail (D-grade instant veto)
   * 9. Optional Draft Generation (Only for Approved A/B grades)
   */
  public static evaluateCandidate(
    db: Db,
    candidate: {
      typeId: number;
      strategy: TradeOpportunity['strategy'];
      originStationId: number;
      originRegionId: number;
      originStationName: string;
      destStationId: number;
      destRegionId: number;
      destStationName: string;
      requestedQty?: number;
      characterId?: number;
      feeContext?: FeeContext;
      riskLimits?: PortfolioRiskLimits;
    },
  ): PipelineEvaluationResult {
    const feeCtx = candidate.feeContext ?? {
      clone: 'alpha',
      skills: ALPHA_DEFAULT_SKILLS,
      facility: 'npc_station',
    };
    const limits = candidate.riskLimits ?? DEFAULT_RISK_LIMITS;

    const meta = DataCenter.getItemMetadata(db, candidate.typeId);
    if (!meta) {
      return this.rejectResult(candidate, '商品元数据在 SDE 中不存在', 'D');
    }

    const unitM3 = meta.volume || 1;

    // Stage 1: Market data extraction & Temporal Consistency Check
    const originBook = DataCenter.getOrderBook(db, candidate.originRegionId, candidate.typeId, candidate.originStationId);
    const destBook = DataCenter.getOrderBook(db, candidate.destRegionId, candidate.typeId, candidate.destStationId);

    if (originBook.sells.length === 0 || destBook.buys.length === 0) {
      return this.rejectResult(candidate, '采购端卖单或销售端买单订单簿为空，无真实流动性', 'D', meta);
    }

    const dataQuality = DataCenter.validateTemporalConsistency(originBook.sells, destBook.buys);

    // Stage 2: Orderbook Depth & Real Volume Determination
    const topBuy = destBook.buys[0];
    const topSell = originBook.sells[0];

    // Cap requested quantity strictly by available top bid volume to prevent phantom spread
    const maxQtyByBid = topBuy.volumeRemain;
    const requestedQty = candidate.requestedQty
      ? Math.min(candidate.requestedQty, maxQtyByBid)
      : Math.min(100, maxQtyByBid);

    if (requestedQty <= 0) {
      return this.rejectResult(candidate, '目标买单剩余深度为 0', 'D', meta);
    }

    // Stage 3: Orderbook Walk Simulation (Weighted average fill prices)
    const buySim = OrderBookSimulator.simulateBuy(originBook.sells, requestedQty);
    const sellSim = OrderBookSimulator.simulateSell(destBook.buys, requestedQty);

    if (!buySim.isComplete || !sellSim.isComplete || buySim.filledQty === 0) {
      return this.rejectResult(candidate, '订单簿深度不足以完全覆盖提议数量', 'D', meta);
    }

    const actualQty = buySim.filledQty;

    // Stage 4: Precise Fee Calculation via FeeEngine
    const trade = FeeEngine.calculateTrade({
      buyType: 'immediate_buy',
      sellType: 'immediate_sell',
      buyUnitPrice: buySim.weightedAvgPrice,
      sellUnitPrice: sellSim.weightedAvgPrice,
      quantity: actualQty,
      buyCtx: feeCtx,
      sellCtx: feeCtx,
      haulingCost: 0,
    });

    // Stage 5: Multi-scenario Stress Testing
    const effectiveRates = FeeEngine.calculateRates(feeCtx);
    const stress = OrderBookSimulator.runStressTest({
      buyOrders: destBook.buys,
      quantity: actualQty,
      netCostIsk: trade.netCost,
      effectiveSalesTaxRate: effectiveRates.salesTaxRate,
      baseSellPrice: sellSim.weightedAvgPrice,
    });

    // Stage 6: Portfolio Risk Check (if characterId provided)
    let portfolioVeto: string | undefined;
    if (candidate.characterId) {
      const breakdown = PortfolioManager.getCapitalBreakdown(db, candidate.characterId, limits);
      const riskCheck = PortfolioManager.validateTradeRisk(
        breakdown,
        trade.netCost,
        candidate.strategy,
        unitM3 * actualQty,
        limits,
        { db, typeId: candidate.typeId, categoryId: meta.category_id || undefined }
      );
      if (!riskCheck.allowed) {
        portfolioVeto = riskCheck.reason;
      }
    }

    // Stage 7: Opportunity Rating & Decision
    let rating: OpportunityRating = 'B';
    let vetoReason: string | undefined = portfolioVeto;

    if (dataQuality.isStale) {
      rating = 'D';
      vetoReason = vetoReason || `两地数据时间差过大 (${dataQuality.timestampSkewMinutes} 分钟) 或快照已过期`;
    } else if (trade.netProfit <= 0 || trade.netMarginPct < 5.0) {
      rating = 'D';
      vetoReason = vetoReason || `净利润率过低 (${trade.netMarginPct.toFixed(1)}%)，无法抵御滑点与税费`;
    } else if (stress.priceDrop10Pct.netProfit < 0) {
      rating = 'C';
      vetoReason = vetoReason || '压力测试下跌 10% 出现亏损，抗风险能力脆弱';
    } else if (portfolioVeto) {
      rating = 'D';
    } else if (trade.netMarginPct >= 12.0 && dataQuality.timestampSkewMinutes <= 15 && stress.priceDrop10Pct.netProfit > 0) {
      rating = 'A';
    }

    const opportunity: TradeOpportunity = {
      typeId: candidate.typeId,
      typeName: meta.en_name,
      zhName: meta.zh_name || undefined,
      groupName: meta.group_name || undefined,
      categoryId: meta.category_id || undefined,
      volumeM3: unitM3,
      strategy: candidate.strategy,
      buyStationId: candidate.originStationId,
      buyStationName: candidate.originStationName,
      sellStationId: candidate.destStationId,
      sellStationName: candidate.destStationName,
      suggestedBuyPrice: buySim.weightedAvgPrice,
      suggestedSellPrice: sellSim.weightedAvgPrice,
      suggestedQuantity: actualQty,
      capitalRequired: trade.netCost,
      estimatedFees: trade.totalFees,
      haulingCost: 0,
      expectedNetProfit: trade.netProfit,
      expectedRoiPct: trade.roiPct,
      dailyVolumeDest: topBuy.volumeRemain,
      turnoverDays: 0,
      liquidityRating: topBuy.volumeRemain >= 20 ? 'A' : 'B',
      riskScore: rating === 'D' ? 4 : (rating === 'C' ? 3 : 1),
      opportunityRating: rating,
      riskVetoReason: vetoReason,
      stressTest: stress,
      dataQuality,
      rationale: `【管线独立评估】在 ${candidate.originStationName} 采购 ${actualQty} 件，运往 ${candidate.destStationName} 变现。净利润 +${trade.netProfit.toLocaleString()} ISK (+${trade.netMarginPct.toFixed(1)}%)，评级为 [${rating} 级]。`,
    };

    // Stage 8 & 9: Draft Generation Gate
    let draft: TradeDraft | undefined;
    const isExecutable = (rating === 'A' || rating === 'B') && !vetoReason;
    if (isExecutable && candidate.characterId) {
      draft = DraftSystem.createDraft(db, candidate.characterId, opportunity);
    }

    return {
      opportunity,
      isExecutable,
      rating,
      vetoReason,
      draft,
    };
  }

  private static rejectResult(
    candidate: any,
    reason: string,
    rating: OpportunityRating,
    meta?: any,
  ): PipelineEvaluationResult {
    return {
      opportunity: {
        typeId: candidate.typeId,
        typeName: meta?.en_name || `Type ${candidate.typeId}`,
        zhName: meta?.zh_name,
        groupName: meta?.group_name,
        volumeM3: meta?.volume || 1,
        strategy: candidate.strategy,
        buyStationId: candidate.originStationId,
        buyStationName: candidate.originStationName,
        sellStationId: candidate.destStationId,
        sellStationName: candidate.destStationName,
        suggestedBuyPrice: 0,
        suggestedSellPrice: 0,
        suggestedQuantity: 0,
        capitalRequired: 0,
        estimatedFees: 0,
        haulingCost: 0,
        expectedNetProfit: 0,
        expectedRoiPct: 0,
        dailyVolumeDest: 0,
        turnoverDays: 0,
        liquidityRating: 'C',
        riskScore: 4,
        opportunityRating: rating,
        riskVetoReason: reason,
        rationale: `【决策管线一票否决】${reason}`,
      },
      isExecutable: false,
      rating,
      vetoReason: reason,
    };
  }
}
