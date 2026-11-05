import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import type { Db } from '../../../src/db/sqlite.js';

const CHARACTER_ID = 9_946_201;

let db: Db;

function primaryKeyColumns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>)
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
}

function tableExists(table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function triggerExists(trigger: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(trigger));
}

function replaceWithLegacySchemas(): void {
  db.exec(`
    DROP TABLE real_trade_records;
    DROP TABLE real_esi_transaction_sync;
    DROP TABLE real_esi_transaction_sync_leases;
    DROP TABLE real_esi_transaction_failures;

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
      character_id   INTEGER NOT NULL,
      failure_key    TEXT NOT NULL,
      transaction_id INTEGER,
      error_code     TEXT NOT NULL,
      error          TEXT NOT NULL,
      first_failed_at TEXT NOT NULL,
      last_failed_at  TEXT NOT NULL,
      retry_count     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (character_id, failure_key)
    );
  `);

  db.prepare(`
    INSERT INTO real_trade_records
      (record_id, character_id, ledger_key, record_state, verification_status,
       trade_kind, direction, type_id, location_id, quantity, unit_price,
       fee_status, trade_time, source_type, source_ref, execution_status, notes)
    VALUES ('p9339-legacy-real', ?, 'p9339-legacy-key', 'ACTIVE', 'PENDING',
            'BUY', 'BUY', 34, 60003760, 8, 12.5, 'UNKNOWN',
            '2026-09-01T00:00:00.000Z', 'USER_MANUAL_ENTRY',
            'p9339-legacy-source', 'MANUAL_ENTRY', 'preserve p9339 legacy row')
  `).run(CHARACTER_ID);
  db.prepare(`
    INSERT INTO real_esi_transaction_sync
      (character_id, last_transaction_id, last_synced_at, status)
    VALUES (?, 7_701, '2026-09-01T00:00:00.000Z', 'ok')
  `).run(CHARACTER_ID);
  db.prepare(`
    INSERT INTO real_esi_transaction_sync_leases
      (character_id, owner_id, acquired_at, expires_at)
    VALUES (?, 'p9339-legacy-lease', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:30.000Z')
  `).run(CHARACTER_ID);
  db.prepare(`
    INSERT INTO real_esi_transaction_failures
      (character_id, failure_key, transaction_id, error_code, error,
       first_failed_at, last_failed_at, retry_count)
    VALUES (?, 'transaction:7701', 7_701, 'TRANSACTION_DATA_INVALID',
            'legacy malformed row', '2026-09-01T00:00:00.000Z',
            '2026-09-01T00:00:00.000Z', 3)
  `).run(CHARACTER_ID);
}

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('P9.3.3.9 independent migration and trigger integrity', () => {
  it('preserves legacy rows and cursors while installing owner-aware uniqueness and immutable facts', () => {
    replaceWithLegacySchemas();
    runMigrations(db);

    expect(db.prepare(`
      SELECT owner_user_id, owner_chat_id, binding_epoch, notes
      FROM real_trade_records WHERE record_id = 'p9339-legacy-real'
    `).get()).toEqual({
      owner_user_id: null,
      owner_chat_id: null,
      binding_epoch: 0,
      notes: 'preserve p9339 legacy row',
    });
    expect(db.prepare(`
      SELECT owner_user_id, owner_chat_id, binding_epoch, last_transaction_id
      FROM real_esi_transaction_sync WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({
      owner_user_id: null,
      owner_chat_id: null,
      binding_epoch: 0,
      last_transaction_id: 7_701,
    });
    expect(db.prepare(`
      SELECT owner_user_id, owner_chat_id, binding_epoch, failure_key
      FROM real_esi_transaction_failures WHERE character_id = ?
    `).get(CHARACTER_ID)).toEqual({
      owner_user_id: null,
      owner_chat_id: null,
      binding_epoch: 0,
      failure_key: 'transaction:7701',
    });
    expect(primaryKeyColumns('real_esi_transaction_sync')).toEqual([
      'character_id', 'owner_user_id', 'owner_chat_id', 'binding_epoch',
    ]);
    expect(primaryKeyColumns('real_esi_transaction_failures')).toEqual([
      'character_id', 'owner_user_id', 'owner_chat_id', 'binding_epoch', 'failure_key',
    ]);
    expect(triggerExists('real_trade_records_no_delete')).toBe(true);
    expect(triggerExists('real_trade_records_immutable_facts')).toBe(true);
    expect(() => db.prepare("DELETE FROM real_trade_records WHERE record_id = 'p9339-legacy-real'").run())
      .toThrow(/不得直接删除/);
    expect(() => db.prepare("UPDATE real_trade_records SET quantity = quantity + 1 WHERE record_id = 'p9339-legacy-real'").run())
      .toThrow(/不可原地覆盖/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    const before = {
      record: db.prepare('SELECT * FROM real_trade_records ORDER BY record_id').all(),
      cursor: db.prepare('SELECT * FROM real_esi_transaction_sync ORDER BY character_id').all(),
      failure: db.prepare('SELECT * FROM real_esi_transaction_failures ORDER BY character_id, failure_key').all(),
    };
    runMigrations(db);
    expect({
      record: db.prepare('SELECT * FROM real_trade_records ORDER BY record_id').all(),
      cursor: db.prepare('SELECT * FROM real_esi_transaction_sync ORDER BY character_id').all(),
      failure: db.prepare('SELECT * FROM real_esi_transaction_failures ORDER BY character_id, failure_key').all(),
    }).toEqual(before);
  });

  it('rolls back the cursor and asset reconstruction after an injected post-rebuild failure', () => {
    replaceWithLegacySchemas();
    db.exec(`
      DROP TABLE character_assets;
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
      INSERT INTO character_assets
        (character_id, item_id, type_id, location_id, location_type, location_flag,
         quantity, is_singleton, is_blueprint_copy, data_json, synced_at)
      VALUES (${CHARACTER_ID}, 9001, 34, 60003760, 'station', 'Hangar',
              7, 0, 0, '{"item_id":9001}', '2026-09-01T00:00:00.000Z');
    `);

    const originalExec = db.exec.bind(db);
    let injected = false;
    (db as any).exec = (sql: string) => {
      const result = originalExec(sql);
      if (!injected && sql.includes('CREATE TABLE character_assets_p9338')) {
        injected = true;
        throw new Error('p9339 injected post-rebuild failure');
      }
      return result;
    };

    expect(() => runMigrations(db)).toThrow(/p9339 injected post-rebuild failure/);
    expect(injected).toBe(true);
    (db as any).exec = originalExec;

    expect(tableExists('real_esi_transaction_sync_p9338')).toBe(false);
    expect(tableExists('character_assets_p9338')).toBe(false);
    expect(primaryKeyColumns('real_esi_transaction_sync')).toEqual(['character_id']);
    expect(primaryKeyColumns('character_assets')).toEqual(['character_id', 'item_id']);
    expect(db.prepare('SELECT last_transaction_id FROM real_esi_transaction_sync WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ last_transaction_id: 7_701 });
    expect(db.prepare('SELECT item_id, quantity FROM character_assets WHERE character_id = ?')
      .get(CHARACTER_ID)).toEqual({ item_id: 9001, quantity: 7 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_p9338'").all())
      .toEqual([]);
  });
});