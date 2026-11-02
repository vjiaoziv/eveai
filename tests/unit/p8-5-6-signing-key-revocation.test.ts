import { describe, expect, it } from 'vitest';
import {
  REVOKED_PIPELINE_SECRET_SHA256,
  isPipelineSecretRevoked,
  pipelineSecretFingerprint,
  signPipelineCredential,
  validatePipelineCredential,
} from '../../src/trading/trading-pipeline.js';
import type { TradeOpportunity } from '../../src/trading/types.js';

function unsigned(overrides: Record<string, unknown> = {}, now = new Date()) {
  return {
    credentialId: 'CRED-REVOKE-001',
    characterId: 5001,
    opportunityId: 'OPP-REVOKE-001',
    typeId: 34,
    strategy: 'station_arbitrage' as const,
    buyStationId: 60003760,
    sellStationId: 60003760,
    suggestedBuyPrice: 1,
    suggestedSellPrice: 2,
    suggestedQuantity: 10,
    capitalRequired: 10,
    expectedNetProfit: 5,
    opportunityRating: 'A' as const,
    marketSnapshotHash: 'abcdef0123456789',
    marketSnapshotId: 'MSNAP-test-0123456789abcdef',
    buySnapshotTimestamp: now.toISOString(),
    sellSnapshotTimestamp: now.toISOString(),
    feeModelVersion: 'eveai-fee-2026-11-v1',
    verifiedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    nonce: 'nonce-revoke-001',
    keyId: 'revocation-test',
    ...overrides,
  };
}

function opportunity(overrides: Record<string, unknown> = {}, now = new Date()): TradeOpportunity {
  return {
    opportunityId: 'OPP-REVOKE-001',
    marketSnapshotHash: 'abcdef0123456789',
    marketSnapshotId: 'MSNAP-test-0123456789abcdef',
    buySnapshotTimestamp: now.toISOString(),
    sellSnapshotTimestamp: now.toISOString(),
    feeModelVersion: 'eveai-fee-2026-11-v1',
    typeId: 34,
    typeName: 'Tritanium',
    volumeM3: 0.01,
    strategy: 'station_arbitrage',
    buyStationId: 60003760,
    buyStationName: 'Jita IV-4',
    sellStationId: 60003760,
    sellStationName: 'Jita IV-4',
    suggestedBuyPrice: 1,
    suggestedSellPrice: 2,
    suggestedQuantity: 10,
    capitalRequired: 10,
    estimatedFees: 1,
    haulingCost: 0,
    expectedNetProfit: 5,
    expectedRoiPct: 50,
    dailyVolumeDest: 100,
    turnoverDays: 1,
    liquidityRating: 'A',
    riskScore: 1,
    opportunityRating: 'A',
    rationale: 'revocation and snapshot binding',
    ...overrides,
  } as TradeOpportunity;
}

describe('P8.5.6 signing-key revocation and snapshot binding', () => {
  it('permanently rejects a secret after its fingerprint is revoked', () => {
    const now = new Date();
    const secret = 'synthetic-test-secret-for-revocation';
    const fingerprint = pipelineSecretFingerprint(secret);
    REVOKED_PIPELINE_SECRET_SHA256.add(fingerprint);

    expect(isPipelineSecretRevoked(secret)).toBe(true);
    expect(() => signPipelineCredential(unsigned({}, now), secret)).toThrow(/密钥已撤销/);

    const validBase = unsigned({}, now);
    const signedBeforeRevocation = signPipelineCredential(validBase, 'not-revoked-secret');
    const opp = opportunity({}, now);
    opp.pipelineCredential = { ...validBase, signature: signedBeforeRevocation };
    expect(validatePipelineCredential(opp, { secretOverride: 'not-revoked-secret', nowMs: now.getTime() }).valid).toBe(true);
  });

  it('rejects mismatched snapshot identity, timestamps, or fee model version', () => {
    const now = new Date();
    const base = unsigned({}, now);

    const wrongSnapshotId = opportunity({ marketSnapshotId: 'MSNAP-other-0123456789abcdef' }, now);
    expect(wrongSnapshotId.marketSnapshotId).toBe('MSNAP-other-0123456789abcdef');
    wrongSnapshotId.pipelineCredential = {
      ...base,
      signature: signPipelineCredential(base, 'not-revoked-secret'),
    };
    const snapshotResult = validatePipelineCredential(wrongSnapshotId, { secretOverride: 'not-revoked-secret', nowMs: now.getTime() });
    expect(snapshotResult.valid).toBe(false);
    expect(snapshotResult.reason ?? '').toContain('行情快照不一致');

    const wrongFeeModel = opportunity({ feeModelVersion: 'eveai-fee-old' }, now);
    wrongFeeModel.pipelineCredential = {
      ...base,
      signature: signPipelineCredential(base, 'not-revoked-secret'),
    };
    const feeResult = validatePipelineCredential(wrongFeeModel, { secretOverride: 'not-revoked-secret', nowMs: now.getTime() });
    expect(feeResult.valid).toBe(false);
    expect(feeResult.reason ?? '').toContain('费用模型版本不一致');
  });
});
