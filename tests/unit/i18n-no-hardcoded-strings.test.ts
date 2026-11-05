import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Phase 0 gate (i18n Unification plan, V3/V4/V5): user-visible natural language
 * must live in i18n-dictionary.ts, not inline in components.
 *
 * Rules enforced:
 *  1. No CJK code lines outside the dictionary.
 *  2. No Cyrillic string literals outside the dictionary.
 *  3. Inline copy is allowed only inside an explicit locale branch
 *     (`locale === 'zh'` / `=== 'ru'`), which is how dates.ts and
 *     SystemInspector localise age strings.
 *  4. Files still awaiting conversion (Phase 2.1/2.2) are listed below with the
 *     baseline count they had when this gate landed; they may shrink but never
 *     grow. Deleting an entry from PENDING is the definition of "done".
 */
const WEB_SRC = new URL('../../web/src/', import.meta.url).pathname;

/** Baseline captured when this gate was written. Lower only, never raise. */
const PENDING: Record<string, number> = {
// Completed and therefore now under the strict rule: components/TradingScreen.tsx
};

// i18n-dictionary.ts holds every translated string.
// i18n.tsx holds only the language switcher: a language's own name/aria
// (中文 / EN / RU / the Russian aria) is never translated by convention.
const SKIP = new Set(['i18n-dictionary.ts', 'i18n.tsx']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Drop comments so documentation prose never trips the gate. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (line, prefix: string) => prefix + ' '.repeat(line.length - prefix.length));
}

const LOCALE_BRANCH = /locale\s*===\s*'(?:zh|en|ru)'|===\s*'(?:zh|ru)'/;

describe('web/src has no hardcoded user-facing copy', () => {
  const files = walk(WEB_SRC).filter((file) => !SKIP.has(relative(WEB_SRC, file)));

  it('scans the whole web/src tree', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('keeps every pending file at or below its baseline', () => {
    const regressions: string[] = [];
    for (const [rel, baseline] of Object.entries(PENDING)) {
      const file = join(WEB_SRC, rel);
      const count = stripComments(readFileSync(file, 'utf8')).split('\n')
        .filter((line) => /[\u4e00-\u9fff]/.test(line)).length;
      if (count > baseline) regressions.push(rel + ' ' + count + ' > baseline ' + baseline);
    }
    expect(regressions).toEqual([]);
  });

  it('has no CJK code lines outside the dictionary and pending files', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(WEB_SRC, file);
      if (rel in PENDING) continue;
      stripComments(readFileSync(file, 'utf8')).split('\n').forEach((line, index) => {
        if (/[\u4e00-\u9fff]/.test(line) && !LOCALE_BRANCH.test(line)) {
          offenders.push(rel + ':' + (index + 1) + ' ' + line.trim().slice(0, 120));
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('has no unconditional Cyrillic literals outside locale branches', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(WEB_SRC, file);
      if (rel in PENDING) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      let match: RegExpExecArray | null;
      const literal = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
      while ((match = literal.exec(code)) !== null) {
        const value = match[2] ?? '';
        if (!/[\u0400-\u04FF]/.test(value) || value.trim() === '') continue;
        const line = code.slice(0, match.index).split('\n').length;
        if (LOCALE_BRANCH.test(code.slice(Math.max(0, match.index - 200), match.index))) continue;
        offenders.push(rel + ':' + line + ' ' + value.replace(/\s+/g, ' ').slice(0, 120));
      }
    }
    expect(offenders).toEqual([]);
  });
});
