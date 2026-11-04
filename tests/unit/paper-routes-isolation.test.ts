import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { registerTradingRoutes } from '../../src/web/trading-routes.js';
import { PaperTradingSystem } from '../../src/trading/paper-trading.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} from '../../src/web/web-session.js';

const OWN = 920001;
const OTHER = 920002;
const UNINITIALIZED = 920003;

let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let ownCookie: string;
let ownCsrf: string;
let uninitializedCookie: string;

function linkCharacter(session: ReturnType<typeof createWebSession>, characterId: number, name: string): void {
  db.prepare(`
    INSERT INTO eve_accounts
      (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, ?, 'access', 'refresh', datetime('now', '+1 hour'), '[]', ?)
  `).run(characterId, name, session.userId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(session.chatId, characterId, session.userId);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(characterId, session.userId);
}

function seedOpportunityAndOrder(characterId: number, opportunityId: string, orderId: string, typeId: number): void {
  db.prepare(`
    INSERT INTO trade_opportunities_log
      (opportunity_id, strategy_type, type_id, region_id, expected_buy_price,
       expected_sell_price, proposed_quantity, expected_fees, expected_net_profit,
       expected_roi, risk_rating, outcome_status)
    VALUES (?, 'station_arbitrage', ?, 10000002, 10, 12, 10, 1, 9, 1, 'A', 'pending')
  `).run(opportunityId, typeId);
  db.prepare(`
    INSERT INTO paper_trading_orders
      (order_id, account_id, opportunity_id, character_id, type_id, strategy_type,
       order_type, price, quantity, filled_quantity, status, fees_paid)
    VALUES (?, ?, ?, ?, ?, 'station_arbitrage', 'buy', 10, 10, 0, 'open', 1)
  `).run(orderId, `PT-ACC-${characterId}`, opportunityId, characterId, typeId);
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();

  const own = createWebSession(db, 'test-own');
  const uninitialized = createWebSession(db, 'test-uninitialized');
  ownCookie = `${WEB_SESSION_COOKIE}=${own.sessionToken}`;
  ownCsrf = own.csrfToken;
  uninitializedCookie = `${WEB_SESSION_COOKIE}=${uninitialized.sessionToken}`;
  linkCharacter(own, OWN, 'Own Pilot');
  linkCharacter(uninitialized, UNINITIALIZED, 'Uninitialized Pilot');

  PaperTradingSystem.getOrCreateAccount(db, OWN);
  PaperTradingSystem.getOrCreateAccount(db, OTHER);
  seedOpportunityAndOrder(OWN, 'OPP-OWN-ROUTE', 'ORDER-OWN-ROUTE', 34);
  seedOpportunityAndOrder(OTHER, 'OPP-OTHER-ROUTE', 'ORDER-OTHER-ROUTE', 35);
  db.prepare(`
    INSERT INTO trade_drafts
      (draft_id, character_id, type_id, strategy, buy_station_id, sell_station_id,
       suggested_buy, suggested_qty, suggested_sell, estimated_fees, hauling_cost,
       expected_profit, expected_roi, capital_required, status, expires_at)
    VALUES ('DRAFT-OTHER-ROUTE', ?, 35, 'station_arbitrage', 60003760, 60011866,
            10, 10, 12, 1, 0, 9, 1, 100, 'draft', datetime('now', '+1 day'))
  `).run(OTHER);
  db.prepare(`
    INSERT INTO paper_fills
      (fill_id, order_id, opportunity_id, filled_at, price, quantity, fees, remaining_quantity, basis, model_version)
    VALUES ('FILL-OWN-ROUTE', 'ORDER-OWN-ROUTE', 'OPP-OWN-ROUTE', '2026-01-02 01:00:00', 10, 1, 1, 9, 'test', 'test')
  `).run();
  db.prepare(`
    INSERT INTO paper_fills
      (fill_id, order_id, opportunity_id, filled_at, price, quantity, fees, remaining_quantity, basis, model_version)
    VALUES ('FILL-OTHER-ROUTE', 'ORDER-OTHER-ROUTE', 'OPP-OTHER-ROUTE', '2026-01-02 01:00:00', 10, 1, 1, 9, 'test', 'test')
  `).run();

  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerTradingRoutes(app, db);
});

afterEach(async () => {
  await app.close();
  db.close();
});

describe('Paper routes role isolation', () => {
  it('requires authentication for opportunity reads', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/web/trading/paper/opportunities' });
    expect(response.statusCode).toBe(401);
  });

  it('returns only the caller-linked opportunities and fills', async () => {
    const opportunities = await app.inject({
      method: 'GET',
      url: '/api/web/trading/paper/opportunities',
      headers: { cookie: ownCookie },
    });
    expect(opportunities.statusCode).toBe(200);
    const opportunityBody = opportunities.json() as { opportunities: Array<{ opportunity_id: string }> };
    expect(opportunityBody.opportunities.map((row) => row.opportunity_id)).toEqual(['OPP-OWN-ROUTE']);

    const fills = await app.inject({
      method: 'GET',
      url: '/api/web/trading/paper/fills',
      headers: { cookie: ownCookie },
    });
    expect(fills.statusCode).toBe(200);
    const fillBody = fills.json() as { fills: Array<{ fill_id: string }> };
    expect(fillBody.fills.map((row) => row.fill_id)).toEqual(['FILL-OWN-ROUTE']);
  });

  it('does not reveal another character order fills', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/web/trading/paper/fills?orderId=ORDER-OTHER-ROUTE',
      headers: { cookie: ownCookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('FILL-OTHER-ROUTE');
  });

  it('does not allow a caller to approve another character draft', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/web/trading/drafts/DRAFT-OTHER-ROUTE/approve',
      headers: {
        origin: 'http://localhost:3000',
        cookie: ownCookie,
        'x-csrf-token': ownCsrf,
      },
    });
    expect(response.statusCode).toBe(404);
    const draft = db.prepare('SELECT status FROM trade_drafts WHERE draft_id = ?')
      .get('DRAFT-OTHER-ROUTE') as { status: string };
    expect(draft.status).toBe('draft');
  });

  it('bounds malformed pagination instead of passing NaN to SQLite', async () => {
    for (const url of [
      '/api/web/trading/paper/orders?limit=not-a-number',
      '/api/web/trading/paper/opportunities?limit=-10',
      '/api/web/trading/paper/fills?limit=1e999',
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie: ownCookie } });
      expect(response.statusCode, url).toBe(200);
    }
  });

  it('validates public scanner identifiers before passing them to SQL', async () => {
    const reprocess = await app.inject({
      method: 'GET',
      url: '/api/web/trading/reprocess/not-a-number',
      headers: { cookie: ownCookie },
    });
    expect(reprocess.statusCode).toBe(400);

    const station = await app.inject({
      method: 'GET',
      url: '/api/web/trading/scan/station?stationId=not-a-number',
      headers: { cookie: ownCookie },
    });
    expect(station.statusCode).toBe(200);
  });

  it('returns a safe uninitialized state without creating a paper account on read', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM paper_trading_accounts WHERE character_id = ?')
      .get(UNINITIALIZED) as { n: number };
    expect(before.n).toBe(0);

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/trading/paper/overview',
      headers: { cookie: uninitializedCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ initialized: false, performance: null, runtime: null });
    const after = db.prepare('SELECT COUNT(*) AS n FROM paper_trading_accounts WHERE character_id = ?')
      .get(UNINITIALIZED) as { n: number };
    expect(after.n).toBe(0);
  });
});
