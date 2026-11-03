import { Cron } from 'croner';
import type { Db } from '../db/sqlite.js';
import { P9OpportunityService } from './p9-opportunity-service.js';

let cronJob: Cron | null = null;
let running = false;

async function tick(db: Db): Promise<void> {
  if (running) return;
  running = true;
  try {
    const due = db.prepare(`
      SELECT s.character_id
      FROM p9_scan_settings s
      WHERE s.auto_scan_enabled = 1
        AND (
          NOT EXISTS (
            SELECT 1 FROM p9_job_runs j
            WHERE j.character_id = s.character_id
              AND j.job_type = 'market_scan'
              AND j.status = 'running'
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM p9_job_runs j
              WHERE j.character_id = s.character_id
                AND j.job_type = 'market_scan'
                AND j.status = 'ok'
            )
            OR (
              SELECT MAX(j.started_at) FROM p9_job_runs j
              WHERE j.character_id = s.character_id AND j.job_type = 'market_scan' AND j.status = 'ok'
            ) < datetime('now', '-' || s.auto_scan_interval_minutes || ' minutes')
          )
        )
      ORDER BY s.character_id
    `).all() as Array<{ character_id: number }>;
    for (const row of due) {
      try {
        P9OpportunityService.scan(db, row.character_id);
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