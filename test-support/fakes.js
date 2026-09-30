import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';
import { createApp } from '../src/app.js';

export const API_KEY = 'val_test-player-key';
export const OTHER_KEY = 'val_other-player-key';
export const DATABASE = resolve('test-data/store.json');
export const NOW = Date.parse('2026-09-30T12:00:00Z');
export const ENV = {
  PORT: '3000',
  PUBLIC_BASE_URL: 'https://valo-api.example.test',
  DATA_FILE: DATABASE,
  RIOT_API_KEY: 'test-riot-key',
  RSO_CLIENT_ID: 'test-client',
  RSO_CLIENT_SECRET: 'test-secret',
};

export function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function linkedDatabase() {
  return {
    players: {
      'player-one': {
        puuid: 'player-one',
        gameName: 'Synapse',
        tagLine: 'NA1',
        shard: 'na',
        accessToken: 'private-access-token',
        refreshToken: 'private-refresh-token',
        expiresAt: NOW + 3600000,
        sharing: true,
      },
      'player-two': {
        puuid: 'player-two',
        gameName: 'Other',
        tagLine: 'EU1',
        shard: 'eu',
        sharing: true,
      },
    },
    keys: {
      [hash(API_KEY)]: { puuid: 'player-one', createdAt: new Date(NOW).toISOString() },
      [hash(OTHER_KEY)]: { puuid: 'player-two', createdAt: new Date(NOW).toISOString() },
    },
    states: {},
  };
}

export function memoryFileSystem(database = linkedDatabase(), databasePath = DATABASE) {
  const files = new Map();
  const failures = new Map();
  const operations = [];
  const normalize = value => value instanceof URL ? fileURLToPath(value) : resolve(value);
  const publicPath = fileURLToPath(new URL('../public/', import.meta.url));
  if (database !== null) {
    files.set(normalize(databasePath), Buffer.from(JSON.stringify(database)));
  }
  for (const name of ['index', 'privacy', 'terms']) {
    files.set(resolve(publicPath, `${name}.html`), Buffer.from(`<h1>${name}</h1>`));
  }
  files.set(resolve(publicPath, 'riot.txt'), Buffer.from('public-verification-code'));
  files.set(resolve(publicPath, 'connected.html'), Buffer.from([
    '<link href="./assets/brand.css"><link href="./assets/favicon.png">',
    '<a href="./index.html">Home</a><img src="./assets/logo.webp">',
    '<p>{{RIOT_ID}} · {{REGION}}</p><code>{{API_KEY}}</code>',
    '<a href="./index.html#docs">Docs</a>',
  ].join('')));
  for (const name of ['index.css', 'index.js', 'privacy.css', 'terms.css', 'connected.css', 'brand.css']) {
    files.set(resolve(publicPath, 'assets', name), Buffer.from(`/* ${name} */`));
  }
  // Invalid UTF-8 bytes expose accidental text decoding by the asset handler.
  for (const name of ['logo.png', 'logo.webp', 'favicon.png', 'apple-touch-icon.png']) {
    files.set(resolve(publicPath, 'assets', name), Buffer.from([137, 80, 78, 71, 0, 255, 254, 128]));
  }
  function record(operation, target, options) {
    operations.push({ operation, path: normalize(target), options });
    if (failures.has(operation)) {
      const error = failures.get(operation);
      failures.delete(operation);
      throw error;
    }
  }
  const fsImpl = {
    async readFile(target, encoding) {
      record('readFile', target);
      const key = normalize(target);
      if (!files.has(key)) {
        throw Object.assign(new Error(`Missing fixture: ${key}`), { code: 'ENOENT' });
      }
      const data = files.get(key);
      return encoding ? data.toString(encoding) : Buffer.from(data);
    },
    async mkdir(target, options) {
      record('mkdir', target, options);
    },
    async writeFile(target, data, options) {
      record('writeFile', target, options);
      files.set(normalize(target), Buffer.from(data));
    },
    async rename(from, to) {
      record('rename', from);
      const data = files.get(normalize(from));
      assert.ok(data, 'The temporary data file must exist before rename');
      files.set(normalize(to), data);
      files.delete(normalize(from));
    },
  };
  return {
    fsImpl,
    files,
    operations,
    failNext(operation, error) { failures.set(operation, error); },
    saved() { return JSON.parse(files.get(normalize(databasePath)).toString()); },
  };
}

export function riotFetch(...responses) {
  return mock.fn(async (url, options) => {
    assert.match(String(url), /^https:\/\/(auth\.riotgames\.com|[a-z]+\.api\.riotgames\.com)\//);
    assert.ok(options.signal instanceof AbortSignal, 'Riot requests need a timeout signal');
    assert.ok(responses.length, `Unexpected Riot request: ${url}`);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
}

export function oauthResponses(account = { puuid: 'player-one', gameName: 'Synapse', tagLine: 'NA1' }) {
  return [
    Response.json({ access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600 }),
    Response.json(account),
  ];
}

export async function call(handler, url, { method = 'GET', key, headers = {} } = {}) {
  const requestHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  if (key) requestHeaders.authorization = `Bearer ${key}`;
  let status;
  let responseHeaders;
  let raw;
  let ended = false;
  await handler({ url, method, headers: requestHeaders }, {
    writeHead(code, values) { status = code; responseHeaders = values; },
    end(body) {
      assert.equal(ended, false, 'A request must not send two responses');
      ended = true;
      raw = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
    },
  });
  assert.equal(ended, true, `No response for ${method} ${url}`);
  const text = raw.toString();
  return {
    status, headers: responseHeaders, raw, text,
    body: responseHeaders['content-type']?.startsWith('application/json') ? JSON.parse(text) : undefined,
  };
}

export async function harness({
  env = ENV,
  database = linkedDatabase(),
  fetchImpl = riotFetch(),
  fileSystem = memoryFileSystem(database, env.DATA_FILE || './data/store.json'),
} = {}) {
  let clock = NOW;
  const logger = { error: mock.fn() };
  const handler = await createApp({ env, fetchImpl, fsImpl: fileSystem.fsImpl, now: () => clock, logger });
  return {
    handler, fileSystem, fetchImpl, logger,
    request: (url, options) => call(handler, url, options),
    setTime(value) { clock = value; },
  };
}

export async function beginLogin(app, region = 'na') {
  const response = await app.request(`/auth/riot/start?region=${encodeURIComponent(region)}`);
  assert.equal(response.status, 200);
  return new URL(response.body.authorizationUrl);
}

export function callbackPath(state) {
  return `/auth/riot/callback?state=${encodeURIComponent(state)}&code=test-code`;
}
