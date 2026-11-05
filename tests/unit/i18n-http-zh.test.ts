import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { createServer } from '../../src/web/server.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} from '../../src/web/web-session.js';

/**
 * V7/V8 runtime paths through the real HTTP router (app.inject): the market
 * detail honors ?lang=zh with a session (defect D1), and the SSO consent page
 * renders Chinese for language=zh while en keeps English and unknown values
 * keep the historical ru fallback (defect D4 / plan R1-Q1).
 */

let db: Database.Database;
let app: Awaited<ReturnType<typeof createServer>>;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  app = await createServer(db);
});

afterEach(async () => {
  await app.close();
  db.close();
});

const RIFTER = 587;

function insertType(typeId: number, name: string, groupId: number | null, data: Record<string, unknown>): void {
  db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)')
    .run(typeId, name, groupId, JSON.stringify(data));
}

/** Minimal SDE card proven to satisfy getMarketTypeInfo (mirrors market-type-info.test). */
function seedMarketCard(): void {
  db.prepare("INSERT INTO sde_categories (category_id, name, data_json) VALUES (6, 'Ship', '{}')").run();
  db.prepare("INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (25, 'Frigate', 6, '{}')").run();
  db.prepare("INSERT INTO sde_market_groups (market_group_id, name, parent_group_id, data_json) VALUES (61, 'Standard Frigates', NULL, '{}')").run();
  db.prepare("INSERT INTO sde_meta_groups (meta_group_id, name, data_json) VALUES (1, 'Tech I', '{}')").run();
  db.prepare("INSERT INTO sde_dogma_units (unit_id, name, data_json) VALUES (101, 'hp', ?)")
    .run(JSON.stringify({ displayName: { en: 'HP', ru: 'ед.' } }));
  db.prepare("INSERT INTO sde_dogma_units (unit_id, name, data_json) VALUES (102, 'skillLevel', '{}')").run();
  insertType(RIFTER, 'Rifter', 25, {
    published: 1,
    marketGroupID: 61,
    metaGroupID: 1,
    mass: 1_067_000,
    volume: 27_289,
    capacity: 140,
    basePrice: 250_000,
    description: { en: 'The Rifter is a versatile frigate.', ru: 'Рифтер — универсальный фрегат.' },
  });
  db.prepare('UPDATE sde_types SET data_json = ? WHERE type_id = ?')
    .run(JSON.stringify({ name: { en: 'Rifter', zh: '裂谷级' } }), RIFTER);
  db.prepare('UPDATE sde_groups SET data_json = ? WHERE group_id = 25')
    .run(JSON.stringify({ name: { en: 'Frigate', zh: '护卫舰' } }));
}

function cookieFor(session: ReturnType<typeof createWebSession>): string {
  return `${WEB_SESSION_COOKIE}=${session.sessionToken}`;
}

describe('zh runtime paths through the HTTP router (V7/V8)', () => {
  it('serves the market detail in Chinese for ?lang=zh (V7)', async () => {
    seedMarketCard();
    const session = createWebSession(db);
    const cookie = cookieFor(session);

    const zh = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${RIFTER}/info?lang=zh`,
      headers: { cookie },
    });
    expect(zh.statusCode).toBe(200);
    const zhPayload = zh.json() as { ok: boolean; info: { name: string; group_name: string } };
    expect(zhPayload.ok).toBe(true);
    expect(zhPayload.info.name).toBe('裂谷级');
    expect(zhPayload.info.group_name).toBe('护卫舰');

    // en/ru behavior is unchanged by the zh branch.
    const en = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${RIFTER}/info?lang=en`,
      headers: { cookie },
    });
    expect((en.json() as { info: { name: string } }).info.name).toBe('Rifter');

    // Unsupported langs are rejected with a machine code, not prose.
    const bad = await app.inject({
      method: 'GET',
      url: `/api/web/market/types/${RIFTER}/info?lang=fr`,
      headers: { cookie },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'invalid_lang_param' });
  });

  it('renders the SSO consent page per requested language (V8)', async () => {
    const session = createWebSession(db);

    // redirect_url is NULL, so the session-binding guard passes without a
    // cookie and the unconsented request renders the disclosure page.
    const insert = db.prepare(`
      INSERT INTO auth_requests (state, type, user_id, chat_id, created_at, expires_at)
      VALUES (?, 'eve_sso', ?, ?, datetime('now'), datetime('now', '+10 minutes'))
    `);
    insert.run('zh-state', session.userId, session.chatId);
    insert.run('en-state', session.userId, session.chatId);
    insert.run('de-state', session.userId, session.chatId);

    const zh = await app.inject({ method: 'GET', url: '/auth/eve/login?state=zh-state&language=zh' });
    expect(zh.statusCode).toBe(200);
    expect(zh.headers['content-type']).toContain('text/html');
    expect(zh.body).toContain('<html lang="zh">');
    expect(zh.body).toContain('由你决定副官能看到什么。');
    expect(zh.body).toContain('继续前往 EVE SSO →');
    expect(zh.body).not.toContain('You decide what the agent can see.');

    const en = await app.inject({ method: 'GET', url: '/auth/eve/login?state=en-state&language=en' });
    expect(en.statusCode).toBe(200);
    expect(en.body).toContain('<html lang="en">');
    expect(en.body).toContain('You decide what the agent can see.');

    // Unknown language keeps the historical ru default (plan R1/Q1).
    const de = await app.inject({ method: 'GET', url: '/auth/eve/login?state=de-state&language=de' });
    expect(de.statusCode).toBe(200);
    expect(de.body).toContain('<html lang="ru">');
    expect(de.body).not.toContain('<html lang="zh">');
  });
});