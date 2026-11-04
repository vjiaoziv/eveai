import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import { clampPositiveInteger } from '../util/query-bounds.js';
import { config } from '../config.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { getEveCapabilities } from '../eve/capabilities.js';
import type { UserContext } from '../auth/user-resolver.js';
import { AssetLocationResolver, type AssetItemRegistry } from './location-resolver.js';

/**
 * P9.2.1 real-asset read-only sync.
 *
 * Pipeline (task book 4.3): create job -> fetch every ESI page -> validate
 * every row -> canonical hash -> compare with the previous COMPLETE snapshot ->
 * single atomic commit (current set + immutable snapshot items + resolution
 * cache + observed changes + latest flag + job finalisation). Any failure
 * before/during the transaction leaves the previous valid snapshot serving and
 * records a FAILED job with the error; a partial page walk can never overwrite
 * production data because callEsiOperation only resolves after all pages.
 */

export type AssetSyncTrigger = 'manual' | 'auto' | 'api';

export type AssetSyncJob = {
  jobId: string;
  characterId: number;
  trigger: AssetSyncTrigger;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  phase: string;
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

type NormalizedAssetRow = {
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

function intField(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function strField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
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

export class RealAssetSyncService {
  static listJobs(db: Db, characterId: number, limit = 50): AssetSyncJob[] {
    const capped = clampPositiveInteger(limit, 50, 500);
    return (db.prepare(`
      SELECT * FROM real_asset_sync_jobs WHERE character_id = ?
      ORDER BY started_at DESC LIMIT ?
    `).all(characterId, capped) as any[]).map(mapJob);
  }

  static latestJob(db: Db, characterId: number): AssetSyncJob | null {
    const row = db.prepare(`
      SELECT * FROM real_asset_sync_jobs WHERE character_id = ?
      ORDER BY started_at DESC LIMIT 1
    `).get(characterId) as any;
    return row ? mapJob(row) : null;
  }

  /** Fail jobs wedged in RUNNING past the stale window so the lane reopens. */
  static reclaimStaleJobs(db: Db, characterId: number): number {
    const result = db.prepare(`
      UPDATE real_asset_sync_jobs
      SET status = 'FAILED', finished_at = datetime('now'),
          last_error = 'sync presumed crashed: RUNNING longer than stale window'
      WHERE character_id = ? AND status = 'RUNNING'
        AND started_at < datetime('now', ?)
    `).run(characterId, `-${config.assetSync.staleJobMinutes} minutes`);
    return result.changes;
  }

  static async syncCharacter(
    db: Db,
    characterId: number,
    ctx: UserContext,
    trigger: AssetSyncTrigger = 'manual',
  ): Promise<AssetSyncResult> {
    this.reclaimStaleJobs(db, characterId);
    const running = db.prepare(`
      SELECT job_id FROM real_asset_sync_jobs
      WHERE character_id = ? AND status = 'RUNNING' LIMIT 1
    `).get(characterId) as { job_id: string } | undefined;
    if (running) {
      throw new Error(`角色 ${characterId} 已有资产同步任务在运行（${running.job_id}）。`);
    }

    const jobId = `ASSETJOB-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO real_asset_sync_jobs
        (job_id, character_id, trigger, status, phase, started_at, source)
      VALUES (?, ?, ?, 'RUNNING', 'fetch', ?, 'esi_character_assets')
    `).run(jobId, characterId, trigger, startedAt);

    const startedMs = Date.now();
    const finish = (status: 'COMPLETED' | 'FAILED', patch: {
      phase?: string; pagesTotal?: number | null; pagesFetched?: number | null;
      itemsFetched?: number | null; itemsCommitted?: number | null; itemsSkipped?: number;
      snapshotId?: string | null; error?: string | null;
    }): AssetSyncJob => {
      const durationMs = Date.now() - startedMs;
      db.prepare(`
        UPDATE real_asset_sync_jobs
        SET status = ?, phase = ?, finished_at = datetime('now'), duration_ms = ?,
            pages_total = COALESCE(?, pages_total),
            pages_fetched = COALESCE(?, pages_fetched),
            items_fetched = COALESCE(?, items_fetched),
            items_committed = COALESCE(?, items_committed),
            items_skipped = COALESCE(?, items_skipped),
            snapshot_id = COALESCE(?, snapshot_id),
            last_error = ?
        WHERE job_id = ?
      `).run(
        status, patch.phase ?? 'done', durationMs,
        patch.pagesTotal ?? null, patch.pagesFetched ?? null,
        patch.itemsFetched ?? null, patch.itemsCommitted ?? null,
        patch.itemsSkipped ?? null, patch.snapshotId ?? null,
        patch.error ?? null, jobId,
      );
      return this.latestJob(db, characterId)!;
    };

    try {
      // Private ESI requires a fresh capability snapshot (same contract as the
      // character datastore sync): record which scopes this ctx may use first.
      await getEveCapabilities(db, 'real asset sync', ctx);
      // --- fetch (all pages; failure here never touches stored assets) ---
      const result = await callEsiOperation<unknown[]>(
        db, 'get_characters_character_id_assets', {}, ctx,
        { maxPages: config.characterSync.maxPages },
      );
      if (!result.ok) throw new Error(result.error);
      const pagesHeader = headerValue(result.headers, 'x-pages');
      const pagesTotal = pagesHeader !== null && Number.isFinite(Number(pagesHeader))
        ? Math.max(1, Math.floor(Number(pagesHeader)))
        : 1;
      db.prepare(`UPDATE real_asset_sync_jobs SET phase = 'validate', pages_total = ?, pages_fetched = ? WHERE job_id = ?`)
        .run(pagesTotal, pagesTotal, jobId);

      // --- validate (any malformed row fails the whole batch) ---
      if (!Array.isArray(result.data)) throw new Error('ESI 资产接口未返回数组，判定为不完整数据。');
      const registry: AssetItemRegistry = new Map();
      const rows: NormalizedAssetRow[] = [];
      for (let index = 0; index < result.data.length; index += 1) {
        const raw = result.data[index];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error(`资产数据第 ${index + 1} 行不是对象，拒绝提交部分结果。`);
        }
        const record = raw as Record<string, unknown>;
        const itemId = intField(record.item_id);
        const typeId = intField(record.type_id);
        const locationId = intField(record.location_id);
        if (itemId === null || typeId === null || locationId === null) {
          throw new Error(`资产数据第 ${index + 1} 行缺少 item_id/type_id/location_id，拒绝提交部分结果。`);
        }
        const quantityRaw = intField(record.quantity);
        rows.push({
          itemId,
          typeId,
          quantity: quantityRaw !== null && quantityRaw > 0 ? quantityRaw : 1,
          locationId,
          locationType: strField(record.location_type),
          locationFlag: strField(record.location_flag),
          isSingleton: record.is_singleton === true ? 1 : 0,
          isBlueprintCopy: record.is_blueprint_copy === undefined || record.is_blueprint_copy === null
            ? null : (record.is_blueprint_copy === true ? 1 : 0),
          parentItemId: null,
          raw: record,
        });
        registry.set(itemId, { typeId, locationId });
      }

      // Container/ship nesting: location_id that equals another item_id.
      for (const row of rows) {
        if (row.locationId !== row.itemId && registry.has(row.locationId)) {
          row.parentItemId = row.locationId;
        }
      }

      // --- canonical hash + dedupe against the previous complete snapshot ---
      const canonical = rows
        .map((row) => [row.itemId, row.typeId, row.quantity, row.locationId, row.locationFlag ?? '', row.parentItemId ?? 0])
        .sort((a, b) => (a[0] as number) - (b[0] as number));
      const dataHash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      const previous = db.prepare(`
        SELECT * FROM real_asset_snapshots
        WHERE character_id = ? AND status = 'COMPLETED' AND is_latest = 1
        LIMIT 1
      `).get(characterId) as any;

      if (previous && previous.data_hash === dataHash) {
        const job = finish('COMPLETED', {
          pagesTotal, pagesFetched: pagesTotal,
          itemsFetched: rows.length, itemsCommitted: 0, itemsSkipped: 0,
          snapshotId: previous.snapshot_id,
        });
        return {
          job,
          snapshotId: previous.snapshot_id,
          deduped: true,
          itemsFetched: rows.length,
          itemsCommitted: 0,
          changesRecorded: 0,
          durationMs: job.durationMs ?? 0,
        };
      }

      db.prepare(`UPDATE real_asset_sync_jobs SET phase = 'commit' WHERE job_id = ?`).run(jobId);

      // --- atomic commit ---
      const snapshotId = `ASSETSNAP-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const nowIso = new Date().toISOString();
      const totalQuantity = rows.reduce((sum, row) => sum + row.quantity, 0);
      const uniqueTypes = new Set(rows.map((row) => row.typeId)).size;
      const uniqueLocations = new Set(rows.map((row) => row.locationId)).size;

      const hints = new Map<number, string | null>();
      for (const row of rows) {
        if (row.locationType && !hints.has(row.locationId)) hints.set(row.locationId, row.locationType);
      }
      const resolved = AssetLocationResolver.resolveMany(
        db, [...new Set(rows.map((row) => row.locationId))], registry, hints,
      );

      const changes = previous ? diffSnapshots(db, characterId, previous.snapshot_id, snapshotId, rows) : [];

      const insertAsset = db.prepare(`
        INSERT INTO character_assets
          (character_id, item_id, type_id, location_id, location_type, location_flag,
           quantity, is_singleton, is_blueprint_copy, data_json, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      const insertSnapshot = db.prepare(`
        INSERT INTO real_asset_snapshots
          (snapshot_id, character_id, job_id, started_at, completed_at, status,
           total_items, total_unique_types, total_locations, total_quantity,
           data_hash, source, error_summary, is_latest)
        VALUES (?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, 'esi_character_assets', NULL, 1)
      `);
      const insertItem = db.prepare(`
        INSERT INTO real_asset_snapshot_items
          (snapshot_id, item_id, type_id, quantity, location_id, location_type,
           location_flag, is_singleton, is_blueprint_copy, parent_item_id, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertChange = db.prepare(`
        INSERT INTO real_asset_changes
          (change_id, character_id, item_id, type_id, change_type,
           prev_quantity, new_quantity, prev_location_id, new_location_id,
           source_class, confidence, from_snapshot_id, to_snapshot_id, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OBSERVED_CHANGE', ?, ?, ?, ?)
      `);

      let changesRecorded = 0;
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM character_assets WHERE character_id = ?').run(characterId);
        for (const row of rows) {
          insertAsset.run(
            characterId, row.itemId, row.typeId, row.locationId, row.locationType, row.locationFlag,
            row.quantity, row.isSingleton, row.isBlueprintCopy, JSON.stringify(row.raw),
          );
        }
        // Clear the previous latest flag first: the partial unique index
        // (character_id WHERE is_latest=1) rejects two latest rows at INSERT
        // time, so ordering inside this transaction matters.
        if (previous) {
          db.prepare('UPDATE real_asset_snapshots SET is_latest = 0 WHERE snapshot_id = ?').run(previous.snapshot_id);
        }
        insertSnapshot.run(
          snapshotId, characterId, jobId, startedAt, nowIso,
          rows.length, uniqueTypes, uniqueLocations, totalQuantity, dataHash,
        );
        for (const row of rows) {
          insertItem.run(
            snapshotId, row.itemId, row.typeId, row.quantity, row.locationId, row.locationType,
            row.locationFlag, row.isSingleton, row.isBlueprintCopy, row.parentItemId,
            JSON.stringify(row.raw),
          );
        }
        for (const change of changes) {
          insertChange.run(
            change.changeId, characterId, change.itemId, change.typeId, change.changeType,
            change.prevQuantity, change.newQuantity, change.prevLocationId, change.newLocationId,
            change.confidence, change.fromSnapshotId, snapshotId, nowIso,
          );
          changesRecorded += 1;
        }
      });
      tx();
      void resolved; // resolution cache written inside AssetLocationResolver.resolveMany

      const job = finish('COMPLETED', {
        pagesTotal, pagesFetched: pagesTotal,
        itemsFetched: rows.length, itemsCommitted: rows.length, itemsSkipped: 0,
        snapshotId,
      });
      return {
        job,
        snapshotId,
        deduped: false,
        itemsFetched: rows.length,
        itemsCommitted: rows.length,
        changesRecorded,
        durationMs: job.durationMs ?? 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const job = finish('FAILED', { error: message.slice(0, 500) });
      throw Object.assign(new Error(message), { job });
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
    `).all(characterId, toSnapshotId) as Array<{ item_id: number }>).map((row) => row.item_id),
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
