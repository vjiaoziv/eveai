import Fastify from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerWebApp } from '../../src/web/server.js';

let tempRoot: string | null = null;

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe('web app static serving', () => {
  it('serves nested hashed assets referenced by the app shell', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'eveai-web-app-'));
    await mkdir(join(tempRoot, 'assets'), { recursive: true });
    await writeFile(
      join(tempRoot, 'index.html'),
      '<!doctype html><div id="root"></div><script type="module" src="/web-assets/assets/app-test.js"></script>',
    );
    await writeFile(join(tempRoot, 'assets', 'app-test.js'), 'globalThis.__eveai_asset_loaded = true;');

    const app = Fastify();
    await registerWebApp(app, tempRoot);
    try {
      const asset = await app.inject({
        method: 'GET',
        url: '/web-assets/assets/app-test.js',
      });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toContain('immutable');
      expect(asset.body).toContain('__eveai_asset_loaded');

      const shell = await app.inject({ method: 'GET', url: '/app' });
      expect(shell.statusCode).toBe(200);
      expect(shell.headers['cache-control']).toBe('no-cache');
      expect(shell.body).toContain('/web-assets/assets/app-test.js');

      const indexedShell = await app.inject({ method: 'GET', url: '/web-assets/index.html' });
      expect(indexedShell.statusCode).not.toBe(200);

      const directoryShell = await app.inject({ method: 'GET', url: '/web-assets/' });
      expect(directoryShell.statusCode).not.toBe(200);
    } finally {
      await app.close();
    }
  });

  it('serves a new hashed bundle after the build output changes without restarting', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'eveai-web-app-rebuild-'));
    await mkdir(join(tempRoot, 'assets'), { recursive: true });
    await writeFile(join(tempRoot, 'index.html'), '<script src="/web-assets/assets/old.js"></script>');
    await writeFile(join(tempRoot, 'assets', 'old.js'), 'old');

    const app = Fastify();
    await registerWebApp(app, tempRoot);
    try {
      await writeFile(join(tempRoot, 'index.html'), '<script src="/web-assets/assets/new-hash.js"></script>');
      await writeFile(join(tempRoot, 'assets', 'new-hash.js'), 'new bundle');

      const asset = await app.inject({ method: 'GET', url: '/web-assets/assets/new-hash.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toBe('new bundle');

      const shell = await app.inject({ method: 'GET', url: '/app' });
      expect(shell.statusCode).toBe(200);
      expect(shell.body).toContain('/web-assets/assets/new-hash.js');

      const traversal = await app.inject({ method: 'GET', url: '/web-assets/../index.html' });
      expect(traversal.statusCode).not.toBe(200);
    } finally {
      await app.close();
    }
  });
});