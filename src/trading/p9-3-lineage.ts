import type { Db } from '../db/sqlite.js';
import type { UserContext } from '../auth/user-resolver.js';
import {
  assetLineageFromBinding,
  readAssetBindingSnapshot,
  resolveAssetLineage,
  type AssetLineage,
} from '../assets/asset-lineage.js';

/**
 * Immutable ownership envelope for REAL accounting history.
 *
 * character_id alone is not an authorization boundary: EVE characters can be
 * unlinked and rebound to another local user or chat. The owner/chat/epoch
 * triple is the durable isolation namespace. binding_digest is retained as
 * evidence for the exact authorization snapshot used at write time, but it is
 * deliberately not part of read authorization so ordinary scope refresh does
 * not hide a user's own historical ledger.
 */
export type RealLedgerLineage = AssetLineage;

export type RealLedgerLineagePredicate = {
  sql: string;
  params: unknown[];
};

export function realLedgerLineageFromContext(
  db: Db,
  characterId: number,
  ctx: UserContext,
): RealLedgerLineage {
  const binding = readAssetBindingSnapshot(
    db,
    characterId,
    { ...ctx, characterId },
    false,
  );
  return assetLineageFromBinding(binding);
}

/**
 * Resolve a lineage for direct service callers that predate the route-level
 * authorization envelope. If no local owner/link exists this returns null,
 * which keeps isolated unit fixtures working while making such rows fail
 * closed for normal web routes. If multiple chat lanes exist the caller must
 * provide an explicit lane; guessing would reintroduce cross-lane writes.
 */
export function optionalRealLedgerLineage(db: Db, characterId: number): RealLedgerLineage | null {
  const account = db.prepare(
    'SELECT user_id FROM eve_accounts WHERE character_id = ?',
  ).get(characterId) as { user_id: number | null } | undefined;
  if (!account?.user_id) return null;
  const links = db.prepare(`
    SELECT chat_id FROM eve_character_links
    WHERE character_id = ? AND user_id = ?
    ORDER BY chat_id
  `).all(characterId, account.user_id) as Array<{ chat_id: number }>;
  if (links.length === 0) return null;
  if (links.length > 1) {
    throw new Error('REAL 账本存在多个 chat lane，服务调用必须显式提供 owner/chat/binding lineage。');
  }
  return resolveAssetLineage(db, characterId, account.user_id, links[0].chat_id);
}

export function resolveRealLedgerLineage(
  db: Db,
  characterId: number,
  lineage?: RealLedgerLineage | null,
): RealLedgerLineage | null {
  return lineage === undefined ? optionalRealLedgerLineage(db, characterId) : lineage;
}

export function realLedgerLineagePredicate(
  alias: string | null,
  lineage: RealLedgerLineage,
): RealLedgerLineagePredicate {
  const prefix = alias ? `${alias}.` : '';
  const chatSql = lineage.ownerChatId === null
    ? `${prefix}owner_chat_id IS NULL`
    : `${prefix}owner_chat_id = ?`;
  return {
    sql: [
      `${prefix}owner_user_id = ?`,
      chatSql,
      `${prefix}binding_epoch = ?`,
    ].join(' AND '),
    params: lineage.ownerChatId === null
      ? [lineage.ownerUserId, lineage.bindingEpoch]
      : [lineage.ownerUserId, lineage.ownerChatId, lineage.bindingEpoch],
  };
}
