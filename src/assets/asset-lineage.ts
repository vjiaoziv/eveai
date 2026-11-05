import { createHash } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import type { UserContext } from '../auth/user-resolver.js';

/**
 * Owner/binding lineage for private real-asset data.
 *
 * character_id alone is never an authorization boundary: EVE characters can
 * be unlinked and rebound to another local user or chat. Every private asset
 * record therefore carries the owner and binding epoch that produced it.
 * Legacy rows deliberately remain unowned and are not visible through the
 * application until an explicit reconciliation assigns a lineage.
 */

export const ASSET_READ_SCOPE = 'esi-assets.read_assets.v1';

export type AssetBindingSnapshot = {
  characterId: number;
  userId: number;
  chatId: number | null;
  accountUserId: number | null;
  ownerHash: string | null;
  scopes: string[];
  bindingEpoch: number;
  digest: string;
};

export type AssetLineage = {
  ownerUserId: number;
  ownerChatId: number | null;
  bindingEpoch: number;
  bindingDigest: string;
};

export type AssetLineagePredicate = {
  sql: string;
  params: unknown[];
};

function assertPinnedContext(characterId: number, ctx: UserContext): void {
  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    throw new Error('资产同步目标 characterId 必须是正安全整数。');
  }
  if (ctx.characterId === undefined || ctx.characterId !== characterId) {
    throw new Error('资产同步上下文未固定到目标角色，拒绝继续。');
  }
  if (!Number.isSafeInteger(ctx.userId) || ctx.userId <= 0) {
    throw new Error('资产同步缺少有效的用户所有权上下文，拒绝继续。');
  }
  if (ctx.chatId !== undefined && (!Number.isSafeInteger(ctx.chatId) || ctx.chatId === 0)) {
    throw new Error('资产同步 chatId 上下文无效，拒绝继续。');
  }
}

function parseScopes(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== 'string')) {
      throw new Error('invalid scopes');
    }
    return parsed;
  } catch {
    throw new Error('角色授权 scope 数据损坏，拒绝资产同步。');
  }
}

/**
 * Capture the exact ownership/authorization state used by one attempt. The
 * returned digest is persisted with every private asset mutation and re-read
 * inside the final commit transaction.
 */
export function readAssetBindingSnapshot(
  db: Db,
  characterId: number,
  ctx: UserContext,
  requireAssetScope = true,
): AssetBindingSnapshot {
  assertPinnedContext(characterId, ctx);
  const account = db.prepare(`
    SELECT user_id, owner_hash, scopes_json
    FROM eve_accounts WHERE character_id = ?
  `).get(characterId) as {
    user_id: number | null;
    owner_hash: string | null;
    scopes_json: string;
  } | undefined;
  if (!account) throw new Error('目标角色的 EVE 账户不存在或已解绑，拒绝资产同步。');
  if (account.user_id !== ctx.userId) {
    throw new Error('目标角色账户所有权与当前用户不一致，拒绝资产同步。');
  }

  const scopes = parseScopes(account.scopes_json);
  if (requireAssetScope && !scopes.includes(ASSET_READ_SCOPE)) {
    throw new Error(`缺少 ESI 权限 ${ASSET_READ_SCOPE}，请重新授权角色资产读取权限后再同步。`);
  }

  let bindingEpoch = 0;
  let bindingLinks: Array<{ chat_id: number; user_id: number | null; linked_at: string; epoch: number }>;
  if (ctx.chatId !== undefined) {
    const link = db.prepare(`
      SELECT l.chat_id, l.user_id, l.linked_at, COALESCE(e.epoch, 0) AS epoch
      FROM eve_character_links l
      LEFT JOIN eve_character_binding_epochs e
        ON e.chat_id = l.chat_id AND e.character_id = l.character_id
      WHERE l.chat_id = ? AND l.character_id = ?
    `).get(ctx.chatId, characterId) as {
      chat_id: number;
      user_id: number | null;
      linked_at: string;
      epoch: number;
    } | undefined;
    if (!link) throw new Error('目标角色已从当前聊天上下文解绑，拒绝资产同步。');
    if (link.user_id !== ctx.userId) {
      throw new Error('目标角色链接所有权与当前用户不一致，拒绝资产同步。');
    }
    bindingEpoch = Number(link.epoch || 0);
    bindingLinks = [link];
  } else {
    bindingLinks = db.prepare(`
      SELECT l.chat_id, l.user_id, l.linked_at, COALESCE(e.epoch, 0) AS epoch
      FROM eve_character_links l
      LEFT JOIN eve_character_binding_epochs e
        ON e.chat_id = l.chat_id AND e.character_id = l.character_id
      WHERE l.user_id = ? AND l.character_id = ?
      ORDER BY l.chat_id
    `).all(ctx.userId, characterId) as Array<{
      chat_id: number;
      user_id: number | null;
      linked_at: string;
      epoch: number;
    }>;
    if (bindingLinks.length === 0) {
      throw new Error('目标角色已从当前用户上下文解绑，拒绝资产同步。');
    }
    bindingEpoch = Math.max(...bindingLinks.map((link) => Number(link.epoch || 0)));
  }

  const digest = createHash('sha256').update(JSON.stringify({
    version: 1,
    characterId,
    userId: ctx.userId,
    chatId: ctx.chatId ?? null,
    accountUserId: account.user_id,
    ownerHash: account.owner_hash,
    scopes: [...scopes].sort(),
    links: bindingLinks.map((link) => ({
      chatId: link.chat_id,
      userId: link.user_id,
      linkedAt: link.linked_at,
      epoch: Number(link.epoch || 0),
    })),
  })).digest('hex');

  return {
    characterId,
    userId: ctx.userId,
    chatId: ctx.chatId ?? null,
    accountUserId: account.user_id,
    ownerHash: account.owner_hash,
    scopes,
    bindingEpoch,
    digest,
  };
}

export function assetLineageFromBinding(binding: AssetBindingSnapshot): AssetLineage {
  return {
    ownerUserId: binding.userId,
    ownerChatId: binding.chatId,
    bindingEpoch: binding.bindingEpoch,
    bindingDigest: binding.digest,
  };
}

export function resolveAssetLineage(
  db: Db,
  characterId: number,
  userId: number,
  chatId?: number,
): AssetLineage {
  return assetLineageFromBinding(readAssetBindingSnapshot(
    db,
    characterId,
    { userId, chatId, characterId },
    false,
  ));
}

/** SQL predicate requiring a record to belong to the exact current binding. */
export function assetLineagePredicate(
  alias: string | null,
  lineage: AssetLineage,
): AssetLineagePredicate {
  const prefix = alias ? `${alias}.` : '';
  const chatSql = lineage.ownerChatId === null
    ? `${prefix}owner_chat_id IS NULL`
    : `${prefix}owner_chat_id = ?`;
  return {
    sql: [
      `${prefix}owner_user_id = ?`,
      chatSql,
      `${prefix}binding_epoch = ?`,
      `${prefix}binding_digest = ?`,
    ].join(' AND '),
    params: lineage.ownerChatId === null
      ? [lineage.ownerUserId, lineage.bindingEpoch, lineage.bindingDigest]
      : [lineage.ownerUserId, lineage.ownerChatId, lineage.bindingEpoch, lineage.bindingDigest],
  };
}

export function assetLineageParams(lineage: AssetLineage): unknown[] {
  return [lineage.ownerUserId, lineage.ownerChatId, lineage.bindingEpoch, lineage.bindingDigest];
}
