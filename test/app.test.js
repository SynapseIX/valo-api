import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import {
  API_KEY, OTHER_KEY, DATABASE, ENV, NOW, hash, linkedDatabase,
  memoryFileSystem, riotFetch, oauthResponses, harness, beginLogin, callbackPath,
} from '../test-support/fakes.js';

function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.body.error.code, code);
  assert.equal(typeof response.body.error.message, 'string');
  assert.equal(response.headers['cache-control'], 'no-store');
}

test('health and legal notices are public without Riot credentials', async () => {
  const app = await harness({ env: { DATA_FILE: DATABASE }, database: null });
  assert.deepEqual((await app.request('/health')).body, { status: 'ok' });
  const legal = await app.request('/legal');
  assert.equal(legal.status, 200);
  assert.equal(legal.body.product, 'Synapse VALO API');
  assert.equal(legal.body.thirdParty, true);
  assert.match(legal.body.disclaimer, /not affiliated with.*Riot Games/);
  assert.equal(app.fetchImpl.mock.callCount(), 0);
});

test('public page aliases return HTML with security headers', async () => {
  const app = await harness();
  for (const [url, title] of [
    ['/', 'index'], ['/index.html', 'index'], ['/privacy', 'privacy'],
    ['/privacy.html', 'privacy'], ['/terms', 'terms'], ['/terms.html', 'terms'],
  ]) {
    const response = await app.request(url);
    assert.equal(response.status, 200, url);
    assert.equal(response.text, `<h1>${title}</h1>`);
    assert.match(response.headers['content-type'], /text\/html/);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('Riot verification is exact plain text and HEAD has no body', async () => {
  const app = await harness();
  const get = await app.request('/riot.txt');
  const head = await app.request('/riot.txt', { method: 'HEAD' });
  assert.equal(get.text, 'public-verification-code');
  assert.equal(get.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(get.headers['content-length'], get.raw.length);
  assert.equal(get.headers['cache-control'], 'no-store');
  assert.equal(head.status, 200);
  assert.deepEqual(head.headers, get.headers);
  assert.equal(head.raw.length, 0);
});

test('allowlisted assets preserve binary bytes, content types, and HEAD metadata', async () => {
  const app = await harness();
  for (const [name, type] of [
    ['index.css', 'text/css; charset=utf-8'], ['index.js', 'text/javascript; charset=utf-8'],
    ['privacy.css', 'text/css; charset=utf-8'], ['terms.css', 'text/css; charset=utf-8'],
    ['connected.css', 'text/css; charset=utf-8'], ['brand.css', 'text/css; charset=utf-8'],
    ['logo.png', 'image/png'], ['logo.webp', 'image/webp'],
    ['favicon.png', 'image/png'], ['apple-touch-icon.png', 'image/png'],
  ]) {
    const get = await app.request(`/assets/${name}`);
    const head = await app.request(`/assets/${name}`, { method: 'HEAD' });
    assert.equal(get.status, 200, name);
    assert.equal(get.headers['content-type'], type);
    assert.equal(get.headers['content-length'], get.raw.length);
    if (type.startsWith('image/')) assert.deepEqual(get.raw, Buffer.from([137, 80, 78, 71, 0, 255, 254, 128]));
    assert.equal(head.status, 200);
    assert.deepEqual(head.headers, get.headers);
    assert.equal(head.raw.length, 0);
  }
});

test('unknown assets and traversal attempts cannot expose private files', async () => {
  const app = await harness();
  for (const url of ['/assets/secrets.json', '/assets/%2e%2e%2fstore.json', '/assets/../store.json', '/.env', '/unknown']) {
    expectError(await app.request(url), 404, 'not_found');
  }
  const reads = app.fileSystem.operations.filter(item => item.operation === 'readFile');
  assert.equal(reads.length, 1, 'Only the initial data-store load is allowed');
});

test('protected endpoints reject missing, malformed, and unknown API keys', async () => {
  const app = await harness();
  for (const authorization of ['', 'Basic abc', 'Bearer wrong', 'bearer val_test-player-key', 'Bearer ']) {
    expectError(await app.request('/v1/me', { headers: { authorization } }), 401, 'invalid_api_key');
  }
  expectError(await app.request('/v1/me'), 401, 'invalid_api_key');
  assert.equal(app.fetchImpl.mock.callCount(), 0);
});

test('profile responses expose only account identity, never OAuth tokens or API keys', async () => {
  const app = await harness();
  const response = await app.request('/v1/me', { key: API_KEY });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { puuid: 'player-one', riotId: 'Synapse#NA1', region: 'na', sharing: true });
  assert.doesNotMatch(response.text, /private-access-token|private-refresh-token|val_test-player-key/);
});

for (const reason of ['disconnected player', 'missing player']) {
  test(`a saved key cannot bypass consent for a ${reason}`, async () => {
    const database = linkedDatabase();
    if (reason === 'missing player') delete database.players['player-one'];
    else database.players['player-one'].sharing = false;
    const app = await harness({ database });
    expectError(await app.request('/v1/me', { key: API_KEY }), 403, 'consent_required');
  });
}

test('key rotation revokes every old key for that player and preserves other players', async () => {
  const database = linkedDatabase();
  database.keys[hash('val_second-old-key')] = { puuid: 'player-one' };
  const app = await harness({ database });
  const response = await app.request('/v1/key/rotate', { method: 'POST', key: API_KEY });
  assert.equal(response.status, 200);
  assert.match(response.body.apiKey, /^val_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(response.body.apiKey, API_KEY);
  for (const key of [API_KEY, 'val_second-old-key']) {
    expectError(await app.request('/v1/me', { key }), 401, 'invalid_api_key');
  }
  assert.equal((await app.request('/v1/me', { key: response.body.apiKey })).status, 200);
  assert.equal((await app.request('/v1/me', { key: OTHER_KEY })).status, 200);
  const saved = app.fileSystem.saved();
  assert.equal(saved.keys[hash(response.body.apiKey)].puuid, 'player-one');
  assert.equal(saved.keys[hash(response.body.apiKey)].createdAt, new Date(NOW).toISOString());
  assert.ok(!JSON.stringify(saved).includes(response.body.apiKey));
  const write = app.fileSystem.operations.find(item => item.operation === 'writeFile');
  assert.equal(write.options.mode, 0o600);
  assert.ok(!app.fileSystem.files.has(`${DATABASE}.tmp`), 'Atomic rename removes the temporary file');
});

test('disconnect deletes account tokens and keys while preserving other accounts', async () => {
  const app = await harness();
  const response = await app.request('/v1/disconnect', { method: 'POST', key: API_KEY });
  assert.deepEqual(response.body, { disconnected: true });
  expectError(await app.request('/v1/me', { key: API_KEY }), 401, 'invalid_api_key');
  assert.equal((await app.request('/v1/me', { key: OTHER_KEY })).status, 200);
  const saved = app.fileSystem.saved();
  assert.equal(saved.players['player-one'], undefined);
  assert.equal(saved.keys[hash(API_KEY)], undefined);
  assert.doesNotMatch(JSON.stringify(saved), /private-access-token|private-refresh-token/);
});

test('applications do not share mutable player state', async () => {
  const first = await harness();
  const second = await harness();
  await first.request('/v1/disconnect', { method: 'POST', key: API_KEY });
  assert.equal((await second.request('/v1/me', { key: API_KEY })).status, 200);
});

test('unsupported methods cannot rotate keys or disconnect accounts', async () => {
  const app = await harness();
  for (const url of ['/v1/key/rotate', '/v1/disconnect']) {
    expectError(await app.request(url, { key: API_KEY }), 404, 'not_found');
  }
  expectError(await app.request('/v1/me', { method: 'POST', key: API_KEY }), 404, 'not_found');
  expectError(await app.request('/v1/unknown', { key: API_KEY }), 404, 'not_found');
  assert.equal((await app.request('/v1/me', { key: API_KEY })).status, 200);
});

test('without the production key, local account operations work but Riot data fails clearly', async () => {
  const app = await harness({ env: { ...ENV, RIOT_API_KEY: '' } });
  assert.equal((await app.request('/v1/me', { key: API_KEY })).status, 200);
  expectError(await app.request('/v1/rank', { key: API_KEY }), 503, 'not_configured');
  assert.equal(app.fetchImpl.mock.callCount(), 0);
});

test('login requires all three Riot credentials', async () => {
  for (const missing of ['RIOT_API_KEY', 'RSO_CLIENT_ID', 'RSO_CLIENT_SECRET']) {
    const app = await harness({ env: { ...ENV, [missing]: '' } });
    expectError(await app.request('/auth/riot/start?region=na'), 503, 'not_configured');
    assert.equal(app.fileSystem.operations.some(item => item.operation === 'writeFile'), false);
  }
});

test('invalid region names, including inherited object keys, are rejected', async () => {
  const app = await harness();
  for (const region of ['', 'unknown', 'NA', 'constructor', 'toString', '__proto__']) {
    expectError(await app.request(`/auth/riot/start?region=${region}`), 400, 'invalid_region');
  }
  assert.deepEqual(app.fileSystem.saved().states, {});
});

test('login generates unique state, stores its hash, and uses the registered redirect URL', async () => {
  const app = await harness();
  const first = await beginLogin(app);
  const second = await beginLogin(app);
  assert.equal(first.origin, 'https://auth.riotgames.com');
  assert.equal(first.pathname, '/authorize');
  assert.equal(first.searchParams.get('client_id'), ENV.RSO_CLIENT_ID);
  assert.equal(first.searchParams.get('redirect_uri'), `${ENV.PUBLIC_BASE_URL}/auth/riot/callback`);
  assert.equal(first.searchParams.get('response_type'), 'code');
  assert.equal(first.searchParams.get('scope'), 'openid offline_access');
  const state = first.searchParams.get('state');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(state, second.searchParams.get('state'));
  assert.deepEqual(app.fileSystem.saved().states[hash(state)], { shard: 'na', expires: NOW + 600000 });
  assert.ok(!JSON.stringify(app.fileSystem.saved()).includes(state));
});

test('default public origin uses the configured local port', async () => {
  const app = await harness({ env: { ...ENV, PUBLIC_BASE_URL: '', PORT: '8123' } });
  const url = await beginLogin(app);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8123/auth/riot/callback');
});

const accountRegions = {
  na: 'americas',
  br: 'americas',
  latam: 'americas',
  eu: 'europe',
  ap: 'asia',
  kr: 'asia',
};

for (const [shard, routingRegion] of Object.entries(accountRegions)) {
  test(`${shard} account linking uses the ${routingRegion} account endpoint`, async () => {
    const fetchImpl = riotFetch(...oauthResponses());
    const app = await harness({ fetchImpl });
    const authorization = await beginLogin(app, shard);
    const state = authorization.searchParams.get('state');
    const response = await app.request(callbackPath(state));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.player, { riotId: 'Synapse#NA1', region: shard });
    const [tokenUrl, tokenOptions] = fetchImpl.mock.calls[0].arguments;
    assert.equal(tokenUrl, 'https://auth.riotgames.com/token');
    assert.equal(tokenOptions.method, 'POST');
    assert.equal(tokenOptions.headers.Authorization, `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`);
    assert.equal(tokenOptions.body.get('grant_type'), 'authorization_code');
    assert.equal(tokenOptions.body.get('code'), 'test-code');
    assert.equal(tokenOptions.body.get('redirect_uri'), `${ENV.PUBLIC_BASE_URL}/auth/riot/callback`);
    const [accountUrl, accountOptions] = fetchImpl.mock.calls[1].arguments;
    assert.equal(accountUrl, `https://${routingRegion}.api.riotgames.com/riot/account/v1/accounts/me`);
    assert.deepEqual(accountOptions.headers, { Authorization: 'Bearer new-access-token' });
    const saved = app.fileSystem.saved();
    assert.equal(saved.players['player-one'].refreshToken, 'new-refresh-token');
    assert.equal(saved.players['player-one'].expiresAt, NOW + 3600000);
    assert.equal(saved.states[hash(state)], undefined);
    assert.ok(saved.keys[hash(response.body.apiKey)]);
    assert.equal(saved.keys[hash(API_KEY)], undefined, 'Reconnecting must revoke the old key');
    assert.equal((await app.request('/v1/me', { key: OTHER_KEY })).status, 200);
    expectError(await app.request(callbackPath(state)), 400, 'invalid_callback');
    assert.equal(fetchImpl.mock.callCount(), 2, 'Replayed callbacks never reach Riot');
    assert.doesNotMatch(response.text, /new-access-token|new-refresh-token|test-secret/);
  });
}

test('missing state, missing code, and unknown state cannot reach Riot', async () => {
  const app = await harness();
  const authorization = await beginLogin(app);
  const state = authorization.searchParams.get('state');
  for (const url of ['/auth/riot/callback?code=x', callbackPath('unknown'), `/auth/riot/callback?state=${state}`]) {
    expectError(await app.request(url), 400, 'invalid_callback');
  }
  assert.equal(app.fetchImpl.mock.callCount(), 0);
});

for (const elapsed of [600000, 600001]) {
  test(`OAuth state is expired after ${elapsed} milliseconds`, async () => {
    const app = await harness();
    const authorization = await beginLogin(app);
    app.setTime(NOW + elapsed);
    expectError(await app.request(callbackPath(authorization.searchParams.get('state'))), 400, 'invalid_callback');
    assert.equal(app.fetchImpl.mock.callCount(), 0);
  });
}

test('a failed token exchange consumes state and returns an OAuth-specific error', async () => {
  const app = await harness({ fetchImpl: riotFetch(Response.json({}, { status: 400 })) });
  const authorization = await beginLogin(app);
  const url = callbackPath(authorization.searchParams.get('state'));
  expectError(await app.request(url), 502, 'riot_oauth_failed');
  expectError(await app.request(url), 400, 'invalid_callback');
});

test('a Riot account without a PUUID cannot replace the linked account', async () => {
  const app = await harness({ fetchImpl: riotFetch(...oauthResponses({ gameName: 'Invalid' })) });
  const authorization = await beginLogin(app);
  expectError(await app.request(callbackPath(authorization.searchParams.get('state'))), 502, 'riot_account_failed');
  assert.equal((await app.request('/v1/me', { key: API_KEY })).status, 200);
});

test('browser callback escapes account names and resolves all assets from the site root', async () => {
  const account = { puuid: 'player-one', gameName: '<script>"&\'</script>', tagLine: 'NA1' };
  const app = await harness({ fetchImpl: riotFetch(...oauthResponses(account)) });
  const authorization = await beginLogin(app);
  const response = await app.request(callbackPath(authorization.searchParams.get('state')), { headers: { accept: 'text/html' } });
  assert.equal(response.status, 200);
  assert.match(response.text, /&lt;script&gt;&quot;&amp;&#39;&lt;\/script&gt;#NA1/);
  assert.doesNotMatch(response.text, /<script>|\{\{|(?:href|src)="\.\//);
  assert.match(response.text, /src="\/assets\/logo.webp"/);
  assert.match(response.text, /href="\/assets\/favicon.png"/);
  assert.match(response.text, /href="\/index.html#docs"/);
  assert.match(response.text, /val_[A-Za-z0-9_-]{43}/);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('OAuth network failures become JSON errors instead of rejected handler promises', async () => {
  const app = await harness({ fetchImpl: riotFetch(new Error('Simulated network failure')) });
  const authorization = await beginLogin(app);
  expectError(await app.request(callbackPath(authorization.searchParams.get('state'))), 502, 'upstream_error');
  assert.equal(app.logger.error.mock.callCount(), 1);
});

test('login persistence failures become JSON errors and a later save can recover', async () => {
  const app = await harness();
  app.fileSystem.failNext('writeFile', new Error('Simulated disk failure'));
  expectError(await app.request('/auth/riot/start?region=na'), 502, 'upstream_error');
  assert.equal((await app.request('/auth/riot/start?region=na')).status, 200);
});

test('rank selects the active act and returns only the linked player’s official row', async () => {
  const fetchImpl = riotFetch(
    Response.json({
      acts: [
        { id: 'episode', type: 'episode', isActive: true },
        { id: 'old', type: 'act', isActive: false },
        { id: 'current/act', name: 'Current Act', type: 'act', isActive: true },
      ],
    }),
    Response.json({
      players: [
        { puuid: 'player-two', rankedRating: 999 },
        { puuid: 'player-one', competitiveTier: 24, leaderboardRank: 150, rankedRating: 87 },
      ],
    }),
  );
  const app = await harness({ fetchImpl });
  const response = await app.request('/v1/rank', { key: API_KEY });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.act, { id: 'current/act', name: 'Current Act' });
  assert.deepEqual(response.body.rank, { tier: 24, leaderboardRank: 150 });
  assert.equal(response.body.rr, 87);
  assert.equal(response.body.availability, 'leaderboard_only');
  assert.equal(response.body.source, 'riot_official');
  assert.equal(
    fetchImpl.mock.calls[1].arguments[0],
    'https://na.api.riotgames.com/val/ranked/v1/leaderboards/by-act/current%2Fact?size=200&startIndex=0',
  );
  assert.deepEqual(fetchImpl.mock.calls[0].arguments[1].headers, { 'X-Riot-Token': 'test-riot-key' });
});

for (const rankedRating of [0, undefined]) {
  test(`rank preserves ${rankedRating === 0 ? 'zero RR' : 'missing RR as null'}`, async () => {
    const app = await harness({ fetchImpl: riotFetch(
      Response.json({ acts: [{ id: 'act', type: 'act', isActive: true }] }),
      Response.json({ players: [{ puuid: 'player-one', competitiveTier: 24, leaderboardRank: 1, rankedRating }] }),
    ) });
    const response = await app.request('/v1/rank', { key: API_KEY });
    assert.equal(response.body.rr, rankedRating ?? null);
  });
}

for (const leaderboard of [{}, { players: [{ puuid: 'player-two', rankedRating: 500 }] }]) {
  test(`rank stays unavailable when ${leaderboard.players ? 'only another player is listed' : 'no players are returned'}`, async () => {
    const app = await harness({ fetchImpl: riotFetch(
      Response.json({ acts: [{ id: 'act', type: 'act', isActive: true }] }),
      Response.json(leaderboard),
    ) });
    const response = await app.request('/v1/rank', { key: API_KEY });
    assert.equal(response.body.rank, null);
    assert.equal(response.body.rr, null);
    assert.equal(response.body.availability, 'unavailable_outside_leaderboard');
  });
}

test('without an active act, rank returns null values without a leaderboard request', async () => {
  for (const content of [{}, { acts: [{ id: 'past', type: 'act', isActive: false }] }]) {
    const app = await harness({ fetchImpl: riotFetch(Response.json(content)) });
    const response = await app.request('/v1/rank', { key: API_KEY });
    assert.deepEqual(response.body, {
      riotId: 'Synapse#NA1',
      rank: null,
      rr: null,
      availability: 'no_active_act',
      source: 'riot_official',
    });
    assert.equal(app.fetchImpl.mock.callCount(), 1);
  }
});

for (const [status, code] of [[401, 'riot_auth_expired'], [404, 'riot_not_found'], [429, 'riot_rate_limited'], [500, 'upstream_error']]) {
  test(`rank handles Riot ${status} errors within the request handler`, async () => {
    const app = await harness({ fetchImpl: riotFetch(Response.json({}, { status, headers: { 'retry-after': '15' } })) });
    const response = await app.request('/v1/rank', { key: API_KEY });
    expectError(response, status === 500 ? 502 : status, code);
    if (status === 429) assert.match(response.body.error.message, /15/);
  });
}

test('leaderboard rate limits without Retry-After use a fallback message', async () => {
  const app = await harness({ fetchImpl: riotFetch(
    Response.json({ acts: [{ id: 'act', type: 'act', isActive: true }] }),
    Response.json({}, { status: 429 }),
  ) });
  const response = await app.request('/v1/rank', { key: API_KEY });
  expectError(response, 429, 'riot_rate_limited');
  assert.match(response.body.error.message, /short delay/);
});

test('Riot timeouts and malformed JSON return generic upstream errors', async () => {
  for (const result of [new Error('Timeout fixture'), new Response('invalid JSON')]) {
    const app = await harness({ fetchImpl: riotFetch(result) });
    const response = await app.request('/v1/rank', { key: API_KEY });
    expectError(response, 502, 'upstream_error');
    assert.doesNotMatch(response.text, /test-riot-key|test-secret/);
  }
});

test('match history uses the linked shard and PUUID, with an empty-history fallback', async () => {
  const history = [{ matchId: 'match-1', queueId: 'competitive' }];
  const app = await harness({ fetchImpl: riotFetch(Response.json({ history }), Response.json({})) });
  const first = await app.request('/v1/matches', { key: OTHER_KEY });
  assert.deepEqual(first.body, { player: 'player-two', history, source: 'riot_official' });
  assert.equal(app.fetchImpl.mock.calls[0].arguments[0], 'https://eu.api.riotgames.com/val/match/v1/matchlists/by-puuid/player-two');
  assert.deepEqual((await app.request('/v1/matches', { key: OTHER_KEY })).body.history, []);
});

test('match detail returns the complete match only when the linked player participated', async () => {
  const match = { matchInfo: { matchId: 'match-123' }, players: [{ puuid: 'player-one', kills: 12 }] };
  const app = await harness({ fetchImpl: riotFetch(Response.json(match)) });
  const response = await app.request('/v1/matches/match-123', { key: API_KEY });
  assert.deepEqual(response.body, { match, source: 'riot_official' });
  assert.equal(app.fetchImpl.mock.calls[0].arguments[0], 'https://na.api.riotgames.com/val/match/v1/matches/match-123');
});

test('foreign matches and matches without participants are forbidden', async () => {
  for (const match of [{}, { players: [{ puuid: 'player-two' }] }]) {
    const app = await harness({ fetchImpl: riotFetch(Response.json(match)) });
    expectError(await app.request('/v1/matches/match-123', { key: API_KEY }), 403, 'not_your_match');
  }
});

test('invalid match identifiers are rejected before contacting Riot', async () => {
  const app = await harness();
  for (const id of ['', 'a'.repeat(101), 'bad!', 'bad%2Fid']) {
    expectError(await app.request(`/v1/matches/${id}`, { key: API_KEY }), 400, 'invalid_match_id');
  }
  assert.equal(app.fetchImpl.mock.callCount(), 0);
});

test('a missing data file initializes an empty store', async () => {
  const app = await harness({ database: null });
  expectError(await app.request('/v1/me', { key: API_KEY }), 401, 'invalid_api_key');
  assert.equal((await app.request('/health')).status, 200);
});

test('unreadable or corrupted data files are rejected without being overwritten', async () => {
  const fileSystem = memoryFileSystem();
  fileSystem.failNext('readFile', Object.assign(new Error('Access denied'), { code: 'EACCES' }));
  await assert.rejects(harness({ fileSystem }), /Access denied/);
  fileSystem.files.set(DATABASE, Buffer.from('{broken'));
  await assert.rejects(harness({ fileSystem }), SyntaxError);
  assert.equal(fileSystem.operations.some(item => item.operation === 'writeFile'), false);
});

for (const invalid of [null, {}, { players: [], keys: {}, states: {} }, { players: {}, keys: {}, states: null }]) {
  test(`invalid store structure is rejected: ${JSON.stringify(invalid)}`, async () => {
    const fileSystem = memoryFileSystem();
    fileSystem.files.set(DATABASE, Buffer.from(JSON.stringify(invalid)));
    await assert.rejects(harness({ fileSystem }), /Invalid data store/);
  });
}

test('relative data paths with spaces and # characters are resolved without URL encoding', async () => {
  const databasePath = './test data#1/store.json';
  const app = await harness({ env: { ...ENV, DATA_FILE: databasePath } });
  assert.equal((await app.request('/v1/key/rotate', { method: 'POST', key: API_KEY })).status, 200);
  const mkdir = app.fileSystem.operations.find(item => item.operation === 'mkdir');
  assert.equal(mkdir.path, dirname(resolve(databasePath)));
});

test('read failures in public assets are handled without exposing internal paths', async () => {
  const app = await harness();
  app.fileSystem.failNext('readFile', new Error('/private/path is unreadable'));
  const response = await app.request('/assets/logo.png');
  expectError(response, 502, 'upstream_error');
  assert.doesNotMatch(response.text, /private\/path/);
});
