import Database from 'better-sqlite3';
import { P93LedgerService } from '../../src/trading/p9-3-ledger-service.js';
import type { RealLedgerLineage } from '../../src/trading/p9-3-lineage.js';
import type { Db } from '../../src/db/sqlite.js';

const dbPath = process.env.EVEAI_LEDGER_DB!;
const characterId = Number(process.env.EVEAI_LEDGER_CHARACTER_ID);
const recordId = process.env.EVEAI_LEDGER_RECORD_ID!;
const actor = process.env.EVEAI_LEDGER_ACTOR!;
const lineage = JSON.parse(process.env.EVEAI_LEDGER_LINEAGE_JSON!) as RealLedgerLineage;

const db = new Database(dbPath) as unknown as Db;
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 20000');

try {
  const record = P93LedgerService.reverse(
    db,
    characterId,
    recordId,
    actor,
    'child-process cross-owner reversal attempt',
    lineage,
  );
  process.stdout.write(JSON.stringify({ ok: true, recordState: record.recordState }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
} finally {
  db.close();
}
