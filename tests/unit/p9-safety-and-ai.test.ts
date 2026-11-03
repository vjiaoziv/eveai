import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { assertEsiHttpDispatch, evaluateEsiOperationPolicy } from '../../src/eve/esi-security.js';
import { loadEsiCatalog } from '../../src/eve/esi-catalog.js';
import { buildP9AnalysisPrompt } from '../../src/trading/p9-ai-analysis.js';
import { buildNativeAgentTools } from '../../src/agent/tools.js';
import { P9OpportunityService } from '../../src/trading/p9-opportunity-service.js';

describe('P9 safety and AI boundaries', () => {
  it('keeps ESI dispatch GET-only at the network boundary', () => {
    expect(() => assertEsiHttpDispatch('https://esi.evetech.net/latest/', 'GET')).not.toThrow();
    expect(() => assertEsiHttpDispatch('https://esi.evetech.net/latest/markets/10000002/orders/', 'POST')).toThrow(/Blocked non-GET/);
    expect(() => assertEsiHttpDispatch('https://example.com/not-esi/', 'POST')).toThrow(/outside the configured ESI origin/);
  });

  it('allows only the read-only wallet transaction sync operation', async () => {
    const catalog = await loadEsiCatalog();
    const operation = catalog.get('get_characters_character_id_wallet_transactions');
    expect(operation).toBeDefined();
    expect(operation!.method).toBe('GET');
    expect(evaluateEsiOperationPolicy(operation!).allowed).toBe(true);
  });

  it('does not expose any REAL ledger mutation capability to the AI tool surface', async () => {
    const tools = await buildNativeAgentTools('full');
    const names = tools.flatMap((tool) => {
      if (tool.type === 'function') return [tool.name];
      if (tool.type === 'namespace') return tool.tools.map((nested) => `${tool.name}.${nested.name}`);
      return [];
    });
    expect(names.filter((name) => /real-ledger|record.*real.*trade|rebuild-ledger|inventory\/lots|real-trades/i.test(name))).toEqual([]);
  });

  it('feeds AI only deterministic references and hard non-calculation limits', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.exec("INSERT INTO sde_regions (region_id, name, data_json) VALUES (10000002, 'The Forge', '{}'), (10000043, 'Domain', '{}'), (10000032, 'Sinq Laison', '{}')");
    P9OpportunityService.saveSettings(db, { characterId: 7701, minNetProfit: 1, minRoiPct: 0 });
    const built = buildP9AnalysisPrompt(db, 7701, { mode: 'daily' });
    expect(built.prompt).toContain('不得自行加减乘除生成新的利润数字');
    expect(built.prompt).toContain('不得输出真实自动交易或 REAL_TRADING_READY');
    expect(built.prompt).toContain('不得把 USER_REPORTED、PENDING、DRAFT 或旧账本数据说成已核实真实交易');
    expect(built.prompt).toContain('确定性数据');
    expect(built.prompt).toContain('"mode": "daily"');
    db.close();
  });
});