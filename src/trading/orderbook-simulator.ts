import type { FillSimulationResult, OrderBookLevel, StressTestResults } from './types.js';

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
