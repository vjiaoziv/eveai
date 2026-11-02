import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildCanonicalCredentialPayload,
  signPipelineCredential,
  validatePipelineCredential,
} from '../../src/trading/trading-pipeline.js';
import { DraftSystem } from '../../src/trading/draft-system.js';
import { runMigrations } from '../../src/db/migrations.js';
import type { TradeOpportunity, PipelineVerificationCredential } from '../../src/trading/types.js';

function unsigned(overrides: Partial<Omit<PipelineVerificationCredential, 'signature'>> = {}) {
  const now = new Date();
  return {
    credentialId: 'CRED-CANON-001',
    characterId: 5001,
    opportunityId: 'OPP-CANON-001',
    typeId: 34,
    strategy: 'station_arbitrage' as const,
    buyStationId: 60003760,
    sellStationId: 60003760,
    suggestedBuyPrice: 1.00,
    suggestedSellPrice: 2.00,
    suggestedQuantity: 10,
    capitalRequired: 10.00,
    expectedNetProfit: 5.00,
    opportunityRating: 'A' as const,
    marketSnapshotHash: 'abcdef0123456789',
    marketSnapshotId: 'MSNAP-test-0123456789abcdef',
    buySnapshotTimestamp: '2026-11-02T00:00:00.000Z',
    sellSnapshotTimestamp: '2026-11-02T00:00:00.000Z',
    feeModelVersion: 'eveai-fee-2026-11-v1',
    verifiedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    nonce: 'nonce-canon-001',
    keyId: 'v1',
    ...overrides,
  };
}

function opportunity(overrides: Partial<TradeOpportunity> = {}): TradeOpportunity {
  return {
    opportunityId: 'OPP-CANON-001',
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
    suggestedBuyPrice: 1.00,
    suggestedSellPrice: 2.00,
    suggestedQuantity: 10,
    capitalRequired: 10.00,
    estimatedFees: 1,
    haulingCost: 0,
    expectedNetProfit: 5.00,
    expectedRoiPct: 50,
    dailyVolumeDest: 100,
    turnoverDays: 1,
    liquidityRating: 'A',
    riskScore: 1,
    opportunityRating: 'A',
    rationale: 'canonical/atomicity test',
    ...overrides,
  };
}

describe('P8.5.5 canonical credential and transaction atomicity', () => {
  it('canonical JSON separates delimiters and rejects invalid precision/types', () => {
    const a = buildCanonicalCredentialPayload(unsigned({ nonce: 'a|b' }));
    const b = buildCanonicalCredentialPayload(unsigned({ nonce: 'a\nb' }));
    expect(a).not.toBe(b);

    const canonicalBase = unsigned({ suggestedBuyPrice: 1 });
    expect(buildCanonicalCredentialPayload({ ...canonicalBase, suggestedBuyPrice: 1.00 }))
      .toBe(buildCanonicalCredentialPayload(canonicalBase));
    expect(buildCanonicalCredentialPayload({ ...canonicalBase, suggestedBuyPrice: 1.01 }))
      .not.toBe(buildCanonicalCredentialPayload(canonicalBase));

    expect(() => buildCanonicalCredentialPayload(unsigned({ suggestedBuyPrice: Number.NaN }))).toThrow(/有限 ISK/);
    expect(() => buildCanonicalCredentialPayload(unsigned({ suggestedBuyPrice: Number.POSITIVE_INFINITY }))).toThrow(/有限 ISK/);
    expect(() => buildCanonicalCredentialPayload(unsigned({ suggestedQuantity: 1.5 }))).toThrow(/安全整数/);
    expect(() => buildCanonicalCredentialPayload(unsigned({ opportunityId: '' }))).toThrow(/opportunityId/);
    expect(() => buildCanonicalCredentialPayload(unsigned({ suggestedBuyPrice: 1.001 }))).toThrow(/两位小数/);
  });

  it('rejects a credential whose expectedNetProfit or market snapshot was replaced', () => {
    const base = unsigned();
    const opp = opportunity();
    opp.pipelineCredential = { ...base, signature: signPipelineCredential(base) };

    const profitTampered = opportunity({ expectedNetProfit: 6 });
    profitTampered.pipelineCredential = opp.pipelineCredential;
    expect(validatePipelineCredential(profitTampered).reason).toContain('【参数篡改】');

    const snapshotTampered = opportunity({ marketSnapshotHash: '1111111111111111' });
    snapshotTampered.pipelineCredential = { ...base, signature: signPipelineCredential(base) };
    expect(validatePipelineCredential(snapshotTampered).reason).toContain('【行情快照不一致】');
  });

  it('rolls back credential consumption when draft insertion fails', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.exec(`
      CREATE TRIGGER fail_draft_insert BEFORE INSERT ON trade_drafts
      BEGIN SELECT RAISE(ABORT, 'forced draft insert failure'); END;
    `);

    const base = unsigned();
    const opp = opportunity();
    opp.pipelineCredential = { ...base, signature: signPipelineCredential(base) };

    expect(() => DraftSystem.createDraft(db, 5001, opp)).toThrow(/forced draft insert failure/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM consumed_pipeline_credentials').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM trade_drafts').get() as { n: number }).n).toBe(0);
    db.close();
  });
});
