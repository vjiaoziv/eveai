import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Phase 0 gate (i18n Unification plan, V2): the dictionary is the single
 * source of truth for zh/en/ru, so every locale must stay key-aligned and
 * placeholder-aligned. EN and ZH are typed Record<keyof typeof RU, string>,
 * which catches missing keys at compile time; this test additionally catches
 * duplicates, empty values and placeholder drift that TypeScript cannot see.
 */
const source = readFileSync(new URL('../../web/src/i18n-dictionary.ts', import.meta.url), 'utf8');

type Table = Map<string, { value: string; placeholders: string[] }>;

/** Minimal object-literal scanner: skips strings/comments, records top-level keys. */
function readTable(startMarker: string, endMarker: string): Table {
  const start = source.indexOf(startMarker);
  expect(start, 'table start not found: ' + startMarker).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  const end = source.indexOf(endMarker, open);
  expect(end, 'table end not found: ' + endMarker).toBeGreaterThan(open);

  const table: Table = new Map();
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let pendingKey: string | null = null;
  let pendingValue = '';
  let readingValue = false;

  for (let i = open; i < end; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) {
        quote = null;
        if (readingValue) {
          if (pendingKey !== null) {
            if (table.has(pendingKey)) throw new Error('duplicate key: ' + pendingKey);
            table.set(pendingKey, {
              value: pendingValue,
              placeholders: [...new Set(pendingValue.match(/\{\w+\}/g) ?? [])].sort(),
            });
          }
          pendingKey = null;
          pendingValue = '';
          readingValue = false;
        }
        continue;
      }
      pendingValue += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // A quote right after `key:` opens the value: start capturing it.
      if (pendingKey !== null && !readingValue) { readingValue = true; pendingValue = ''; }
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') { depth += 1; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth -= 1; continue; }
    if (depth !== 1) continue;
    if (!readingValue) {
      const rest = source.slice(i);
      const ident = rest.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
      if (ident) {
        let k = i + ident[0].length;
        while (k < end && /\s/.test(source[k]!)) k += 1;
        if (source[k] === ':') {
          // Stop on the colon itself; the loop's i++ lands on the value.
          pendingKey = ident[0];
          i = k;
          continue;
        }
        // Not a key: skip the bare word and keep scanning.
        i += ident[0].length - 1;
        continue;
      }
      if (pendingKey !== null && (ch === "'" || ch === '"')) {
        readingValue = true;
        pendingValue = '';
        i -= 1;
      }
    }
  }
  return table;
}

const ru = readTable('const RU = {', '} as const;');
const en = readTable('const EN: Record<keyof typeof RU, string> = {', '\n};');
const zh = readTable('const ZH: Record<keyof typeof RU, string> = {', '\n};');

describe('i18n dictionary integrity', () => {
  it('parses all three tables with the same key set', () => {
    expect(ru.size).toBeGreaterThan(400);
    expect(en.size).toBe(ru.size);
    expect(zh.size).toBe(ru.size);
    expect([...ru.keys()].filter((key) => !en.has(key))).toEqual([]);
    expect([...ru.keys()].filter((key) => !zh.has(key))).toEqual([]);
    expect([...en.keys()].filter((key) => !ru.has(key))).toEqual([]);
    expect([...zh.keys()].filter((key) => !ru.has(key))).toEqual([]);
  });

  it('has no empty values in any locale', () => {
    for (const [name, table] of [['ru', ru], ['en', en], ['zh', zh]] as const) {
      const empty = [...table.entries()].filter(([, entry]) => entry.value.trim() === '').map(([key]) => key);
      expect(empty, name + ' empty values').toEqual([]);
    }
  });

  it('keeps {placeholder} sets identical across locales', () => {
    const drift: string[] = [];
    for (const [key, entry] of ru) {
      const enPlaceholders = en.get(key)?.placeholders ?? null;
      const zhPlaceholders = zh.get(key)?.placeholders ?? null;
      if (enPlaceholders === null || zhPlaceholders === null) continue;
      if (JSON.stringify(entry.placeholders) !== JSON.stringify(enPlaceholders)
        || JSON.stringify(entry.placeholders) !== JSON.stringify(zhPlaceholders)) {
        drift.push(key + ' ru=[' + entry.placeholders.join(',') + '] en=[' + enPlaceholders.join(',') + '] zh=[' + zhPlaceholders.join(',') + ']');
      }
    }
    expect(drift).toEqual([]);
  });

  it('exports the non-React lookup and the shared storage key', () => {
    expect(source).toContain('export function translateOutOfReact(');
    expect(source).toContain("export const LOCALE_STORAGE_KEY = 'eveai.locale.v1';");
  });
});
