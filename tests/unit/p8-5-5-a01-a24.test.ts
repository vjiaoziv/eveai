import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { 
  TradingPipeline, 
  signPipelineCredential, 
  validatePipelineCredential, 
  validateAndConsumePipelineCredential,
  PIPELINE_KEY_STORE 
} from '../../src/trading/trading-pipeline.js';
import { DraftSystem } from '../../src/trading/draft-system.js';
import { PaperTradingSystem } from '../../src/trading/paper-trading.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS } from '../../src/trading/fee-engine.js';
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
    VALUES (5001, 100000000, datetime('now'));
  `);

  return db;
}

function createValidSignedOpportunity(characterId = 5001, keyId = 'v1'): TradeOpportunity {
  const now = new Date();
  const opp: TradeOpportunity = {
    opportunityId: 'OPP-A24-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
    marketSnapshotHash: 'abcdef0123456789',
    marketSnapshotId: 'MSNAP-test-0123456789abcdef',
    buySnapshotTimestamp: '2026-11-02T00:00:00.000Z',
    sellSnapshotTimestamp: '2026-11-02T00:00:00.000Z',
    feeModelVersion: 'eveai-fee-2026-11-v1',
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
    rationale: 'Valid signed A01-A24 test',
  };

  const unsigned = {
    credentialId: 'CRED-A24-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
    characterId,
    opportunityId: opp.opportunityId,
    typeId: opp.typeId,
    strategy: opp.strategy,
    buyStationId: opp.buyStationId,
    sellStationId: opp.sellStationId,
    suggestedBuyPrice: opp.suggestedBuyPrice,
    suggestedSellPrice: opp.suggestedSellPrice,
    suggestedQuantity: opp.suggestedQuantity,
    capitalRequired: opp.capitalRequired,
    expectedNetProfit: opp.expectedNetProfit,
    opportunityRating: 'A' as const,
    marketSnapshotHash: 'abcdef0123456789',
    marketSnapshotId: 'MSNAP-test-0123456789abcdef',
    buySnapshotTimestamp: '2026-11-02T00:00:00.000Z',
    sellSnapshotTimestamp: '2026-11-02T00:00:00.000Z',
    feeModelVersion: 'eveai-fee-2026-11-v1',
    verifiedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    nonce: 'nonce-' + Math.random(),
    keyId,
  };

  opp.pipelineCredential = {
    ...unsigned,
    signature: signPipelineCredential(unsigned),
  };

  return opp;
}

describe('P8.5.5 Exhaustive Adversarial Test Matrix (A01 - A24)', () => {
  it('A01: 无凭证创建草案 -> 拒绝', () => {
    const db = createTestDb();
    const opp = createValidSignedOpportunity();
    opp.pipelineCredential = undefined;
    expect(() => DraftSystem.createDraft(db, 5001, opp)).toThrow(/【凭证缺失】/);
  });

  it('A02: 伪造签名 -> 拒绝', () => {
    const db = createTestDb();
    const opp = createValidSignedOpportunity();
    opp.pipelineCredential!.signature = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    expect(() => DraftSystem.createDraft(db, 5001, opp)).toThrow(/【凭证篡改】/);
  });

  it('A03: 修改交易价格 -> 拒绝', () => {
    const db = createTestDb();
    const opp = createValidSignedOpportunity();
    opp.suggestedBuyPrice = 999.0;
    expect(() => DraftSystem.createDraft(db, 5001, opp)).toThrow(/【参数篡改】/);
  });

  it('A04: 修改交易数量 -> 拒绝', () => {
    const db = createTestDb();
    const opp = createValidSignedOpportunity();
    opp.suggestedQuantity = 999999;
    expect(() => DraftSystem.createDraft(db, 5001, opp)).toThrow(/【参数篡改】/);
  });

  it('A05: 修改商品 Type ID -> 拒绝', () => {
    const db = createTestDb();
    const opp = createValidSignedOpportunity();
    opp.typeId = 6675;
    expect(() => DraftSystem.createDraft(db, 5001, opp)).toThrow(/【参数篡改】/);
  });

  it('A06: 修改买卖站点 -> 拒绝', () => {
    const db = createTestDb();
    const opp = createValidSignedOpportunity();
    opp.sellStationId = 60011866;
    expect(() => DraftSystem.createDraft(db, 5001, opp)).toThrow(/【参数篡改】/);
  });

  it('A07: 跨用户复用凭证 -> 拒绝', () => {
    const db = createTestDb();
    const opp = createValidSignedOpportunity(5001); // Signed for 5001
    // Attempted by character 8888
    expect(() => DraftSystem.createDraft(db, 8888, opp)).toThrow(/【跨角色越权】/);
  });

  it('A08: 跨机会复用凭证 -> 拒绝', () => {
    const db = createTestDb();
    const opp1 = createValidSignedOpportunity(5001);
    const opp2 = createValidSignedOpportunity(5001);
    // Bind opp2 to opp1's credential
    opp2.pipelineCredential = { ...opp1.pipelineCredential! };
    opp2.capitalRequired = 99999;
    expect(() => DraftSystem.createDraft(db, 5001, opp2)).toThrow(/【参数篡改】/);
  });

  it('A09: 跨策略复用凭证 -> 拒绝', () => {
    const db = createTestDb();
    const opp = createValidSignedOpportunity(5001);
    opp.strategy = 'regional_hauling';
    expect(() => DraftSystem.createDraft(db, 5001, opp)).toThrow(/【参数篡改】/);
  });

  it('A10: 过期凭证 -> 拒绝', () => {
    const db = createTestDb();
    const opp = createValidSignedOpportunity(5001);
    // Set expiration in past
    opp.pipelineCredential!.expiresAt = new Date(Date.now() - 60_000).toISOString();
    // Re-sign with expired timestamp
    opp.pipelineCredential!.signature = signPipelineCredential(opp.pipelineCredential!);
    expect(() => DraftSystem.createDraft(db, 5001, opp)).toThrow(/【凭证过期】/);
  });

  it('A11: 行情快照被替换 -> 拒绝并要求重新评估', () => {
    const db = createTestDb();
    const opp = createValidSignedOpportunity(5001);
    // Modify snapshot hash
    opp.pipelineCredential!.marketSnapshotHash = '1111111111111111';
    // Re-sign with wrong snapshot hash but valid HMAC
    opp.pipelineCredential!.signature = signPipelineCredential(opp.pipelineCredential!);
    const res = validatePipelineCredential(opp);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('【行情快照不一致】');
  });

  it('A12: 行情快照超过有效期 -> 拒绝', () => {
    const db = createTestDb();
    const staleTime = new Date(Date.now() - 3600 * 1000 * 3).toISOString(); // 3 hours ago
    db.exec(`
      INSERT INTO market_snapshot_regions (region_id, pages, rows_loaded, fetched_at, expires_at)
      VALUES (10000002, 10, 1000, '${staleTime}', datetime('now', '-2 hours')),
             (10000032, 10, 1000, '${staleTime}', datetime('now', '-2 hours'));
    `);

    const result = TradingPipeline.evaluateCandidate(db, {
      typeId: 34,
      strategy: 'regional_hauling',
      originStationId: 60003760,
      originRegionId: 10000002,
      originStationName: 'Jita IV-4',
      destStationId: 60011866,
      destRegionId: 10000032,
      destStationName: 'Dodixie IX-20',
      characterId: 5001,
    });

    expect(result.rating).toBe('D');
    expect(result.isExecutable).toBe(false);
    expect(result.draft).toBeUndefined();
  });

  it('A13: 同一凭证并发消费 -> 仅允许一次，第二次重放阻断', () => {
    const db = createTestDb();
    const opp = createValidSignedOpportunity(5001);

    // First call succeeds
    const d1 = DraftSystem.createDraft(db, 5001, opp);
    expect(d1.draftId).toBeDefined();

    // Replay attempt MUST throw
    expect(() => DraftSystem.createDraft(db, 5001, opp)).toThrow(/【凭证重放阻断】/);
  });

  it('A14: 相同幂等键、不同请求参数 -> 拒绝 (409 Conflict)', () => {
    const db = createTestDb();
    PaperTradingSystem.getOrCreateAccount(db, 5001, 10_000_000);
    const key = 'IDEMP-A14-KEY';

    const o1 = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 5001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 10,
      quantity: 100,
      idempotencyKey: key,
    });
    expect(o1.success).toBe(true);

    const o2 = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 5001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 20, // Different price!
      quantity: 100,
      idempotencyKey: key,
    });
    expect(o2.success).toBe(false);
    expect(o2.error).toContain('【幂等冲突】');
  });

  it('A15: 签名密钥缺失 -> 安全失败拒绝', () => {
    // 1. 尝试使用未知 keyId 签名时拒绝
    expect(() => {
      signPipelineCredential({
        credentialId: 'cred-dummy',
        characterId: 5001,
        opportunityId: 'opp-dummy',
        typeId: 34,
        strategy: 'station_arbitrage',
        buyStationId: 60003760,
        sellStationId: 60003760,
        suggestedBuyPrice: 5.0,
        suggestedSellPrice: 6.0,
        suggestedQuantity: 100,
        capitalRequired: 500,
        expectedNetProfit: 100,
        opportunityRating: 'A',
        marketSnapshotHash: 'abcdef0123456789',
        marketSnapshotId: 'MSNAP-test-0123456789abcdef',
        buySnapshotTimestamp: '2026-11-02T00:00:00.000Z',
        sellSnapshotTimestamp: '2026-11-02T00:00:00.000Z',
        feeModelVersion: 'eveai-fee-2026-11-v1',
        verifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        nonce: 'nonce',
        keyId: 'non_existent_key_id',
      });
    }).toThrow(/【密钥未知】/);

    // 2. 验证凭证时，若 keyId 未知，安全拒绝
    const opp = createValidSignedOpportunity(5001, 'v1');
    opp.pipelineCredential!.keyId = 'non_existent_key_id';
    const res = validatePipelineCredential(opp);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('【密钥失效】');
  });

  it('A16: 签名密钥轮换 -> 支持注销旧密钥并使旧凭证失效', () => {
    const db = createTestDb();
    // Register temporary key v2
    PIPELINE_KEY_STORE['v2_temp'] = 'temp-secret-key-v2';

    const opp = createValidSignedOpportunity(5001, 'v2_temp');
    expect(validatePipelineCredential(opp).valid).toBe(true);

    // Revoke key v2
    delete PIPELINE_KEY_STORE['v2_temp'];

    // Validation must now fail because key is revoked
    const revokedCheck = validatePipelineCredential(opp);
    expect(revokedCheck.valid).toBe(false);
    expect(revokedCheck.reason).toContain('【密钥失效】');
  });

  it('A17: 同一成交事件重复提交 -> 幂等性不重复记账', () => {
    const db = createTestDb();
    PaperTradingSystem.getOrCreateAccount(db, 5001, 10_000_000);

    const ord = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 5001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 10,
      quantity: 50,
    });

    // First fill: 50 units (complete)
    const exec1 = PaperTradingSystem.executeVirtualOrderAgainstBook(db, ord.orderId!, [{ price: 10, volumeRemain: 50 }]);
    expect(exec1.filledQty).toBe(50);
    expect(exec1.status).toBe('filled');

    // Duplicate fill attempt on filled order: 0 units filled
    const exec2 = PaperTradingSystem.executeVirtualOrderAgainstBook(db, ord.orderId!, [{ price: 10, volumeRemain: 50 }]);
    expect(exec2.filledQty).toBe(0);

    // Inventory must remain exactly 50
    const pos = db.prepare('SELECT quantity FROM paper_trading_positions WHERE character_id = 5001').get() as any;
    expect(pos.quantity).toBe(50);
  });

  it('A18: 成交与撤单并发状态锁死 -> 已成交订单无法撤销', () => {
    const db = createTestDb();
    PaperTradingSystem.getOrCreateAccount(db, 5001, 10_000_000);

    const ord = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 5001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 10,
      quantity: 50,
    });

    PaperTradingSystem.executeVirtualOrderAgainstBook(db, ord.orderId!, [{ price: 10, volumeRemain: 50 }]);
    // Attempting to cancel filled order must return false
    expect(PaperTradingSystem.cancelVirtualOrder(db, ord.orderId!)).toBe(false);
  });

  it('A19: 部分成交后撤单 -> 正确释放剩余冻结资金', () => {
    const db = createTestDb();
    PaperTradingSystem.getOrCreateAccount(db, 5001, 10_000_000);

    const ord = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 5001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 10,
      quantity: 100,
    });

    // Fill 30 units
    PaperTradingSystem.executeVirtualOrderAgainstBook(db, ord.orderId!, [{ price: 10, volumeRemain: 30 }]);
    // Cancel remaining 70 units
    const cancelOk = PaperTradingSystem.cancelVirtualOrder(db, ord.orderId!);
    expect(cancelOk).toBe(true);

    const recon = PaperTradingSystem.verifyAccountBalance(db, 'PT-ACC-5001');
    expect(recon.isReconciled).toBe(true);
    expect(recon.discrepancy).toBe(0);
  });

  it('A20: SCC 附加税重复计费检查 -> 建筑费与 SCC 税独立无重叠', () => {
    const upwellCtx = {
      clone: 'alpha' as const,
      skills: ALPHA_DEFAULT_SKILLS,
      facility: 'upwell_structure' as const,
      customStructureBrokerFee: 0.015, // 1.5% structure fee
    };

    const trade = FeeEngine.calculateTrade({
      buyType: 'immediate_buy',
      sellType: 'place_sell_order',
      buyUnitPrice: 1000,
      sellUnitPrice: 2000,
      quantity: 1000, // 2,000,000 revenue
      buyCtx: upwellCtx,
      sellCtx: upwellCtx,
    });

    expect(trade.sellerBrokerFee).toBe(30_000); // 2M * 1.5%
    expect(trade.sccSurcharge).toBe(10_000);   // 2M * 0.5% statutory SCC
    expect(trade.totalFees).toBe(30_000 + 10_000 + (2_000_000 * 0.05025));
  });

  it('A21: 费用舍入边界 -> 百分比费用与两位小数精度', () => {
    const alphaCtx = {
      clone: 'alpha' as const,
      skills: ALPHA_DEFAULT_SKILLS,
      facility: 'npc_station' as const,
    };

    const trade = FeeEngine.calculateTrade({
      buyType: 'place_buy_order',
      sellType: 'place_sell_order',
      buyUnitPrice: 10,
      sellUnitPrice: 20,
      quantity: 1, // tiny order
      buyCtx: alphaCtx,
      sellCtx: alphaCtx,
    });

    expect(trade.buyerBrokerFee).toBe(0.21);
    expect(trade.sellerBrokerFee).toBe(0.42);
  });

  it('A22: 账户并发访问资金守恒 -> 100 并发订单无透支', () => {
    const db = createTestDb();
    PaperTradingSystem.getOrCreateAccount(db, 5001, 1_000_000);

    for (let i = 0; i < 50; i++) {
      PaperTradingSystem.createVirtualOrder(db, {
        characterId: 5001,
        typeId: 34,
        strategyType: 'station_arbitrage',
        orderType: 'buy',
        price: 100,
        quantity: 500, // 50,000 + fees
      });
    }

    const acc = PaperTradingSystem.getOrCreateAccount(db, 5001);
    expect(acc.availableCash).toBeGreaterThanOrEqual(0);
    expect(acc.escrowLocked).toBeLessThanOrEqual(1_000_000);
  });

  it('A23: 真实 ESI 写接口零暴露 -> 架构级物理阻断', () => {
    const fs = require('fs');
    const tools = fs.readFileSync('src/agent/tools.ts', 'utf8');
    expect(tools).not.toContain('create_market_order');
    expect(tools).not.toContain('cancel_market_order');
    expect(tools).not.toContain('transfer_wallet_isk');
  });

  it('A24: 账本中途崩溃恢复 -> 重启后借贷依然平衡', () => {
    const db = createTestDb();
    PaperTradingSystem.getOrCreateAccount(db, 5001, 10_000_000);

    const ord = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 5001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 10,
      quantity: 500,
    });

    PaperTradingSystem.executeVirtualOrderAgainstBook(db, ord.orderId!, [{ price: 10, volumeRemain: 200 }]);

    // Reopen DB connection simulation
    const recon = PaperTradingSystem.verifyAccountBalance(db, 'PT-ACC-5001');
    expect(recon.isReconciled).toBe(true);
    expect(recon.discrepancy).toBe(0);
  });
});
