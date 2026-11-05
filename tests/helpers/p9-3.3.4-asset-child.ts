import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { RealAssetSyncService } from '../../src/assets/asset-sync-service.js';
import type { Db } from '../../src/db/sqlite.js';

const dbPath = process.env.EVEAI_ASSET_DB!;
const barrierDir = process.env.EVEAI_ASSET_BARRIER!;
const role = process.env.EVEAI_ASSET_ROLE ?? 'solo';
const mode = process.env.EVEAI_ASSET_MODE ?? 'normal';
const characterId = Number(process.env.EVEAI_ASSET_CHARACTER_ID);
const userId = Number(process.env.EVEAI_ASSET_USER_ID);
const chatId = Number(process.env.EVEAI_ASSET_CHAT_ID);
const quantity = Number(process.env.EVEAI_ASSET_QUANTITY ?? '1');
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

if (mode === 'race') {
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
          signal(`${role}.checked`);
          waitFile('a.checked');
          waitFile('b.checked');
          // B is the deterministic winner. A waits until B has committed its
          // lease, then its atomic acquisition must lose before reaching ESI.
          if (role === 'a') waitFile('b.acquired');
          return row;
        };
      },
    });
  }) as typeof db.prepare;
}

if (
  mode === 'crash-during-commit'
  || mode === 'crash-after-mirror-delete'
  || mode === 'commit-hold'
) {
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    if (!sql.includes('DELETE FROM character_assets')) return statement;
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property !== 'run' || typeof value !== 'function') {
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (...args: unknown[]) => {
          if (mode === 'crash-during-commit' || mode === 'commit-hold') {
            signal('commit-blocked');
            if (mode === 'crash-during-commit') {
              while (true) Atomics.wait(waiter, 0, 0, 1_000);
            } else {
              waitFile('release-commit');
            }
          }
          const result = value.apply(target, args);
          if (mode === 'crash-after-mirror-delete') {
            signal('mirror-deleted');
            // The parent performs the SIGKILL only after observing this marker.
            // The process remains inside the open SQLite transaction here.
            while (true) Atomics.wait(waiter, 0, 0, 1_000);
          }
          return result;
        };
      },
    });
  }) as typeof db.prepare;
}

if (mode === 'unlink') {
  try {
    waitFile('unlink-requested');
    signal('unlink-attempting');
    db.prepare('DELETE FROM eve_character_links WHERE chat_id = ? AND character_id = ?')
      .run(chatId, characterId);
    signal('unlink-done');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  } finally {
    db.close();
  }
  process.exit(process.exitCode ?? 0);
}

globalThis.fetch = async (input, init) => {
  const url = String(input);
  signal('fetch-entered');
  if (mode === 'race' && role === 'b') {
    // Reaching fetch proves B owns the committed per-character lease. Keep B
    // in flight until A has attempted its own acquisition and exited; this
    // makes A the deterministic loser without holding a SQLite write lock.
    signal('b.acquired');
    waitFile('a.done');
  }
  if (mode === 'crash-after-job') {
    await new Promise<never>(() => {});
  }
  if (mode === 'hold-fetch') waitFile('release-fetch');
  if (!url.includes(`/characters/${characterId}/assets`)) {
    throw new Error(`unexpected fetch: ${url}`);
  }
  if (init?.method && init.method !== 'GET') {
    throw new Error(`asset sync attempted non-GET: ${init.method}`);
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
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
} finally {
  signal(`${role}.done`);
  db.close();
}
