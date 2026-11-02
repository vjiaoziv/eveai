import { describe, expect, it } from 'vitest';
import { OrderBookSimulator } from '../../src/trading/orderbook-simulator.js';

describe('P8.7 graded fill simulation modes', () => {
  it('Mode B fills only immediately marketable limit orders without observable queue ahead', () => {
    const book = [
      { price: 10, volumeRemain: 5 },
      { price: 12, volumeRemain: 5 },
    ];

    const partial = OrderBookSimulator.simulateLimitOrder({
      side: 'buy',
      limitPrice: 11,
      requestedQty: 8,
      counterpartyBook: book,
      visibleQueueAheadQty: 0,
    });
    expect(partial.status).toBe('PARTIALLY_FILLED');
    expect(partial.filledQty).toBe(5);
    expect(partial.unfilledQty).toBe(3);
    expect(partial.fills).toEqual([{ price: 10, quantity: 5 }]);
    expect(partial.modelVersion).toBe('eveai-paper-fill-v1-limit-queue');

    const queued = OrderBookSimulator.simulateLimitOrder({
      side: 'buy',
      limitPrice: 11,
      requestedQty: 8,
      counterpartyBook: book,
      visibleQueueAheadQty: 1,
    });
    expect(queued.status).toBe('OPEN');
    expect(queued.filledQty).toBe(0);
    expect(queued.reason).toBe('queue_ahead_not_filled');

    const notMarketable = OrderBookSimulator.simulateLimitOrder({
      side: 'buy',
      limitPrice: 9,
      requestedQty: 8,
      counterpartyBook: book,
      visibleQueueAheadQty: 0,
    });
    expect(notMarketable.status).toBe('OPEN');
    expect(notMarketable.filledQty).toBe(0);
    expect(notMarketable.reason).toBe('limit_not_marketable');
  });

  it('Mode C caps fill quantity and applies adverse price adjustment', () => {
    const result = OrderBookSimulator.simulateStressFill({
      side: 'buy',
      requestedQty: 10,
      currentBook: [{ price: 10, volumeRemain: 10 }],
      maxFillRatio: 0.5,
      adversePriceBps: 100,
    });

    expect(result.status).toBe('PARTIALLY_FILLED');
    expect(result.filledQty).toBe(5);
    expect(result.unfilledQty).toBe(5);
    expect(result.weightedAvgPrice).toBe(10.1);
    expect(result.fills).toEqual([{ price: 10.1, quantity: 5 }]);
    expect(result.modelVersion).toBe('eveai-paper-fill-v1-stress');
  });
});
