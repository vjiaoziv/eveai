import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TradingPipeline, signPipelineCredential, validatePipelineCredential } from '../../src/trading/trading-pipeline.js';
import { DraftSystem } from '../../src/trading/draft-system.js';
import { PaperTradingSystem } from '../../src/trading/paper-trading.js';
import { runMigrations } from '../../src/db/migrations.js';
import type { TradeOpportunity } from '../../src/trading/types.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);

  db.exec(`
    INSERT INTO sde_types (type_id, name, group_id, data_json)
    VALUES (34, 'Tritanium', 18, '{"volume":0.01,"portionSize":1,"mass":0,"basePrice":2,"name":{"en":"Tritanium","zh":"三钛合金"}}'),
           (6675, 'Small Laser', 53, '{"volume":5.0,"portionSize":1,"mass":10000,"basePrice":300000,"name":{"en":"Small Laser","zh":"小型激光器"}}');

    INSERT INTO sde_groups (group_id, name, category_id, data_json)
    VALUES (18, 'Mineral', 4, '{"name":{"en":"Mineral","zh":"矿物"}}'),
           (53, 'Energy Weapon', 7, '{"name":{"en":"Energy Weapon","zh":"能量武器"}}');

    INSERT INTO sde_categories (category_id, name, data_json)
    VALUES (4, 'Material', '{"name":{"en":"Material","zh":"材料"}}'),
           (7, 'Module', '{"name":{"en":"Module","zh":"装备"}}');

    INSERT INTO sde_stations (station_id, name, system_id, data_json)
    VALUES (60003760, 'Jita IV-4', 30000142, '{"name":{"en":"Jita IV-4","zh":"吉他海四"}}'),
           (60011866, 'Dodixie IX-20', 30002659, '{"name":{"en":"Dodixie IX-20","zh":"杜迪克西"}}');

    INSERT INTO character_wallet (character_id, balance, synced_at)
    VALUES (4001, 100000000, datetime('now'));
  `);

  return db;
}

describe('P8.5.3 Adversarial Verification & Security Hardening Test Suite', () => {
  it('Adversarial Pipeline 1: Opportunity without cryptographic credential cannot create draft', () => {
    const db = createTestDb();
    const forgedOpp: TradeOpportunity = {
      typeId: 34,
      typeName: 'Tritanium',
      volumeM3: 0.01,
      strategy: 'station_arbitrage',
      buyStationId: 60003760,
      buyStationName: 'Jita IV-4',
      sellStationId: 60003760,
      sellStationName: 'Jita IV-4',
      suggestedBuyPrice: 3.5,
      suggestedSellPrice: 5.0,
      suggestedQuantity: 1000,
      capitalRequired: 3500,
      estimatedFees: 300,
      haulingCost: 0,
      expectedNetProfit: 1200,
      expectedRoiPct: 34.2,
      dailyVolumeDest: 10000,
      turnoverDays: 0.5,
      liquidityRating: 'A',
      riskScore: 1,
      opportunityRating: 'A',
      rationale: 'Forged opportunity',
      // pipelineCredential is intentionally MISSING
    };

    expect(() => {
      DraftSystem.createDraft(db, 4001, forgedOpp);
    }).toThrow(/【凭证缺失】/);
  });

  it('Adversarial Pipeline 2: Tampered parameters invalidate cryptographic credential', () => {
    const db = createTestDb();
    const opp: TradeOpportunity = {
      typeId: 34,
      typeName: 'Tritanium',
      volumeM3: 0.01,
      strategy: 'station_arbitrage',
      buyStationId: 60003760,
      buyStationName: 'Jita IV-4',
      sellStationId: 60003760,
      sellStationName: 'Jita IV-4',
      suggestedBuyPrice: 3.5,
      suggestedSellPrice: 5.0,
      suggestedQuantity: 1000,
      capitalRequired: 3500,
      estimatedFees: 300,
      haulingCost: 0,
      expectedNetProfit: 1200,
      expectedRoiPct: 34.2,
      dailyVolumeDest: 10000,
      turnoverDays: 0.5,
      liquidityRating: 'A',
      riskScore: 1,
      opportunityRating: 'A',
      rationale: 'Valid signed test',
    };

    const now = new Date();
    const unsigned = {
      credentialId: 'CRED-ADV-001',
      characterId: 4001,
      typeId: 34,
      strategy: 'station_arbitrage' as const,
      buyStationId: 60003760,
      sellStationId: 60003760,
      suggestedBuyPrice: 3.5,
      suggestedSellPrice: 5.0,
      suggestedQuantity: 1000,
      capitalRequired: 3500,
      expectedNetProfit: 1200,
      opportunityRating: 'A' as const,
      marketSnapshotHash: 'snaph1234567890',
      verifiedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      nonce: 'nonce-12345',
      keyId: 'v1',
    };
    opp.pipelineCredential = {
      ...unsigned,
      signature: signPipelineCredential(unsigned),
    };

    // 1. Valid opportunity can create draft
    const draft = DraftSystem.createDraft(db, 4001, opp);
    expect(draft.draftId).toBeDefined();

    // 2. Tampering quantity from 1000 to 50000 MUST FAIL
    const tamperedQtyOpp = { ...opp, suggestedQuantity: 50000 };
    expect(() => {
      DraftSystem.createDraft(db, 4001, tamperedQtyOpp);
    }).toThrow(/【参数篡改】/);

    // 3. Tampering typeId from 34 to 6675 MUST FAIL
    const tamperedTypeOpp = { ...opp, typeId: 6675 };
    expect(() => {
      DraftSystem.createDraft(db, 4001, tamperedTypeOpp);
    }).toThrow(/【参数篡改】/);

    // 4. Forged fake signature MUST FAIL
    const fakeSigOpp = {
      ...opp,
      pipelineCredential: {
        ...opp.pipelineCredential!,
        signature: 'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
      },
    };
    expect(() => {
      DraftSystem.createDraft(db, 4001, fakeSigOpp);
    }).toThrow(/【凭证篡改】/);
  });

  it('Adversarial Pipeline 3: Expired credential is strictly rejected', () => {
    const db = createTestDb();
    const now = new Date();
    const twentyMinsAgo = new Date(now.getTime() - 20 * 60 * 1000).toISOString();
    const expiredAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();

    const opp: TradeOpportunity = {
      typeId: 34,
      typeName: 'Tritanium',
      volumeM3: 0.01,
      strategy: 'station_arbitrage',
      buyStationId: 60003760,
      buyStationName: 'Jita IV-4',
      sellStationId: 60003760,
      sellStationName: 'Jita IV-4',
      suggestedBuyPrice: 3.5,
      suggestedSellPrice: 5.0,
      suggestedQuantity: 1000,
      capitalRequired: 3500,
      estimatedFees: 300,
      haulingCost: 0,
      expectedNetProfit: 1200,
      expectedRoiPct: 34.2,
      dailyVolumeDest: 10000,
      turnoverDays: 0.5,
      liquidityRating: 'A',
      riskScore: 1,
      opportunityRating: 'A',
      rationale: 'Expired test',
    };

    const unsigned = {
      credentialId: 'CRED-EXP-001',
      characterId: 4001,
      typeId: 34,
      strategy: 'station_arbitrage' as const,
      buyStationId: 60003760,
      sellStationId: 60003760,
      suggestedBuyPrice: 3.5,
      suggestedSellPrice: 5.0,
      suggestedQuantity: 1000,
      capitalRequired: 3500,
      expectedNetProfit: 1200,
      opportunityRating: 'A' as const,
      marketSnapshotHash: 'snaph1234567890',
      verifiedAt: twentyMinsAgo,
      expiresAt: expiredAt,
      nonce: 'nonce-exp-01',
      keyId: 'v1',
    };
    opp.pipelineCredential = {
      ...unsigned,
      signature: signPipelineCredential(unsigned),
    };

    expect(() => {
      DraftSystem.createDraft(db, 4001, opp);
    }).toThrow(/【凭证过期】/);
  });

  it('Adversarial Pipeline 4: Anti-replay protection prevents reusing the same credential twice', () => {
    const db = createTestDb();
    const now = new Date();
    const opp: TradeOpportunity = {
      typeId: 34,
      typeName: 'Tritanium',
      volumeM3: 0.01,
      strategy: 'station_arbitrage',
      buyStationId: 60003760,
      buyStationName: 'Jita IV-4',
      sellStationId: 60003760,
      sellStationName: 'Jita IV-4',
      suggestedBuyPrice: 3.5,
      suggestedSellPrice: 5.0,
      suggestedQuantity: 1000,
      capitalRequired: 3500,
      estimatedFees: 300,
      haulingCost: 0,
      expectedNetProfit: 1200,
      expectedRoiPct: 34.2,
      dailyVolumeDest: 10000,
      turnoverDays: 0.5,
      liquidityRating: 'A',
      riskScore: 1,
      opportunityRating: 'A',
      rationale: 'Replay test',
    };

    const unsigned = {
      credentialId: 'CRED-REPLAY-001',
      characterId: 4001,
      typeId: 34,
      strategy: 'station_arbitrage' as const,
      buyStationId: 60003760,
      sellStationId: 60003760,
      suggestedBuyPrice: 3.5,
      suggestedSellPrice: 5.0,
      suggestedQuantity: 1000,
      capitalRequired: 3500,
      expectedNetProfit: 1200,
      opportunityRating: 'A' as const,
      marketSnapshotHash: 'snaph1234567890',
      verifiedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      nonce: 'nonce-replay-01',
      keyId: 'v1',
    };
    opp.pipelineCredential = {
      ...unsigned,
      signature: signPipelineCredential(unsigned),
    };

    // First draft consumption succeeds
    const d1 = DraftSystem.createDraft(db, 4001, opp);
    expect(d1.draftId).toBeDefined();

    // Replay with identical credential MUST FAIL
    expect(() => {
      DraftSystem.createDraft(db, 4001, opp);
    }).toThrow(/【凭证重放阻断】/);
  });

  it('Adversarial Pipeline 5: Cross-character credential theft is rejected', () => {
    const db = createTestDb();
    const now = new Date();
    const opp: TradeOpportunity = {
      typeId: 34,
      typeName: 'Tritanium',
      volumeM3: 0.01,
      strategy: 'station_arbitrage',
      buyStationId: 60003760,
      buyStationName: 'Jita IV-4',
      sellStationId: 60003760,
      sellStationName: 'Jita IV-4',
      suggestedBuyPrice: 3.5,
      suggestedSellPrice: 5.0,
      suggestedQuantity: 1000,
      capitalRequired: 3500,
      estimatedFees: 300,
      haulingCost: 0,
      expectedNetProfit: 1200,
      expectedRoiPct: 34.2,
      dailyVolumeDest: 10000,
      turnoverDays: 0.5,
      liquidityRating: 'A',
      riskScore: 1,
      opportunityRating: 'A',
      rationale: 'Cross-user test',
    };

    // Credential signed for Alice (characterId 4001)
    const unsigned = {
      credentialId: 'CRED-ALICE-001',
      characterId: 4001,
      typeId: 34,
      strategy: 'station_arbitrage' as const,
      buyStationId: 60003760,
      sellStationId: 60003760,
      suggestedBuyPrice: 3.5,
      suggestedSellPrice: 5.0,
      suggestedQuantity: 1000,
      capitalRequired: 3500,
      expectedNetProfit: 1200,
      opportunityRating: 'A' as const,
      marketSnapshotHash: 'snaph1234567890',
      verifiedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      nonce: 'nonce-alice-01',
      keyId: 'v1',
    };
    opp.pipelineCredential = {
      ...unsigned,
      signature: signPipelineCredential(unsigned),
    };

    // Bob (characterId 9999) attempts to create a draft using Alice's credential -> MUST FAIL
    expect(() => {
      DraftSystem.createDraft(db, 9999, opp);
    }).toThrow(/【跨角色越权】/);
  });

  it('Adversarial Idempotency: Same key with different payload is rejected with conflict', () => {
    const db = createTestDb();
    PaperTradingSystem.getOrCreateAccount(db, 4001, 10_000_000);
    const key = 'IDEMP-ADV-KEY-999';

    // 1. First order succeeds
    const o1 = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 4001,
      typeId: 34,
      strategyType: 'regional_hauling',
      orderType: 'buy',
      price: 5,
      quantity: 100,
      idempotencyKey: key,
    });
    expect(o1.success).toBe(true);

    // 2. Same key, identical payload -> Returns same orderId
    const o2 = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 4001,
      typeId: 34,
      strategyType: 'regional_hauling',
      orderType: 'buy',
      price: 5,
      quantity: 100,
      idempotencyKey: key,
    });
    expect(o2.success).toBe(true);
    expect(o2.orderId).toBe(o1.orderId);

    // 3. Same key, different quantity (200 vs 100) -> MUST FAIL with conflict
    const o3 = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 4001,
      typeId: 34,
      strategyType: 'regional_hauling',
      orderType: 'buy',
      price: 5,
      quantity: 200,
      idempotencyKey: key,
    });
    expect(o3.success).toBe(false);
    expect(o3.error).toContain('【幂等冲突】');

    // 4. Same key, different typeId (6675 vs 34) -> MUST FAIL with conflict
    const o4 = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 4001,
      typeId: 6675,
      strategyType: 'regional_hauling',
      orderType: 'buy',
      price: 5,
      quantity: 100,
      idempotencyKey: key,
    });
    expect(o4.success).toBe(false);
    expect(o4.error).toContain('【幂等冲突】');
  });

  it('Adversarial State Machine: Terminal states cannot be mutated or reversed', () => {
    const db = createTestDb();
    PaperTradingSystem.getOrCreateAccount(db, 4001, 10_000_000);

    const ord = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 4001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 10,
      quantity: 50,
    });

    // Execute full 50 units -> filled
    PaperTradingSystem.executeVirtualOrderAgainstBook(db, ord.orderId!, [{ price: 10, volumeRemain: 50 }]);
    const filledOrder = db.prepare('SELECT status FROM paper_trading_orders WHERE order_id = ?').get(ord.orderId!) as any;
    expect(filledOrder.status).toBe('filled');

    // Attempting to execute again against a filled order must do nothing (0 filled)
    const secondExec = PaperTradingSystem.executeVirtualOrderAgainstBook(db, ord.orderId!, [{ price: 10, volumeRemain: 50 }]);
    expect(secondExec.filledQty).toBe(0);

    // Attempting to cancel a filled order must fail
    const cancelRes = PaperTradingSystem.cancelVirtualOrder(db, ord.orderId!);
    expect(cancelRes).toBe(false);
  });
});
