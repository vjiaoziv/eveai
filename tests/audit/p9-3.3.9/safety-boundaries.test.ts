import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import { P93FifoService } from '../../../src/trading/p9-3-fifo-service.js';
import { P93LedgerService } from '../../../src/trading/p9-3-ledger-service.js';
import { buildNativeAgentTools } from '../../../src/agent/tools.js';
import { loadEsiCatalog } from '../../../src/eve/esi-catalog.js';
import { assertEsiHttpDispatch, evaluateEsiOperationPolicy } from '../../../src/eve/esi-security.js';
import { fetchEsiWithRetry } from '../../../src/eve/esi-client.js';
import type { Db } from '../../../src/db/sqlite.js';

vi.mock('../../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    auth: { secretKey: 'p9339-independent-safety-secret' },
    eve: {
      clientId: 'test-client', clientSecret: 'test-secret',
      callbackUrl: 'http://localhost:3000/auth/eve/callback', requestTimeoutMs: 5000,
    },
    esi: {
      baseUrl: 'https://esi.evetech.net/latest/', specUrl: 'https://esi.evetech.net/latest/swagger.json',
      catalogCachePath: './data/cache/esi-swagger.json', compatibilityDate: '2026-03-15',
      userAgent: 'EVEAI/4.0 (+https://github.com/example/eveai; contact=operator@example.com)',
      maxPages: 5, backoffMaxSeconds: 1, requestTimeoutMs: 5000, retryMaxAttempts: 1,
    },
    characterSync: { maxPages: 50, fallbackTtlSeconds: 3600, errorRetrySeconds: 120 },
    assetSync: { enabled: false, intervalMinutes: 60 },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' }, sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720 },
  },
}));

const CHARACTER_ID = 9_945_201;
const LOCATION_ID = 60_003_760;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('P9.3.3.9 independent safety boundaries', () => {
  it('blocks every non-GET catalog operation, cross-origin dispatch and retry-wrapper bypass before fetch', async () => {
    const catalog = await loadEsiCatalog();
    const nonGet = [...catalog.values()].filter((operation) => operation.method !== 'GET');
    expect(nonGet.length).toBeGreaterThan(0);
    for (const operation of nonGet) {
      expect(evaluateEsiOperationPolicy(operation)).toMatchObject({ allowed: false, status: 405 });
    }

    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(() => assertEsiHttpDispatch('https://esi.evetech.net/latest/markets/prices/', method))
        .toThrow(/Blocked non-GET/);
      await expect(fetchEsiWithRetry(
        new URL('https://esi.evetech.net/latest/ui/autopilot/waypoint/'),
        method,
        new Headers(),
        null,
        {},
      )).rejects.toThrow(/Blocked non-GET/);
    }
    expect(() => assertEsiHttpDispatch('https://example.invalid/esi', 'GET'))
      .toThrow(/outside the configured ESI origin/);
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
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('rejects non-human ledger actors, PAPER relabeling and PAPER data promotion into REAL FIFO', () => {
    const db = new Database(':memory:') as unknown as Db;
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const input = {
      ledgerKey: 'p9339-safety-real-buy',
      tradeKind: 'BUY' as const,
      direction: 'BUY' as const,
      typeId: 34,
      locationId: LOCATION_ID,
      quantity: 10,
      unitPrice: 100,
      tradeTime: '2026-09-01T00:00:00.000Z',
      sourceType: 'USER_MANUAL_ENTRY' as const,
      draft: false,
      feeStatus: 'UNKNOWN' as const,
    };
    for (const actor of ['ai-agent', 'assistant', 'bot', 'llm', 'scheduler', 'system', '']) {
      expect(() => P93LedgerService.recordManual(db, CHARACTER_ID, input, actor)).toThrow(/人类用户|无权/);
      expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE character_id = ?').get(CHARACTER_ID))
        .toEqual({ n: 0 });
    }

    const record = P93LedgerService.recordManual(db, CHARACTER_ID, input, 'user:9339');
    expect(db.prepare('SELECT is_paper FROM real_trade_records WHERE record_id = ?').get(record.recordId))
      .toEqual({ is_paper: 0 });
    expect(() => db.prepare('UPDATE real_trade_records SET is_paper = 1 WHERE record_id = ?').run(record.recordId))
      .toThrow(/CHECK|immutable|不允许|禁止|不可原地覆盖/i);
    expect(() => db.prepare(`
      INSERT INTO real_trade_records
        (record_id, character_id, ledger_key, trade_kind, direction, type_id, location_id,
         quantity, unit_price, trade_time, source_type, is_paper)
      VALUES ('P9339-PAPER-REAL', ?, 'paper-relabel', 'BUY', 'BUY', 34, ?, 1, 1,
              datetime('now'), 'PAPER', 1)
    `).run(CHARACTER_ID, LOCATION_ID)).toThrow();

    db.prepare(`
      INSERT INTO paper_trading_positions
        (paper_id, character_id, type_id, location_id, quantity, cost_price, status)
      VALUES ('P9339-PAPER-POSITION', ?, 34, ?, 999, 1, 'holding')
    `).run(CHARACTER_ID, LOCATION_ID);
    P93FifoService.recalculate(db, CHARACTER_ID);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_fifo_lots WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE character_id = ? AND is_paper <> 0')
      .get(CHARACTER_ID)).toEqual({ n: 0 });
    db.close();
  });

  it('does not expose a REAL ledger mutation tool to the native AI tool surface', async () => {
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