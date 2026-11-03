import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';
import type { WebSession } from './web-session.js';
import { getLinkedCharacter } from '../eve/sso.js';
import { RealAssetSyncService } from '../assets/asset-sync-service.js';
import { RealInventoryService, ASSET_TAG_LABELS_ZH, BUCKET_LABELS_ZH } from '../assets/inventory-service.js';
import { RealValuationService } from '../assets/valuation-service.js';
import { RealAssetHistoryService } from '../assets/history-service.js';
import { RealOpportunityMatchService } from '../assets/opportunity-match-service.js';

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
    WHERE l.user_id = ?
    ORDER BY l.character_id
  `).all(session.userId) as Array<{ character_id: number; character_name: string | null }>;
  return rows.map((row) => ({ characterId: row.character_id, name: row.character_name }));
}

function requireLinkedCharacter(db: Db, session: WebSession, reply: FastifyReply, characterId?: number): LinkedChar | null {
  const linked = linkedCharacters(db, session);
  if (linked.length === 0) {
    reply.status(404).send({ error: '尚未关联 EVE 角色。' });
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
    reply.status(403).send({ error: '无权访问该角色的资产数据。' });
    return null;
  }
  return match;
}

function intQuery(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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
    const characters = linked.map((char) => {
      const latestSnapshot = db.prepare(`
        SELECT snapshot_id, status, completed_at, total_items, total_unique_types,
               total_locations, total_quantity, data_hash
        FROM real_asset_snapshots
        WHERE character_id = ? AND status = 'COMPLETED'
        ORDER BY completed_at DESC LIMIT 1
      `).get(char.characterId) as any;
      const job = RealAssetSyncService.latestJob(db, char.characterId);
      const currentItems = Number((db.prepare(
        'SELECT COUNT(*) AS n FROM character_assets WHERE character_id = ?',
      ).get(char.characterId) as any)?.n || 0);
      return {
        characterId: char.characterId,
        characterName: char.name,
        currentAssetItems: currentItems,
        latestSnapshot: latestSnapshot || null,
        lastJob: job,
        latestValuation: RealValuationService.latestTotals(db, char.characterId),
        syncIntervalMinutes: config.assetSync.intervalMinutes,
        syncEnabled: config.assetSync.enabled,
      };
    });
    const totals = characters.reduce((acc, row) => ({
      items: acc.items + row.currentAssetItems,
      characters: acc.characters + 1,
      withSnapshot: acc.withSnapshot + (row.latestSnapshot ? 1 : 0),
    }), { items: 0, characters: 0, withSnapshot: 0 });
    for (const row of characters) {
      (row as any).bucketSummary = RealInventoryService.bucketSummary(db, row.characterId);
    }
    return {
      totals,
      buckets: Object.entries(BUCKET_LABELS_ZH).map(([bucket, labelZh]) => ({ bucket, labelZh })),
      characters,
      // Perspectives are reported separately per valuation run; they are
      // never summed into one fake net-worth number.
      valuationNote: 'market_reference / bid_liquidation / ask_replacement / cost_basis are independent perspectives and must not be summed',
      realTradingExecutionDisabled: true,
    };
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
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('已有资产同步任务在运行')) {
        return reply.status(409).send({ error: message, job: job ?? null });
      }
      return reply.status(502).send({ error: message, job: job ?? null });
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/assets/sync/jobs', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const target = requireLinkedCharacter(db, session, reply, intQuery(request.query.characterId));
    if (!target) return;
    const limit = Math.max(1, Math.min(500, Number(request.query.limit ?? 50) || 50));
    return { jobs: RealAssetSyncService.listJobs(db, target.characterId, limit) };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/assets/snapshots', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const target = requireLinkedCharacter(db, session, reply, intQuery(request.query.characterId));
    if (!target) return;
    const result = RealAssetHistoryService.listSnapshots(db, {
      characterId: target.characterId,
      status: request.query.status,
      from: request.query.from,
      to: request.query.to,
      limit: Number(request.query.limit ?? 50),
      offset: Number(request.query.offset ?? 0),
    });
    return result;
  });

  app.get<{ Params: { snapshotId: string } }>('/api/web/assets/snapshots/:snapshotId', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const snapshot = db.prepare('SELECT * FROM real_asset_snapshots WHERE snapshot_id = ?')
      .get(request.params.snapshotId) as any;
    if (!snapshot) return reply.status(404).send({ error: '快照不存在。' });
    const target = requireLinkedCharacter(db, session, reply, Number(snapshot.character_id));
    if (!target) return;
    const items = db.prepare(`
      SELECT item_id, type_id, quantity, location_id, location_type, location_flag,
             is_singleton, is_blueprint_copy, parent_item_id
      FROM real_asset_snapshot_items WHERE snapshot_id = ?
      ORDER BY type_id, item_id LIMIT 5000
    `).all(snapshot.snapshot_id);
    return { snapshot, items };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/assets/changes', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const target = requireLinkedCharacter(db, session, reply, intQuery(request.query.characterId));
    if (!target) return;
    return RealAssetHistoryService.listChanges(db, {
      characterId: target.characterId,
      changeType: request.query.changeType,
      itemId: intQuery(request.query.itemId),
      typeId: intQuery(request.query.typeId),
      from: request.query.from,
      to: request.query.to,
      limit: Number(request.query.limit ?? 100),
      offset: Number(request.query.offset ?? 0),
    });
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/assets/history/totals', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const target = requireLinkedCharacter(db, session, reply, intQuery(request.query.characterId));
    if (!target) return;
    return { snapshots: RealAssetHistoryService.totalsHistory(db, target.characterId, Number(request.query.limit ?? 100)) };
  });

  app.get<{ Params: { itemId: string }; Querystring: Record<string, string | undefined> }>('/api/web/assets/history/item/:itemId', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const itemId = Number(request.params.itemId);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      return reply.status(400).send({ error: '无效的物品 ID。' });
    }
    const linked = linkedCharacters(db, session);
    const owner = linked.find((char) => db.prepare(
      'SELECT 1 FROM character_assets WHERE character_id = ? AND item_id = ?',
    ).get(char.characterId, itemId))
      ?? linked.find((char) => db.prepare(`
        SELECT 1 FROM real_asset_snapshot_items si
        JOIN real_asset_snapshots s ON s.snapshot_id = si.snapshot_id
        WHERE s.character_id = ? AND si.item_id = ? LIMIT 1
      `).get(char.characterId, itemId));
    if (!owner) return reply.status(404).send({ error: '物品历史不存在或无权查看。' });
    return { characterId: owner.characterId, ...RealAssetHistoryService.itemHistory(db, owner.characterId, itemId) };
  });

  app.get<{ Params: { fromSnapshotId: string; toSnapshotId: string }; Querystring: Record<string, string | undefined> }>('/api/web/assets/history/compare/:fromSnapshotId/:toSnapshotId', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const snapshot = db.prepare('SELECT character_id FROM real_asset_snapshots WHERE snapshot_id = ?')
      .get(request.params.fromSnapshotId) as { character_id: number } | undefined;
    if (!snapshot) return reply.status(404).send({ error: '起始快照不存在。' });
    const target = requireLinkedCharacter(db, session, reply, snapshot.character_id);
    if (!target) return;
    try {
      return RealAssetHistoryService.compare(
        db, target.characterId, request.params.fromSnapshotId, request.params.toSnapshotId,
      );
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '快照对比失败。' });
    }
  });
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/assets/inventory', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const target = requireLinkedCharacter(db, session, reply, intQuery(request.query.characterId));
    if (!target) return;
    const query = request.query;
    const tradableRaw = query.tradable;
    const result = RealInventoryService.list(db, {
      characterId: target.characterId,
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
      return reply.status(400).send({ error: '无效的物品 ID。' });
    }
    const linked = linkedCharacters(db, session);
    // IDOR: locate the item only among THIS user's linked characters.
    const owner = linked.map((char) => ({ char, detail: RealInventoryService.detail(db, char.characterId, itemId) }))
      .find((entry) => entry.detail !== null);
    if (!owner) return reply.status(404).send({ error: '物品不存在或无权查看。' });
    return { item: owner.detail, tagLabels: ASSET_TAG_LABELS_ZH };
  });

  app.get('/api/web/assets/tags', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const linked = linkedCharacters(db, session);
    const tags = linked.flatMap((char) => (db.prepare(`
      SELECT tg.item_id, tg.tag, tg.updated_at, a.type_id,
             COALESCE(json_extract(t.data_json, '$.name.zh'), t.name) AS type_name
      FROM real_asset_tags tg
      JOIN character_assets a ON a.character_id = tg.character_id AND a.item_id = tg.item_id
      LEFT JOIN sde_types t ON t.type_id = a.type_id
      WHERE tg.character_id = ?
      ORDER BY tg.updated_at DESC LIMIT 500
    `).all(char.characterId) as any[]).map((row) => ({ characterId: char.characterId, ...row })));
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
    try {
      const result = RealValuationService.run(db, target.characterId, {
        snapshotId: typeof body.snapshotId === 'string' ? body.snapshotId : undefined,
        hubLocationId: typeof body.hubLocationId === 'number' ? body.hubLocationId : undefined,
        hubRegionId: typeof body.hubRegionId === 'number' ? body.hubRegionId : undefined,
      });
      // Run history is capped in the response; the full item list lives on GET :id.
      return { valuation: { ...result, items: undefined }, itemCount: result.items.length };
    } catch (error) {
      const valuationId = (error as { valuationId?: string }).valuationId;
      return reply.status(500).send({
        error: error instanceof Error ? error.message : '估值任务失败。',
        valuationId: valuationId ?? null,
      });
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/assets/valuations', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const target = requireLinkedCharacter(db, session, reply, intQuery(request.query.characterId));
    if (!target) return;
    return {
      runs: RealValuationService.listRuns(db, target.characterId, Number(request.query.limit ?? 20)),
      latestTotals: RealValuationService.latestTotals(db, target.characterId),
    };
  });

  app.get<{ Params: { valuationId: string } }>('/api/web/assets/valuations/:valuationId', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const linked = linkedCharacters(db, session);
    for (const char of linked) {
      const run = RealValuationService.getRun(db, char.characterId, request.params.valuationId);
      if (run) return run;
    }
    return reply.status(404).send({ error: '估值记录不存在或无权查看。' });
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/web/assets/opportunity-matches', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const target = requireLinkedCharacter(db, session, reply, intQuery(request.query.characterId));
    if (!target) return;
    return RealOpportunityMatchService.list(db, target.characterId, {
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
    try {
      return RealOpportunityMatchService.recompute(db, target.characterId);
    } catch (error) {
      return reply.status(500).send({ error: error instanceof Error ? error.message : '库存机会联动计算失败。' });
    }
  });
  app.put<{ Params: { itemId: string }; Body: unknown }>('/api/web/assets/tags/:itemId', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const itemId = Number(request.params.itemId);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      return reply.status(400).send({ error: '无效的物品 ID。' });
    }
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as Record<string, unknown> : {};
    const linked = linkedCharacters(db, session);
    const owner = linked.find((char) => db.prepare(
      'SELECT 1 FROM character_assets WHERE character_id = ? AND item_id = ?',
    ).get(char.characterId, itemId));
    if (!owner) return reply.status(404).send({ error: '物品不存在或无权修改。' });
    try {
      if (body.tag === null || body.tag === '') {
        RealInventoryService.clearTag(db, owner.characterId, itemId);
        return { itemId, tag: null };
      }
      if (typeof body.tag !== 'string') throw new Error('tag 必须是字符串或 null。');
      const tag = RealInventoryService.setTag(db, owner.characterId, itemId, body.tag);
      return { itemId, tag, tagLabel: ASSET_TAG_LABELS_ZH[tag] };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : '标签保存失败。' });
    }
  });
}
