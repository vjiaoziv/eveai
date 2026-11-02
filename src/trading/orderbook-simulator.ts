import type { FillSimulationResult, OrderBookLevel } from './types.js';

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
    // For selling, negative slippage means realized average price is below top-of-book buy price
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
}