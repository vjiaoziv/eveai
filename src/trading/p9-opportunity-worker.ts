import { Cron } from 'croner';
import type { Db } from '../db/sqlite.js';
import { P9OpportunityService } from './p9-opportunity-service.js';
import { resolveAssetLineage, type AssetLineage } from '../assets/asset-lineage.js';

let cronJob: Cron | null = null;
let running = false;

async function tick(db: Db): Promise<void> {
  if (running) return;
  running = true;
  try {
    const due = db.prepare(`
      SELECT s.character_id, s.owner_user_id, s.owner_chat_id, s.binding_epoch
      FROM p9_scan_settings s
      WHERE s.auto_scan_enabled = 1
        AND (
          NOT EXISTS (
            SELECT 1 FROM p9_job_runs j
            WHERE j.character_id = s.character_id
              AND j.owner_user_id = s.owner_user_id
              AND j.owner_chat_id = s.owner_chat_id
              AND j.binding_epoch = s.binding_epoch
              AND j.job_type = 'market_scan'
              AND j.status = 'running'
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM p9_job_runs j
              WHERE j.character_id = s.character_id
                AND j.owner_user_id = s.owner_user_id
                AND j.owner_chat_id = s.owner_chat_id
                AND j.binding_epoch = s.binding_epoch
                AND j.job_type = 'market_scan'
                AND j.status = 'ok'
            )
            OR (
              SELECT MAX(j.started_at) FROM p9_job_runs j
              WHERE j.character_id = s.character_id
                AND j.owner_user_id = s.owner_user_id
                AND j.owner_chat_id = s.owner_chat_id
                AND j.binding_epoch = s.binding_epoch
                AND j.job_type = 'market_scan'
                AND j.status = 'ok'
            ) < datetime('now', '-' || s.auto_scan_interval_minutes || ' minutes')
          )
        )
      ORDER BY s.character_id, s.owner_user_id, s.owner_chat_id, s.binding_epoch
    `).all() as Array<{
      character_id: number;
      owner_user_id: number;
      owner_chat_id: number;
      binding_epoch: number;
    }>;
    for (const row of due) {
      try {
        let lineage: AssetLineage | null = null;
        if (row.owner_user_id > 0) {
          if (row.owner_chat_id <= 0) continue;
          lineage = resolveAssetLineage(
            db,
            row.character_id,
            row.owner_user_id,
            row.owner_chat_id,
          );
          // A rebind is a new authorization namespace. Do not let an old
          // auto-scan setting silently act under the replacement owner.
          if (lineage.bindingEpoch !== row.binding_epoch) continue;
        }
        P9OpportunityService.scan(db, row.character_id, {}, lineage);
      } catch (error) {
        console.error('[p9-opportunity-worker] scan failed character=%d error=%s', row.character_id, error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    running = false;
  }
}

export function startP9OpportunityWorker(db: Db): void {
  if (cronJob) return;
  cronJob = new Cron('*/5 * * * *', { protect: true }, () => {
    void tick(db);
  });
}

export function stopP9OpportunityWorker(): void {
  cronJob?.stop();
  cronJob = null;
}