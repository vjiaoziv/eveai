import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { readLocale } from '../../src/web/read-locale.js';

/**
 * V8 machine path: the response locale that drives Chinese perimeter
 * advisories (appendAdvisory stores advisory.text[locale]) starts here.
 * First Accept-Language tag wins; unknown or missing values keep the
 * historical ru default (plan R1 / Q1).
 */
function requestWith(acceptLanguage?: string): FastifyRequest {
  return {
    headers: acceptLanguage === undefined ? {} : { 'accept-language': acceptLanguage },
  } as FastifyRequest;
}

describe('readLocale', () => {
  it('recognizes Chinese from the first Accept-Language tag', () => {
    expect(readLocale(requestWith('zh-CN'))).toBe('zh');
    expect(readLocale(requestWith('zh'))).toBe('zh');
    expect(readLocale(requestWith('zh-CN,zh;q=0.9,en;q=0.8'))).toBe('zh');
  });

  it('keeps the first tag authoritative when languages are ordered', () => {
    expect(readLocale(requestWith('en-US,en;q=0.9,zh-CN;q=0.8'))).toBe('en');
    expect(readLocale(requestWith('en'))).toBe('en');
  });

  it('falls back to ru for unknown or missing values (R1/Q1)', () => {
    expect(readLocale(requestWith('ru-RU'))).toBe('ru');
    expect(readLocale(requestWith('fr-FR,de;q=0.8'))).toBe('ru');
    expect(readLocale(requestWith(undefined))).toBe('ru');
  });
});