import { Cron } from 'croner';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { RealAssetSyncService } from './asset-sync-service.js';

/**
 * P9.2.1 scheduled real-asset sync. Runs on its own cron lane (every 5 min
 * tick, per-character due check) so a long asset walk never blocks the market
 * snapshot sweep. One sync per character at a time: the service rejects a
 * second RUNNING job and the query below also excludes in-flight characters.
 */

let cronJob: Cron | null = null;
let running = false;

export async function runAssetSyncWorkerTick(db: Db): Promise<void> {
  if (running || !config.assetSync.enabled) return;
  running = true;
  try {
    try {
      const reclaimed = RealAssetSyncService.reclaimStaleJobs(db);
      if (reclaimed > 0) {
        console.warn('[asset-sync] reclaimed %d stale RUNNING job(s)', reclaimed);
      }
    } catch (error) {
      // A transient database error must be visible; the next scheduled tick
      // retries reclaim before any due-character selection.
      console.error(
        '[asset-sync] stale-job reclaim failed: %s',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const due = db.prepare(`
      SELECT l.character_id, MIN(l.user_id) AS user_id, MIN(l.chat_id) AS chat_id
      FROM eve_character_links l
      WHERE NOT EXISTS (
        SELECT 1 FROM real_asset_sync_jobs j
        WHERE j.character_id = l.character_id AND j.status = 'RUNNING'
      )
        AND NOT EXISTS (
        SELECT 1 FROM real_asset_sync_jobs j2
        WHERE j2.character_id = l.character_id AND j2.status = 'COMPLETED'
          AND j2.finished_at > datetime('now', ?)
        )
      GROUP BY l.character_id
      ORDER BY l.character_id
    `).all(`-${config.assetSync.intervalMinutes} minutes`) as Array<{
      character_id: number; user_id: number; chat_id: number;
    }>;
    for (const row of due) {
      try {
        await RealAssetSyncService.syncCharacter(
          db,
          row.character_id,
          // Pinned: resolveActiveCharacterId prefers users.active_character_id
          // when userId is set, which would sync the wrong pilot in multi-char
          // households. The pin is ownership-checked inside sso.ts.
          { userId: row.user_id, chatId: row.chat_id, characterId: row.character_id },
          'auto',
        );
      } catch (error) {
        // The FAILED job row already carries the reason; log for journalctl.
        console.error(
          '[asset-sync] auto sync failed character=%d error=%s',
          row.character_id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } finally {
    running = false;
  }
}

export function startAssetSyncWorker(db: Db): void {
  if (cronJob) return;
  if (!config.assetSync.enabled) {
    console.log('[asset-sync] Worker disabled (ASSET_SYNC_ENABLED=false)');
    return;
  }
  console.log('[asset-sync] Starting real-asset sync worker');
  cronJob = new Cron('*/5 * * * *', { protect: true }, () => {
    void runAssetSyncWorkerTick(db);
  });
}

export function stopAssetSyncWorker(): void {
  cronJob?.stop();
  cronJob = null;
}
