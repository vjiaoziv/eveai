import { describe, expect, it } from 'vitest';
import { clampNonNegativeInteger, clampPositiveInteger } from '../../src/util/query-bounds.js';

describe('query pagination bounds', () => {
  it('rejects NaN, Infinity, negatives, fractions and unsafe integers', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'bad']) {
      expect(clampPositiveInteger(value, 25, 100)).toBe(25);
      expect(clampNonNegativeInteger(value)).toBe(0);
    }
  });

  it('caps valid values and accepts zero only for offsets', () => {
    expect(clampPositiveInteger('20', 25, 100)).toBe(20);
    expect(clampPositiveInteger(500, 25, 100)).toBe(100);
    expect(clampNonNegativeInteger(0)).toBe(0);
    expect(clampNonNegativeInteger(2_000_000)).toBe(1_000_000);
  });
});
