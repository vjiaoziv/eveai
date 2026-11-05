import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations.js';
import type { Db } from '../../../src/db/sqlite.js';

const dbPath = process.env.EVEAI_P9339_MIGRATION_DB;
if (!dbPath) throw new Error('EVEAI_P9339_MIGRATION_DB is required');

const db = new Database(dbPath) as unknown as Db;
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const originalExec = db.exec.bind(db);
(db as any).exec = (sql: string) => {
  if (sql.includes('CREATE TABLE character_assets_p9338')) {
    process.kill(process.pid, 'SIGKILL');
  }
  return originalExec(sql);
};

runMigrations(db);
process.stdout.write('MIGRATION_COMPLETED_WITHOUT_INTERRUPTION');
db.close();