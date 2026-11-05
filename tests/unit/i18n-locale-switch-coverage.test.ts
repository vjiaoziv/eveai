import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * V10 gate: every main view (the activeView branches rendered by App.tsx)
 * plus the data dock must render the language switch, so a user can change
 * zh/en/ru from anywhere instead of only the screens that happened to be
 * wired up. Visual confirmation remains a manual acceptance step; this test
 * pins the coverage mechanically.
 */
const MAIN_VIEWS: Array<[label: string, path: string]> = [
  ['chat', 'web/src/components/ChatScreen.tsx'],
  ['market', 'web/src/components/MarketScreen.tsx'],
  ['trading', 'web/src/components/TradingScreen.tsx'],
  ['p9', 'web/src/components/P9TradingScreen.tsx'],
  ['assets', 'web/src/components/AssetScreen.tsx'],
  ['map', 'web/src/components/map/MapScreen.tsx'],
  ['profile', 'web/src/components/PilotProfileScreen.tsx'],
  ['settings', 'web/src/components/SettingsScreen.tsx'],
  ['examples', 'web/src/components/ExamplesScreen.tsx'],
  ['support', 'web/src/components/SupportScreen.tsx'],
  ['data dock', 'web/src/components/DataDock.tsx'],
];

describe('language switch coverage (V10)', () => {
  it.each(MAIN_VIEWS)('%s view renders LocaleSwitch', (label, path) => {
    const source = readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
    expect(source, label + ' must import LocaleSwitch').toContain('LocaleSwitch');
    expect(source, label + ' must render <LocaleSwitch').toContain('<LocaleSwitch');
    // import + JSX usage (no view merely references the name in a comment)
    expect(source.match(/LocaleSwitch/g) ?? []).toHaveLength(2);
  });
});