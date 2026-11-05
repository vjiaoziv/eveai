import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import type { Db } from '../../src/db/sqlite.js';
import { clearCapabilitySnapshots } from '../../src/eve/capabilities.js';
import { P93EsiEvidenceService } from '../../src/trading/p9-3-evidence-service.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    auth: { secretKey: 'test-auth-secret' },
    eve: {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      callbackUrl: 'http://localhost:3000/auth/eve/callback',
      requestTimeoutMs: 5000,
    },
    esi: {
      baseUrl: 'https://esi.evetech.net/latest/',
      specUrl: 'https://esi.evetech.net/latest/swagger.json',
      catalogCachePath: './data/cache/esi-swagger.json',
      compatibilityDate: '2026-03-15',
      userAgent: 'EVEAI/4.0 (+https://github.com/example/eveai; contact=operator@example.com)',
      maxPages: 5,
      backoffMaxSeconds: 1,
      requestTimeoutMs: 5000,
      retryMaxAttempts: 1,
    },
    characterSync: { maxPages: 50, fallbackTtlSeconds: 3600, errorRetrySeconds: 120 },
    assetSync: { enabled: false, intervalMinutes: 60 },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720 },
  },
}));

const USER_ID = 9433001;
const CHAT_ID = 9433101;
const CHARACTER_ID = 9433201;
const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1';
const CTX = { userId: USER_ID, chatId: CHAT_ID };
const OPEN_DATABASES: Database.Database[] = [];

function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  OPEN_DATABASES.push(db);
  return db;
}

function linkCharacter(db: Database.Database): void {
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'Cross Connection Lease', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'cross-connection-lease', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Cross Connection Lease', 'lease-token', 'lease-refresh',
            datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_ID, JSON.stringify([WALLET_SCOPE]), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

function walletRow(transactionId: number): Record<string, unknown> {
  return {
    transaction_id: transactionId,
    date: '2026-05-01T00:00:00Z',
    type_id: 34,
    quantity: 1,
    unit_price: 10,
    is_buy: true,
    location_id: 60003760,
  };
}

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3_600_000).toUTCString(),
      'X-Pages': '1',
    },
  });
}

afterEach(() => {
  clearCapabilitySnapshots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (OPEN_DATABASES.length > 0) OPEN_DATABASES.pop()?.close();
});

describe('P9.3.3.2 cross-connection wallet lease', () => {
  it('observes another SQLite connection owner and proceeds only after that lease is released', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eveai-wallet-lease-'));
    const dbPath = join(dir, 'wallet.sqlite');
    const dbA = openDatabase(dbPath);
    let dbB: Database.Database | null = null;
    try {
      runMigrations(dbA);
      linkCharacter(dbA);
      dbB = openDatabase(dbPath);
      dbB.prepare(`
        INSERT INTO real_esi_transaction_sync_leases
          (character_id, owner_user_id, owner_chat_id, binding_epoch, owner_id, acquired_at, expires_at)
        VALUES (?, ?, ?, 1, 'other-process-owner', datetime('now'), datetime('now', '+30 seconds'))
      `).run(CHARACTER_ID, USER_ID, CHAT_ID);
      vi.stubGlobal('fetch', vi.fn(async () => response([walletRow(950)])));

      const sync = P93EsiEvidenceService.syncWalletTransactions(dbA as Db, CHARACTER_ID, CTX);
      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(dbA.prepare('SELECT COUNT(*) AS n FROM real_trade_records WHERE character_id = ?').get(CHARACTER_ID))
        .toEqual({ n: 0 });
      expect(dbA.prepare('SELECT owner_id FROM real_esi_transaction_sync_leases WHERE character_id = ?').get(CHARACTER_ID))
        .toEqual({ owner_id: 'other-process-owner' });

      dbB.prepare('DELETE FROM real_esi_transaction_sync_leases WHERE character_id = ?').run(CHARACTER_ID);
      const result = await sync;

      expect(result).toMatchObject({ ok: true, status: 'ok', lastTransactionId: 950 });
      expect(dbA.prepare('SELECT last_transaction_id, status FROM real_esi_transaction_sync WHERE character_id = ?').get(CHARACTER_ID))
        .toEqual({ last_transaction_id: 950, status: 'ok' });
      expect(dbA.prepare('SELECT COUNT(*) AS n FROM real_esi_transaction_sync_leases WHERE character_id = ?').get(CHARACTER_ID))
        .toEqual({ n: 0 });
    } finally {
      if (dbB) {
        const index = OPEN_DATABASES.indexOf(dbB);
        if (index >= 0) OPEN_DATABASES.splice(index, 1);
        dbB.close();
      }
      const index = OPEN_DATABASES.indexOf(dbA);
      if (index >= 0) OPEN_DATABASES.splice(index, 1);
      dbA.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
