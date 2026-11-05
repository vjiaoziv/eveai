import type { AssetLineage } from '../../src/assets/asset-lineage.js';

/**
 * Deterministic owner/binding lineage for isolated SQLite tests.
 * Production code must always resolve this from the authenticated session.
 */
export function testAssetLineage(
  characterId: number,
  overrides: Partial<AssetLineage> = {},
): AssetLineage {
  const ownerUserId = overrides.ownerUserId ?? characterId + 100_000;
  const ownerChatId = overrides.ownerChatId === undefined
    ? characterId + 200_000
    : overrides.ownerChatId;
  const bindingEpoch = overrides.bindingEpoch ?? 1;
  const bindingDigest = overrides.bindingDigest
    ?? `test-binding:${characterId}:${ownerUserId}:${ownerChatId ?? 'null'}:${bindingEpoch}`;
  return { ownerUserId, ownerChatId, bindingEpoch, bindingDigest };
}
