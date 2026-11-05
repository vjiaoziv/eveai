import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import { DataCenter } from './data-center.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS, FEE_MODEL_VERSION } from './fee-engine.js';
import { OrderBookSimulator } from './orderbook-simulator.js';
import { PortfolioManager, DEFAULT_RISK_LIMITS, type PortfolioRiskLimits } from './portfolio-manager.js';
import { DraftSystem } from './draft-system.js';
import { PaperTradingSystem } from './paper-trading.js';
import type { AssetLineage } from '../assets/asset-lineage.js';
import type { 
  FeeContext, 
  OpportunityRating, 
  PipelineVerificationCredential,
  TradeDraft, 
  TradeOpportunity 
} from './types.js';

function loadPipelineKeyStore(): Record<string, string> {
  const raw = process.env.EVEAI_PIPELINE_SIGNING_KEYS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] =>
        typeof entry[0] === 'string' && entry[0].length > 0 &&
        typeof entry[1] === 'string' && entry[1].length > 0,
      ),
    );
  } catch {
    return {};
  }
}

// Production keys must arrive through the environment; no signing secret is
// committed in source. Tests inject a non-production key via tests/setup.ts.
export const PIPELINE_KEY_STORE: Record<string, string> = loadPipelineKeyStore();

// SHA-256 fingerprints only: the compromised historical plaintext is never
// repeated in source. Any attempt to reintroduce it is rejected at signing and
// verification time.
export const REVOKED_PIPELINE_SECRET_SHA256: ReadonlySet<string> = new Set([
  '37ca7d242a79b5dfa5c774b0e43510a05d6ffc965e65b00d0c7ae5ccccc08c69',
]);

export function pipelineSecretFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function isPipelineSecretRevoked(secret: string): boolean {
  return REVOKED_PIPELINE_SECRET_SHA256.has(pipelineSecretFingerprint(secret));
}

export function getPipelineKey(keyId: string): string | undefined {
  return PIPELINE_KEY_STORE[keyId];
}

function resolvePipelineSecret(
  keyId: string,
  secretOverride?: string,
): { ok: true; secret: string } | { ok: false; reason: string } {
  const secret = secretOverride || getPipelineKey(keyId);
  if (!secret) return { ok: false, reason: `【密钥未知】无法为 keyId=${keyId} 找到可用的签名密钥` };
  if (isPipelineSecretRevoked(secret)) return { ok: false, reason: '【密钥已撤销】该历史签名密钥已永久吊销，禁止签发或验证凭证！' };
  return { ok: true, secret };
}

function requireInteger(name: string, value: number, min = Number.MIN_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`【凭证参数非法】${name} 必须是不小于 ${min} 的安全整数`);
  return value;
}

function requireMoney(name: string, value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER / 100) {
    throw new Error(`【凭证参数非法】${name} 必须是有限 ISK 数值`);
  }
  const cents = value * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-8) {
    throw new Error(`【凭证参数非法】${name} 最多支持两位小数`);
  }
  return Math.round(cents) / 100;
}

function requireText(name: string, value: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error(`【凭证参数非法】${name} 必须是非空且长度受控的字符串`);
  }
  if (pattern && !pattern.test(value)) throw new Error(`【凭证参数非法】${name} 格式不合法`);
  return value;
}

function normalizeSnapshotTimestamp(value?: string | null): string {
  if (!value) return new Date(0).toISOString();
  const normalized = value.endsWith('Z') ? value : value + 'Z';
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}

function requireIso(name: string, value: string): string {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) throw new Error(`【凭证参数非法】${name} 必须是有效 ISO 时间`);
  return new Date(ts).toISOString();
}

export function buildCanonicalCredentialPayload(
  data: Omit<PipelineVerificationCredential, 'signature'>,
): string {
  const canonical = {
    schema: 'eveai-pipeline-credential-v3',
    keyId: requireText('keyId', data.keyId),
    credentialId: requireText('credentialId', data.credentialId),
    characterId: requireInteger('characterId', data.characterId, 1),
    opportunityId: requireText('opportunityId', data.opportunityId),
    typeId: requireInteger('typeId', data.typeId, 1),
    strategy: requireText('strategy', data.strategy),
    buyStationId: requireInteger('buyStationId', data.buyStationId, 1),
    sellStationId: requireInteger('sellStationId', data.sellStationId, 1),
    suggestedBuyPrice: requireMoney('suggestedBuyPrice', data.suggestedBuyPrice),
    suggestedSellPrice: requireMoney('suggestedSellPrice', data.suggestedSellPrice),
    suggestedQuantity: requireInteger('suggestedQuantity', data.suggestedQuantity, 1),
    capitalRequired: requireMoney('capitalRequired', data.capitalRequired),
    expectedNetProfit: requireMoney('expectedNetProfit', data.expectedNetProfit),
    opportunityRating: requireText('opportunityRating', data.opportunityRating, /^[ABCD]$/),
    marketSnapshotHash: requireText('marketSnapshotHash', data.marketSnapshotHash, /^[a-f0-9]{16,64}$/i),
    marketSnapshotId: requireText('marketSnapshotId', data.marketSnapshotId),
    buySnapshotTimestamp: requireIso('buySnapshotTimestamp', data.buySnapshotTimestamp),
    sellSnapshotTimestamp: requireIso('sellSnapshotTimestamp', data.sellSnapshotTimestamp),
    feeModelVersion: requireText('feeModelVersion', data.feeModelVersion),
    verifiedAt: requireIso('verifiedAt', data.verifiedAt),
    expiresAt: requireIso('expiresAt', data.expiresAt),
    nonce: requireText('nonce', data.nonce),
  };
  return JSON.stringify(canonical);
}

export function signPipelineCredential(
  data: Omit<PipelineVerificationCredential, 'signature'>,
  secretOverride?: string,
): string {
  const resolved = resolvePipelineSecret(data.keyId, secretOverride);
  if (!resolved.ok) throw new Error(resolved.reason);
  const payload = buildCanonicalCredentialPayload(data);
  return createHmac('sha256', resolved.secret).update(payload).digest('hex');
}

function safeCompareHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length % 2 !== 0 || b.length % 2 !== 0) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

export function validatePipelineCredential(
  opp: TradeOpportunity,
  options?: {
    expectedCharacterId?: number;
    secretOverride?: string;
    nowMs?: number;
  },
): { valid: boolean; reason?: string } {
  if (!opp.pipelineCredential) {
    return { valid: false, reason: '【凭证缺失】该交易机会未包含统一决策管线签发的验证凭证，严禁创建草案！' };
  }

  const cred = opp.pipelineCredential;
  if (cred.opportunityRating === 'D' || opp.opportunityRating === 'D' || opp.riskVetoReason) {
    return { valid: false, reason: '【风控一票否决】D 级或被否决的高危机会不得签发或使用执行凭证！' };
  }

  const now = options?.nowMs ?? Date.now();
  const expiresTs = new Date(cred.expiresAt.endsWith('Z') ? cred.expiresAt : cred.expiresAt + 'Z').getTime();
  if (now > expiresTs) {
    return { valid: false, reason: '【凭证过期】该凭证已超过授权有效期，严禁使用陈旧行情创建草案！' };
  }

  if (options?.expectedCharacterId && cred.characterId !== options.expectedCharacterId) {
    return { valid: false, reason: `【跨角色越权】凭证绑定角色 (${cred.characterId}) 与当前操作角色 (${options.expectedCharacterId}) 不一致，严禁跨用户复用凭证！` };
  }

  const resolved = resolvePipelineSecret(cred.keyId, options?.secretOverride);
  if (!resolved.ok) {
    const reason = resolved.reason.includes('【密钥未知】')
      ? resolved.reason.replace('【密钥未知】', '【密钥失效】')
      : resolved.reason;
    return { valid: false, reason };
  }
  const secret = resolved.secret;

  const expectedSig = signPipelineCredential({
    credentialId: cred.credentialId,
    characterId: cred.characterId,
    opportunityId: cred.opportunityId,
    typeId: cred.typeId,
    strategy: cred.strategy,
    buyStationId: cred.buyStationId,
    sellStationId: cred.sellStationId,
    suggestedBuyPrice: cred.suggestedBuyPrice,
    suggestedSellPrice: cred.suggestedSellPrice,
    suggestedQuantity: cred.suggestedQuantity,
    capitalRequired: cred.capitalRequired,
    expectedNetProfit: cred.expectedNetProfit,
    opportunityRating: cred.opportunityRating,
    marketSnapshotHash: cred.marketSnapshotHash,
    marketSnapshotId: cred.marketSnapshotId,
    buySnapshotTimestamp: cred.buySnapshotTimestamp,
    sellSnapshotTimestamp: cred.sellSnapshotTimestamp,
    feeModelVersion: cred.feeModelVersion,
    verifiedAt: cred.verifiedAt,
    expiresAt: cred.expiresAt,
    nonce: cred.nonce,
    keyId: cred.keyId,
  }, secret);

  if (!safeCompareHex(cred.signature, expectedSig)) {
    return { valid: false, reason: '【凭证篡改】凭证数字签名验证失败，参数已被篡改或由未授权模块伪造！' };
  }

  if (Math.abs(cred.expectedNetProfit - opp.expectedNetProfit) > 0.01) {
    return { valid: false, reason: '【参数篡改】机会当前预期净利润与凭证签章值不吻合！' };
  }
  if (
    cred.marketSnapshotHash !== opp.marketSnapshotHash
    || cred.marketSnapshotId !== opp.marketSnapshotId
    || cred.buySnapshotTimestamp !== opp.buySnapshotTimestamp
    || cred.sellSnapshotTimestamp !== opp.sellSnapshotTimestamp
  ) {
    return { valid: false, reason: '【行情快照不一致】凭证绑定的行情快照身份或时间与当前机会不一致！' };
  }
  if (cred.feeModelVersion !== opp.feeModelVersion) {
    return { valid: false, reason: '【费用模型版本不一致】凭证签发时使用的费用模型与当前机会不一致！' };
  }
  if (
    cred.typeId !== opp.typeId ||
    cred.strategy !== opp.strategy ||
    cred.buyStationId !== opp.buyStationId ||
    cred.sellStationId !== opp.sellStationId ||
    Math.abs(cred.suggestedBuyPrice - opp.suggestedBuyPrice) > 0.01 ||
    Math.abs(cred.suggestedSellPrice - opp.suggestedSellPrice) > 0.01 ||
    cred.suggestedQuantity !== opp.suggestedQuantity ||
    Math.abs(cred.capitalRequired - opp.capitalRequired) > 1.0 ||
    cred.opportunityRating !== opp.opportunityRating
  ) {
    return { valid: false, reason: '【参数篡改】机会当前参数与凭证内签章的原始计算快照不吻合！' };
  }

  if (!cred.opportunityId || cred.opportunityId !== opp.opportunityId) {
    return { valid: false, reason: '【机会绑定缺失】凭证未绑定当前交易机会 ID，禁止脱离原始评估结果使用！' };
  }

  return { valid: true };
}

export function validateAndConsumePipelineCredential(
  db: Db,
  opp: TradeOpportunity,
  characterId: number,
  draftId: string,
): void {
  const check = validatePipelineCredential(opp, { expectedCharacterId: characterId });
  if (!check.valid) {
    throw new Error(check.reason || '【凭证无效】交易机会未通过决策管线加密凭证校验');
  }

  const credId = opp.pipelineCredential!.credentialId;

  // Atomic single-use consumption: the primary key makes concurrent replays
  // lose the insert race instead of relying on a prior SELECT.
  const consumed = db.prepare(`
    INSERT OR IGNORE INTO consumed_pipeline_credentials (credential_id, character_id, draft_id, consumed_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(credId, characterId, draftId);
  if (consumed.changes !== 1) {
    throw new Error(`【凭证重放阻断】验证凭证 ${credId} 已经被消费使用过，严禁重复提交生成草案！`);
  }
}

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
   * 1. Data Quality & Temporal Consistency Verification (using snapshot metadata)
   * 2. Orderbook Depth & Liquidity Walk Simulation across multiple levels
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
      maxCapital?: number;
      maxCargoM3?: number;
      requestedQty?: number;
      characterId?: number;
      assetLineage?: AssetLineage;
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

    // Stage 1: Snapshot temporal consistency validation using authoritative region metadata
    const dataQuality = DataCenter.validateTemporalConsistency(
      db,
      candidate.originRegionId,
      candidate.destRegionId,
    );

    // Stage 2: Pull full discrete orderbook for rigorous simulation
    const originBook = DataCenter.getOrderBook(db, candidate.originRegionId, candidate.typeId, candidate.originStationId);
    const destBook = DataCenter.getOrderBook(db, candidate.destRegionId, candidate.typeId, candidate.destStationId);

    if (originBook.sells.length === 0 || destBook.buys.length === 0) {
      return this.rejectResult(candidate, '采购端卖单或销售端买单订单簿为空，无真实流动性', 'D', meta);
    }

    // Determine capital and cargo volume constraints
    const maxCapital = candidate.maxCapital ?? 50_000_000;
    const maxCargoM3 = candidate.maxCargoM3 ?? 5_000;
    const lowestSellPrice = originBook.sells[0]?.price || 1;
    const maxQtyByCap = Math.max(1, Math.floor(maxCapital / lowestSellPrice));
    const maxQtyByM3 = Math.max(1, Math.floor(maxCargoM3 / unitM3));
    const maxAllowedQty = candidate.requestedQty
      ? Math.min(candidate.requestedQty, maxQtyByCap, maxQtyByM3)
      : Math.min(maxQtyByCap, maxQtyByM3);

    // Stage 3: Optimal quantity determination across orderbook levels
    const { optimalQuantity, buySim, sellSim } = OrderBookSimulator.findOptimalProfitableQuantity({
      originSells: originBook.sells,
      destBuys: destBook.buys,
      maxAllowedQty,
      feeCtx,
      minNetMarginPct: 5.0,
    });

    const depthCapacity = Math.min(
      originBook.sells.reduce((sum, level) => sum + Math.max(0, level.volumeRemain), 0),
      destBook.buys.reduce((sum, level) => sum + Math.max(0, level.volumeRemain), 0),
    );
    if (candidate.requestedQty && candidate.requestedQty > depthCapacity) {
      return this.rejectResult(
        candidate,
        `订单簿可成交量 ${depthCapacity} 不足拟交易数量 ${candidate.requestedQty}，明确拒绝授权`,
        'D',
        meta,
      );
    }
    if (optimalQuantity === 0 || !buySim.isComplete || !sellSim.isComplete || buySim.filledQty === 0) {
      return this.rejectResult(candidate, '订单簿深度无法支撑具有正边际利润的批量交易', 'D', meta);
    }

    const actualQty = optimalQuantity;

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
      const breakdown = PortfolioManager.getCapitalBreakdown(
        db,
        candidate.characterId,
        limits,
        candidate.assetLineage,
      );
      const riskCheck = PortfolioManager.validateTradeRisk(
        breakdown,
        trade.netCost,
        candidate.strategy,
        unitM3 * actualQty,
        limits,
        {
          db,
          typeId: candidate.typeId,
          categoryId: meta.category_id || undefined,
          assetLineage: candidate.assetLineage,
        }
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

    // Compute a quantity-aware snapshot binding. The full normalized book is
    // hashed, not just the top three levels, so different trade sizes cannot
    // share one authorization by accident.
    const normalizeLevels = (levels: Array<{ price: number; volumeRemain: number }>) =>
      [...levels]
        .map((level) => ({ p: level.price, v: level.volumeRemain }))
        .sort((left, right) => left.p - right.p || left.v - right.v);
    const snapshotContent = JSON.stringify({
      schema: 'eveai-market-snapshot-v2',
      requestedQuantity: actualQty,
      originSells: normalizeLevels(originBook.sells),
      destBuys: normalizeLevels(destBook.buys).sort((left, right) => right.p - left.p || right.v - left.v),
      buyFill: {
        requestedQty: buySim.requestedQty,
        filledQty: buySim.filledQty,
        unfilledQty: buySim.unfilledQty,
        isComplete: buySim.isComplete,
        effectiveOrders: buySim.effectiveOrders,
      },
      sellFill: {
        requestedQty: sellSim.requestedQty,
        filledQty: sellSim.filledQty,
        unfilledQty: sellSim.unfilledQty,
        isComplete: sellSim.isComplete,
        effectiveOrders: sellSim.effectiveOrders,
      },
    });
    const marketSnapshotHash = createHash('sha256').update(snapshotContent).digest('hex');
    const marketSnapshotId = 'MSNAP-' + marketSnapshotHash.slice(0, 24);
    const originMeta = DataCenter.getRegionSnapshotMeta(db, candidate.originRegionId);
    const destMeta = DataCenter.getRegionSnapshotMeta(db, candidate.destRegionId);
    const buySnapshotTimestamp = normalizeSnapshotTimestamp(originMeta?.fetchedAt);
    const sellSnapshotTimestamp = normalizeSnapshotTimestamp(destMeta?.fetchedAt);
    const opportunityId = 'OPP-' + Date.now() + '-' + randomUUID().slice(0, 8);

    // Stage 7.5: Generate Cryptographic Pipeline Verification Credential for Approved A/B grades
    let pipelineCredential: PipelineVerificationCredential | undefined;
    if ((rating === 'A' || rating === 'B') && !vetoReason) {
      const now = new Date();
      const verifiedAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
      const unsigned = {
        credentialId: 'CRED-' + Date.now() + '-' + randomUUID().slice(0, 8),
        characterId: candidate.characterId || 0,
        opportunityId,
        typeId: candidate.typeId,
        strategy: candidate.strategy,
        buyStationId: candidate.originStationId,
        sellStationId: candidate.destStationId,
        suggestedBuyPrice: buySim.weightedAvgPrice,
        suggestedSellPrice: sellSim.weightedAvgPrice,
        suggestedQuantity: actualQty,
        capitalRequired: trade.netCost,
        expectedNetProfit: trade.netProfit,
        opportunityRating: rating,
        marketSnapshotHash,
        marketSnapshotId,
        buySnapshotTimestamp,
        sellSnapshotTimestamp,
        feeModelVersion: FEE_MODEL_VERSION,
        verifiedAt,
        expiresAt,
        nonce: randomUUID(),
        keyId: 'v1',
      };
      pipelineCredential = {
        ...unsigned,
        signature: signPipelineCredential(unsigned),
      };
    }

    const opportunity: TradeOpportunity = {
      opportunityId,
      marketSnapshotHash,
      marketSnapshotId,
      buySnapshotTimestamp,
      sellSnapshotTimestamp,
      feeModelVersion: FEE_MODEL_VERSION,
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
      dailyVolumeDest: destBook.buys[0].volumeRemain,
      turnoverDays: 0,
      liquidityRating: actualQty >= 20 ? 'A' : 'B',
      riskScore: rating === 'D' ? 4 : (rating === 'C' ? 3 : 1),
      opportunityRating: rating,
      riskVetoReason: vetoReason,
      stressTest: stress,
      dataQuality,
      pipelineCredential,
      rationale: `【管线独立评估】在 ${candidate.originStationName} 采购 ${actualQty} 件，运往 ${candidate.destStationName} 变现。加权净利润 +${trade.netProfit.toLocaleString()} ISK (+${trade.netMarginPct.toFixed(1)}%)，评级为 [${rating} 级]。`,
    };

    // Persist the exact opportunity object before any draft/order is created so
    // scan, pipeline, draft, order and fill share one opportunityId.
    PaperTradingSystem.logOpportunity(db, opportunity);

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
