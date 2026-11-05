import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import type { Db } from '../../../src/db/sqlite.js';

const CHARACTER_ID = 9_947_201;
const TEMP_DIRS: string[] = [];

function seedLegacyDatabase(db: Db): void {
  db.exec(`
    DROP TABLE real_trade_records;
    DROP TABLE real_esi_transaction_sync;
    DROP TABLE real_esi_transaction_sync_leases;
    DROP TABLE real_esi_transaction_failures;
    DROP TABLE character_assets;

    CREATE TABLE real_trade_records (
      record_id             TEXT PRIMARY KEY,
      character_id          INTEGER NOT NULL,
      ledger_key            TEXT NOT NULL,
      record_state          TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (record_state IN ('DRAFT', 'ACTIVE', 'VERIFIED', 'REJECTED', 'REVERSED', 'CORRECTED')),
      verification_status   TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (verification_status IN ('VERIFIED', 'USER_REPORTED', 'PENDING', 'CONFLICT', 'REJECTED')),
      trade_kind            TEXT NOT NULL,
      direction             TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL', 'NONE')),
      type_id               INTEGER NOT NULL,
      location_id           INTEGER NOT NULL,
      quantity              INTEGER NOT NULL CHECK (quantity >= 0),
      unit_price            REAL NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
      gross_amount          REAL GENERATED ALWAYS AS (quantity * unit_price) STORED,
      fee_status            TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (fee_status IN ('COMPLETE', 'UNKNOWN')),
      trade_time            TEXT NOT NULL,
      source_type           TEXT NOT NULL,
      source_ref            TEXT,
      source_hash           TEXT,
      order_id              TEXT,
      fill_id               TEXT,
      execution_status      TEXT NOT NULL DEFAULT 'MANUAL_ENTRY',
      opportunity_id        TEXT,
      plan_id               TEXT,
      notes                 TEXT,
      adjustment_mode       TEXT,
      adjustment_amount     REAL,
      target_lot_id         TEXT,
      from_location_id      INTEGER,
      to_location_id        INTEGER,
      supersedes_record_id  TEXT,
      reverses_record_id    TEXT,
      rejected_reason       TEXT,
      verified_at           TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      is_paper              INTEGER NOT NULL DEFAULT 0 CHECK (is_paper = 0),
      UNIQUE (character_id, ledger_key)
    );

    CREATE TABLE real_esi_transaction_sync (
      character_id        INTEGER PRIMARY KEY,
      last_transaction_id INTEGER,
      last_synced_at      TEXT,
      status              TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
      error               TEXT
    );

    CREATE TABLE real_esi_transaction_sync_leases (
      character_id INTEGER PRIMARY KEY,
      owner_id     TEXT NOT NULL,
      acquired_at  TEXT NOT NULL,
      expires_at   TEXT NOT NULL
    );

    CREATE TABLE real_esi_transaction_failures (
      character_id    INTEGER NOT NULL,
      failure_key     TEXT NOT NULL,
      transaction_id  INTEGER,
      error_code      TEXT NOT NULL,
      error           TEXT NOT NULL,
      first_failed_at TEXT NOT NULL,
      last_failed_at  TEXT NOT NULL,
      retry_count     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (character_id, failure_key)
    );

    CREATE TABLE character_assets (
      character_id      INTEGER NOT NULL,
      item_id           INTEGER NOT NULL,
      type_id           INTEGER NOT NULL,
      location_id       INTEGER NOT NULL,
      location_type     TEXT,
      location_flag     TEXT,
      quantity          INTEGER,
      is_singleton      INTEGER NOT NULL DEFAULT 0,
      is_blueprint_copy INTEGER,
      data_json         TEXT NOT NULL,
      synced_at         TEXT NOT NULL,
      PRIMARY KEY (character_id, item_id)
    );
  `);
  db.prepare(`
    INSERT INTO real_trade_records
      (record_id, character_id, ledger_key, record_state, verification_status,
       trade_kind, direction, type_id, location_id, quantity, unit_price,
       fee_status, trade_time, source_type, source_ref, execution_status, notes)
    VALUES ('p9339-migration-crash-record', ?, 'p9339-migration-crash-key', 'ACTIVE', 'PENDING',
            'BUY', 'BUY', 34, 60003760, 9, 11.5, 'UNKNOWN',
            '2026-09-01T00:00:00.000Z', 'USER_MANUAL_ENTRY',
            'p9339-migration-crash-source', 'MANUAL_ENTRY', 'must survive SIGKILL')
  `).run(CHARACTER_ID);
  db.prepare(`
    INSERT INTO real_esi_transaction_sync
      (character_id, last_transaction_id, last_synced_at, status)
    VALUES (?, 8801, '2026-09-01T00:00:00.000Z', 'ok')
  `).run(CHARACTER_ID);
  db.prepare(`
    INSERT INTO real_esi_transaction_failures
      (character_id, failure_key, transaction_id, error_code, error, first_failed_at, last_failed_at, retry_count)
    VALUES (?, 'transaction:8801', 8801, 'TRANSACTION_DATA_INVALID', 'legacy malformed row',
            '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 2)
  `).run(CHARACTER_ID);
  db.prepare(`
    INSERT INTO character_assets
      (character_id, item_id, type_id, location_id, location_type, location_flag,
       quantity, is_singleton, is_blueprint_copy, data_json, synced_at)
    VALUES (?, 9901, 34, 60003760, 'station', 'Hangar', 9, 0, 0, '{"item_id":9901}', '2026-09-01T00:00:00.000Z')
  `).run(CHARACTER_ID);
}

afterEach(async () => {
  for (const dir of TEMP_DIRS.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('P9.3.3.9 migration interruption and restart recovery', () => {
  it('survives five independent SIGKILL interruptions without losing legacy rows, cursor, or asset mirror', async () => {
    for (let round = 1; round <= 5; round += 1) {
      const dir = await mkdtemp(join(tmpdir(), `eveai-p9339-migration-kill-${round}-`));
      TEMP_DIRS.push(dir);
      const dbPath = join(dir, 'migration.sqlite');
      const seed = new Database(dbPath) as unknown as Db;
      seed.pragma('foreign_keys = ON');
      seed.pragma('journal_mode = WAL');
      runMigrations(seed);
      seedLegacyDatabase(seed);
      seed.close();

      const child = spawnSync(process.execPath, [
        '--import', 'tsx', 'tests/audit/p9-3.3.9/migration-kill-child.ts',
      ], {
        cwd: process.cwd(),
        env: { ...process.env, EVEAI_P9339_MIGRATION_DB: dbPath },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(child.error, `round ${round}: ${child.stderr}`).toBeUndefined();
      expect(child.signal, `round ${round}: ${child.stdout} ${child.stderr}`).toBe('SIGKILL');

      const recovered = new Database(dbPath) as unknown as Db;
      recovered.pragma('foreign_keys = ON');
      recovered.pragma('journal_mode = WAL');
      expect(recovered.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(recovered.prepare(`
        SELECT last_transaction_id, status FROM real_esi_transaction_sync WHERE character_id = ?
      `).get(CHARACTER_ID)).toEqual({ last_transaction_id: 8801, status: 'ok' });
      expect(recovered.prepare(`
        SELECT record_id, quantity, notes FROM real_trade_records WHERE character_id = ?
      `).get(CHARACTER_ID)).toEqual({
        record_id: 'p9339-migration-crash-record', quantity: 9, notes: 'must survive SIGKILL',
      });
      expect(recovered.prepare(`
        SELECT transaction_id, retry_count FROM real_esi_transaction_failures WHERE character_id = ?
      `).get(CHARACTER_ID)).toEqual({ transaction_id: 8801, retry_count: 2 });
      expect(recovered.prepare(`
        SELECT item_id, quantity FROM character_assets WHERE character_id = ?
      `).get(CHARACTER_ID)).toEqual({ item_id: 9901, quantity: 9 });
      expect(recovered.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_p9338'
      `).all()).toEqual([]);

      runMigrations(recovered);
      expect(recovered.prepare(`
        SELECT last_transaction_id FROM real_esi_transaction_sync WHERE character_id = ?
      `).get(CHARACTER_ID)).toEqual({ last_transaction_id: 8801 });
      expect(recovered.prepare(`
        SELECT quantity FROM character_assets WHERE character_id = ? AND item_id = 9901
      `).get(CHARACTER_ID)).toEqual({ quantity: 9 });
      expect(recovered.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      recovered.close();
    }
  }, 60_000);
});