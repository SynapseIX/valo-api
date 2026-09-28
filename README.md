# Synapse VALO API

Synapse VALO API is an independent third-party tool. It is not affiliated with, authorized by, sponsored by, or endorsed by Riot Games, Inc. or VALORANT. Riot Games, VALORANT, and related marks belong to their respective owners.

A Node.js 20+ API for a player who explicitly links their Riot account. It issues an API key to that player, exposes identity and official match data, and reports official leaderboard rank/RR **only when Riot includes the player in the leaderboard response**. No scraping, client credentials, undocumented endpoints, or fabricated RR.

## Hosted site

The Node server also serves a responsive landing page at `/`, with account linking, endpoint documentation, and a one-time API key screen after Riot redirects back. The production URL is `https://valo-api.synapseix.pro`; register `https://valo-api.synapseix.pro/auth/riot/callback` as the Riot RSO redirect URI. The site links to [GitHub](https://github.com/SynapseIX/valo-api), [X](https://x.com/synapseix), and [Twitch](https://www.twitch.tv/synapseix). The published privacy and terms pages describe the current single-server implementation. Review their operator identity, host logging, backup behavior, and applicable legal requirements before launch or when deployment changes. The website does not collect a password; Riot handles sign-in. Page templates live in `public/*.html`, styles in `public/assets/*.css`, and browser behavior in `public/assets/index.js`.

## Important limitation

Riot's documented VALORANT endpoints do **not** include a general player-current-rank/current-RR endpoint. The ranked leaderboard returns `competitiveTier`, `leaderboardRank`, and `rankedRating` for listed players. For most players `GET /v1/rank` therefore returns `rank: null`, `rr: null`, and `availability: "unavailable_outside_leaderboard"`. This project cannot satisfy universal current RR with the public official API. The data is fetched on each request, subject to Riot updates and rate limits; it is not live in-game telemetry. See [Riot VALORANT API documentation](https://developer.riotgames.com/docs/valorant).

## Prerequisites

1. Register a public product and request a **VALORANT production API key** and Riot Sign On (RSO) client at [Riot Developer Portal](https://developer.riotgames.com/). VALORANT personal keys and personal-only apps are not supported. Approval and RSO access are external prerequisites.
2. Configure your registered RSO redirect URI to precisely `https://valo-api.synapseix.pro/auth/riot/callback` and use Riot's confidential client secret authentication. The implementation uses the `openid offline_access` scopes, authorization code, state, refresh token, and Riot's `/riot/account/v1/accounts/me` endpoint.
3. Publish the included privacy notice and terms, and verify they accurately describe your actual hosting and backup practices. Linking opts the player in to sharing their account and gameplay information with anyone they give an API key. Follow Riot's application and display requirements. Do not publish another player's data without their own opt-in.
4. Use HTTPS for all public traffic. Never embed Riot credentials or generated player API keys in frontend code.

## Run locally

### Preview the pages directly

Extract the complete ZIP and open `public/index.html` in your browser. Keep the
`public/assets` folder next to the HTML files: the CSS, JavaScript, and links to
`privacy.html` and `terms.html` use relative paths so previews also work with
`file://` URLs. `connected.html` is a server template; opening it directly previews
its styling with placeholder account and key values.

### Run the website and API

For a local website preview through Node, run `npm start` from the project folder
and open `http://localhost:3000`. Riot sign-in requires the running backend and
configured Riot credentials; it cannot run from an HTML file opened directly.

To start with the deployment settings:

```bash
cp .env.example .env
# Edit .env and load variables with your process manager or shell.
set -a; . ./.env; set +a
npm start
```

No npm dependencies. `PUBLIC_BASE_URL` must be the public origin without a trailing slash, matching the Riot registered redirect URL. `DATA_FILE` must point to a persistent writable location; use a single running instance with the JSON store. The process must be restarted after changing environment variables. The `/health` endpoint works without Riot credentials; the linking flow requires approved credentials.

## Deploy

For a Node hosting panel (including GoDaddy Node apps), upload this directory, select Node 20 or newer, set startup command `npm start`, set the six values in `.env.example` as **server environment variables**, assign a persistent writable absolute `DATA_FILE`, enable HTTPS at the reverse proxy, and register the resulting callback URL in Riot. If your host resets local storage on deployment, mount durable storage or replace the JSON store before production. This simple store is designed for **one process**; concurrent replicas can overwrite each other's data. Restrict file permissions and back up the store securely: it contains Riot OAuth tokens in plaintext. For a larger public service, move tokens to encrypted storage, add request throttling, central persistence, monitoring, and audit logs. The provided Dockerfile expects a writable `/data` volume owned by the container user.

## Player onboarding and API keys

1. The client opens `GET /auth/riot/start?region=na` (supported: `na`, `br`, `latam`, `eu`, `ap`, `kr`). The region is the player's VALORANT platform shard; it is not inferred from Riot ID.
2. Redirect the player to `authorizationUrl`. Riot redirects back to `/auth/riot/callback?code=...&state=...`.
3. A browser callback displays an HTML page with a single API key; a JSON client receives the same result as JSON. Give it only to the account owner over HTTPS; store it securely. Re-linking rotates existing keys. Clients use `Authorization: Bearer val_...`. Each key grants access only to its linked account.
4. `POST /v1/key/rotate` replaces all keys for that player. `POST /v1/disconnect` removes local account data and invalidates all local keys. A disconnected player can withdraw Riot authorization separately in their Riot account settings. The server does not call a Riot token-revocation endpoint.

The browser callback renders a one-time HTML key screen; clients requesting JSON receive JSON. Use a private browser session, and do not log callback responses. OAuth `state` expires after 10 minutes and is consumed once. Keys are stored only as SHA-256 hashes; Riot access and refresh tokens reside in the data file. Player API keys are distinct from your server-only Riot production key.

## Endpoints

API responses are JSON with `Cache-Control: no-store`; `/`, `/privacy`, `/terms`, and browser OAuth callbacks return HTML. The server also supports `/index.html`, `/privacy.html`, and `/terms.html` for the relative links used in local previews. These pages, their allowlisted `/assets/*` files, `/health`, `/legal`, and the two `/auth/riot/*` endpoints are public. `/v1/*` requires a player API key. Errors have `{ "error": { "code": "...", "message": "..." } }`. Typical statuses: 400 invalid input, 401 invalid key or expired Riot authorization, 403 revoked sharing or unauthorized match, 404 missing resource, 429 Riot rate limit, 502 upstream failure, 503 missing configuration.

### GET /legal

Public product and rights notice. Response `200`:
```json
{"product":"Synapse VALO API","thirdParty":true,"disclaimer":"Synapse VALO API is an independent third-party tool. It is not affiliated with, authorized by, sponsored by, or endorsed by Riot Games, Inc. or VALORANT. Riot Games, VALORANT, and related marks belong to their respective owners."}
```

### GET /health

Response `200`:
```json
{"status":"ok"}
```

### GET /auth/riot/start?region=na

Response `200` (URL abbreviated):
```json
{"authorizationUrl":"https://auth.riotgames.com/authorize?...","notice":"Linking opts you in to sharing account and gameplay data with holders of your API key. You can revoke access at any time."}
```

### GET /auth/riot/callback?code=...&state=...

Riot redirects here. Response `200`, delivered once:
```json
{"message":"Connected. Save this API key now; it will not be shown again.","apiKey":"val_EXAMPLE","player":{"riotId":"Example#NA1","region":"na"},"sharing":true}
```

### GET /v1/me

```bash
curl -H 'Authorization: Bearer val_EXAMPLE' https://valo-api.synapseix.pro/v1/me
```
Response `200`:
```json
{"puuid":"sample-puuid","riotId":"Example#NA1","region":"na","sharing":true}
```

### GET /v1/rank

```bash
curl -H 'Authorization: Bearer val_EXAMPLE' https://valo-api.synapseix.pro/v1/rank
```
Response `200` for a player included in the returned top 200 leaderboard entries:
```json
{"riotId":"Example#NA1","act":{"id":"act-uuid","name":"ACT NAME"},"rank":{"tier":27,"leaderboardRank":42},"rr":573,"availability":"leaderboard_only","source":"riot_official","note":"RR is the official leaderboard rankedRating; limited to returned leaderboard entries."}
```
Response `200` for other players:
```json
{"riotId":"Example#NA1","act":{"id":"act-uuid","name":"ACT NAME"},"rank":null,"rr":null,"availability":"unavailable_outside_leaderboard","source":"riot_official","note":"The official API does not expose current rank or RR for players outside the returned leaderboard."}
```
An inactive act returns `availability: "no_active_act"` with `rank` and `rr` null. `rr` for leaderboard entries is the leaderboard's `rankedRating` field; do not equate it with the ordinary 0–100 progress display for all tiers.

### GET /v1/matches

Returns Riot's match history for the linked PUUID:
```json
{"player":"sample-puuid","history":[{"matchId":"match-uuid","gameStartTimeMillis":1700000000000,"queueId":"competitive"}],"source":"riot_official"}
```

### GET /v1/matches/:matchId

Returns `{ "match": { ...official Riot match detail... }, "source": "riot_official" }`. The linked PUUID must appear in `match.players`; otherwise `403`. Request:
```bash
curl -H 'Authorization: Bearer val_EXAMPLE' https://valo-api.synapseix.pro/v1/matches/match-uuid
```
The embedded `match` is Riot's original response; consult [Riot's official API reference](https://developer.riotgames.com/apis) for the full schema.

### POST /v1/key/rotate

```bash
curl -X POST -H 'Authorization: Bearer val_EXAMPLE' https://valo-api.synapseix.pro/v1/key/rotate
```
Response `200`: `{ "apiKey": "val_NEW_KEY", "message": "Previous keys revoked. Save this key now." }`.

### POST /v1/disconnect

```bash
curl -X POST -H 'Authorization: Bearer val_EXAMPLE' https://valo-api.synapseix.pro/v1/disconnect
```
Response `200`: `{ "disconnected": true }`.

## Operational notes

- `riotId` may change when a player renames their account; PUUID is the stable account identifier.
- Riot can return `429`; the API relays a `429` with a retry hint. Calls are currently uncached and count against your approved Riot key's rate limits.
- The rank endpoint uses Riot content to locate the active act and checks the first 200 leaderboard players; API coverage and shapes should be checked against your granted production access.
- This API does not provide live match scouting or gameplay advice.
- Synapse VALO API is an independent third-party tool and is not affiliated with, sponsored by, or endorsed by Riot Games, Inc. or VALORANT.
- If Riot-owned assets are later used, review and display the notice required by [Riot’s Legal Jibber Jabber policy](https://www.riotgames.com/en/legal), along with any applicable Developer Portal terms.
