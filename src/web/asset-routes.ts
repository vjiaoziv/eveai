import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';
import type { WebSession } from './web-session.js';
import { getLinkedCharacter } from '../eve/sso.js';
import {
  CANONICAL_ASSET_HASH_VERSION,
  RealAssetSyncService,
  computeCanonicalMirrorHash,
} from '../assets/asset-sync-service.js';
import { RealInventoryService, ASSET_TAG_LABELS_ZH, BUCKET_LABELS_ZH } from '../assets/inventory-service.js';
import { RealValuationService } from '../assets/valuation-service.js';
import { RealAssetHistoryService } from '../assets/history-service.js';
import { RealOpportunityMatchService } from '../assets/opportunity-match-service.js';
import { assetLineagePredicate, resolveAssetLineage, type AssetLineage } from '../assets/asset-lineage.js';

/**
 * P9.2 asset API (session-authenticated, same-origin). The task book's
 * suggested `/api/assets/*` paths are mounted under the app's existing
 * `/api/web/*` namespace per "follow the existing Fastify route style";
 * every handler resolves the caller's OWN linked characters only (IDOR) and
 * no handler ever returns OAuth material.
 */

type LinkedChar = { characterId: number; name: string | null };

function sessionContext(session: WebSession) {
  return { userId: session.userId, chatId: session.chatId };
}

/** All characters linked to this user (for IDOR checks and listings). */
function linkedCharacters(db: Db, session: WebSession): LinkedChar[] {
  const rows = db.prepare(`
    SELECT DISTINCT l.character_id, a.character_name
    FROM eve_character_links l
    LEFT JOIN eve_accounts a ON a.character_id = l.character_id
    WHERE l.user_id = ? AND l.chat_id = ?
    ORDER BY l.character_id
  `).all(session.userId, session.chatId) as Array<{ character_id: number; character_name: string | null }>;
  return rows.map((row) => ({ characterId: row.character_id, name: row.character_name }));
}

function requireAssetLineage(
  db: Db,
  session: WebSession,
  reply: FastifyReply,
  characterId: number,
): AssetLineage | null {
  try {
    return resolveAssetLineage(db, characterId, session.userId, session.chatId);
  } catch {
    reply.status(403).send({ error: 'character_asset_context_invalid' });
    return null;
  }
}

function requireLinkedCharacter(db: Db, session: WebSession, reply: FastifyReply, characterId?: number): LinkedChar | null {
  const linked = linkedCharacters(db, session);
  if (linked.length === 0) {
    reply.status(404).send({ error: 'eve_character_not_linked' });
    return null;
  }
  if (characterId === undefined) {
    const active = getLinkedCharacter(db, sessionContext(session));
    if (active) return { characterId: active.characterId, name: active.characterName };
    return linked[0];
  }
  const match = linked.find((row) => row.characterId === characterId);
  if (!match) {
    // IDOR guard: never confirm or expose another user's character.
    reply.status(403).send({ error: 'asset_access_denied' });
    return null;
  }
  return match;
}

function intQuery(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Never expose filesystem paths, database details, or credential material. */
function sanitizeAssetError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\b(?:access_token|refresh_token|client_secret|password|bearer)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[凭证已隐藏]')
    .replace(/(?:[A-Za-z]:\\|\/)[^\s'"`]+/g, '[路径已隐藏]')
    .replace(/\b(?:sqlite|database(?:\s+path)?|\.db)\b/gi, '数据库')
    .slice(0, 500);
}

function sanitizeAssetJob<T extends Record<string, unknown>>(job: T): T {
  const copy: Record<string, unknown> = { ...job };
  if (typeof copy.lastError === 'string') copy.lastError = sanitizeAssetError(copy.lastError);
  if (typeof copy.last_error === 'string') copy.last_error = sanitizeAssetError(copy.last_error);
  return copy as T;
}

export function registerAssetRoutes(app: FastifyInstance, db: Db): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/web/assets/')) {
      reply.header('Cache-Control', 'no-store');
    }
  });

  app.get('/api/web/assets/overview', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const linked = linkedCharacters(db, session);
    const characters = linked.flatMap((char) => {
      let lineage: AssetLineage;
      try {
        lineage = resolveAssetLineage(db, char.characterId, session.userId, session.chatId);
      } catch {
        return [];
      }
      const snapshotOwnership = assetLineagePredicate(null, lineage);
      const latestSnapshot = db.prepare(`
        SELECT snapshot_id, status, completed_at, total_items, total_unique_types,
               total_locations, total_quantity, data_hash, hash_algorithm, canonical_version
        FROM real_asset_snapshots
        WHERE character_id = ? AND status = 'COMPLETED' AND ${snapshotOwnership.sql}
        ORDER BY completed_at DESC LIMIT 1
      `).get(char.characterId, ...snapshotOwnership.params) as any;
      const job = RealAssetSyncService.latestJob(db, char.characterId, lineage);
      const jobOwnership = assetLineagePredicate(null, lineage);
      const lastSuccess = db.prepare(`
        SELECT job_id, finished_at, duration_ms, snapshot_id
        FROM real_asset_sync_jobs
        WHERE character_id = ? AND status = 'COMPLETED' AND ${jobOwnership.sql}
        ORDER BY finished_at DESC LIMIT 1
      `).get(char.characterId, ...jobOwnership.params) as any;
      const account = db.prepare(`
        SELECT scopes_json FROM eve_accounts WHERE character_id = ?
      `).get(char.characterId) as { scopes_json?: string } | undefined;
      let scopes: string[] = [];
      try { scopes = JSON.parse(account?.scopes_json || '[]') as string[]; } catch { scopes = []; }
      const mirrorOwnership = assetLineagePredicate(null, lineage);
      const current = db.prepare(`
        SELECT COUNT(*) AS items,
               COUNT(DISTINCT type_id) AS unique_types,
               COUNT(DISTINCT location_id) AS locations,
               COALESCE(SUM(quantity), 0) AS quantity
        FROM character_assets WHERE character_id = ? AND ${mirrorOwnership.sql}
      `).get(char.characterId, ...mirrorOwnership.params) as any;
      const currentAssetItems = Number(current.items || 0);
      const hasAssetScope = scopes.includes('esi-assets.read_assets.v1');
      let currentDataHash: string | null = null;
      try {
        currentDataHash = computeCanonicalMirrorHash(db, char.characterId, lineage);
      } catch {
        currentDataHash = null;
      }
      const canonicalSnapshotMatches = !!latestSnapshot
        && latestSnapshot.hash_algorithm === 'sha256'
        && Number(latestSnapshot.canonical_version) === CANONICAL_ASSET_HASH_VERSION
        && currentDataHash !== null
        && currentDataHash === latestSnapshot.data_hash;
      const dataIntegrity = !latestSnapshot
        ? 'NO_SNAPSHOT'
        : canonicalSnapshotMatches
          && currentAssetItems === Number(latestSnapshot.total_items)
          && Number(current.unique_types || 0) === Number(latestSnapshot.total_unique_types)
          && Number(current.locations || 0) === Number(latestSnapshot.total_locations)
          && Number(current.quantity || 0) === Number(latestSnapshot.total_quantity)
          ? 'COMPLETE'
          : 'INCONSISTENT';
      const latestValuation = RealValuationService.latestTotals(db, char.characterId, lineage);
      const latestSnapshotId = typeof latestSnapshot?.snapshot_id === 'string' ? latestSnapshot.snapshot_id : null;
      const latestValuationSnapshotId = typeof latestValuation?.snapshotId === 'string' ? latestValuation.snapshotId : null;
      const valuationStatus = !latestValuation
        ? 'NO_VALUATION'
        : !latestSnapshotId
          ? 'NO_LATEST_SNAPSHOT'
          : latestValuationSnapshotId === latestSnapshotId
            ? 'CURRENT'
            : 'STALE';
      const valuationFreshness = {
        status: valuationStatus,
        latestSnapshotId,
        valuationSnapshotId: latestValuationSnapshotId,
        valuationItems: Number(latestValuation?.items ?? 0),
        currentAssetItems,
        message: valuationStatus === 'NO_VALUATION'
          ? '尚无完成的资产估值；市场参考和可执行估值均不可得。'
          : valuationStatus === 'STALE'
            ? '最近估值绑定的资产快照不是当前最新快照；该估值只代表旧快照，不代表当前库存。'
            : valuationStatus === 'NO_LATEST_SNAPSHOT'
              ? '没有最新完整资产快照可供估值。'
              : '估值绑定当前最新完整资产快照。',
      };
      return [{
        characterId: char.characterId,
        characterName: char.name,
        currentAssetItems,
        currentUniqueTypes: Number(current.unique_types || 0),
        currentLocations: Number(current.locations || 0),
        latestSnapshot: latestSnapshot || null,
        lastJob: job ? sanitizeAssetJob(job as unknown as Record<string, unknown>) : null,
        lastSuccessAt: lastSuccess?.finished_at ?? latestSnapshot?.completed_at ?? null,
        authorization: {
          status: hasAssetScope ? 'AUTHORIZED' : scopes.length > 0 ? 'MISSING_ASSET_SCOPE' : 'NO_ACCOUNT',
          hasAssetScope,
        },
        dataIntegrity,
        latestValuation,
        valuationFreshness,
        syncIntervalMinutes: config.assetSync.intervalMinutes,
        syncEnabled: config.assetSync.enabled,
      }];
    });
    const totals = characters.reduce((acc, row) => ({
      items: acc.items + row.currentAssetItems,
      uniqueTypes: acc.uniqueTypes + row.currentUniqueTypes,
      locations: acc.locations + row.currentLocations,
      characters: acc.characters + 1,
      withSnapshot: acc.withSnapshot + (row.latestSnapshot ? 1 : 0),
      authorized: acc.authorized + (row.authorization.hasAssetScope ? 1 : 0),
      lastSuccessAt: [acc.lastSuccessAt, row.lastSuccessAt].filter(Boolean).sort().at(-1) ?? null,
      integrity: {
        complete: acc.integrity.complete + (row.dataIntegrity === 'COMPLETE' ? 1 : 0),
        inconsistent: acc.integrity.inconsistent + (row.dataIntegrity === 'INCONSISTENT' ? 1 : 0),
        noSnapshot: acc.integrity.noSnapshot + (row.dataIntegrity === 'NO_SNAPSHOT' ? 1 : 0),
      },
    }), {
      items: 0,
      uniqueTypes: 0,
      locations: 0,
      characters: 0,
      withSnapshot: 0,
      authorized: 0,
      lastSuccessAt: null as string | null,
      integrity: { complete: 0, inconsistent: 0, noSnapshot: 0 },
    });
    for (const row of characters) {
      const lineage = resolveAssetLineage(db, row.characterId, session.userId, session.chatId);
      (row as any).bucketSummary = RealInventoryService.bucketSummary(db, row.characterId, lineage);
    }
    return {
      totals,
      buckets: Object.entries(BUCKET_LABELS_ZH).map(([bucket, labelZh]) => ({ bucket, labelZh })),
      characters,
      retentionPolicy: {
        snapshots: 'permanent_immutable',
        identicalSnapshots: 'sha256_deduplicated',
        changes: 'diff_only',
        valuationRuns: 'permanent_history',
        currentSet: 'atomic_replace',
        note: '不删除历史快照或变化；相同快照按哈希去重，变化仅存差异。',
      },
      valuationNote: 'market_reference / bid_liquidation / ask_replacement / cost_basis are independent perspectives and must not be summed',
      realTradingExecutionDisabled: true,
    };
  });

  app.post('/api/web/assets/sync/all', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const linked = linkedCharacters(db, session);
    if (linked.length === 0) return reply.status(404).send({ error: 'eve_character_not_linked' });
    const results: Array<Record<string, unknown>> = [];
    for (const char of linked) {
      try {
        const result = await RealAssetSyncService.syncCharacter(
          db,
          char.characterId,
          { ...sessionContext(session), characterId: char.characterId },
          'api',
        );
        results.push({ characterId: char.characterId, ok: true, result });
      } catch (error) {
        results.push({
          characterId: char.characterId,
          ok: false,
          error: 'asset_sync_failed',
          job: sanitizeAssetJob(((error as { job?: unknown }).job ?? {}) as Record<string, unknown>),
        });
      }
    }
    return { results, total: results.length, succeeded: results.filter((row) => row.ok).length };
  });

  app.get('/api/web/assets/characters', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    return { characters: linkedCharacters(db, session) };
  });

  app.post<{ Body: unknown }>('/api/web/assets/sync', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {};
    const requestedId = typeof body.characterId === 'number' && Number.isSafeInteger(body.characterId)
      ? body.characterId : undefined;
    const target = requireLinkedCharacter(db, session, reply, requestedId);
    if (!target) return;
    try {
      const result = await RealAssetSyncService.syncCharacter(
        db, target.characterId,
        { ...sessionContext(session), characterId: target.characterId },
        'api',
      );
      return { result };
    } catch (error) {
      const job = (error as { job?: unknown }).job;
      const message = sanitizeAssetError(error);
      const safeJob = job ? sanitizeAssetJob(job as Record<string, unknown>) : null;
      if (message.includes('已有资产同步任务在运行')) {
        return reply.status(409).send({ error: 'asset_sync_already_running', job: safeJob });
      }
      return reply.status(502).send({ error: 'asset_sync_failed', job: safeJob });
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/assets/sync/jobs', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const target = requireLinkedCharacter(db, session, reply, intQuery(request.query.characterId));
    if (!target) return;
    const lineage = requireAssetLineage(db, session, reply, target.characterId);
    if (!lineage) return;
    const limit = Math.max(1, Math.min(500, Number(request.query.limit ?? 50) || 50));
    return {
      jobs: RealAssetSyncService.listJobs(db, target.characterId, limit, lineage)
        .map((job) => sanitizeAssetJob(job as unknown as Record<string, unknown>)),
    };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/assets/snapshots', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const target = requireLinkedCharacter(db, session, reply, intQuery(request.query.characterId));
    if (!target) return;
    const lineage = requireAssetLineage(db, session, reply, target.characterId);
    if (!lineage) return;
    const result = RealAssetHistoryService.listSnapshots(db, {
      characterId: target.characterId,
      status: request.query.status,
      from: request.query.from,
      to: request.query.to,
      limit: Number(request.query.limit ?? 50),
      offset: Number(request.query.offset ?? 0),
    }, lineage);
    return result;
  });

  app.get<{
    Params: { snapshotId: string };
    Querystring: Record<string, string | undefined>;
  }>('/api/web/assets/snapshots/:snapshotId', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    let snapshot: any = null;
    let target: LinkedChar | null = null;
    for (const char of linkedCharacters(db, session)) {
      const lineage = requireAssetLineage(db, session, reply, char.characterId);
      if (!lineage) return;
      const ownership = assetLineagePredicate(null, lineage);
      snapshot = db.prepare(`
        SELECT * FROM real_asset_snapshots
        WHERE snapshot_id = ? AND character_id = ? AND ${ownership.sql}
      `).get(request.params.snapshotId, char.characterId, ...ownership.params) as any;
      if (snapshot) {
        target = char;
        break;
      }
    }
    if (!snapshot || !target) return reply.status(404).send({ error: 'snapshot_not_found_or_forbidden' });
    const rawLimit = Number(request.query.limit ?? 500);
    const rawOffset = Number(request.query.offset ?? 0);
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 5000) : 500;
    const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const total = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM real_asset_snapshot_items WHERE snapshot_id = ?
    `).get(snapshot.snapshot_id) as { n: number }).n || 0);
    const items = db.prepare(`
      SELECT item_id, type_id, quantity, location_id, location_type, location_flag,
             is_singleton, is_blueprint_copy, parent_item_id
      FROM real_asset_snapshot_items WHERE snapshot_id = ?
      ORDER BY type_id, item_id LIMIT ? OFFSET ?
    `).all(snapshot.snapshot_id, limit, offset);
    const nextOffset = offset + items.length < total ? offset + items.length : null;
    return {
      snapshot,
      items,
      total,
      limit,
      offset,
      hasMore: nextOffset !== null,
      nextOffset,
    };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/assets/changes', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const target = requireLinkedCharacter(db, session, reply, intQuery(request.query.characterId));
    if (!target) return;
    const lineage = requireAssetLineage(db, session, reply, target.characterId);
    if (!lineage) return;
    return RealAssetHistoryService.listChanges(db, {
      characterId: target.characterId,
      changeType: request.query.changeType,
      itemId: intQuery(request.query.itemId),
      typeId: intQuery(request.query.typeId),
      from: request.query.from,
      to: request.query.to,
      limit: Number(request.query.limit ?? 100),
      offset: Number(request.query.offset ?? 0),
    }, lineage);
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/assets/history/totals', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const target = requireLinkedCharacter(db, session, reply, intQuery(request.query.characterId));
    if (!target) return;
    const lineage = requireAssetLineage(db, session, reply, target.characterId);
    if (!lineage) return;
    return { snapshots: RealAssetHistoryService.totalsHistory(db, target.characterId, lineage, Number(request.query.limit ?? 100)) };
  });

  app.get<{ Params: { itemId: string }; Querystring: Record<string, string | undefined> }>('/api/web/assets/history/item/:itemId', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const itemId = Number(request.params.itemId);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      return reply.status(400).send({ error: 'invalid_item_id' });
    }
    for (const char of linkedCharacters(db, session)) {
      const lineage = requireAssetLineage(db, session, reply, char.characterId);
      if (!lineage) return;
      const mirrorOwnership = assetLineagePredicate(null, lineage);
      const snapshotOwnership = assetLineagePredicate('s', lineage);
      const owner = db.prepare(`
        SELECT 1 FROM character_assets
        WHERE character_id = ? AND item_id = ? AND ${mirrorOwnership.sql}
      `).get(char.characterId, itemId, ...mirrorOwnership.params)
        ?? db.prepare(`
          SELECT 1 FROM real_asset_snapshot_items si
          JOIN real_asset_snapshots s ON s.snapshot_id = si.snapshot_id
          WHERE s.character_id = ? AND si.item_id = ? AND ${snapshotOwnership.sql} LIMIT 1
        `).get(char.characterId, itemId, ...snapshotOwnership.params);
      if (owner) {
        return {
          characterId: char.characterId,
          ...RealAssetHistoryService.itemHistory(db, char.characterId, itemId, lineage),
        };
      }
    }
    return reply.status(404).send({ error: 'item_history_not_found_or_forbidden' });
  });

  app.get<{ Params: { fromSnapshotId: string; toSnapshotId: string }; Querystring: Record<string, string | undefined> }>('/api/web/assets/history/compare/:fromSnapshotId/:toSnapshotId', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    let target: LinkedChar | null = null;
    let lineage: AssetLineage | null = null;
    for (const char of linkedCharacters(db, session)) {
      const candidateLineage = requireAssetLineage(db, session, reply, char.characterId);
      if (!candidateLineage) return;
      const ownership = assetLineagePredicate(null, candidateLineage);
      const snapshot = db.prepare(`
        SELECT character_id FROM real_asset_snapshots
        WHERE snapshot_id = ? AND character_id = ? AND ${ownership.sql}
      `).get(request.params.fromSnapshotId, char.characterId, ...ownership.params);
      if (snapshot) {
        target = char;
        lineage = candidateLineage;
        break;
      }
    }
    if (!target || !lineage) return reply.status(404).send({ error: 'source_snapshot_not_found_or_forbidden' });
    try {
      return RealAssetHistoryService.compare(
        db, target.characterId, request.params.fromSnapshotId, request.params.toSnapshotId, lineage,
      );
    } catch {
      return reply.status(400).send({ error: 'snapshot_compare_failed' });
    }
  });
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/assets/inventory', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const target = requireLinkedCharacter(db, session, reply, intQuery(request.query.characterId));
    if (!target) return;
    const lineage = requireAssetLineage(db, session, reply, target.characterId);
    if (!lineage) return;
    const query = request.query;
    const tradableRaw = query.tradable;
    const result = RealInventoryService.list(db, {
      characterId: target.characterId,
      lineage,
      regionId: intQuery(query.region_id),
      solarSystemId: intQuery(query.solar_system_id),
      locationId: intQuery(query.location_id),
      bucket: query.bucket,
      resolutionStatus: query.resolution_status,
      q: query.q,
      tradable: tradableRaw === undefined ? undefined : tradableRaw === 'true' || tradableRaw === '1',
      sort: (query.sort as 'quantity' | 'name' | 'type') ?? 'quantity',
      order: query.order === 'asc' ? 'asc' : 'desc',
      limit: Number(query.limit ?? 100),
      offset: Number(query.offset ?? 0),
    });
    return result;
  });

  app.get<{ Params: { itemId: string } }>('/api/web/assets/inventory/:itemId', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const itemId = Number(request.params.itemId);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      return reply.status(400).send({ error: 'invalid_item_id' });
    }
    // IDOR: locate the item only among THIS user's linked characters.
    const owner = linkedCharacters(db, session).map((char) => {
      const lineage = requireAssetLineage(db, session, reply, char.characterId);
      return lineage
        ? { char, lineage, detail: RealInventoryService.detail(db, char.characterId, itemId, lineage) }
        : null;
    }).find((entry) => entry?.detail !== null && entry !== null);
    if (!owner) return reply.status(404).send({ error: 'item_not_found_or_forbidden' });
    return { item: owner.detail, tagLabels: ASSET_TAG_LABELS_ZH };
  });

  app.get('/api/web/assets/tags', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const linked = linkedCharacters(db, session);
    const tags = linked.flatMap((char) => {
      const lineage = requireAssetLineage(db, session, reply, char.characterId);
      if (!lineage) return [];
      const ownership = assetLineagePredicate('tg', lineage);
      return (db.prepare(`
        SELECT tg.item_id, tg.tag, tg.updated_at, a.type_id,
               COALESCE(json_extract(t.data_json, '$.name.zh'), t.name) AS type_name
        FROM real_asset_tags tg
        JOIN character_assets a
          ON a.character_id = tg.character_id AND a.item_id = tg.item_id
         AND a.owner_user_id = tg.owner_user_id
         AND a.owner_chat_id IS tg.owner_chat_id
         AND a.binding_epoch = tg.binding_epoch
         AND a.binding_digest = tg.binding_digest
        LEFT JOIN sde_types t ON t.type_id = a.type_id
        WHERE tg.character_id = ? AND ${ownership.sql}
        ORDER BY tg.updated_at DESC LIMIT 500
      `).all(char.characterId, ...ownership.params) as any[])
        .map((row) => ({ characterId: char.characterId, ...row }));
    });
    return { tags, tagLabels: ASSET_TAG_LABELS_ZH };
  });

  app.post<{ Body: unknown }>('/api/web/assets/valuations', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as Record<string, unknown> : {};
    const target = requireLinkedCharacter(
      db, session, reply,
      typeof body.characterId === 'number' ? body.characterId : undefined,
    );
    if (!target) return;
    const lineage = requireAssetLineage(db, session, reply, target.characterId);
    if (!lineage) return;
    try {
      const result = RealValuationService.run(db, target.characterId, lineage, {
        snapshotId: typeof body.snapshotId === 'string' ? body.snapshotId : undefined,
        hubLocationId: typeof body.hubLocationId === 'number' ? body.hubLocationId : undefined,
        hubRegionId: typeof body.hubRegionId === 'number' ? body.hubRegionId : undefined,
      });
      // Run history is capped in the response; the full item list lives on GET :id.
      return { valuation: { ...result, items: undefined }, itemCount: result.items.length };
    } catch (error) {
      const valuationId = (error as { valuationId?: string }).valuationId;
      return reply.status(500).send({
        error: 'valuation_job_failed',
        valuationId: valuationId ?? null,
      });
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/assets/valuations', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const target = requireLinkedCharacter(db, session, reply, intQuery(request.query.characterId));
    if (!target) return;
    const lineage = requireAssetLineage(db, session, reply, target.characterId);
    if (!lineage) return;
    return {
      runs: RealValuationService.listRuns(db, target.characterId, lineage, Number(request.query.limit ?? 20))
        .map((row) => sanitizeAssetJob(row as unknown as Record<string, unknown>)),
      latestTotals: RealValuationService.latestTotals(db, target.characterId, lineage),
    };
  });

  app.get<{ Params: { valuationId: string } }>('/api/web/assets/valuations/:valuationId', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    for (const char of linkedCharacters(db, session)) {
      const lineage = requireAssetLineage(db, session, reply, char.characterId);
      if (!lineage) return;
      const run = RealValuationService.getRun(db, char.characterId, request.params.valuationId, lineage);
      if (run) return run;
    }
    return reply.status(404).send({ error: 'valuation_not_found_or_forbidden' });
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/assets/opportunity-matches', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const target = requireLinkedCharacter(db, session, reply, intQuery(request.query.characterId));
    if (!target) return;
    const lineage = requireAssetLineage(db, session, reply, target.characterId);
    if (!lineage) return;
    return RealOpportunityMatchService.list(db, target.characterId, lineage, {
      supportClass: request.query.supportClass,
      state: request.query.state,
      limit: Number(request.query.limit ?? 100),
      offset: Number(request.query.offset ?? 0),
    });
  });

  app.post<{ Body: unknown }>('/api/web/assets/opportunity-matches/recompute', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as Record<string, unknown> : {};
    const target = requireLinkedCharacter(
      db, session, reply,
      typeof body.characterId === 'number' ? body.characterId : undefined,
    );
    if (!target) return;
    const lineage = requireAssetLineage(db, session, reply, target.characterId);
    if (!lineage) return;
    try {
      return RealOpportunityMatchService.recompute(db, target.characterId, lineage);
    } catch {
      return reply.status(500).send({ error: 'inventory_opportunity_failed' });
    }
  });
  app.put<{ Params: { itemId: string }; Body: unknown }>('/api/web/assets/tags/:itemId', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const itemId = Number(request.params.itemId);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      return reply.status(400).send({ error: 'invalid_item_id' });
    }
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as Record<string, unknown> : {};
    let owner: { char: LinkedChar; lineage: AssetLineage } | null = null;
    for (const char of linkedCharacters(db, session)) {
      const lineage = requireAssetLineage(db, session, reply, char.characterId);
      if (!lineage) return;
      const ownership = assetLineagePredicate(null, lineage);
      const exists = db.prepare(`
        SELECT 1 FROM character_assets
        WHERE character_id = ? AND item_id = ? AND ${ownership.sql}
      `).get(char.characterId, itemId, ...ownership.params);
      if (exists) {
        owner = { char, lineage };
        break;
      }
    }
    if (!owner) return reply.status(404).send({ error: 'item_not_editable' });
    try {
      if (body.tag === null || body.tag === '') {
        RealInventoryService.clearTag(db, owner.char.characterId, itemId, owner.lineage);
        return { itemId, tag: null };
      }
      if (typeof body.tag !== 'string') throw new Error('tag 必须是字符串或 null。');
      const tag = RealInventoryService.setTag(db, owner.char.characterId, itemId, body.tag, owner.lineage);
      return { itemId, tag, tagLabel: ASSET_TAG_LABELS_ZH[tag] };
    } catch {
      return reply.status(400).send({ error: 'tag_save_failed' });
    }
  });
}
