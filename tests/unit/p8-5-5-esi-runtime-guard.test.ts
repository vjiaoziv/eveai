import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { callEsiOperation } from '../../src/eve/esi-client.js';

describe('P8.5.5 ESI runtime boundary smoke', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects an unknown ESI operation before any network dispatch', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    let fetchCalled = false;
    vi.stubGlobal('fetch', async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    });

    const result = await callEsiOperation(db, 'post_markets_character_id_orders', { character_id: 5001 }, null);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(fetchCalled).toBe(false);
    db.close();
  });
});
