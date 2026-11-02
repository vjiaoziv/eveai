import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMigrations } from '../../src/db/migrations.js';
import { PaperTradingSystem } from '../../src/trading/paper-trading.js';
import { signPipelineCredential } from '../../src/trading/trading-pipeline.js';
import type { TradeOpportunity } from '../../src/trading/types.js';

const projectRoot = resolve(process.cwd());
const tsx = join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const worker = join(projectRoot, 'tests', 'helpers', 'p8-5-6-concurrency-worker.ts');

function runWorker(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(tsx, [worker, JSON.stringify(args)], {
      cwd: projectRoot,
      env: {
        ...process.env,
        EVEAI_PIPELINE_SIGNING_KEYS: '{"v1":"test-pipeline-signing-key-v1"}',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`worker ${code}: ${stderr}`));
      try { resolvePromise(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}

function signedOpportunity(): TradeOpportunity {
  const now = new Date();
  const opp: TradeOpportunity = {
    opportunityId: 'OPP-MP-' + now.getTime(),
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
    rationale: 'multi-process credential consumption',
  };
  const unsigned = {
    credentialId: 'CRED-MP-' + now.getTime(),
    characterId: 5001,
    opportunityId: opp.opportunityId!,
    typeId: opp.typeId,
    strategy: opp.strategy,
    buyStationId: opp.buyStationId,
    sellStationId: opp.sellStationId,
    suggestedBuyPrice: opp.suggestedBuyPrice,
    suggestedSellPrice: opp.suggestedSellPrice,
    suggestedQuantity: opp.suggestedQuantity,
    capitalRequired: opp.capitalRequired,
    expectedNetProfit: opp.expectedNetProfit,
    opportunityRating: opp.opportunityRating,
    marketSnapshotHash: opp.marketSnapshotHash!,
    marketSnapshotId: 'MSNAP-test-0123456789abcdef',
    buySnapshotTimestamp: '2026-11-02T00:00:00.000Z',
    sellSnapshotTimestamp: '2026-11-02T00:00:00.000Z',
    feeModelVersion: 'eveai-fee-2026-11-v1',
    verifiedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    nonce: 'nonce-mp-' + now.getTime(),
    keyId: 'v1',
  };
  opp.pipelineCredential = { ...unsigned, signature: signPipelineCredential(unsigned) };
  return opp;
}

describe('P8.5.6 multi-process SQLite concurrency', () => {
  it('keeps funds non-negative across 80 competing order requests from 8 processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eveai-mp-funds-'));
    const dbPath = join(dir, 'funds.db');
    const db = new Database(dbPath);
    runMigrations(db);
    PaperTradingSystem.getOrCreateAccount(db, 5001, 1_000_000);
    db.close();

    const results = await Promise.all(Array.from({ length: 8 }, () => runWorker({
      mode: 'orders',
      dbPath,
      characterId: 5001,
      iterations: 10,
      price: 100,
      quantity: 195,
    })));

    const succeeded = results.reduce((sum, row) => sum + Number(row.succeeded || 0), 0);
    const rejected = results.reduce((sum, row) => sum + Number(row.rejected || 0), 0);
    const check = new Database(dbPath);
    const account = check.prepare('SELECT available_cash, escrow_locked FROM paper_trading_accounts WHERE account_id = ?').get('PT-ACC-5001') as any;
    const orders = check.prepare('SELECT COUNT(*) AS n FROM paper_trading_orders').get() as { n: number };
    check.close();
    rmSync(dir, { recursive: true, force: true });

    expect(succeeded + rejected).toBe(80);
    expect(account.available_cash).toBeGreaterThanOrEqual(0);
    expect(account.escrow_locked).toBeGreaterThanOrEqual(0);
    expect(account.available_cash + account.escrow_locked).toBeLessThanOrEqual(1_000_000);
    expect(orders.n).toBe(succeeded);
  });

  it('consumes one credential exactly once across 100 attempts in 10 competing processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eveai-mp-cred-'));
    const dbPath = join(dir, 'credential.db');
    const db = new Database(dbPath);
    runMigrations(db);
    db.close();

    const opp = signedOpportunity();
    const results = await Promise.all(Array.from({ length: 10 }, () => runWorker({
      mode: 'credential',
      dbPath,
      characterId: 5001,
      attempts: 10,
      opportunity: opp,
    })));

    const ok = results.reduce((sum, row) => sum + Number(row.succeeded || 0), 0);
    const replay = results.reduce((sum, row) => sum + Number(row.replayed || 0), 0);
    const check = new Database(dbPath);
    const consumed = check.prepare('SELECT COUNT(*) AS n FROM consumed_pipeline_credentials').get() as { n: number };
    const drafts = check.prepare('SELECT COUNT(*) AS n FROM trade_drafts').get() as { n: number };
    check.close();
    rmSync(dir, { recursive: true, force: true });

    expect(ok).toBe(1);
    expect(replay).toBe(99);
    expect(consumed.n).toBe(1);
    expect(drafts.n).toBe(1);
  }, 20_000);
});
