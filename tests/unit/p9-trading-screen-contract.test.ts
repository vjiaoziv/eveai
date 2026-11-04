import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { P9_TAB_LABELS } from '../../web/src/components/P9TradingScreen.js';

describe('P9 trading screen navigation contract', () => {
  it('keeps the overview tab reachable alongside the active P9.3 tabs', () => {
    expect(P9_TAB_LABELS).toMatchObject({
      overview: '交易总览',
      accounting: 'REAL 账本',
      opportunities: '机会中心',
      plans: '交易方案',
      settings: '系统设置',
    });
    expect(Object.keys(P9_TAB_LABELS)).toEqual([
      'overview',
      'accounting',
      'opportunities',
      'plans',
      'settings',
    ]);
  });

  it('exposes the complete P9.3 record, evidence, correction and adjustment workflow', () => {
    const source = readFileSync(new URL('../../web/src/components/P93AccountingPanel.tsx', import.meta.url), 'utf8');
    for (const contract of [
      'targetLotId',
      'adjustmentMode',
      'adjustmentAmount',
      'fromLocationId',
      'toLocationId',
      'linkEvidence',
      'correctRecord',
      'localInputToIso',
    ]) {
      expect(source).toContain(contract);
    }
    expect(source).toContain('value="USER_ATTACHMENT"');
    expect(source).toContain('value="USER_CONFIRMATION"');
    expect(source).not.toContain('value="ESI_WALLET_LOG"');
    expect(source).not.toContain('value="ESI_MARKET_ORDER"');
  });

  it('localizes market AI provider failures instead of showing raw server text', () => {
    const component = readFileSync(new URL('../../web/src/components/market/MarketAiSearch.tsx', import.meta.url), 'utf8');
    const i18n = readFileSync(new URL('../../web/src/i18n.tsx', import.meta.url), 'utf8');
    expect(component).toContain("t('marketAiUnavailable')");
    expect(component).toContain("t('requestTooMany')");
    expect(i18n.match(/marketAiUnavailable:/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(i18n.match(/requestTooMany:/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('keeps P9.3 tabs and wide audit tables contained on narrow screens', () => {
    const component = readFileSync(new URL('../../web/src/components/P93AccountingPanel.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8');
    expect(component).toContain('className="market-tabs market-tabs--scroll"');
    expect(component.match(/className="data-table-wrap"/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(styles).toContain('.market-tabs--scroll {');
    expect(styles).toContain('overflow-x: auto;');
    expect(styles).toContain('.data-table pre {');
    expect(styles).toContain('.asset-screen__topbar h1 {');
  });

  it('does not expose retired P9 ledger tabs that now return 410', () => {
    expect(P9_TAB_LABELS).not.toHaveProperty('assets');
    expect(P9_TAB_LABELS).not.toHaveProperty('inventory');
    expect(P9_TAB_LABELS).not.toHaveProperty('trades');
    expect(P9_TAB_LABELS).not.toHaveProperty('performance');
    expect(P9_TAB_LABELS).not.toHaveProperty('risk');
  });
});
