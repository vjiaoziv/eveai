import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * V6 gate: src/web answers HTTP errors with snake_case machine codes only.
 * Localized copy lives in web/src/api-error-keys.ts plus the i18n dictionary;
 * the transport layer (api.ts) renders codes in the active locale.
 *
 * Scope: error fields of HTTP responses and the helpers that feed them
 * (web-admission, agent-requests enqueue, live-session attach, avoid, and the
 * Fastify error handler). health.ts reports ops diagnostics, and error fields
 * inside 200-OK payloads (dataset freshness, snapshots) are data fields that
 * the plan defers to the data-localization pass (Phase 5).
 */

const ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const CODE_RE = /^[a-z][a-z0-9_]*$/;
const SKIP = new Set(['health.ts']);
const PRODUCERS = [
  'src/eve-map/live-session.ts',
  'src/eve-map/avoid.ts',
  'src/web/web-admission.ts',
  'src/web/agent-requests.ts',
];

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

function webSources(): string[] {
  return readdirSync(path.join(ROOT, 'src/web'))
    .filter((f) => f.endsWith('.ts') && !SKIP.has(f))
    .map((f) => path.join('src/web', f));
}

function literalErrors(text: string): string[] {
  const out: string[] = [];
  const re = /\berror:\s*(['"])((?:(?!\1)[^\n])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[2]);
  return out;
}

describe('src/web error responses are machine codes (V6)', () => {
  it('never puts localized prose into an error field', () => {
    const violations: string[] = [];
    for (const rel of [...webSources(), ...PRODUCERS]) {
      const text = read(rel);
      for (const value of literalErrors(text)) {
        if (!CODE_RE.test(value)) violations.push(rel + ': "' + value.slice(0, 60) + '"');
      }
      const tmpl = /\berror:\s*`/g;
      let m: RegExpExecArray | null;
      while ((m = tmpl.exec(text)) !== null) {
        const line = text.slice(0, m.index).split('\n').length;
        violations.push(rel + ':' + line + ' template-literal error field');
      }
    }
    expect(violations).toEqual([]);
  });

  it('never forwards raw internal messages as the error field', () => {
    const banned: Array<[string, RegExp]> = [
      ['error instanceof Error ternary', /error:\s*error instanceof Error/],
      ['err.message passthrough', /error:\s*err\.message/],
      ['error.message passthrough', /error:\s*error\.message/],
      ['sanitizeAssetError passthrough', /error:\s*sanitizeAssetError\(/],
      ['message variable passthrough', /error:\s*message\b/],
      ['joined internal errors', /error:\s*result\.errors\.join/],
      ['FOREIGN_SESSION_NOTICE', /error:\s*FOREIGN_SESSION_NOTICE/],
      ['UNAVAILABLE_ERROR', /error:\s*UNAVAILABLE_ERROR/],
      ['stringifyError diagnostics', /error:\s*stringifyError\(/],
      ['firstError diagnostics', /error:\s*firstError\b/],
      ['health.error diagnostics', /error:\s*health\.error\b/],
    ];
    const violations: string[] = [];
    for (const rel of webSources()) {
      const text = read(rel);
      for (const [label, re] of banned) {
        if (re.test(text)) violations.push(rel + ': ' + label);
      }
    }
    expect(violations).toEqual([]);
  });

  it('maps every code it can emit', () => {
    const mapText = read('web/src/api-error-keys.ts');
    const mapped = new Set(Array.from(mapText.matchAll(/^  ([a-z0-9_]+):/gm), (m) => m[1]));
    const emitted = new Set<string>();
    for (const rel of [...webSources(), ...PRODUCERS]) {
      const text = read(rel);
      for (const m of text.matchAll(/\berror:\s*['"]([a-z][a-z0-9_]*)['"]/g)) emitted.add(m[1]);
      for (const m of text.matchAll(/rejection\(\s*\d+,\s*['"]([a-z][a-z0-9_]*)['"]/g)) emitted.add(m[1]);
    }
    const server = read('src/web/server.ts');
    for (const block of ['STATUS_ERROR_CODES', 'FASTIFY_ERROR_CODES']) {
      const body = server.match(new RegExp('const ' + block + '[\\s\\S]*?\\n};'))?.[0] ?? '';
      for (const m of body.matchAll(/'([a-z][a-z0-9_]*)'/g)) emitted.add(m[1]);
    }
    emitted.add('request_failed'); // fastifyErrorCode fallback
    // Agent-request DTO codes: publicError passes stored codes through.
    for (const code of [
      'cancelled', 'deadline_exceeded', 'identity_changed', 'service_restarted',
      'overloaded', 'provider_unavailable', 'agent_failure',
    ]) emitted.add(code);
    const unmapped = [...emitted].filter((c) => !mapped.has(c)).sort();
    expect(unmapped).toEqual([]);
  });

  it('publicError passes codes through without prose', () => {
    const text = read('src/web/agent-requests.ts');
    const fn = text.match(/function publicError[\s\S]*?\n}/)?.[0] ?? '';
    expect(fn).not.toMatch(/[а-яА-Я]/);
    expect(fn).toContain("? code : 'agent_failure'");
  });
});