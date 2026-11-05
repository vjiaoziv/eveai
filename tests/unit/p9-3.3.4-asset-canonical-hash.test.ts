import { describe, expect, it } from 'vitest';
import {
  computeCanonicalAssetHash,
  type NormalizedAssetRow,
} from '../../src/assets/asset-sync-service.js';

function row(overrides: Partial<NormalizedAssetRow> = {}): NormalizedAssetRow {
  return {
    itemId: 98_001,
    typeId: 34,
    quantity: 5,
    locationId: 60_003_760,
    locationType: 'station',
    locationFlag: 'Hangar',
    isSingleton: 0,
    isBlueprintCopy: 0,
    parentItemId: null,
    raw: { item_id: 98_001, ignored_noise: 'not-semantic' },
    ...overrides,
  };
}

describe('P9.3.3.4 canonical asset hash', () => {
  it('T09: location_type is semantic and changes the hash', () => {
    const base = computeCanonicalAssetHash([row()]);
    expect(computeCanonicalAssetHash([row({ locationType: 'item' })])).not.toBe(base);
  });

  it('T10: is_singleton is semantic and changes the hash', () => {
    const base = computeCanonicalAssetHash([row()]);
    expect(computeCanonicalAssetHash([row({ isSingleton: 1 })])).not.toBe(base);
  });

  it('T11: is_blueprint_copy, including KNOWN-false to UNKNOWN, changes the hash', () => {
    const base = computeCanonicalAssetHash([row()]);
    expect(computeCanonicalAssetHash([row({ isBlueprintCopy: 1 })])).not.toBe(base);
    expect(computeCanonicalAssetHash([row({ isBlueprintCopy: null })])).not.toBe(base);
  });

  it('T12: ESI input order does not affect the canonical hash', () => {
    const first = row({ itemId: 1 });
    const second = row({ itemId: 2, typeId: 587, quantity: 9 });
    expect(computeCanonicalAssetHash([first, second]))
      .toBe(computeCanonicalAssetHash([second, first]));
  });

  it('keeps raw non-semantic fields out of the versioned canonical representation', () => {
    const a = row({ raw: { item_id: 98_001, volatile: 1 } });
    const b = row({ raw: { item_id: 98_001, volatile: 2 } });
    expect(computeCanonicalAssetHash([a])).toBe(computeCanonicalAssetHash([b]));
    expect(computeCanonicalAssetHash([a])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('all remaining P9.2 semantic fields still invalidate dedupe', () => {
    const base = computeCanonicalAssetHash([row()]);
    for (const change of [
      { itemId: 98_002 },
      { typeId: 35 },
      { quantity: 6 },
      { locationId: 60_003_761 },
      { locationFlag: 'Cargo' },
      { parentItemId: 4 },
    ] satisfies Array<Partial<NormalizedAssetRow>>) {
      expect(computeCanonicalAssetHash([row(change)]), JSON.stringify(change)).not.toBe(base);
    }
  });
});