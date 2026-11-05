import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { RealAssetSyncService } from '../../src/assets/asset-sync-service.js';
import type { Db } from '../../src/db/sqlite.js';

const dbPath = process.env.EVEAI_AUDIT_DB!;
const barrierDir = process.env.EVEAI_AUDIT_BARRIER!;
const role = process.env.EVEAI_AUDIT_ROLE ?? 'p1';
const characterId = Number(process.env.EVEAI_AUDIT_CHARACTER_ID);
const userId = Number(process.env.EVEAI_AUDIT_USER_ID);
const chatId = Number(process.env.EVEAI_AUDIT_CHAT_ID);
const quantity = Number(process.env.EVEAI_AUDIT_QUANTITY ?? '1');
const roles = ['p1', 'p2', 'p3', 'p4', 'p5'];
const waiter = new Int32Array(new SharedArrayBuffer(4));

function waitFile(name: string, timeoutMs = 20_000): void {
  const path = join(barrierDir, name);
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`barrier timeout: ${name}`);
    Atomics.wait(waiter, 0, 0, 10);
  }
}

function signal(name: string): void {
  writeFileSync(join(barrierDir, name), '1');
}

const db = new Database(dbPath) as Db;
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 20000');

// Synchronize all five processes after the non-authoritative precheck and
// before the atomic acquisition. The database transaction, not this barrier,
// decides the single winner.
const originalPrepare = db.prepare.bind(db);
db.prepare = ((sql: string) => {
  const statement = originalPrepare(sql);
  const isRunningLookup = sql.includes('FROM real_asset_sync_jobs')
    && sql.includes("status = 'RUNNING'")
    && sql.includes('LIMIT 1');
  if (!isRunningLookup) return statement;
  return new Proxy(statement, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property !== 'get' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const row = value.apply(target, args);
        signal(`${role}.prechecked`);
        for (const other of roles) waitFile(`${other}.prechecked`);
        return row;
      };
    },
  });
}) as typeof db.prepare;

globalThis.fetch = async (input, init) => {
  const url = String(input);
  signal(`${role}.fetch-entered`);
  if (!url.includes(`/characters/${characterId}/assets`)) {
    throw new Error(`unexpected fetch: ${url}`);
  }
  if (init?.method && init.method !== 'GET') {
    throw new Error(`non-GET dispatch: ${init.method}`);
  }
  // Keep the winner in flight until all four acquisition losers have exited.
  for (const other of roles) {
    if (other !== role) waitFile(`${other}.done`);
  }
  return new Response(JSON.stringify([{
    item_id: 98_001,
    type_id: 34,
    location_id: 60_003_760,
    location_type: 'station',
    location_flag: 'Hangar',
    quantity,
    is_singleton: false,
    is_blueprint_copy: false,
  }]), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      'X-Pages': '1',
    },
  });
};

try {
  const result = await RealAssetSyncService.syncCharacter(
    db,
    characterId,
    { userId, chatId, characterId },
    'manual',
  );
  process.stdout.write(JSON.stringify({ ok: true, role, quantity, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    role,
    quantity,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
} finally {
  signal(`${role}.done`);
  db.close();
}