import { describe, expect, it } from 'vitest';
import { OrderBookSimulator } from '../../src/trading/orderbook-simulator.js';
import { ALPHA_DEFAULT_SKILLS } from '../../src/trading/fee-engine.js';

const feeCtx = {
  clone: 'alpha' as const,
  skills: ALPHA_DEFAULT_SKILLS,
  facility: 'npc_station' as const,
};

describe('P8.5.6 orderbook depth and executable quantity', () => {
  it('uses multiple levels to support a quantity larger than top-of-book volume', () => {
    const result = OrderBookSimulator.findOptimalProfitableQuantity({
      originSells: [
        { price: 10, volumeRemain: 2 },
        { price: 11, volumeRemain: 3 },
        { price: 12, volumeRemain: 5 },
      ],
      destBuys: [
        { price: 30, volumeRemain: 2 },
        { price: 28, volumeRemain: 3 },
        { price: 26, volumeRemain: 5 },
      ],
      maxAllowedQty: 10,
      feeCtx,
      minNetMarginPct: 5,
    });

    expect(result.optimalQuantity).toBe(10);
    expect(result.buySim.filledQty).toBe(10);
    expect(result.sellSim.filledQty).toBe(10);
    expect(result.buySim.levelsConsumed).toBe(3);
    expect(result.sellSim.levelsConsumed).toBe(3);
    expect(result.isDepthConstrained).toBe(false);
  });

  it('rejects shallow or inverted depth instead of extrapolating top-of-book prices', () => {
    const shallow = OrderBookSimulator.findOptimalProfitableQuantity({
      originSells: [{ price: 10, volumeRemain: 1 }],
      destBuys: [{ price: 20, volumeRemain: 1 }],
      maxAllowedQty: 10,
      feeCtx,
    });
    expect(shallow.isDepthConstrained).toBe(true);
    expect(shallow.optimalQuantity).toBe(1);
    expect(shallow.buySim.filledQty).toBe(1);

    const inverted = OrderBookSimulator.findOptimalProfitableQuantity({
      originSells: [{ price: 30, volumeRemain: 10 }],
      destBuys: [{ price: 10, volumeRemain: 10 }],
      maxAllowedQty: 10,
      feeCtx,
    });
    expect(inverted.optimalQuantity).toBe(0);
    expect(inverted.effectiveNetMarginPct).toBe(0);
  });

  it('refuses partial fills for authorization quantities', () => {
    const buy = OrderBookSimulator.simulateBuy([{ price: 10, volumeRemain: 4 }], 5);
    const sell = OrderBookSimulator.simulateSell([{ price: 20, volumeRemain: 3 }], 5);
    expect(buy.isComplete).toBe(false);
    expect(sell.isComplete).toBe(false);
    expect(buy.filledQty).toBe(4);
    expect(sell.filledQty).toBe(3);
  });
});
