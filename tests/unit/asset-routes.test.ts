import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { registerAssetRoutes } from '../../src/web/asset-routes.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} from '../../src/web/web-session.js';

const ORIGIN = 'http://localhost:3000';
const OWN_CHARACTER = 90000051;
const OTHER_CHARACTER = 90000052;

let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let session: { cookie: string; csrf: string; userId: number; chatId: number };

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();

  const created = createWebSession(db);
  session = {
    cookie: `${WEB_SESSION_COOKIE}=${created.sessionToken}`,
    csrf: created.csrfToken,
    userId: created.userId,
    chatId: created.chatId,
  };

  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, 'Asset Pilot', 'access-token-should-never-leak', 'refresh-token-should-never-leak',
            datetime('now', '+1 hour'), '["esi-assets.read_assets.v1"]', ?)
  `).run(OWN_CHARACTER, session.userId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(session.chatId, OWN_CHARACTER, session.userId);
  db.prepare("UPDATE users SET active_character_id = ? WHERE user_id = ?")
    .run(OWN_CHARACTER, session.userId);

  db.prepare(`
    INSERT INTO sde_types (type_id, name, group_id, data_json)
    VALUES (34, 'Tritanium', NULL, '{"name":{"en":"Tritanium","zh":"三钛合金"}}')
  `).run();
  db.prepare(`
    INSERT INTO character_assets
      (character_id, item_id, type_id, location_id, location_type, location_flag,
       quantity, is_singleton, is_blueprint_copy, data_json, synced_at)
    VALUES (?, 1, 34, 60003760, 'station', 'Hangar', 100, 0, 0, '{}', datetime('now'))
  `).run(OWN_CHARACTER);
  db.prepare(`
    INSERT INTO real_asset_locations
      (location_id, location_type, location_name, solar_system_id, solar_system_name,
       region_id, region_name, parent_location_id, resolution_status, resolution_source, resolved_at)
    VALUES (60003760, 'STATION', 'Jita Trade Hub', 30000142, 'Jita', 10000002, 'The Forge',
            NULL, 'RESOLVED', 'sde_stations', datetime('now'))
  `).run();

  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerAssetRoutes(app, db);
});

afterEach(async () => {
  await app.close();
  db.close();
});

function readHeaders() {
  return { cookie: session.cookie };
}

function mutationHeaders() {
  return {
    origin: ORIGIN,
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
  };
}

describe('asset API security (P9.2)', () => {
  it('requires a browser session for asset reads', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/web/assets/overview' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses another character with IDOR and never leaks OAuth material', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: `/api/web/assets/inventory?characterId=${OTHER_CHARACTER}`,
      headers: readHeaders(),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('access_token');
    expect(denied.body).not.toContain('refresh_token');

    const allowed = await app.inject({
      method: 'GET',
      url: `/api/web/assets/overview`,
      headers: readHeaders(),
    });
    expect(allowed.statusCode).toBe(200);
    const body = allowed.body;
    expect(body).not.toContain('access-token-should-never-leak');
    expect(body).not.toContain('refresh-token-should-never-leak');
    expect(body).toContain('Asset Pilot');
  });

  it('rejects local mutations without origin and CSRF', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/web/assets/valuations',
      headers: { cookie: session.cookie },
      payload: { characterId: OWN_CHARACTER },
    });
    expect(response.statusCode).toBe(403);

    const withCsrfOnly = await app.inject({
      method: 'POST',
      url: '/api/web/assets/valuations',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: { characterId: OWN_CHARACTER },
    });
    expect(withCsrfOnly.statusCode).toBe(403);
  });

  it('permits the caller’s own asset overview with a valid session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/web/assets/overview',
      headers: readHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as any;
    expect(payload.totals.characters).toBe(1);
    expect(payload.characters[0].characterId).toBe(OWN_CHARACTER);
    expect(payload.realTradingExecutionDisabled).toBe(true);
  });
});