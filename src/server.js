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
const regions = {
    na: 'americas',
    br: 'americas',
    latam: 'americas',
    eu: 'europe',
    ap: 'asia',
    kr: 'asia'
};

const safe = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(x);
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');

let db = {
    players: {},
    keys: {},
    states: {}
};

let saveQueue = Promise.resolve();
async function save() {
    const snapshot = JSON.stringify(db);
    saveQueue = saveQueue.then(async () => {
        await fs.mkdir(new URL('.', `file://${DB.startsWith('/')?DB:process.cwd()+'/'+DB}`).pathname, {
            recursive: true
        });
        await fs.writeFile(DB + '.tmp', snapshot, {
            mode: 0o600
        });
        await fs.rename(DB + '.tmp', DB)
    });
    return saveQueue;
}

function json(res, status, data, headers = {}) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...headers
    });
    res.end(JSON.stringify(data));
}

function fail(res, status, code, detail) {
    json(res, status, {
        error: {
            code,
            message: detail
        }
    })
}

function token(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7) : null
}

async function riot(url, access) {
    const r = await fetch(url, {
        headers: access ? {
            Authorization: `Bearer ${access}`
        } : {
            'X-Riot-Token': RIOT_KEY
        },
        signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) {
        const e = new Error(`Riot returned ${r.status}`);
        e.status = r.status;
        e.retry = r.headers.get('retry-after');
        throw e
    }
    return r.json()
}

async function refresh(player) {
    if (player.expiresAt > Date.now() + 60000) return player.accessToken;
    const b = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: player.refreshToken
    });
    const r = await fetch('https://auth.riotgames.com/token', {
        method: 'POST',
        headers: {
            Authorization: 'Basic ' + Buffer.from(CLIENT + ':' + SECRET).toString('base64'),
            'content-type': 'application/x-www-form-urlencoded'
        },
        body: b,
        signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw Object.assign(new Error('Riot authorization expired; reconnect account'), {
        status: 401
    });
    const t = await r.json();
    player.accessToken = t.access_token;
    player.refreshToken = t.refresh_token || player.refreshToken;
    player.expiresAt = Date.now() + t.expires_in * 1000;
    await save();
    return player.accessToken
}

function auth(req, res) {
    const key = token(req);
    const record = key && db.keys[sha(key)];
    if (!record) {
        fail(res, 401, 'invalid_api_key', 'Provide a valid API key as a Bearer token');
        return null
    }
    const player = db.players[record.puuid];
    if (!player || !player.sharing) {
        fail(res, 403, 'consent_required', 'Player has disconnected or disabled sharing');
        return null
    }
    return player
}

async function handler(req, res) {
    try {
        const url = new URL(req.url, BASE),
            p = url.pathname;
        if (req.method === 'GET' && p === '/health') return json(res, 200, {
            status: 'ok'
        });
        if (req.method === 'GET' && p === '/legal') return json(res, 200, {
            product: 'Synapse VALO API',
            thirdParty: true,
            disclaimer: 'Synapse VALO API is an independent third-party tool. It is not affiliated with, authorized by, sponsored by, or endorsed by Riot Games, Inc. or VALORANT. Riot Games, VALORANT, and related marks belong to their respective owners.'
        });
        if (req.method === 'GET' && p === '/auth/riot/start') {
            if (!CLIENT || !SECRET || !RIOT_KEY) return fail(res, 503, 'not_configured', 'Set Riot production credentials first');
            const shard = url.searchParams.get('region');
            if (!regions[shard]) return fail(res, 400, 'invalid_region', 'Use na, br, latam, eu, ap, or kr');
            const state = random();
            db.states[sha(state)] = {
                shard,
                expires: Date.now() + 600000
            };
            await save();
            const target = new URL('https://auth.riotgames.com/authorize');
            target.search = new URLSearchParams({
                client_id: CLIENT,
                redirect_uri: BASE + '/auth/riot/callback',
                response_type: 'code',
                scope: 'openid offline_access',
                state
            }).toString();
            return json(res, 200, {
                authorizationUrl: target.toString(),
                notice: 'Linking opts you in to sharing account and gameplay data with holders of your API key. You can revoke access at any time.'
            });
        }
        if (req.method === 'GET' && p === '/auth/riot/callback') {
            const state = url.searchParams.get('state'),
                code = url.searchParams.get('code');
            const entry = state && db.states[sha(state)];
            if (!entry || entry.expires < Date.now() || !code) return fail(res, 400, 'invalid_callback', 'Expired or invalid OAuth callback');
            delete db.states[sha(state)];
            await save();
            const r = await fetch('https://auth.riotgames.com/token', {
                method: 'POST',
                headers: {
                    Authorization: 'Basic ' + Buffer.from(CLIENT + ':' + SECRET).toString('base64'),
                    'content-type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: BASE + '/auth/riot/callback'
                }),
                signal: AbortSignal.timeout(10000)
            });
            if (!r.ok) return fail(res, 502, 'riot_oauth_failed', `Riot token exchange returned ${r.status}`);
            const t = await r.json();
            const a = await riot(`https://${regions[entry.shard]}.api.riotgames.com/riot/account/v1/accounts/me`, t.access_token);
            if (!a.puuid) return fail(res, 502, 'riot_account_failed', 'Riot did not return a PUUID');
            const player = db.players[a.puuid] || {};
            Object.assign(player, {
                puuid: a.puuid,
                gameName: a.gameName,
                tagLine: a.tagLine,
                shard: entry.shard,
                accessToken: t.access_token,
                refreshToken: t.refresh_token,
                expiresAt: Date.now() + t.expires_in * 1000,
                sharing: true
            });
            db.players[a.puuid] = player;
            for (const [hash, v] of Object.entries(db.keys))
                if (v.puuid === a.puuid) delete db.keys[hash];
            const key = 'val_' + random();
            db.keys[sha(key)] = {
                puuid: a.puuid,
                createdAt: new Date().toISOString()
            };
            await save();
            return json(res, 200, {
                message: 'Connected. Save this API key now; it will not be shown again.',
                apiKey: key,
                player: {
                    riotId: `${a.gameName}#${a.tagLine}`,
                    region: entry.shard
                },
                sharing: true
            });
        }
        if (!p.startsWith('/v1/')) return fail(res, 404, 'not_found', 'Unknown endpoint');
        const player = auth(req, res);
        if (!player) return;
        if (req.method === 'GET' && p === '/v1/me') return json(res, 200, {
            puuid: player.puuid,
            riotId: `${player.gameName}#${player.tagLine}`,
            region: player.shard,
            sharing: player.sharing
        });
        if (req.method === 'POST' && p === '/v1/key/rotate') {
            for (const [h, v] of Object.entries(db.keys))
                if (v.puuid === player.puuid) delete db.keys[h];
            const key = 'val_' + random();
            db.keys[sha(key)] = {
                puuid: player.puuid,
                createdAt: new Date().toISOString()
            };
            await save();
            return json(res, 200, {
                apiKey: key,
                message: 'Previous keys revoked. Save this key now.'
            });
        }
        if (req.method === 'POST' && p === '/v1/disconnect') {
            delete db.players[player.puuid];
            for (const [h, v] of Object.entries(db.keys))
                if (v.puuid === player.puuid) delete db.keys[h];
            await save();
            return json(res, 200, {
                disconnected: true
            });
        }
        if (!RIOT_KEY) return fail(res, 503, 'not_configured', 'RIOT_API_KEY is required');
        const origin = `https://${player.shard}.api.riotgames.com`;
        if (req.method === 'GET' && p === '/v1/matches') {
            const raw = await riot(`${origin}/val/match/v1/matchlists/by-puuid/${encodeURIComponent(player.puuid)}`);
            return json(res, 200, {
                player: player.puuid,
                history: raw.history || [],
                source: 'riot_official'
            });
        }
        if (req.method === 'GET' && p.startsWith('/v1/matches/')) {
            const id = p.slice('/v1/matches/'.length);
            if (!safe(id)) return fail(res, 400, 'invalid_match_id', 'Invalid match ID');
            const match = await riot(`${origin}/val/match/v1/matches/${encodeURIComponent(id)}`);
            if (!match.players?.some(x => x.puuid === player.puuid)) return fail(res, 403, 'not_your_match', 'This match does not belong to the linked account');
            return json(res, 200, {
                match,
                source: 'riot_official'
            });
        }
        if (req.method === 'GET' && p === '/v1/rank') {
            const content = await riot(`${origin}/val/content/v1/contents`);
            const acts = content.acts || [];
            const act = acts.find(x => x.isActive && x.type === 'act');
            if (!act) return json(res, 200, {
                riotId: `${player.gameName}#${player.tagLine}`,
                rank: null,
                rr: null,
                availability: 'no_active_act',
                source: 'riot_official'
            });
            const board = await riot(`${origin}/val/ranked/v1/leaderboards/by-act/${encodeURIComponent(act.id)}?size=200&startIndex=0`);
            const row = (board.players || []).find(x => x.puuid === player.puuid);
            return json(res, 200, {
                riotId: `${player.gameName}#${player.tagLine}`,
                act: {
                    id: act.id,
                    name: act.name
                },
                rank: row ? {
                    tier: row.competitiveTier,
                    leaderboardRank: row.leaderboardRank
                } : null,
                rr: row?.rankedRating ?? null,
                availability: row ? 'leaderboard_only' : 'unavailable_outside_leaderboard',
                source: 'riot_official',
                note: row ? 'RR is the official leaderboard rankedRating; limited to returned leaderboard entries.' : 'The official API does not expose current rank or RR for players outside the returned leaderboard.'
            });
        }
        return fail(res, 404, 'not_found', 'Unknown endpoint');
    } catch (e) {
        if (e.status === 429) return fail(res, 429, 'riot_rate_limited', `Riot rate limit; retry after ${e.retry||'a short delay'}`);
        if (e.status === 401) return fail(res, 401, 'riot_auth_expired', e.message);
        if (e.status === 404) return fail(res, 404, 'riot_not_found', 'Riot resource not found');
        console.error(e);
        return fail(res, 502, 'upstream_error', 'Riot service unavailable or request failed')
    }
}

async function main() {
    try {
        db = JSON.parse(await fs.readFile(DB, 'utf8'))
    } catch (e) {
        if (e.code !== 'ENOENT') throw e
    }
    if (!db.players || !db.keys || !db.states) throw Error('Invalid data store');
    http.createServer(handler).listen(PORT, () => console.log(`Listening on ${PORT}`))
}

main();
