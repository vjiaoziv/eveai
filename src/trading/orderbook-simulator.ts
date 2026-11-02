import type { FeeContext, FillSimulationResult, OrderBookLevel, StressTestResults } from './types.js';
import { FeeEngine } from './fee-engine.js';

export class OrderBookSimulator {
  /**
   * Simulate purchasing `targetQuantity` from active sell orders.
   * Orders must be sorted by price ASC (lowest price first).
   */
  public static simulateBuy(
    sellOrders: OrderBookLevel[],
    targetQuantity: number,
  ): FillSimulationResult {
    if (targetQuantity <= 0 || sellOrders.length === 0) {
      return {
        requestedQty: targetQuantity,
        filledQty: 0,
        unfilledQty: targetQuantity,
        isComplete: false,
        totalGrossIsk: 0,
        weightedAvgPrice: 0,
        topOfBookPrice: sellOrders[0]?.price || 0,
        slippagePct: 0,
        levelsConsumed: 0,
        effectiveOrders: [],
      };
    }

    const sorted = [...sellOrders].sort((a, b) => a.price - b.price);
    const topOfBookPrice = sorted[0].price;

    let remaining = targetQuantity;
    let totalGrossIsk = 0;
    let levelsConsumed = 0;
    const effectiveOrders: Array<{ price: number; volume: number }> = [];

    for (const order of sorted) {
      if (remaining <= 0) break;
      if (order.volumeRemain <= 0) continue;

      const take = Math.min(remaining, order.volumeRemain);
      totalGrossIsk += take * order.price;
      remaining -= take;
      levelsConsumed += 1;
      effectiveOrders.push({ price: order.price, volume: take });
    }

    const filledQty = targetQuantity - remaining;
    const weightedAvgPrice = filledQty > 0 ? totalGrossIsk / filledQty : 0;
    const slippagePct = topOfBookPrice > 0 ? ((weightedAvgPrice - topOfBookPrice) / topOfBookPrice) * 100 : 0;

    return {
      requestedQty: targetQuantity,
      filledQty,
      unfilledQty: remaining,
      isComplete: remaining === 0,
      totalGrossIsk: Math.round(totalGrossIsk * 100) / 100,
      weightedAvgPrice: Math.round(weightedAvgPrice * 100) / 100,
      topOfBookPrice,
      slippagePct: Math.round(slippagePct * 100) / 100,
      levelsConsumed,
      effectiveOrders,
    };
  }

  /**
   * Simulate selling `targetQuantity` into active buy orders.
   * Orders must be sorted by price DESC (highest price first).
   */
  public static simulateSell(
    buyOrders: OrderBookLevel[],
    targetQuantity: number,
  ): FillSimulationResult {
    if (targetQuantity <= 0 || buyOrders.length === 0) {
      return {
        requestedQty: targetQuantity,
        filledQty: 0,
        unfilledQty: targetQuantity,
        isComplete: false,
        totalGrossIsk: 0,
        weightedAvgPrice: 0,
        topOfBookPrice: buyOrders[0]?.price || 0,
        slippagePct: 0,
        levelsConsumed: 0,
        effectiveOrders: [],
      };
    }

    const sorted = [...buyOrders].sort((a, b) => b.price - a.price);
    const topOfBookPrice = sorted[0].price;

    let remaining = targetQuantity;
    let totalGrossIsk = 0;
    let levelsConsumed = 0;
    const effectiveOrders: Array<{ price: number; volume: number }> = [];

    for (const order of sorted) {
      if (remaining <= 0) break;
      if (order.volumeRemain <= 0) continue;

      const take = Math.min(remaining, order.volumeRemain);
      totalGrossIsk += take * order.price;
      remaining -= take;
      levelsConsumed += 1;
      effectiveOrders.push({ price: order.price, volume: take });
    }

    const filledQty = targetQuantity - remaining;
    const weightedAvgPrice = filledQty > 0 ? totalGrossIsk / filledQty : 0;
    // For selling, positive slippage represents price degradation below top of book
    const slippagePct = topOfBookPrice > 0 ? ((topOfBookPrice - weightedAvgPrice) / topOfBookPrice) * 100 : 0;

    return {
      requestedQty: targetQuantity,
      filledQty,
      unfilledQty: remaining,
      isComplete: remaining === 0,
      totalGrossIsk: Math.round(totalGrossIsk * 100) / 100,
      weightedAvgPrice: Math.round(weightedAvgPrice * 100) / 100,
      topOfBookPrice,
      slippagePct: Math.round(slippagePct * 100) / 100,
      levelsConsumed,
      effectiveOrders,
    };
  }

  /**
   * Find optimal profitable quantity across multiple orderbook levels.
   * Dynamically balances multi-level depth with marginal unit profitability:
   * - Traverses orderbook levels.
   * - Prevents phantom spread dilution by halting when marginal selling revenue drops below marginal buying cost.
   * - Ensures batch net margin remains >= minNetMarginPct.
   */
  public static findOptimalProfitableQuantity(params: {
    originSells: OrderBookLevel[];
    destBuys: OrderBookLevel[];
    maxAllowedQty: number;
    feeCtx: FeeContext;
    minNetMarginPct?: number;
  }): {
    optimalQuantity: number;
    buySim: FillSimulationResult;
    sellSim: FillSimulationResult;
    effectiveNetMarginPct: number;
    isDepthConstrained: boolean;
  } {
    const { originSells, destBuys, maxAllowedQty, feeCtx, minNetMarginPct = 6.0 } = params;

    if (originSells.length === 0 || destBuys.length === 0 || maxAllowedQty <= 0) {
      return {
        optimalQuantity: 0,
        buySim: this.simulateBuy([], 0),
        sellSim: this.simulateSell([], 0),
        effectiveNetMarginPct: 0,
        isDepthConstrained: true,
      };
    }

    const sortedSells = [...originSells].sort((a, b) => a.price - b.price);
    const sortedBuys = [...destBuys].sort((a, b) => b.price - a.price);

    const rates = FeeEngine.calculateRates(feeCtx);
    const effectiveSellMultiplier = 1 - rates.salesTaxRate;

    // Discretize search steps by orderbook bucket boundaries
    const candidateQuantities = new Set<number>();
    let cumulativeBuyDepth = 0;
    for (const b of sortedBuys) {
      cumulativeBuyDepth += b.volumeRemain;
      if (cumulativeBuyDepth <= maxAllowedQty) {
        candidateQuantities.add(cumulativeBuyDepth);
      } else {
        candidateQuantities.add(maxAllowedQty);
        break;
      }
    }
    candidateQuantities.add(Math.min(maxAllowedQty, sortedBuys[0].volumeRemain));
    candidateQuantities.add(Math.min(maxAllowedQty, sortedSells[0].volumeRemain));

    const sortedCandidates = Array.from(candidateQuantities).filter(q => q > 0).sort((a, b) => a - b);

    let bestQty = 0;
    let bestBuySim = this.simulateBuy(sortedSells, 0);
    let bestSellSim = this.simulateSell(sortedBuys, 0);
    let bestNetMargin = 0;

    for (const testQty of sortedCandidates) {
      const bSim = this.simulateBuy(sortedSells, testQty);
      const sSim = this.simulateSell(sortedBuys, testQty);

      if (!bSim.isComplete || !sSim.isComplete) continue;

      // Marginal test on the last level
      const lastBuyOrder = sSim.effectiveOrders[sSim.effectiveOrders.length - 1];
      const lastSellOrder = bSim.effectiveOrders[bSim.effectiveOrders.length - 1];
      if (lastBuyOrder && lastSellOrder) {
        const marginalSellNet = lastBuyOrder.price * effectiveSellMultiplier;
        const marginalBuyCost = lastSellOrder.price;
        // If marginal unit produces a loss, stop expanding quantity
        if (marginalSellNet < marginalBuyCost) {
          break;
        }
      }

      const trade = FeeEngine.calculateTrade({
        buyType: 'immediate_buy',
        sellType: 'immediate_sell',
        buyUnitPrice: bSim.weightedAvgPrice,
        sellUnitPrice: sSim.weightedAvgPrice,
        quantity: testQty,
        buyCtx: feeCtx,
        sellCtx: feeCtx,
      });

      if (trade.netMarginPct >= minNetMarginPct && trade.netProfit > 0) {
        bestQty = testQty;
        bestBuySim = bSim;
        bestSellSim = sSim;
        bestNetMargin = trade.netMarginPct;
      }
    }

    return {
      optimalQuantity: bestQty,
      buySim: bestBuySim,
      sellSim: bestSellSim,
      effectiveNetMarginPct: bestNetMargin,
      isDepthConstrained: bestQty < maxAllowedQty,
    };
  }

  /**
   * Run multi-scenario stress test on selling side.
   */
  public static runStressTest(params: {
    buyOrders: OrderBookLevel[];
    quantity: number;
    netCostIsk: number;
    effectiveSalesTaxRate: number;
    baseSellPrice: number;
  }): StressTestResults {
    const { buyOrders, quantity, netCostIsk, effectiveSalesTaxRate, baseSellPrice } = params;

    const calcScenario = (scenario: string, projectedPrice: number) => {
      const grossRev = projectedPrice * quantity;
      const netRev = grossRev * (1 - effectiveSalesTaxRate);
      const netProfit = netRev - netCostIsk;
      const roiPct = netCostIsk > 0 ? (netProfit / netCostIsk) * 100 : 0;
      return {
        scenario,
        projectedSellPrice: Math.round(projectedPrice * 100) / 100,
        projectedGrossRevenue: Math.round(grossRev * 100) / 100,
        netProfit: Math.round(netProfit * 100) / 100,
        roiPct: Math.round(roiPct * 100) / 100,
      };
    };

    // Scenario 4: Top buy order evaporates entirely (drop top level)
    const secondaryOrders = buyOrders.length > 1 ? buyOrders.slice(1) : [];
    const evaporationSim = this.simulateSell(secondaryOrders, quantity);
    const evapGrossRev = evaporationSim.totalGrossIsk;
    const evapNetRev = evapGrossRev * (1 - effectiveSalesTaxRate);
    const evapNetProfit = evapNetRev - netCostIsk;
    const evapRoi = netCostIsk > 0 ? (evapNetProfit / netCostIsk) * 100 : 0;

    return {
      priceDrop5Pct: calcScenario('价格下跌 5%', baseSellPrice * 0.95),
      priceDrop10Pct: calcScenario('价格下跌 10%', baseSellPrice * 0.90),
      priceDrop20Pct: calcScenario('价格下跌 20%', baseSellPrice * 0.80),
      bidEvaporation: {
        scenario: '顶档买单完全消失（直接滑落至次级买盘）',
        projectedSellPrice: evaporationSim.weightedAvgPrice,
        projectedGrossRevenue: Math.round(evapGrossRev * 100) / 100,
        netProfit: Math.round(evapNetProfit * 100) / 100,
        roiPct: Math.round(evapRoi * 100) / 100,
      },
    };
  }
}
