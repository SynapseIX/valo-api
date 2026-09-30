import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { URL, URLSearchParams } from 'node:url';

const PAGE = new URL('../public/index.html', import.meta.url);
const PRIVACY = new URL('../public/privacy.html', import.meta.url);
const TERMS = new URL('../public/terms.html', import.meta.url);
const RIOT_VERIFICATION_FILE = new URL('../public/riot.txt', import.meta.url);
const PUBLIC_PAGES = new Map([
  ['/', PAGE],
  ['/index.html', PAGE],
  ['/privacy', PRIVACY],
  ['/privacy.html', PRIVACY],
  ['/terms', TERMS],
  ['/terms.html', TERMS],
]);
const ASSETS = new URL('../public/assets/', import.meta.url);
const PUBLIC_ASSETS = new Map([
  ['index.css', 'text/css; charset=utf-8'],
  ['index.js', 'text/javascript; charset=utf-8'],
  ['privacy.css', 'text/css; charset=utf-8'],
  ['terms.css', 'text/css; charset=utf-8'],
  ['connected.css', 'text/css; charset=utf-8'],
  ['brand.css', 'text/css; charset=utf-8'],
  ['logo.png', 'image/png'],
  ['logo.webp', 'image/webp'],
  ['favicon.png', 'image/png'],
  ['apple-touch-icon.png', 'image/png'],
]);
const REGIONS = {
  na: 'americas',
  br: 'americas',
  latam: 'americas',
  eu: 'europe',
  ap: 'asia',
  kr: 'asia',
};

const safe = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})[character]);

/**
 * Build an isolated request handler without opening a port.
 * Production uses Node's filesystem, clock, and fetch; tests supply fakes.
 */
export async function createApp({
  env = process.env,
  fetchImpl = globalThis.fetch,
  fsImpl = fs,
  now = Date.now,
  logger = console,
} = {}) {
  const PORT = Number(env.PORT || 3000);
  const BASE = env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
  const DB = resolve(env.DATA_FILE || './data/store.json');
  const RIOT_KEY = env.RIOT_API_KEY;
  const CLIENT = env.RSO_CLIENT_ID;
  const SECRET = env.RSO_CLIENT_SECRET;

  let db = { players: {}, keys: {}, states: {} };
  let saveQueue = Promise.resolve();

  async function save() {
    const snapshot = JSON.stringify(db);
    // Report this write's failure to its caller, but allow later writes to retry.
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await fsImpl.mkdir(dirname(DB), { recursive: true });
      await fsImpl.writeFile(`${DB}.tmp`, snapshot, { mode: 0o600 });
      await fsImpl.rename(`${DB}.tmp`, DB);
    });
    return saveQueue;
  }

  function json(res, status, data, headers = {}) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(data));
  }

  function html(res, status, body) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }

  function fail(res, status, code, message) {
    json(res, status, { error: { code, message } });
  }

  function token(req) {
    const authorization = req.headers.authorization || '';
    return authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
  }

  async function riot(url, accessToken) {
    const response = await fetchImpl(url, {
      headers: accessToken
        ? { Authorization: `Bearer ${accessToken}` }
        : { 'X-Riot-Token': RIOT_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const error = new Error(`Riot returned ${response.status}`);
      error.status = response.status;
      error.retry = response.headers.get('retry-after');
      throw error;
    }
    return response.json();
  }

  function auth(req, res) {
    const apiKey = token(req);
    const record = apiKey && db.keys[sha(apiKey)];
    if (!record) {
      fail(res, 401, 'invalid_api_key', 'Provide a valid API key as a Bearer token');
      return null;
    }
    const player = db.players[record.puuid];
    if (!player || !player.sharing) {
      fail(res, 403, 'consent_required', 'Player has disconnected or disabled sharing');
      return null;
    }
    return player;
  }

  function revokeKeys(puuid) {
    for (const [hash, record] of Object.entries(db.keys)) {
      if (record.puuid === puuid) delete db.keys[hash];
    }
  }

  async function startLink(url, res) {
    if (!CLIENT || !SECRET || !RIOT_KEY) {
      return fail(res, 503, 'not_configured', 'Set Riot production credentials first');
    }
    const shard = url.searchParams.get('region');
    if (!Object.hasOwn(REGIONS, shard)) {
      return fail(res, 400, 'invalid_region', 'Use na, br, latam, eu, ap, or kr');
    }

    const state = random();
    db.states[sha(state)] = { shard, expires: now() + 600000 };
    await save();
    const authorizationUrl = new URL('https://auth.riotgames.com/authorize');
    authorizationUrl.search = new URLSearchParams({
      client_id: CLIENT,
      redirect_uri: `${BASE}/auth/riot/callback`,
      response_type: 'code',
      scope: 'openid offline_access',
      state,
    }).toString();
    json(res, 200, {
      authorizationUrl: authorizationUrl.toString(),
      notice: 'Linking opts you in to sharing account and gameplay data with holders of your API key. You can revoke access at any time.',
    });
  }

  async function finishLink(req, url, res) {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const entry = state && db.states[sha(state)];
    if (!entry || entry.expires <= now() || !code) {
      return fail(res, 400, 'invalid_callback', 'Expired or invalid OAuth callback');
    }

    delete db.states[sha(state)];
    await save();
    const response = await fetchImpl('https://auth.riotgames.com/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${BASE}/auth/riot/callback`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      return fail(res, 502, 'riot_oauth_failed', `Riot token exchange returned ${response.status}`);
    }

    const tokens = await response.json();
    const account = await riot(
      `https://${REGIONS[entry.shard]}.api.riotgames.com/riot/account/v1/accounts/me`,
      tokens.access_token,
    );
    if (!account.puuid) {
      return fail(res, 502, 'riot_account_failed', 'Riot did not return a PUUID');
    }

    db.players[account.puuid] = {
      ...db.players[account.puuid],
      puuid: account.puuid,
      gameName: account.gameName,
      tagLine: account.tagLine,
      shard: entry.shard,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: now() + tokens.expires_in * 1000,
      sharing: true,
    };
    revokeKeys(account.puuid);
    const apiKey = `val_${random()}`;
    db.keys[sha(apiKey)] = { puuid: account.puuid, createdAt: new Date(now()).toISOString() };
    await save();

    const result = {
      message: 'Connected. Save this API key now; it will not be shown again.',
      apiKey,
      player: { riotId: `${account.gameName}#${account.tagLine}`, region: entry.shard },
      sharing: true,
    };
    if (req.headers.accept?.includes('text/html')) {
      const page = (await fsImpl.readFile(new URL('../public/connected.html', import.meta.url), 'utf8'))
        // This template is also previewable as a local file. In the nested OAuth
        // callback route, resolve all assets and home links from the site root.
        .replaceAll('href="./', 'href="/')
        .replaceAll('src="./', 'src="/')
        .replaceAll('{{RIOT_ID}}', escapeHtml(result.player.riotId))
        .replaceAll('{{REGION}}', escapeHtml(entry.shard))
        .replaceAll('{{API_KEY}}', escapeHtml(apiKey));
      return html(res, 200, page);
    }
    json(res, 200, result);
  }

  async function rank(player, origin, res) {
    const content = await riot(`${origin}/val/content/v1/contents`);
    const act = (content.acts || []).find(item => item.isActive && item.type === 'act');
    const riotId = `${player.gameName}#${player.tagLine}`;
    if (!act) {
      return json(res, 200, {
        riotId, rank: null, rr: null, availability: 'no_active_act', source: 'riot_official',
      });
    }

    const leaderboard = await riot(
      `${origin}/val/ranked/v1/leaderboards/by-act/${encodeURIComponent(act.id)}?size=200&startIndex=0`,
    );
    const row = (leaderboard.players || []).find(item => item.puuid === player.puuid);
    json(res, 200, {
      riotId,
      act: { id: act.id, name: act.name },
      rank: row ? { tier: row.competitiveTier, leaderboardRank: row.leaderboardRank } : null,
      rr: row?.rankedRating ?? null,
      availability: row ? 'leaderboard_only' : 'unavailable_outside_leaderboard',
      source: 'riot_official',
      note: row
        ? 'RR is the official leaderboard rankedRating; limited to returned leaderboard entries.'
        : 'The official API does not expose current rank or RR for players outside the returned leaderboard.',
    });
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url, BASE);
      const path = url.pathname;
      // Riot checks this public URL before granting production API credentials.
      if ((req.method === 'GET' || req.method === 'HEAD') && path === '/riot.txt') {
        const verification = await fsImpl.readFile(RIOT_VERIFICATION_FILE);
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': verification.byteLength,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        return res.end(req.method === 'HEAD' ? undefined : verification);
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/assets/')) {
        const asset = path.slice('/assets/'.length);
        if (!PUBLIC_ASSETS.has(asset)) return fail(res, 404, 'not_found', 'Unknown asset');
        const body = await fsImpl.readFile(new URL(asset, ASSETS));
        res.writeHead(200, {
          'content-type': PUBLIC_ASSETS.get(asset),
          'content-length': body.byteLength,
          'x-content-type-options': 'nosniff',
        });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      if (req.method === 'GET' && PUBLIC_PAGES.has(path)) {
        const file = PUBLIC_PAGES.get(path);
        return html(res, 200, await fsImpl.readFile(file, 'utf8'));
      }
      if (req.method === 'GET' && path === '/health') {
        return json(res, 200, { status: 'ok' });
      }
      if (req.method === 'GET' && path === '/legal') {
        return json(res, 200, {
          product: 'Synapse VALO API',
          thirdParty: true,
          disclaimer: 'Synapse VALO API is an independent third-party tool. It is not affiliated with, authorized by, sponsored by, or endorsed by Riot Games, Inc. or VALORANT. Riot Games, VALORANT, and related marks belong to their respective owners.',
        });
      }
      // Await these routes so asynchronous failures reach the error mapping below.
      if (req.method === 'GET' && path === '/auth/riot/start') return await startLink(url, res);
      if (req.method === 'GET' && path === '/auth/riot/callback') return await finishLink(req, url, res);
      if (!path.startsWith('/v1/')) return fail(res, 404, 'not_found', 'Unknown endpoint');

      const player = auth(req, res);
      if (!player) return;
      if (req.method === 'GET' && path === '/v1/me') {
        return json(res, 200, {
          puuid: player.puuid,
          riotId: `${player.gameName}#${player.tagLine}`,
          region: player.shard,
          sharing: player.sharing,
        });
      }
      if (req.method === 'POST' && path === '/v1/key/rotate') {
        revokeKeys(player.puuid);
        const apiKey = `val_${random()}`;
        db.keys[sha(apiKey)] = { puuid: player.puuid, createdAt: new Date(now()).toISOString() };
        await save();
        return json(res, 200, { apiKey, message: 'Previous keys revoked. Save this key now.' });
      }
      if (req.method === 'POST' && path === '/v1/disconnect') {
        delete db.players[player.puuid];
        revokeKeys(player.puuid);
        await save();
        return json(res, 200, { disconnected: true });
      }
      if (!RIOT_KEY) return fail(res, 503, 'not_configured', 'RIOT_API_KEY is required');

      const origin = `https://${player.shard}.api.riotgames.com`;
      if (req.method === 'GET' && path === '/v1/matches') {
        const response = await riot(
          `${origin}/val/match/v1/matchlists/by-puuid/${encodeURIComponent(player.puuid)}`,
        );
        return json(res, 200, {
          player: player.puuid,
          history: response.history || [],
          source: 'riot_official',
        });
      }
      if (req.method === 'GET' && path.startsWith('/v1/matches/')) {
        const matchId = path.slice('/v1/matches/'.length);
        if (!safe(matchId)) return fail(res, 400, 'invalid_match_id', 'Invalid match ID');
        const match = await riot(`${origin}/val/match/v1/matches/${encodeURIComponent(matchId)}`);
        if (!match.players?.some(item => item.puuid === player.puuid)) {
          return fail(res, 403, 'not_your_match', 'This match does not belong to the linked account');
        }
        return json(res, 200, { match, source: 'riot_official' });
      }
      if (req.method === 'GET' && path === '/v1/rank') return await rank(player, origin, res);
      return fail(res, 404, 'not_found', 'Unknown endpoint');
    } catch (error) {
      if (error.status === 429) {
        return fail(res, 429, 'riot_rate_limited', `Riot rate limit; retry after ${error.retry || 'a short delay'}`);
      }
      if (error.status === 401) return fail(res, 401, 'riot_auth_expired', error.message);
      if (error.status === 404) return fail(res, 404, 'riot_not_found', 'Riot resource not found');
      logger.error(error);
      return fail(res, 502, 'upstream_error', 'Riot service unavailable or request failed');
    }
  }

  try {
    db = JSON.parse(await fsImpl.readFile(DB, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(db) || !['players', 'keys', 'states'].every(name => isRecord(db[name]))) {
    throw Error('Invalid data store');
  }
  return handler;
}
