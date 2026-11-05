import type { AssetLineage } from '../assets/asset-lineage.js';

/**
 * Authorization envelope for P9 research/planning control-plane data.
 *
 * P9 opportunities, settings, plans, jobs and the legacy plan audit feed are
 * user-private even though they are not REAL ledger facts. They therefore use
 * the same durable owner/chat/binding-epoch namespace as REAL accounting.
 * The sentinel 0 represents ownerless legacy/service-fixture rows; real users
 * are always positive IDs, so scoped requests cannot read those rows.
 */
export type P9ControlPlaneLineage = AssetLineage;

export type P9LineagePredicate = {
  sql: string;
  params: unknown[];
};

function chatValue(lineage: P9ControlPlaneLineage): number {
  return lineage.ownerChatId ?? 0;
}

export function p9LineageValues(
  lineage?: P9ControlPlaneLineage | null,
): [number, number, number, string] {
  if (!lineage) return [0, 0, 0, ''];
  return [lineage.ownerUserId, chatValue(lineage), lineage.bindingEpoch, lineage.bindingDigest];
}

export function p9LineagePredicate(
  alias: string | null,
  lineage?: P9ControlPlaneLineage | null,
): P9LineagePredicate {
  const prefix = alias ? `${alias}.` : '';
  const [ownerUserId, ownerChatId, bindingEpoch] = p9LineageValues(lineage);
  return {
    sql: [
      `${prefix}owner_user_id = ?`,
      `${prefix}owner_chat_id = ?`,
      `${prefix}binding_epoch = ?`,
    ].join(' AND '),
    params: [ownerUserId, ownerChatId, bindingEpoch],
  };
}
