import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { P93EsiEvidenceService } from '../../../src/trading/p9-3-evidence-service.js';
import type { Db } from '../../../src/db/sqlite.js';

const dbPath = process.env.EVEAI_P9339_WALLET_DB!;
const barrierDir = process.env.EVEAI_P9339_WALLET_BARRIER!;
const role = process.env.EVEAI_P9339_WALLET_ROLE!;
const characterId = Number(process.env.EVEAI_P9339_WALLET_CHARACTER_ID);
const userId = Number(process.env.EVEAI_P9339_WALLET_USER_ID);
const chatId = Number(process.env.EVEAI_P9339_WALLET_CHAT_ID);
const waiter = new Int32Array(new SharedArrayBuffer(4));

function waitFor(name: string, timeoutMs = 20_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(join(barrierDir, name))) {
    if (Date.now() > deadline) throw new Error(`barrier timeout: ${name}`);
    Atomics.wait(waiter, 0, 0, 10);
  }
}

globalThis.fetch = async (_input, init) => {
  if (init?.method && init.method !== 'GET') throw new Error(`non-GET dispatch: ${init.method}`);
  return new Response(JSON.stringify([
    {
      transaction_id: 100,
      date: '2026-09-05T00:00:00Z',
      type_id: 34,
      quantity: 1,
      unit_price: 10,
      is_buy: true,
      location_id: 60003760,
    },
    {
      transaction_id: 101,
      date: '2026-09-05T00:01:00Z',
      type_id: 34,
      quantity: 1,
      unit_price: 11,
      is_buy: true,
      location_id: 60003760,
    },
  ]), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      'X-Pages': '1',
    },
  });
};

writeFileSync(join(barrierDir, `${role}.ready`), '1');
waitFor(process.env.EVEAI_P9339_WALLET_IMMEDIATE === '1' ? 'immediate-go' : 'go');

const db = new Database(dbPath) as unknown as Db;
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 20000');

try {
  const result = await P93EsiEvidenceService.syncWalletTransactions(
    db,
    characterId,
    { userId, chatId, characterId },
  );
  process.stdout.write(JSON.stringify({ role, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    role,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
} finally {
  db.close();
}