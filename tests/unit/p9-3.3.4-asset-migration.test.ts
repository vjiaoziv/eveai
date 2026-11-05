import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import type { Db } from '../../src/db/sqlite.js';

function columnNames(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

describe('P9.3.3.4 asset migration compatibility', () => {
  it('upgrades a legacy asset job table, reconciles duplicate RUNNING rows, and remains idempotent', () => {
    const db = new Database(':memory:') as Db;
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE real_asset_sync_jobs (
        job_id       TEXT PRIMARY KEY,
        character_id INTEGER NOT NULL,
        trigger      TEXT NOT NULL DEFAULT 'manual',
        status       TEXT NOT NULL DEFAULT 'RUNNING',
        phase        TEXT NOT NULL DEFAULT 'fetch',
        pages_total  INTEGER,
        pages_fetched INTEGER,
        items_fetched INTEGER,
        items_committed INTEGER,
        items_skipped INTEGER NOT NULL DEFAULT 0,
        started_at   TEXT NOT NULL,
        finished_at  TEXT,
        duration_ms  INTEGER,
        snapshot_id  TEXT,
        last_error   TEXT,
        source       TEXT NOT NULL DEFAULT 'esi_character_assets'
      );
      INSERT INTO real_asset_sync_jobs (job_id, character_id, status, started_at)
      VALUES
        ('legacy-1', 9001, 'RUNNING', '2026-11-04T01:00:00Z'),
        ('legacy-2', 9001, 'RUNNING', '2026-11-04T02:00:00Z');
    `);

    runMigrations(db);
    runMigrations(db);

    expect(columnNames(db, 'real_asset_sync_jobs')).toEqual(expect.arrayContaining([
      'generation',
      'owner_user_id',
      'owner_chat_id',
      'binding_epoch',
      'binding_digest',
      'account_owner_hash',
    ]));
    expect(columnNames(db, 'real_asset_snapshots')).toEqual(expect.arrayContaining([
      'hash_algorithm',
      'canonical_version',
    ]));
    expect(db.prepare(`
      SELECT job_id, status FROM real_asset_sync_jobs WHERE character_id = 9001 ORDER BY job_id
    `).all()).toEqual([
      { job_id: 'legacy-1', status: 'FAILED' },
      { job_id: 'legacy-2', status: 'RUNNING' },
    ]);
    expect(db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_real_asset_jobs_one_running'
    `).get()).toEqual({ name: 'idx_real_asset_jobs_one_running' });

    expect(() => db.prepare(`
      INSERT INTO real_asset_sync_jobs (job_id, character_id, status, started_at)
      VALUES ('legacy-3', 9001, 'RUNNING', '2026-11-04T03:00:00Z')
    `).run()).toThrow(/UNIQUE constraint failed/);

    db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
      .run(88, 'migration-user', null);
    db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
      .run(77, 'migration-user', null);
    db.prepare(`
      INSERT INTO eve_accounts
        (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
      VALUES (?, ?, 'access-token', 'refresh-token', datetime('now', '+1 hour'), '[]', ?)
    `).run(9002, 'Migration Pilot', 88);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(77, 9002, 88);
    expect(db.prepare(`
      SELECT epoch FROM eve_character_binding_epochs WHERE chat_id = 77 AND character_id = 9002
    `).get()).toEqual({ epoch: 1 });
    db.prepare('DELETE FROM eve_character_links WHERE chat_id = 77 AND character_id = 9002').run();
    expect(db.prepare(`
      SELECT epoch FROM eve_character_binding_epochs WHERE chat_id = 77 AND character_id = 9002
    `).get()).toEqual({ epoch: 2 });
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(77, 9002, 88);
    expect(db.prepare(`
      SELECT epoch FROM eve_character_binding_epochs WHERE chat_id = 77 AND character_id = 9002
    `).get()).toEqual({ epoch: 3 });

    runMigrations(db);
    expect(db.prepare(`
      SELECT epoch FROM eve_character_binding_epochs WHERE chat_id = 77 AND character_id = 9002
    `).get()).toEqual({ epoch: 3 });
    db.close();
  });
});
