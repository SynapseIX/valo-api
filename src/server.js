import http from 'node:http';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { URL, URLSearchParams } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const DB = process.env.DATA_FILE || './data/store.json';
const RIOT_KEY = process.env.RIOT_API_KEY;
const CLIENT = process.env.RSO_CLIENT_ID;
const SECRET = process.env.RSO_CLIENT_SECRET;
const PAGE = new URL('../public/index.html', import.meta.url);
const PRIVACY = new URL('../public/privacy.html', import.meta.url);
const TERMS = new URL('../public/terms.html', import.meta.url);
const PUBLIC_PAGES = new Map([
  ['/', PAGE],
  ['/index.html', PAGE],
  ['/privacy', PRIVACY],
  ['/privacy.html', PRIVACY],
  ['/terms', TERMS],
  ['/terms.html', TERMS],
]);
const ASSETS = new URL('../public/assets/', import.meta.url);
const PUBLIC_ASSETS = new Set(['index.css', 'index.js', 'privacy.css', 'terms.css', 'connected.css']);
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

let db = { players: {}, keys: {}, states: {} };
let saveQueue = Promise.resolve();

async function save() {
  const snapshot = JSON.stringify(db);
  saveQueue = saveQueue.then(async () => {
    const path = DB.startsWith('/') ? DB : `${process.cwd()}/${DB}`;
    await fs.mkdir(new URL('.', `file://${path}`).pathname, { recursive: true });
    await fs.writeFile(`${DB}.tmp`, snapshot, { mode: 0o600 });
    await fs.rename(`${DB}.tmp`, DB);
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
  const response = await fetch(url, {
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
  if (!REGIONS[shard]) {
    return fail(res, 400, 'invalid_region', 'Use na, br, latam, eu, ap, or kr');
  }

  const state = random();
  db.states[sha(state)] = { shard, expires: Date.now() + 600000 };
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
  if (!entry || entry.expires < Date.now() || !code) {
    return fail(res, 400, 'invalid_callback', 'Expired or invalid OAuth callback');
  }

  delete db.states[sha(state)];
  await save();
  const response = await fetch('https://auth.riotgames.com/token', {
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
    expiresAt: Date.now() + tokens.expires_in * 1000,
    sharing: true,
  };
  revokeKeys(account.puuid);
  const apiKey = `val_${random()}`;
  db.keys[sha(apiKey)] = { puuid: account.puuid, createdAt: new Date().toISOString() };
  await save();

  const result = {
    message: 'Connected. Save this API key now; it will not be shown again.',
    apiKey,
    player: { riotId: `${account.gameName}#${account.tagLine}`, region: entry.shard },
    sharing: true,
  };
  if (req.headers.accept?.includes('text/html')) {
    const page = (await fs.readFile(new URL('../public/connected.html', import.meta.url), 'utf8'))
      // This template is also previewable as a local file. In the nested OAuth
      // callback route, resolve its stylesheet and home link from the site root.
      .replace('href="./assets/connected.css"', 'href="/assets/connected.css"')
      .replace('href="./index.html#docs"', 'href="/index.html#docs"')
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
    if (req.method === 'GET' && path.startsWith('/assets/')) {
      const asset = path.slice('/assets/'.length);
      if (!PUBLIC_ASSETS.has(asset)) return fail(res, 404, 'not_found', 'Unknown asset');
      const body = await fs.readFile(new URL(asset, ASSETS), 'utf8');
      res.writeHead(200, {
        'content-type': asset.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
        'x-content-type-options': 'nosniff',
      });
      return res.end(body);
    }
    if (req.method === 'GET' && PUBLIC_PAGES.has(path)) {
      const file = PUBLIC_PAGES.get(path);
      return html(res, 200, await fs.readFile(file, 'utf8'));
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
    if (req.method === 'GET' && path === '/auth/riot/start') return startLink(url, res);
    if (req.method === 'GET' && path === '/auth/riot/callback') return finishLink(req, url, res);
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
      db.keys[sha(apiKey)] = { puuid: player.puuid, createdAt: new Date().toISOString() };
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
    if (req.method === 'GET' && path === '/v1/rank') return rank(player, origin, res);
    return fail(res, 404, 'not_found', 'Unknown endpoint');
  } catch (error) {
    if (error.status === 429) {
      return fail(res, 429, 'riot_rate_limited', `Riot rate limit; retry after ${error.retry || 'a short delay'}`);
    }
    if (error.status === 401) return fail(res, 401, 'riot_auth_expired', error.message);
    if (error.status === 404) return fail(res, 404, 'riot_not_found', 'Riot resource not found');
    console.error(error);
    return fail(res, 502, 'upstream_error', 'Riot service unavailable or request failed');
  }
}

async function main() {
  try {
    db = JSON.parse(await fs.readFile(DB, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!db.players || !db.keys || !db.states) throw Error('Invalid data store');
  http.createServer(handler).listen(PORT, () => console.log(`Listening on ${PORT}`));
}

main();
