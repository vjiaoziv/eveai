import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import { clampPositiveInteger } from '../util/query-bounds.js';
import { config } from '../config.js';
import { callEsiOperation, type EsiExecutionGuard } from '../eve/esi-client.js';
import { getEveCapabilities } from '../eve/capabilities.js';
import { getAccessToken } from '../eve/sso.js';
import type { UserContext } from '../auth/user-resolver.js';
import { AssetLocationResolver, type AssetItemRegistry } from './location-resolver.js';
import {
  ASSET_READ_SCOPE,
  assetLineageFromBinding,
  assetLineagePredicate,
  readAssetBindingSnapshot,
  type AssetBindingSnapshot,
  type AssetLineage,
} from './asset-lineage.js';

/**
 * P9.2.1 real-asset read-only sync, hardened by P9.3.3.4.
 *
 * Pipeline: atomically acquire a per-character fencing lease -> fetch every ESI
 * page -> validate every row -> canonical hash -> one BEGIN IMMEDIATE commit
 * that rechecks identity/authorization and atomically writes the current set,
 * immutable snapshot, observed changes, job completion and lease release.
 * Any failure leaves the previous valid snapshot and mirror untouched.
 */

export type AssetSyncTrigger = 'manual' | 'auto' | 'api';

export type AssetSyncJob = {
  jobId: string;
  characterId: number;
  trigger: AssetSyncTrigger;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  phase: string;
  generation: number;
  pagesTotal: number | null;
  pagesFetched: number | null;
  itemsFetched: number | null;
  itemsCommitted: number | null;
  itemsSkipped: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  snapshotId: string | null;
  lastError: string | null;
  source: string;
};

export type AssetSyncResult = {
  job: AssetSyncJob;
  snapshotId: string;
  deduped: boolean;
  itemsFetched: number;
  itemsCommitted: number;
  changesRecorded: number;
  durationMs: number;
};

export type NormalizedAssetRow = {
  itemId: number;
  typeId: number;
  quantity: number;
  locationId: number;
  locationType: string | null;
  locationFlag: string | null;
  isSingleton: number;
  isBlueprintCopy: number | null;
  parentItemId: number | null;
  raw: Record<string, unknown>;
};

type AssetSyncOwnership = {
  jobId: string;
  characterId: number;
  generation: number;
  binding: AssetBindingSnapshot;
  pinnedCtx: UserContext;
};

export const CANONICAL_ASSET_HASH_VERSION = 1;

function positiveSafeIntegerField(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`资产字段 ${field} 必须是正安全整数，拒绝提交部分结果。`);
  }
  return value;
}

function leaseTtlSeconds(): number {
  const raw = Number((config.assetSync as { leaseTtlSeconds?: unknown }).leaseTtlSeconds);
  if (Number.isSafeInteger(raw) && raw > 0) return raw;
  const staleMinutes = Number((config.assetSync as { staleJobMinutes?: unknown }).staleJobMinutes);
  return Math.max(30, Math.round((Number.isFinite(staleMinutes) && staleMinutes > 0 ? staleMinutes : 30) * 60));
}

function heartbeatIntervalMs(): number {
  const configured = Number((config.assetSync as { heartbeatSeconds?: unknown }).heartbeatSeconds);
  const ttlMs = leaseTtlSeconds() * 1000;
  const configuredMs = Number.isSafeInteger(configured) && configured > 0
    ? configured * 1000
    : Math.floor(ttlMs / 3);
  // A heartbeat that is not materially shorter than the lease creates a
  // deterministic self-reclaim window. Clamp even if configuration drifts.
  return Math.max(1000, Math.min(configuredMs, Math.floor(ttlMs / 2)));
}

function parseXPages(
  headers: Record<string, string> | undefined,
  maxPages = config.characterSync.maxPages,
): number {
  const raw = headerValue(headers, 'x-pages');
  if (raw === null) {
    throw new Error('ESI 分页响应缺少 X-Pages，拒绝生成不完整资产快照。');
  }
  const value = raw.trim();
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`ESI X-Pages 必须为正整数，实际为 ${JSON.stringify(raw)}，拒绝生成不完整资产快照。`);
  }
  const pages = Number(value);
  if (!Number.isSafeInteger(pages) || pages < 1) {
    throw new Error('ESI X-Pages 超出安全整数范围，拒绝生成不完整资产快照。');
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new Error('ESI 最大分页预算配置无效，拒绝生成不完整资产快照。');
  }
  if (pages > maxPages) {
    throw new Error(`ESI 资产接口需要 ${pages} 页，超过允许的 ${maxPages} 页，拒绝生成不完整资产快照。`);
  }
  return pages;
}

function safeQuantityTotal(rows: readonly NormalizedAssetRow[]): number {
  let total = 0n;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.quantity) || row.quantity <= 0) {
      throw new Error('资产数量必须是正安全整数，拒绝提交不完整结果。');
    }
    total += BigInt(row.quantity);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('资产总数量超过安全整数范围，拒绝提交不完整结果。');
    }
  }
  const result = Number(total);
  if (!Number.isSafeInteger(result)) {
    throw new Error('资产总数量无法由 API/数据库安全表示，拒绝提交不完整结果。');
  }
  return result;
}

function requiredStringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`资产字段 ${field} 必须是非空字符串，拒绝提交部分结果。`);
  }
  return value;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

function mapJob(row: any): AssetSyncJob {
  return {
    jobId: row.job_id,
    characterId: row.character_id,
    trigger: row.trigger,
    status: row.status,
    phase: row.phase,
    generation: Number(row.generation || 0),
    pagesTotal: row.pages_total ?? null,
    pagesFetched: row.pages_fetched ?? null,
    itemsFetched: row.items_fetched ?? null,
    itemsCommitted: row.items_committed ?? null,
    itemsSkipped: Number(row.items_skipped || 0),
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    durationMs: row.duration_ms ?? null,
    snapshotId: row.snapshot_id ?? null,
    lastError: row.last_error ?? null,
    source: row.source,
  };
}

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

function assertSameBinding(expected: AssetBindingSnapshot, actual: AssetBindingSnapshot): void {
  if (expected.digest !== actual.digest) {
    throw new Error('资产同步身份上下文已失效（角色解绑、所有权变化或授权变更），拒绝提交结果。');
  }
}

function readPersistedSnapshotRows(db: Db, snapshotId: string): NormalizedAssetRow[] {
  const stored = db.prepare(`
    SELECT item_id, type_id, quantity, location_id, location_type, location_flag,
           is_singleton, is_blueprint_copy, parent_item_id
    FROM real_asset_snapshot_items
    WHERE snapshot_id = ?
    ORDER BY item_id
  `).all(snapshotId) as Array<{
    item_id: number;
    type_id: number;
    quantity: number;
    location_id: number;
    location_type: string | null;
    location_flag: string | null;
    is_singleton: number;
    is_blueprint_copy: number | null;
    parent_item_id: number | null;
  }>;
  return stored.map((row) => ({
    itemId: Number(row.item_id),
    typeId: Number(row.type_id),
    quantity: Number(row.quantity),
    locationId: Number(row.location_id),
    locationType: row.location_type,
    locationFlag: row.location_flag,
    isSingleton: Number(row.is_singleton),
    isBlueprintCopy: row.is_blueprint_copy === null ? null : Number(row.is_blueprint_copy),
    parentItemId: row.parent_item_id === null ? null : Number(row.parent_item_id),
    raw: {},
  }));
}

function snapshotItemsMatchRows(
  db: Db,
  snapshotId: string,
  rows: readonly NormalizedAssetRow[],
): boolean {
  const stored = readPersistedSnapshotRows(db, snapshotId);
  if (stored.length !== rows.length) return false;
  const expected = new Map(rows.map((row) => [row.itemId, row]));
  for (const row of stored) {
    const target = expected.get(row.itemId);
    if (
      !target
      || row.typeId !== target.typeId
      || row.quantity !== target.quantity
      || row.locationId !== target.locationId
      || row.locationType !== target.locationType
      || row.locationFlag !== target.locationFlag
      || row.isSingleton !== target.isSingleton
      || row.isBlueprintCopy !== target.isBlueprintCopy
      || row.parentItemId !== target.parentItemId
    ) {
      return false;
    }
  }
  return true;
}

function mirrorMatchesRows(
  db: Db,
  characterId: number,
  lineage: AssetLineage,
  rows: readonly NormalizedAssetRow[],
): boolean {
  const predicate = assetLineagePredicate('a', lineage);
  const stored = db.prepare(`
    SELECT a.item_id, a.type_id, a.quantity, a.location_id, a.location_type,
           a.location_flag, a.is_singleton, a.is_blueprint_copy
    FROM character_assets a
    WHERE a.character_id = ? AND ${predicate.sql}
  `).all(characterId, ...predicate.params) as Array<{
    item_id: number;
    type_id: number;
    quantity: number;
    location_id: number;
    location_type: string | null;
    location_flag: string | null;
    is_singleton: number;
    is_blueprint_copy: number | null;
  }>;
  if (stored.length !== rows.length) return false;
  const expected = new Map(rows.map((row) => [row.itemId, row]));
  for (const row of stored) {
    const target = expected.get(Number(row.item_id));
    if (
      !target
      || Number(row.type_id) !== target.typeId
      || Number(row.quantity) !== target.quantity
      || Number(row.location_id) !== target.locationId
      || row.location_type !== target.locationType
      || row.location_flag !== target.locationFlag
      || Number(row.is_singleton) !== target.isSingleton
      || (row.is_blueprint_copy === null ? null : Number(row.is_blueprint_copy)) !== target.isBlueprintCopy
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Versioned canonical representation. Every semantic field used by P9.2 is
 * included; rows are sorted by itemId so input order cannot change the hash.
 */
export function computeCanonicalAssetHash(rows: readonly NormalizedAssetRow[]): string {
  const items = rows
    .map((row) => ({
      itemId: row.itemId,
      typeId: row.typeId,
      quantity: row.quantity,
      locationId: row.locationId,
      locationType: row.locationType,
      locationFlag: row.locationFlag,
      isSingleton: row.isSingleton === 1,
      isBlueprintCopy: row.isBlueprintCopy === null ? null : row.isBlueprintCopy === 1,
      parentItemId: row.parentItemId,
    }))
    .sort((a, b) => a.itemId - b.itemId);
  return createHash('sha256').update(JSON.stringify({
    version: CANONICAL_ASSET_HASH_VERSION,
    items,
  })).digest('hex');
}

export function computeCanonicalMirrorHash(
  db: Db,
  characterId: number,
  lineage: AssetLineage,
): string {
  const ownership = assetLineagePredicate(null, lineage);
  const rows = db.prepare(`
    SELECT item_id, type_id, quantity, location_id, location_type,
           location_flag, is_singleton, is_blueprint_copy
    FROM character_assets
    WHERE character_id = ? AND ${ownership.sql}
    ORDER BY item_id
  `).all(characterId, ...ownership.params) as Array<{
    item_id: number;
    type_id: number;
    quantity: number | null;
    location_id: number;
    location_type: string | null;
    location_flag: string | null;
    is_singleton: number;
    is_blueprint_copy: number | null;
  }>;
  const itemIds = new Set(rows.map((row) => Number(row.item_id)));
  return computeCanonicalAssetHash(rows.map((row) => {
    const itemId = Number(row.item_id);
    const locationId = Number(row.location_id);
    return {
      itemId,
      typeId: Number(row.type_id),
      quantity: Number(row.quantity),
      locationId,
      locationType: row.location_type,
      locationFlag: row.location_flag,
      isSingleton: Number(row.is_singleton),
      isBlueprintCopy: row.is_blueprint_copy === null ? null : Number(row.is_blueprint_copy),
      parentItemId: row.location_type === 'item' && locationId !== itemId && itemIds.has(locationId)
        ? locationId
        : null,
      raw: {},
    };
  }));
}

export class RealAssetSyncService {
  static listJobs(db: Db, characterId: number, limit = 50, lineage?: AssetLineage): AssetSyncJob[] {
    const capped = clampPositiveInteger(limit, 50, 500);
    const lineageWhere = lineage ? ` AND ${assetLineagePredicate(null, lineage).sql}` : '';
    const lineageParams = lineage ? assetLineagePredicate(null, lineage).params : [];
    return (db.prepare(`
      SELECT * FROM real_asset_sync_jobs WHERE character_id = ?${lineageWhere}
      ORDER BY started_at DESC LIMIT ?
    `).all(characterId, ...lineageParams, capped) as any[]).map(mapJob);
  }

  static latestJob(db: Db, characterId: number, lineage?: AssetLineage): AssetSyncJob | null {
    const lineageWhere = lineage ? ` AND ${assetLineagePredicate(null, lineage).sql}` : '';
    const lineageParams = lineage ? assetLineagePredicate(null, lineage).params : [];
    const row = db.prepare(`
      SELECT * FROM real_asset_sync_jobs WHERE character_id = ?${lineageWhere}
      ORDER BY started_at DESC LIMIT 1
    `).get(characterId, ...lineageParams) as any;
    return row ? mapJob(row) : null;
  }

  /** Fail jobs wedged in RUNNING past the stale window and revoke their lease. */
  static reclaimStaleJobs(db: Db, characterId?: number): number {
    const ttl = leaseTtlSeconds();
    const scope = characterId === undefined ? '' : ' AND j.character_id = ?';
    const scopeParams = characterId === undefined ? [] : [characterId];
    const reclaim = db.transaction(() => {
      const result = db.prepare(`
        UPDATE real_asset_sync_jobs AS j
        SET status = 'FAILED', phase = 'done', finished_at = datetime('now'),
            last_error = 'sync presumed crashed: RUNNING longer than stale window'
        WHERE j.status = 'RUNNING'${scope}
          AND julianday(COALESCE((
            SELECT l.renewed_at FROM real_asset_sync_leases l
            WHERE l.character_id = j.character_id AND l.job_id = j.job_id
            LIMIT 1
          ), j.started_at)) < julianday('now', ?)
      `).run(...scopeParams, `-${ttl} seconds`);
      db.prepare(`
        DELETE FROM real_asset_sync_leases
        WHERE job_id IN (
          SELECT l.job_id
          FROM real_asset_sync_leases l
          JOIN real_asset_sync_jobs j
            ON j.job_id = l.job_id AND j.character_id = l.character_id
          WHERE j.status = 'FAILED'
            ${characterId === undefined ? '' : 'AND l.character_id = ?'}
        )
      `).run(...scopeParams);
      return result.changes;
    });
    return reclaim.immediate();
  }

  private static acquireOwnership(
    db: Db,
    characterId: number,
    trigger: AssetSyncTrigger,
    binding: AssetBindingSnapshot,
    pinnedCtx: UserContext,
  ): AssetSyncOwnership {
    const jobId = `ASSETJOB-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const acquire = db.transaction(() => {
      db.prepare(`
        UPDATE real_asset_sync_jobs AS j
        SET status = 'FAILED', phase = 'done', finished_at = datetime('now'),
            last_error = 'sync presumed crashed: RUNNING longer than stale window'
        WHERE j.character_id = ? AND j.status = 'RUNNING'
          AND julianday(COALESCE((
            SELECT l.renewed_at FROM real_asset_sync_leases l
            WHERE l.character_id = j.character_id AND l.job_id = j.job_id
            LIMIT 1
          ), j.started_at)) < julianday('now', ?)
      `).run(characterId, `-${leaseTtlSeconds()} seconds`);
      db.prepare(`
        DELETE FROM real_asset_sync_leases
        WHERE character_id = ?
          AND job_id IN (
            SELECT job_id FROM real_asset_sync_jobs
            WHERE character_id = ? AND status = 'FAILED'
          )
      `).run(characterId, characterId);

      const held = db.prepare(`
        SELECT l.job_id, l.generation
        FROM real_asset_sync_leases l
        JOIN real_asset_sync_jobs j ON j.job_id = l.job_id
        WHERE l.character_id = ? AND j.status = 'RUNNING'
        LIMIT 1
      `).get(characterId) as { job_id: string; generation: number } | undefined;
      if (held) {
        throw new Error(`角色 ${characterId} 已有资产同步任务在运行（${held.job_id}）。`);
      }

      const generation = Number((db.prepare(`
        SELECT COALESCE(MAX(generation), 0) + 1 AS generation
        FROM real_asset_sync_jobs WHERE character_id = ?
      `).get(characterId) as { generation: number }).generation);
      db.prepare(`
        INSERT INTO real_asset_sync_jobs
          (job_id, character_id, trigger, status, phase, generation,
           owner_user_id, owner_chat_id, binding_epoch, binding_digest,
           account_owner_hash, started_at, source)
        VALUES (?, ?, ?, 'RUNNING', 'fetch', ?, ?, ?, ?, ?, ?, ?, 'esi_character_assets')
      `).run(
        jobId,
        characterId,
        trigger,
        generation,
        binding.userId,
        binding.chatId,
        binding.bindingEpoch,
        binding.digest,
        binding.ownerHash,
        startedAt,
      );
      db.prepare(`
        INSERT INTO real_asset_sync_leases
          (character_id, generation, job_id, acquired_at, renewed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(character_id) DO UPDATE SET
          generation = excluded.generation,
          job_id = excluded.job_id,
          acquired_at = excluded.acquired_at,
          renewed_at = excluded.renewed_at
      `).run(characterId, generation, jobId, startedAt, startedAt);
      return { jobId, characterId, generation, binding, pinnedCtx };
    });
    try {
      return acquire.immediate();
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      if (code.includes('SQLITE_CONSTRAINT')) {
        throw new Error(`角色 ${characterId} 已有资产同步任务在运行。`);
      }
      throw error;
    }
  }

  /**
   * Renew only the exact live lease. An expired lease, a higher generation or
   * a changed owner/binding can never be revived by a late heartbeat.
   */
  static renewOwnershipLease(db: Db, ownership: AssetSyncOwnership): void {
    const renew = db.transaction(() => {
      const job = db.prepare(`
        SELECT status, generation, owner_user_id, owner_chat_id,
               binding_epoch, binding_digest, account_owner_hash
        FROM real_asset_sync_jobs
        WHERE job_id = ? AND character_id = ?
      `).get(ownership.jobId, ownership.characterId) as {
        status: string;
        generation: number;
        owner_user_id: number | null;
        owner_chat_id: number | null;
        binding_epoch: number;
        binding_digest: string;
        account_owner_hash: string | null;
      } | undefined;
      if (
        !job
        || job.status !== 'RUNNING'
        || Number(job.generation) !== ownership.generation
        || job.owner_user_id !== ownership.binding.userId
        || job.owner_chat_id !== ownership.binding.chatId
        || Number(job.binding_epoch) !== ownership.binding.bindingEpoch
        || job.binding_digest !== ownership.binding.digest
        || job.account_owner_hash !== ownership.binding.ownerHash
      ) {
        throw new Error('资产同步租约续期失败：任务已被接管或身份上下文已变化。');
      }
      const current = readAssetBindingSnapshot(
        db,
        ownership.characterId,
        ownership.pinnedCtx,
        true,
      );
      assertSameBinding(ownership.binding, current);
      const result = db.prepare(`
        UPDATE real_asset_sync_leases
        SET renewed_at = ?
        WHERE character_id = ? AND generation = ? AND job_id = ?
          AND julianday(renewed_at) >= julianday('now', ?)
      `).run(
        new Date().toISOString(),
        ownership.characterId,
        ownership.generation,
        ownership.jobId,
        `-${leaseTtlSeconds()} seconds`,
      );
      if (result.changes !== 1) {
        throw new Error('资产同步租约续期失败：租约已过期或已被其他任务接管。');
      }
    });
    renew.immediate();
  }

  private static startLeaseHeartbeat(
    db: Db,
    ownership: AssetSyncOwnership,
  ): { stop: () => void; failure: () => Error | null } {
    let failure: Error | null = null;
    const timer = setInterval(() => {
      if (failure) return;
      try {
        RealAssetSyncService.renewOwnershipLease(db, ownership);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    }, heartbeatIntervalMs());
    timer.unref?.();
    return {
      stop: () => clearInterval(timer),
      failure: () => failure,
    };
  }

  private static failOwnership(db: Db, ownership: AssetSyncOwnership, message: string): AssetSyncJob | null {
    const fail = db.transaction(() => {
      db.prepare(`
        UPDATE real_asset_sync_jobs
        SET status = 'FAILED', phase = 'done', finished_at = datetime('now'),
            duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER),
            last_error = ?
        WHERE job_id = ? AND character_id = ? AND generation = ? AND status = 'RUNNING'
      `).run(message.slice(0, 500), ownership.jobId, ownership.characterId, ownership.generation);
      db.prepare(`
        DELETE FROM real_asset_sync_leases
        WHERE character_id = ? AND generation = ? AND job_id = ?
      `).run(ownership.characterId, ownership.generation, ownership.jobId);
      const row = db.prepare(`
        SELECT * FROM real_asset_sync_jobs
        WHERE job_id = ? AND character_id = ?
      `).get(ownership.jobId, ownership.characterId) as any;
      return row ? mapJob(row) : null;
    });
    return fail.immediate();
  }

  static async syncCharacter(
    db: Db,
    characterId: number,
    ctx: UserContext,
    trigger: AssetSyncTrigger = 'manual',
    guard: EsiExecutionGuard = {},
  ): Promise<AssetSyncResult> {
    assertPinnedContext(characterId, ctx);
    const pinnedCtx: UserContext = { ...ctx, characterId };

    // Reject invalid ownership/scope/context before creating a job. The actual
    // capability snapshot is rebuilt on every sync; no cached snapshot is used
    // as an authorization decision.
    readAssetBindingSnapshot(db, characterId, pinnedCtx, true);
    const capabilities = await getEveCapabilities(db, 'real asset sync', pinnedCtx);
    if (capabilities.characterId !== characterId) {
      throw new Error('能力快照角色与目标角色不一致，拒绝资产同步。');
    }
    if (!capabilities.grantedScopes.includes(ASSET_READ_SCOPE)) {
      throw new Error(`缺少 ESI 权限 ${ASSET_READ_SCOPE}，请重新授权角色资产读取权限后再同步。`);
    }
    const access = await getAccessToken(db, pinnedCtx);
    if (!access || access.characterId !== characterId) {
      throw new Error('EVE Access Token 不属于目标角色或已失效，拒绝资产同步。');
    }

    this.reclaimStaleJobs(db, characterId);
    // A fast, non-authoritative UX check. This query shape is intentionally
    // outside the transaction; acquireOwnership is the only proof of ownership.
    const running = db.prepare(`
      SELECT job_id FROM real_asset_sync_jobs
      WHERE character_id = ? AND status = 'RUNNING' LIMIT 1
    `).get(characterId) as { job_id: string } | undefined;
    if (running) {
      throw new Error(`角色 ${characterId} 已有资产同步任务在运行（${running.job_id}）。`);
    }

    const currentBinding = readAssetBindingSnapshot(db, characterId, pinnedCtx, true);
    const ownership = this.acquireOwnership(db, characterId, trigger, currentBinding, pinnedCtx);
    const startedMs = Date.now();
    const heartbeat = this.startLeaseHeartbeat(db, ownership);

    try {
      const result = await callEsiOperation<unknown[]>(
        db,
        'get_characters_character_id_assets',
        { character_id: characterId },
        pinnedCtx,
        {
          maxPages: config.characterSync.maxPages,
          bypassCache: true,
          signal: guard.signal,
          identityCurrent: () => {
            try {
              if (guard.signal?.aborted || guard.identityCurrent?.() === false || heartbeat.failure()) {
                return false;
              }
              const current = readAssetBindingSnapshot(db, characterId, pinnedCtx, true);
              assertSameBinding(ownership.binding, current);
              return true;
            } catch {
              return false;
            }
          },
        },
      );
      const heartbeatFailure = heartbeat.failure();
      if (heartbeatFailure) throw heartbeatFailure;
      if (!result.ok) throw new Error(result.error);
      const pagesTotal = parseXPages(result.headers, config.characterSync.maxPages);
      db.prepare(`
        UPDATE real_asset_sync_jobs
        SET phase = 'validate', pages_total = ?, pages_fetched = ?
        WHERE job_id = ? AND generation = ? AND status = 'RUNNING'
      `).run(pagesTotal, pagesTotal, ownership.jobId, ownership.generation);

      if (!Array.isArray(result.data)) throw new Error('ESI 资产接口未返回数组，判定为不完整数据。');
      const registry: AssetItemRegistry = new Map();
      const rows: NormalizedAssetRow[] = [];
      for (let index = 0; index < result.data.length; index += 1) {
        const raw = result.data[index];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error(`资产数据第 ${index + 1} 行不是对象，拒绝提交部分结果。`);
        }
        const record = raw as Record<string, unknown>;
        const prefix = `资产数据第 ${index + 1} 行`;
        const itemId = positiveSafeIntegerField(record.item_id, 'item_id');
        const typeId = positiveSafeIntegerField(record.type_id, 'type_id');
        const locationId = positiveSafeIntegerField(record.location_id, 'location_id');
        const quantity = positiveSafeIntegerField(record.quantity, 'quantity');
        const locationType = requiredStringField(record.location_type, 'location_type');
        const locationFlag = requiredStringField(record.location_flag, 'location_flag');
        if (!['station', 'solar_system', 'item', 'other'].includes(locationType)) {
          throw new Error(`${prefix} location_type 不在 ESI 允许枚举内，拒绝提交部分结果。`);
        }
        if (typeof record.is_singleton !== 'boolean') {
          throw new Error(`${prefix} is_singleton 必须是 boolean，拒绝提交部分结果。`);
        }
        if (record.is_blueprint_copy !== undefined && typeof record.is_blueprint_copy !== 'boolean') {
          throw new Error(`${prefix} is_blueprint_copy 必须是 boolean，拒绝提交部分结果。`);
        }
        if (registry.has(itemId)) {
          throw new Error(`${prefix} 的 item_id ${itemId} 重复，拒绝提交部分结果。`);
        }
        rows.push({
          itemId,
          typeId,
          quantity,
          locationId,
          locationType,
          locationFlag,
          isSingleton: record.is_singleton ? 1 : 0,
          isBlueprintCopy: record.is_blueprint_copy === undefined ? null : (record.is_blueprint_copy ? 1 : 0),
          parentItemId: null,
          raw: record,
        });
        registry.set(itemId, { typeId, locationId });
      }

      for (const row of rows) {
        if (row.locationId !== row.itemId && registry.has(row.locationId)) {
          row.parentItemId = row.locationId;
        }
      }

      const dataHash = computeCanonicalAssetHash(rows);
      const snapshotId = `ASSETSNAP-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const nowIso = new Date().toISOString();
      const totalQuantity = safeQuantityTotal(rows);
      const lineage = assetLineageFromBinding(ownership.binding);
      const uniqueTypes = new Set(rows.map((row) => row.typeId)).size;
      const uniqueLocations = new Set(rows.map((row) => row.locationId)).size;
      const hints = new Map<number, string | null>();
      for (const row of rows) {
        if (row.locationType && !hints.has(row.locationId)) hints.set(row.locationId, row.locationType);
      }

      const insertAsset = db.prepare(`
        INSERT INTO character_assets
          (character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
           item_id, type_id, location_id, location_type, location_flag,
           quantity, is_singleton, is_blueprint_copy, data_json, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      const insertSnapshot = db.prepare(`
        INSERT INTO real_asset_snapshots
          (snapshot_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
           job_id, started_at, completed_at, status,
           total_items, total_unique_types, total_locations, total_quantity,
           data_hash, hash_algorithm, canonical_version, source, error_summary, is_latest)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, 'sha256', ?, 'esi_character_assets', NULL, 1)
      `);
      const insertItem = db.prepare(`
        INSERT INTO real_asset_snapshot_items
          (snapshot_id, item_id, type_id, quantity, location_id, location_type,
           location_flag, is_singleton, is_blueprint_copy, parent_item_id, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertChange = db.prepare(`
        INSERT INTO real_asset_changes
          (change_id, character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
           item_id, type_id, change_type,
           prev_quantity, new_quantity, prev_location_id, new_location_id,
           source_class, confidence, from_snapshot_id, to_snapshot_id, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OBSERVED_CHANGE', ?, ?, ?, ?)
      `);

      const commit = db.transaction(() => {
        const heartbeatFailure = heartbeat.failure();
        if (heartbeatFailure) throw heartbeatFailure;
        const job = db.prepare(`
          SELECT status, generation, owner_user_id, owner_chat_id,
                 binding_epoch, binding_digest, account_owner_hash, started_at
          FROM real_asset_sync_jobs
          WHERE job_id = ? AND character_id = ?
        `).get(ownership.jobId, characterId) as {
          status: string;
          generation: number;
          owner_user_id: number | null;
          owner_chat_id: number | null;
          binding_epoch: number;
          binding_digest: string;
          account_owner_hash: string | null;
          started_at: string;
        } | undefined;
        if (
          !job
          || job.status !== 'RUNNING'
          || Number(job.generation) !== ownership.generation
          || job.owner_user_id !== ownership.binding.userId
          || job.owner_chat_id !== ownership.binding.chatId
          || Number(job.binding_epoch) !== ownership.binding.bindingEpoch
          || job.binding_digest !== ownership.binding.digest
          || job.account_owner_hash !== ownership.binding.ownerHash
        ) {
          throw new Error('资产同步任务 fencing 令牌已失效，拒绝提交结果。');
        }
        const lease = db.prepare(`
        SELECT generation, job_id, renewed_at,
               CASE WHEN julianday(renewed_at) >= julianday('now', ?) THEN 1 ELSE 0 END AS live
          FROM real_asset_sync_leases
          WHERE character_id = ?
      `).get(`-${leaseTtlSeconds()} seconds`, characterId) as {
          generation: number;
          job_id: string;
          renewed_at: string;
          live: number;
        } | undefined;
        if (
          !lease
          || Number(lease.generation) !== ownership.generation
          || lease.job_id !== ownership.jobId
          || Number(lease.live) !== 1
        ) {
          throw new Error('资产同步租约已失效，拒绝提交结果。');
        }

        // Final authorization check occurs inside the same write transaction as
        // the mirror/snapshot replacement. Unlink/rebind or owner/scope changes
        // cannot interleave between this check and the financial snapshot write.
        const current = readAssetBindingSnapshot(db, characterId, pinnedCtx, true);
        assertSameBinding(ownership.binding, current);
        if (current.accountUserId !== ownership.binding.accountUserId || current.ownerHash !== ownership.binding.ownerHash) {
          throw new Error('资产同步账户所有权已经变化，拒绝提交结果。');
        }

        const previous = db.prepare(`
          SELECT * FROM real_asset_snapshots
          WHERE character_id = ? AND status = 'COMPLETED' AND is_latest = 1
            AND ${assetLineagePredicate(null, lineage).sql}
          LIMIT 1
        `).get(characterId, ...assetLineagePredicate(null, lineage).params) as any;

        const finishCompleted = (opts: {
          snapshotId: string;
          itemsCommitted: number;
          pagesTotal: number;
        }): AssetSyncJob => {
          const result = db.prepare(`
            UPDATE real_asset_sync_jobs
            SET status = 'COMPLETED', phase = 'done', finished_at = datetime('now'),
                duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER),
                pages_total = ?, pages_fetched = ?, items_fetched = ?,
                items_committed = ?, items_skipped = 0, snapshot_id = ?, last_error = NULL
            WHERE job_id = ? AND character_id = ? AND generation = ? AND status = 'RUNNING'
          `).run(
            opts.pagesTotal,
            opts.pagesTotal,
            rows.length,
            opts.itemsCommitted,
            opts.snapshotId,
            ownership.jobId,
            characterId,
            ownership.generation,
          );
          if (result.changes !== 1) {
            throw new Error('资产同步任务已完成或已被回收，拒绝伪造完成状态。');
          }
          db.prepare(`
            DELETE FROM real_asset_sync_leases
            WHERE character_id = ? AND generation = ? AND job_id = ?
          `).run(characterId, ownership.generation, ownership.jobId);
          return mapJob(db.prepare(`
            SELECT * FROM real_asset_sync_jobs WHERE job_id = ? AND character_id = ?
          `).get(ownership.jobId, characterId));
        };

        if (
          previous
          && previous.data_hash === dataHash
          && previous.hash_algorithm === 'sha256'
          && Number(previous.canonical_version) === CANONICAL_ASSET_HASH_VERSION
          && mirrorMatchesRows(db, characterId, lineage, rows)
          && snapshotItemsMatchRows(db, previous.snapshot_id, rows)
        ) {
          return {
            deduped: true,
            snapshotId: previous.snapshot_id as string,
            itemsCommitted: 0,
            changesRecorded: 0,
            job: finishCompleted({
              snapshotId: previous.snapshot_id,
              itemsCommitted: 0,
              pagesTotal,
            }),
          };
        }

        AssetLocationResolver.resolveMany(
          db,
          [...new Set(rows.map((row) => row.locationId))],
          registry,
          hints,
        );
        const changes = previous
          ? diffSnapshots(db, characterId, lineage, previous.snapshot_id, snapshotId, rows)
          : [];

        db.prepare(`DELETE FROM character_assets
          WHERE character_id = ? AND ${assetLineagePredicate(null, lineage).sql}`)
          .run(characterId, ...assetLineagePredicate(null, lineage).params);
        for (const row of rows) {
          insertAsset.run(
            characterId,
            lineage.ownerUserId,
            lineage.ownerChatId,
            lineage.bindingEpoch,
            lineage.bindingDigest,
            row.itemId,
            row.typeId,
            row.locationId,
            row.locationType,
            row.locationFlag,
            row.quantity,
            row.isSingleton,
            row.isBlueprintCopy,
            JSON.stringify(row.raw),
          );
        }
        if (previous) {
          db.prepare(`
            UPDATE real_asset_snapshots
            SET is_latest = 0
            WHERE character_id = ? AND is_latest = 1
              AND ${assetLineagePredicate(null, lineage).sql}
          `).run(characterId, ...assetLineagePredicate(null, lineage).params);
        }
        insertSnapshot.run(
          snapshotId,
          characterId,
          lineage.ownerUserId,
          lineage.ownerChatId,
          lineage.bindingEpoch,
          lineage.bindingDigest,
          ownership.jobId,
          job.started_at,
          nowIso,
          rows.length,
          uniqueTypes,
          uniqueLocations,
          totalQuantity,
          dataHash,
          CANONICAL_ASSET_HASH_VERSION,
        );
        for (const row of rows) {
          insertItem.run(
            snapshotId,
            row.itemId,
            row.typeId,
            row.quantity,
            row.locationId,
            row.locationType,
            row.locationFlag,
            row.isSingleton,
            row.isBlueprintCopy,
            row.parentItemId,
            JSON.stringify(row.raw),
          );
        }
        const persistedRows = readPersistedSnapshotRows(db, snapshotId);
        const persistedHash = computeCanonicalAssetHash(persistedRows);
        const persistedQuantity = safeQuantityTotal(persistedRows);
        const persistedUniqueTypes = new Set(persistedRows.map((row) => row.typeId)).size;
        const persistedUniqueLocations = new Set(persistedRows.map((row) => row.locationId)).size;
        if (
          persistedRows.length !== rows.length
          || persistedHash !== dataHash
          || persistedQuantity !== totalQuantity
          || persistedUniqueTypes !== uniqueTypes
          || persistedUniqueLocations !== uniqueLocations
          || !snapshotItemsMatchRows(db, snapshotId, rows)
        ) {
          throw new Error('资产快照持久化回读校验失败，拒绝将不完整集合标记为 COMPLETED。');
        }
        for (const change of changes) {
          insertChange.run(
            change.changeId,
            characterId,
            lineage.ownerUserId,
            lineage.ownerChatId,
            lineage.bindingEpoch,
            lineage.bindingDigest,
            change.itemId,
            change.typeId,
            change.changeType,
            change.prevQuantity,
            change.newQuantity,
            change.prevLocationId,
            change.newLocationId,
            change.confidence,
            change.fromSnapshotId,
            snapshotId,
            nowIso,
          );
        }

        return {
          deduped: false,
          snapshotId,
          itemsCommitted: rows.length,
          changesRecorded: changes.length,
          job: finishCompleted({
            snapshotId,
            itemsCommitted: rows.length,
            pagesTotal,
          }),
        };
      });

      const committed = commit.immediate();
      return {
        job: committed.job,
        snapshotId: committed.snapshotId,
        deduped: committed.deduped,
        itemsFetched: rows.length,
        itemsCommitted: committed.itemsCommitted,
        changesRecorded: committed.changesRecorded,
        durationMs: committed.job.durationMs ?? (Date.now() - startedMs),
      };
    } catch (error) {
      const heartbeatFailure = heartbeat.failure();
      const message = heartbeatFailure?.message
        ?? (error instanceof Error ? error.message : String(error));
      const job = this.failOwnership(db, ownership, message);
      throw Object.assign(new Error(message), { job });
    } finally {
      heartbeat.stop();
    }
  }
}
type ChangeRow = {
  changeId: string;
  itemId: number;
  typeId: number;
  changeType: 'ADDED' | 'QTY_INCREASED' | 'QTY_DECREASED' | 'MOVED' | 'REMOVED' | 'REAPPEARED' | 'CONTAINER_CHANGED';
  prevQuantity: number | null;
  newQuantity: number | null;
  prevLocationId: number | null;
  newLocationId: number | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  fromSnapshotId: string | null;
};

function diffSnapshots(
  db: Db,
  characterId: number,
  lineage: AssetLineage,
  fromSnapshotId: string,
  toSnapshotId: string,
  nextRows: NormalizedAssetRow[],
): ChangeRow[] {
  const prevRows = db.prepare(`
    SELECT item_id, type_id, quantity, location_id, parent_item_id
    FROM real_asset_snapshot_items WHERE snapshot_id = ?
  `).all(fromSnapshotId) as Array<{ item_id: number; type_id: number; quantity: number; location_id: number; parent_item_id: number | null }>;
  const prev = new Map(prevRows.map((row) => [row.item_id, row]));
  const next = new Map(nextRows.map((row) => [row.itemId, row]));

  // Items seen in ANY older snapshot of this character reappear rather than
  // being brand new (only relevant for REAPPEARED classification).
  const olderItemIds = new Set<number>(
    (db.prepare(`
      SELECT DISTINCT si.item_id FROM real_asset_snapshot_items si
      JOIN real_asset_snapshots s ON s.snapshot_id = si.snapshot_id
      WHERE s.character_id = ? AND s.status = 'COMPLETED' AND s.snapshot_id != ?
        AND ${assetLineagePredicate('s', lineage).sql}
    `).all(characterId, toSnapshotId, ...assetLineagePredicate('s', lineage).params) as Array<{ item_id: number }>).map((row) => row.item_id),
  );

  const out: ChangeRow[] = [];
  const push = (partial: Omit<ChangeRow, 'changeId' | 'fromSnapshotId'> & { suffix?: string }): void => {
    out.push({
      changeId: `ASSETCHG-${Date.now()}-${randomUUID().slice(0, 8)}${partial.suffix ?? ''}`,
      fromSnapshotId,
      ...partial,
    });
  };

  for (const [itemId, nextRow] of next) {
    const prevRow = prev.get(itemId);
    if (!prevRow) {
      push({
        itemId,
        typeId: nextRow.typeId,
        changeType: olderItemIds.has(itemId) ? 'REAPPEARED' : 'ADDED',
        prevQuantity: null,
        newQuantity: nextRow.quantity,
        prevLocationId: null,
        newLocationId: nextRow.locationId,
        confidence: 'HIGH',
      });
      continue;
    }
    if (prevRow.quantity !== nextRow.quantity) {
      push({
        itemId,
        typeId: nextRow.typeId,
        changeType: nextRow.quantity > prevRow.quantity ? 'QTY_INCREASED' : 'QTY_DECREASED',
        prevQuantity: prevRow.quantity,
        newQuantity: nextRow.quantity,
        prevLocationId: prevRow.location_id,
        newLocationId: nextRow.locationId,
        confidence: 'HIGH',
        suffix: '-qty',
      });
    }
    if (prevRow.location_id !== nextRow.locationId) {
      push({
        itemId,
        typeId: nextRow.typeId,
        changeType: 'MOVED',
        prevQuantity: prevRow.quantity,
        newQuantity: nextRow.quantity,
        prevLocationId: prevRow.location_id,
        newLocationId: nextRow.locationId,
        confidence: 'HIGH',
        suffix: '-loc',
      });
    }
    if ((prevRow.parent_item_id ?? null) !== (nextRow.parentItemId ?? null)) {
      push({
        itemId,
        typeId: nextRow.typeId,
        changeType: 'CONTAINER_CHANGED',
        prevQuantity: prevRow.quantity,
        newQuantity: nextRow.quantity,
        prevLocationId: prevRow.location_id,
        newLocationId: nextRow.locationId,
        confidence: 'MEDIUM',
        suffix: '-parent',
      });
    }
  }
  for (const [itemId, prevRow] of prev) {
    if (next.has(itemId)) continue;
    push({
      itemId,
      typeId: prevRow.type_id,
      changeType: 'REMOVED',
      prevQuantity: prevRow.quantity,
      newQuantity: null,
      prevLocationId: prevRow.location_id,
      newLocationId: null,
      confidence: 'HIGH',
    });
  }
  return out;
}
