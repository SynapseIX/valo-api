import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { API_KEY, ENV, linkedDatabase, call } from '../test-support/fakes.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('HTTP smoke: real entry point serves pages, images, and verification without Riot credentials', { timeout: 15000 }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'synapse-http-'));
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: '0',
      PUBLIC_BASE_URL: 'http://localhost',
      DATA_FILE: path.join(temporary, 'store.json'),
      RIOT_API_KEY: '',
      RSO_CLIENT_ID: '',
      RSO_CLIENT_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    server.stderr.on('data', chunk => { errors += chunk; });
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`Server exited before listening (${code}): ${errors}`)));
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Listening on (\d+)/);
      if (match) resolve(Number(match[1]));
    });
  });
  assert.ok(port > 0, 'The server must bind an ephemeral port');
  const origin = `http://127.0.0.1:${port}`;
  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal((await fetch(`${origin}/v1/me`)).status, 401);
  assert.equal((await fetch(`${origin}/auth/riot/start?region=na`)).status, 503);

  for (const route of ['/', '/index.html', '/privacy', '/privacy.html', '/terms', '/terms.html']) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200, route);
    const html = await response.text();
    assert.match(html, /class="brand__logo"/);
    for (const [, reference] of html.matchAll(/(?:href|src)="(\.\/[^"#]+)"/g)) {
      const resource = await fetch(new URL(reference, origin + route));
      assert.equal(resource.status, 200, `Broken reference on ${route}: ${reference}`);
      await resource.arrayBuffer();
    }
  }
  for (const name of ['logo.png', 'logo.webp', 'favicon.png', 'apple-touch-icon.png']) {
    const response = await fetch(`${origin}/assets/${name}`);
    const expected = await fs.readFile(path.join(root, 'public', 'assets', name));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, name);
    const head = await fetch(`${origin}/assets/${name}`, { method: 'HEAD' });
    assert.equal(Number(head.headers.get('content-length')), expected.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
  const verification = await fetch(`${origin}/riot.txt`);
  assert.deepEqual(Buffer.from(await verification.arrayBuffer()), await fs.readFile(path.join(root, 'public', 'riot.txt')));
  const head = await fetch(`${origin}/riot.txt`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(`${origin}/assets/missing.png`)).status, 404);
});

test('persistence smoke: rotated keys survive a restart using a temporary data file', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'synapse store#'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const dataFile = path.join(temporary, 'store.json');
  await fs.writeFile(dataFile, JSON.stringify(linkedDatabase()), { mode: 0o600 });
  const options = {
    env: { ...ENV, DATA_FILE: dataFile },
    fetchImpl: async () => { assert.fail('Persistence checks must never contact Riot'); },
  };
  const first = await createApp(options);
  const rotation = await call(first, '/v1/key/rotate', { method: 'POST', key: API_KEY });
  assert.equal(rotation.status, 200);
  const restarted = await createApp(options);
  assert.equal((await call(restarted, '/v1/me', { key: API_KEY })).status, 401);
  assert.equal((await call(restarted, '/v1/me', { key: rotation.body.apiKey })).status, 200);
  assert.ok(!(await fs.readFile(dataFile, 'utf8')).includes(rotation.body.apiKey));
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(dataFile)).mode & 0o777, 0o600);
  }
  await assert.rejects(fs.access(`${dataFile}.tmp`), { code: 'ENOENT' });
});
