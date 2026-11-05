import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { P93LedgerService } from '../../../src/trading/p9-3-ledger-service.js';
import type { RealLedgerLineage } from '../../../src/trading/p9-3-lineage.js';
import type { Db } from '../../../src/db/sqlite.js';

const dbPath = process.env.EVEAI_P9339_LEDGER_DB!;
const barrierDir = process.env.EVEAI_P9339_LEDGER_BARRIER!;
const role = process.env.EVEAI_P9339_LEDGER_ROLE!;
const characterId = Number(process.env.EVEAI_P9339_LEDGER_CHARACTER_ID);
const recordId = process.env.EVEAI_P9339_LEDGER_RECORD_ID!;
const actor = process.env.EVEAI_P9339_LEDGER_ACTOR!;
const lineage = JSON.parse(process.env.EVEAI_P9339_LEDGER_LINEAGE_JSON!) as RealLedgerLineage;
const waiter = new Int32Array(new SharedArrayBuffer(4));

function waitFor(name: string, timeoutMs = 20_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(join(barrierDir, name))) {
    if (Date.now() > deadline) throw new Error(`barrier timeout: ${name}`);
    Atomics.wait(waiter, 0, 0, 10);
  }
}

writeFileSync(join(barrierDir, `${role}.ready`), '1');
waitFor('go');

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
    `${role}: cross-owner concurrent reversal attempt`,
    lineage,
  );
  process.stdout.write(JSON.stringify({ role, ok: true, recordState: record.recordState }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    role,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
} finally {
  db.close();
}