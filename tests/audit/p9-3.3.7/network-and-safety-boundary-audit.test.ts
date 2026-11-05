import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { P93AuditService } from '../../../src/trading/p9-3-audit-service.js';
import { P93FifoService } from '../../../src/trading/p9-3-fifo-service.js';
import { P93LedgerService } from '../../../src/trading/p9-3-ledger-service.js';
import { buildNativeAgentTools } from '../../../src/agent/tools.js';
import { loadEsiCatalog } from '../../../src/eve/esi-catalog.js';
import {
  assertEsiHttpDispatch,
  evaluateEsiOperationPolicy,
} from '../../../src/eve/esi-security.js';
import { fetchEsiWithRetry } from '../../../src/eve/esi-client.js';
import type { Db } from '../../../src/db/sqlite.js';

vi.mock('../../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    auth: { secretKey: 'p9337-boundary-audit-secret' },
    eve: {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      callbackUrl: 'http://localhost:3000/auth/eve/callback',
      requestTimeoutMs: 5000,
    },
    esi: {
      baseUrl: 'https://esi.evetech.net/latest/',
      specUrl: 'https://esi.evetech.net/latest/swagger.json',
      catalogCachePath: './data/cache/esi-swagger.json',
      compatibilityDate: '2026-03-15',
      userAgent: 'EVEAI/4.0 (+https://github.com/example/eveai; contact=operator@example.com)',
      maxPages: 5,
      backoffMaxSeconds: 1,
      requestTimeoutMs: 5000,
      retryMaxAttempts: 1,
    },
    characterSync: { maxPages: 50, fallbackTtlSeconds: 3600, errorRetrySeconds: 120 },
    assetSync: { enabled: false, intervalMinutes: 60 },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
  },
}));

const CHARACTER_ID = 9_834_741;
const LOCATION_ID = 60_003_760;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('P9.3.3.7 independent network and safety boundary counterexamples', () => {
  it('blocks every non-GET ESI catalog operation and both dispatch bypass forms before fetch', async () => {
    const catalog = await loadEsiCatalog();
    expect(catalog.get('get_characters_character_id_wallet_transactions')?.method).toBe('GET');
    const nonGet = [...catalog.values()].filter((operation) => operation.method !== 'GET');
    expect(nonGet.length).toBeGreaterThan(0);
    for (const operation of nonGet) {
      expect(evaluateEsiOperationPolicy(operation)).toMatchObject({ allowed: false, status: 405 });
    }

    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(() => assertEsiHttpDispatch('https://esi.evetech.net/latest/markets/prices/', 'POST'))
      .toThrow(/Blocked non-GET/);
    expect(() => assertEsiHttpDispatch('https://example.com/not-esi', 'GET'))
      .toThrow(/outside the configured ESI origin/);
    await expect(fetchEsiWithRetry(
      new URL('https://esi.evetech.net/latest/ui/autopilot/waypoint/'),
      'DELETE',
      new Headers(),
      null,
      {},
    )).rejects.toThrow(/Blocked non-GET/);
    expect(fetchMock).not.toHaveBeenCalled();

    const allowed = await fetchEsiWithRetry(
      new URL('https://esi.evetech.net/latest/markets/prices/'),
      'GET',
      new Headers(),
      null,
      {},
    );
    expect(allowed.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not allow a REAL record to be relabeled PAPER and keeps the audit integrity check clean', () => {
    const db = new Database(':memory:') as unknown as Db;
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const record = P93LedgerService.recordManual(db, CHARACTER_ID, {
      ledgerKey: 'p9337-boundary-real-record',
      tradeKind: 'BUY',
      direction: 'BUY',
      typeId: 34,
      locationId: LOCATION_ID,
      quantity: 10,
      unitPrice: 100,
      tradeTime: '2026-09-01T00:00:00.000Z',
      sourceType: 'USER_MANUAL_ENTRY',
      draft: false,
      feeStatus: 'UNKNOWN',
    }, 'user:audit');

    expect(db.prepare('SELECT is_paper FROM real_trade_records WHERE record_id = ?').get(record.recordId))
      .toEqual({ is_paper: 0 });
    expect(() => db.prepare('UPDATE real_trade_records SET is_paper = 1 WHERE record_id = ?')
      .run(record.recordId)).toThrow(/CHECK|immutable|不允许|禁止|非草稿|不可原地覆盖/i);

    db.prepare(`
      INSERT INTO paper_trading_positions
        (paper_id, character_id, type_id, location_id, quantity, cost_price, status)
      VALUES ('P9337-PAPER-POSITION', ?, 34, ?, 999, 1, 'holding')
    `).run(CHARACTER_ID, LOCATION_ID);
    P93FifoService.recalculate(db, CHARACTER_ID);

    const integrity = P93AuditService.integrityCheck(db, CHARACTER_ID);
    expect(integrity.findings.filter((finding) => finding.includes('PAPER'))).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE character_id = ? AND is_paper <> 0')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_fifo_lots WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
    db.close();
  });

  it('does not expose REAL ledger mutation tools to the AI tool surface', async () => {
    const tools = await buildNativeAgentTools('full');
    const names = tools.flatMap((tool) => {
      if (tool.type === 'function') return [tool.name];
      if (tool.type === 'namespace') return tool.tools.map((nested) => `${tool.name}.${nested.name}`);
      return [];
    });
    expect(names.filter((name) => /real-ledger|record.*real.*trade|rebuild-ledger|real-trades|inventory\/lots/i.test(name)))
      .toEqual([]);
  });
});