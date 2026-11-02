import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { FeeEngine, ALPHA_DEFAULT_SKILLS, OMEGA_DEFAULT_SKILLS } from '../../src/trading/fee-engine.js';
import { OrderBookSimulator } from '../../src/trading/orderbook-simulator.js';

describe('FeeEngine', () => {
  it('calculates Alpha clone tax rates correctly based on CCP 7.5% baseline', () => {
    const rates = FeeEngine.calculateRates({
      clone: 'alpha',
      skills: ALPHA_DEFAULT_SKILLS, // Accounting 3, Broker Relations 3
      facility: 'npc_station',
    });

    // Accounting 3: 0.075 * (1 - 0.33) = 0.05025 (5.025%)
    expect(rates.salesTaxRate).toBe(0.05025);
    // Broker Relations 3 in NPC: 0.03 - 0.003 * 3 = 0.0210 (2.10%)
    expect(rates.brokerFeeRate).toBe(0.021);
  });

  it('calculates Omega clone max skills tax rates correctly based on CCP 7.5% baseline', () => {
    const rates = FeeEngine.calculateRates({
      clone: 'omega',
      skills: OMEGA_DEFAULT_SKILLS, // Accounting 5, Broker Relations 5
      facility: 'npc_station',
    });

    // Accounting 5: 0.075 * (1 - 0.55) = 0.03375 (3.375%)
    expect(rates.salesTaxRate).toBe(0.03375);
    // Broker Relations 5 in NPC: 0.03 - 0.003 * 5 = 0.0150 (1.50%)
    expect(rates.brokerFeeRate).toBe(0.015);
  });

  it('enforces broker fee floor in NPC station with high standing', () => {
    const rates = FeeEngine.calculateRates({
      clone: 'omega',
      skills: {
        accounting: 5,
        brokerRelations: 5,
        advancedBrokerRelations: 5,
        factionStanding: 10.0,
        corpStanding: 10.0,
      },
      facility: 'npc_station',
    });

    // 0.03 - 0.015 - 0.003 - 0.002 = 0.0100 (floor is 1.0%)
    expect(rates.brokerFeeRate).toBe(0.01);
  });

  it('enforces 100 ISK minimum broker fee on small orders', () => {
    const alphaCtx = {
      clone: 'alpha' as const,
      skills: ALPHA_DEFAULT_SKILLS,
      facility: 'npc_station' as const,
    };

    // Tiny order: 1 unit @ 1,000 ISK. Normal 2.1% fee would be 21 ISK, but floor is 100 ISK
    const trade = FeeEngine.calculateTrade({
      buyType: 'place_buy_order',
      sellType: 'place_sell_order',
      buyUnitPrice: 1000,
      sellUnitPrice: 2000,
      quantity: 1,
      buyCtx: alphaCtx,
      sellCtx: alphaCtx,
    });

    expect(trade.buyerBrokerFee).toBe(100);
    expect(trade.sellerBrokerFee).toBe(100);
  });

  it('applies Upwell structure SCC statutory surcharge correctly', () => {
    const upwellCtx = {
      clone: 'alpha' as const,
      skills: ALPHA_DEFAULT_SKILLS,
      facility: 'upwell_structure' as const,
      customStructureBrokerFee: 0.01, // 1.0% structure fee
    };

    const trade = FeeEngine.calculateTrade({
      buyType: 'immediate_buy',
      sellType: 'place_sell_order',
      buyUnitPrice: 100_000,
      sellUnitPrice: 200_000,
      quantity: 10,
      buyCtx: upwellCtx,
      sellCtx: upwellCtx,
    });

    // 2,000,000 gross revenue * 0.5% statutory SCC fee = 10,000 ISK
    expect(trade.sccSurcharge).toBe(10_000);
  });

  it('computes accurate net profit and break-even price for a trade', () => {
    const alphaCtx = {
      clone: 'alpha' as const,
      skills: ALPHA_DEFAULT_SKILLS,
      facility: 'npc_station' as const,
    };

    const trade = FeeEngine.calculateTrade({
      buyType: 'immediate_buy', // Eating sell order: 0 broker fee
      sellType: 'place_sell_order', // Placing sell order: pays broker fee + sales tax
      buyUnitPrice: 100_000,
      sellUnitPrice: 150_000,
      quantity: 10,
      buyCtx: alphaCtx,
      sellCtx: alphaCtx,
      haulingCost: 0,
    });

    expect(trade.grossCost).toBe(1_000_000);
    expect(trade.buyerBrokerFee).toBe(0);
    expect(trade.netCost).toBe(1_000_000);

    expect(trade.grossRevenue).toBe(1_500_000);
    // Seller broker fee on 1.5M: 1.5M * 0.021 = 31,500
    expect(trade.sellerBrokerFee).toBe(31_500);
    // Sales tax on 1.5M: 1.5M * 0.05025 = 75,375
    expect(trade.salesTax).toBe(75_375);

    expect(trade.netRevenue).toBe(1_393_125);
    expect(trade.netProfit).toBe(393_125);
    expect(trade.netMarginPct).toBe(39.31);
    expect(trade.breakEvenSellPrice).toBeCloseTo(107_671.60, 1);
  });
});

describe('OrderBookSimulator', () => {
  const sampleSellOrders = [
    { price: 100, volumeRemain: 10 },
    { price: 105, volumeRemain: 20 },
    { price: 110, volumeRemain: 30 },
  ];

  it('simulates purchasing within top-of-book depth', () => {
    const res = OrderBookSimulator.simulateBuy(sampleSellOrders, 5);
    expect(res.isComplete).toBe(true);
    expect(res.filledQty).toBe(5);
    expect(res.unfilledQty).toBe(0);
    expect(res.totalGrossIsk).toBe(500);
    expect(res.weightedAvgPrice).toBe(100);
    expect(res.slippagePct).toBe(0);
    expect(res.levelsConsumed).toBe(1);
  });

  it('simulates multi-level consumption with price slippage', () => {
    // Need 25 units: 10 @ 100 + 15 @ 105 = 1000 + 1575 = 2575
    const res = OrderBookSimulator.simulateBuy(sampleSellOrders, 25);
    expect(res.isComplete).toBe(true);
    expect(res.filledQty).toBe(25);
    expect(res.totalGrossIsk).toBe(2575);
    expect(res.weightedAvgPrice).toBe(103);
    expect(res.slippagePct).toBe(3.0);
    expect(res.levelsConsumed).toBe(2);
  });

  it('handles depth exhaustion with partial fills', () => {
    // Total available in sample is 60 units
    const res = OrderBookSimulator.simulateBuy(sampleSellOrders, 100);
    expect(res.isComplete).toBe(false);
    expect(res.filledQty).toBe(60);
    expect(res.unfilledQty).toBe(40);
    expect(res.levelsConsumed).toBe(3);
  });

  const sampleBuyOrders = [
    { price: 95, volumeRemain: 10 },
    { price: 90, volumeRemain: 20 },
    { price: 85, volumeRemain: 30 },
  ];

  it('simulates selling with multi-level buy orders', () => {
    // Sell 15 units: 10 @ 95 + 5 @ 90 = 950 + 450 = 1400
    const res = OrderBookSimulator.simulateSell(sampleBuyOrders, 15);
    expect(res.isComplete).toBe(true);
    expect(res.filledQty).toBe(15);
    expect(res.totalGrossIsk).toBe(1400);
    expect(res.weightedAvgPrice).toBeCloseTo(93.33, 2);
    expect(res.topOfBookPrice).toBe(95);
  });
});
