import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { callEsiOperation, fetchEsiWithRetry } from '../../src/eve/esi-client.js';
import { fetchWithTimeout } from '../../src/eve/http.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('P8.5.6 strict ESI GET-only gateway', () => {
  it('blocks UI POST operations before authentication or network dispatch', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    let fetchCalled = false;
    vi.stubGlobal('fetch', async () => {
      fetchCalled = true;
      return new Response(null, { status: 204 });
    });

    const result = await callEsiOperation(db, 'post_ui_autopilot_waypoint', {
      destination_id: 30000142,
      clear_other_waypoints: false,
    }, null);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(405);
      expect(result.error).toContain('Blocked non-GET ESI operation');
    }
    expect(fetchCalled).toBe(false);
    db.close();
  });

  it('rejects non-GET and off-origin requests in the final ESI fetch helper', async () => {
    let fetchCalled = false;
    vi.stubGlobal('fetch', async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    });

    await expect(fetchEsiWithRetry(
      new URL('https://esi.evetech.net/latest/ui/autopilot/waypoint/'),
      'POST',
      new Headers(),
      '{}',
      {},
    )).rejects.toThrow('Blocked non-GET ESI request');

    await expect(fetchEsiWithRetry(
      new URL('https://example.com/not-esi'),
      'GET',
      new Headers(),
      null,
      {},
    )).rejects.toThrow('outside the configured ESI origin');

    expect(fetchCalled).toBe(false);
  });

  it('blocks direct ESI POST calls made through fetchWithTimeout', async () => {
    let fetchCalled = false;
    vi.stubGlobal('fetch', async () => {
      fetchCalled = true;
      return new Response(null, { status: 204 });
    });

    await expect(fetchWithTimeout(
      'https://esi.evetech.net/latest/ui/autopilot/waypoint/',
      { method: 'POST', body: '{}' },
      1000,
    )).rejects.toThrow('Blocked non-GET ESI request');
    expect(fetchCalled).toBe(false);
  });

  it('allows an explicitly registered GET through the same final gateway', async () => {
    let fetchCalled = false;
    vi.stubGlobal('fetch', async () => {
      fetchCalled = true;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await fetchEsiWithRetry(
      new URL('https://esi.evetech.net/latest/markets/prices/'),
      'GET',
      new Headers(),
      null,
      {},
    );
    expect(result.ok).toBe(true);
    expect(fetchCalled).toBe(true);
  });
});
