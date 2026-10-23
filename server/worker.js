// Netplay room server for online play (Cloudflare Worker + Durable Objects). It only runs rooms: it serves
// no page, no build and no game files. Each player serves the page from their own copy and points it at
// this server with ?netplay=<this Worker's URL>.
//
//   GET /_netplay_ticket   a short-lived signed ticket plus ICE servers for direct WebRTC channels
//   /netplay/<code>        WebSocket into the room (a Durable Object), presenting the ticket
//
// A room relays lobby events and lockstep inputs between up to 4 peers (see NetplayRoom below,
// web/netplay.js and host/netplay.c). Setup: see README.md in this folder.

const ALLOWED = (env) => (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());

function cors(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED(env);
  const ok = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : '';
  return ok ? { 'Access-Control-Allow-Origin': ok, 'Cross-Origin-Resource-Policy': 'cross-origin', Vary: 'Origin' } : {};
}

function respond(body, status, extra = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extra } });
}

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// ------------------------------------------------------------------ tickets and ICE servers

const TICKET_SECONDS = 3600;
const FILES_PER_ROOM = 160e6;   // bytes of the host's saves a room relays (base64), over all attempts

// Tickets are HMAC-signed with the NETPLAY_SECRET secret (any random string), so a room can't be opened
// without fetching a ticket first.
function ticketSecret(env) {
  return env.NETPLAY_SECRET;
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function ticketValid(env, ticket) {
  const [exp, sig] = String(ticket || '').split('.');
  const secret = ticketSecret(env);
  if (!secret || !exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return timingSafeEqual(sig, await hmac(secret, `netplay:${exp}`));
}

// ICE servers for the players' direct WebRTC channels: Cloudflare's TURN service (secrets TURN_KEY_ID and
// TURN_KEY_API_TOKEN) relays a direct channel through the data center nearest each player when the two
// can't reach each other directly (symmetric NATs, firewalls), which beats going through the room when the
// room is far away. Credentials last a day, longer than a game.
async function iceServers(env) {
  const stun = [{ urls: 'stun:stun.cloudflare.com:3478' }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return stun;
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: 'POST', body: JSON.stringify({ ttl: 86400 }),
    headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`TURN credentials: HTTP ${res.status} ${await res.text()}`);
  const { iceServers: servers } = await res.json();
  // browsers block port 53, and trying those addresses only slows ICE down (as Cloudflare's docs advise)
  return [servers].flat().map((s) => ({ ...s, urls: [s.urls].flat().filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((s) => s.urls.length);
}

const MAX_PLAYERS = 4;
// How long a running game keeps a player whose connection dropped (the others wait, told why): long enough for a
// router restart or a change of network. REJOIN_GRACE_MS overrides it (tests).
const REJOIN_GRACE_MS = 180000;

// One room: the first peer to join hosts. Peers say hello (name, game build), the host starts the session
// (fixing the player count and input delay), then every input/hash batch a peer sends is relayed to the
// others. Uses WebSocket hibernation; the lobby lives in the sockets' attachments and durable storage.
export class NetplayRoom {
  constructor(ctx, env) { this.ctx = ctx; this.grace = Number(env?.REJOIN_GRACE_MS) || REJOIN_GRACE_MS; }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    // the data center this peer reaches Cloudflare through, shown in the lobby next to the room's own
    server.serializeAttachment({ slot: -1, name: '', version: '', rtt: 0, via: String(request.cf?.colo || '') });
    this.where();
    return new Response(null, { status: 101, webSocket: client });
  }

  // The data center this room runs in (its own outgoing requests leave from there), once per instance.
  where() {
    this.colo ??= fetch('https://cloudflare.com/cdn-cgi/trace').then((r) => r.text())
      .then((t) => /^colo=(\w+)/m.exec(t)?.[1] || '?').catch(() => '?');
    return this.colo;
  }

  peers() {
    return this.ctx.getWebSockets().map((ws) => ({ ws, ...ws.deserializeAttachment() })).filter((p) => p.slot >= 0);
  }

  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch { /* closed */ } }

  async lobby() {
    const started = (await this.ctx.storage.get('started')) || null;
    const players = this.peers().map(({ slot, name, version, rtt, p2p, via }) => ({ slot, name, version, rtt, p2p: p2p || {}, via }))
      .sort((a, b) => a.slot - b.slot);
    const colo = await this.where();
    for (const p of this.peers()) this.send(p.ws, { t: 'lobby', you: p.slot, host: p.slot === 0, players, started, colo });
  }

  async webSocketMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const me = ws.deserializeAttachment();
    if (msg.t === 'hello' && me.slot < 0) {
      if (await this.ctx.storage.get('started')) { this.send(ws, { t: 'error', msg: 'This game has already started.' }); ws.close(4000, 'started'); return; }
      const used = new Set(this.peers().map((p) => p.slot));
      let slot = 0;
      while (used.has(slot)) slot++;
      if (slot >= MAX_PLAYERS) { this.send(ws, { t: 'error', msg: 'The room is full.' }); ws.close(4001, 'full'); return; }
      // key: the player's secret for rejoining this game after a dropped connection (never sent to anyone)
      const key = typeof msg.key === 'string' && /^[0-9a-f]{32}$/.test(msg.key) ? msg.key : '';
      ws.serializeAttachment({ ...me, slot, key, name: String(msg.name || `Player ${slot + 1}`).slice(0, 24), version: String(msg.version || ''), rtt: 0 });
      await this.lobby();
      return;
    }
    if (msg.t === 'ping') { this.send(ws, { t: 'pong', ts: msg.ts }); return; }
    // leaving on purpose (Leave the match): the others are told at once, not after the grace period
    if (msg.t === 'bye') { ws.serializeAttachment({ ...me, bye: msg.why === 'closed' ? 'closed' : 'quit' }); return; }
    if (msg.t === 'rejoin' && me.slot < 0) {   // a player of a running game whose connection dropped
      const started = await this.ctx.storage.get('started');
      const slot = Number(msg.slot);
      const away = (await this.ctx.storage.get('away')) || {};
      // only the player who left, by their key: anyone else with the room code gets nowhere
      if (!started || !(slot in away) || this.peers().some((p) => p.slot === slot) ||
          (away[slot].key && !timingSafeEqual(String(msg.key || ''), away[slot].key))) {
        this.send(ws, { t: 'error', msg: 'The match ended while you were away.', ended: true }); ws.close(4002, 'rejoin'); return;
      }
      ws.serializeAttachment({ ...away[slot], slot });
      delete away[slot];
      await this.ctx.storage.put('away', away);
      this.send(ws, { t: 'rejoined', slot });
      for (const p of this.peers()) if (p.slot !== slot) this.send(p.ws, { t: 'back', slot });
      return;
    }
    if (me.slot < 0) return;
    if (msg.t === 'rtt') {   // a peer's round trip to this room, shown in the lobby and used for the auto delay
      ws.serializeAttachment({ ...me, rtt: Math.max(0, Math.min(5000, Math.round(Number(msg.ms) || 0))) });
      if (!(await this.ctx.storage.get('started'))) await this.lobby();
      return;
    }
    if (msg.t === 'start' && me.slot === 0 && !(await this.ctx.storage.get('started'))) {
      const peers = this.peers();
      const versions = new Set(peers.map((p) => p.version));
      if (versions.size > 1) { this.send(ws, { t: 'error', msg: 'Players have different game builds, files or patches: everyone needs the same ones, then a reload.' }); return; }
      const slots = peers.map((p) => p.slot).sort((a, b) => a - b);
      if (slots.some((s, i) => s !== i)) { this.send(ws, { t: 'error', msg: 'Waiting for the player list to settle; try again.' }); return; }
      // the saves the host brought (relayed below, before the start): every game starts from them
      const f = msg.files;
      const files = f && /^[0-9a-f]{16}$/.test(f.id) && /^[0-9a-f]{64}$/.test(f.hash) ? { id: f.id, hash: f.hash, size: Number(f.size) || 0 } : null;
      const started = { players: peers.length, delay: Math.max(2, Math.min(30, Number(msg.delay) || 6)), ...(files ? { files } : {}) };
      await this.ctx.storage.put('started', started);
      for (const p of peers) this.send(p.ws, { t: 'start', ...started, you: p.slot });
      return;
    }
    if (msg.t === 'sig') {   // WebRTC signaling (offers, answers, ICE candidates) to one peer
      for (const p of this.peers()) if (p.slot === msg.to) this.send(p.ws, { t: 'sig', from: me.slot, data: msg.data });
      return;
    }
    if (msg.t === 'p2p') {   // a peer's direct round trips to the others, for the auto delay
      const p2p = {};
      for (const [k, v] of Object.entries(msg.rtt || {})) p2p[Number(k)] = Math.max(0, Math.min(5000, Math.round(Number(v) || 0)));
      ws.serializeAttachment({ ...me, p2p });
      if (!(await this.ctx.storage.get('started'))) await this.lobby();
      return;
    }
    // the saves the host brings to the match, in chunks, before the start; each player confirms to the host
    if ((msg.t === 'files' || msg.t === 'chunk') && me.slot === 0 && !(await this.ctx.storage.get('started'))) {
      // a chunk is 192 KB as base64 plus a little; a room relays a few bundles' worth at most
      this.relayed = (this.relayed || 0) + data.length;
      if (data.length > 300000 || this.relayed > FILES_PER_ROOM) { this.send(ws, { t: 'error', msg: 'Too much data sent through this room.' }); return; }
      for (const p of this.peers()) if (p.slot !== me.slot) try { p.ws.send(data); } catch { /* closed */ }
      return;
    }
    if (msg.t === 'files-ok' && me.slot > 0) {
      for (const p of this.peers()) if (p.slot === 0) this.send(p.ws, { t: 'files-ok', from: me.slot, id: String(msg.id || ''), hash: String(msg.hash || '') });
      return;
    }
    if (msg.t === 'in') {   // relay as-is to everyone else
      for (const p of this.peers()) if (p.slot !== me.slot) try { p.ws.send(data); } catch { /* closed */ }
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* already closed */ }   // complete the handshake
    await this.left(ws, code);
  }
  async webSocketError(ws) { await this.left(ws, 1006); }

  // Lobby: a player who disconnects is gone. In a running game a player who left on purpose ('bye') or closed the
  // page (close code 1001: their game is gone with it) is gone at once; one whose connection dropped keeps their
  // slot for the grace period, so they can rejoin (their game waits meanwhile, and the others' wait in lockstep,
  // told why: 'away', then 'back' or 'left').
  async left(ws, code) {
    const me = ws.deserializeAttachment();
    if (me.slot < 0) return;
    ws.serializeAttachment({ ...me, slot: -1 });
    const started = await this.ctx.storage.get('started');
    if (!started || me.bye || code === 1001) {
      for (const p of this.peers()) this.send(p.ws, { t: 'left', slot: me.slot, why: started ? me.bye || 'closed' : '' });
      if (!started) await this.lobby();
      if (this.peers().length === 0) await this.ctx.storage.deleteAll();   // empty room: reusable
      return;
    }
    const away = (await this.ctx.storage.get('away')) || {};
    away[me.slot] = { ...me, at: Date.now() };
    await this.ctx.storage.put('away', away);
    for (const p of this.peers()) this.send(p.ws, { t: 'away', slot: me.slot, grace: this.grace });
    await this.ctx.storage.setAlarm(Date.now() + this.grace);
  }

  async alarm() {
    const away = (await this.ctx.storage.get('away')) || {};
    let next = 0;
    for (const [slot, a] of Object.entries(away)) {
      if (Date.now() - a.at >= this.grace) {
        for (const p of this.peers()) this.send(p.ws, { t: 'left', slot: Number(slot), why: 'timeout' });
        delete away[slot];
      } else next = Math.max(next, a.at + this.grace);
    }
    await this.ctx.storage.put('away', away);
    if (next) await this.ctx.storage.setAlarm(next);
    else if (this.peers().length === 0) await this.ctx.storage.deleteAll();   // everyone gone: reusable
  }
}

// Durable Object location hints (developers.cloudflare.com/durable-objects/reference/data-location/)
const REGIONS = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me'];

function nearestRegion(cf) {
  const lon = Number(cf?.longitude);
  switch (cf?.continent) {
    case 'NA': return lon < -100 ? 'wnam' : 'enam';
    case 'SA': return 'sam';
    case 'EU': return lon > 20 ? 'eeur' : 'weur';
    case 'AF': return 'afr';
    case 'OC': return 'oc';
    case 'AS': return cf?.country && ['AE', 'SA', 'QA', 'BH', 'KW', 'OM', 'IL', 'JO', 'TR'].includes(cf.country) ? 'me' : 'apac';
    default: return undefined;
  }
}

async function netplay(request, env, url) {
  const code = url.pathname.slice('/netplay/'.length).toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return respond('Bad room code', 400);
  if (!(await ticketValid(env, url.searchParams.get('ticket')))) return respond('Forbidden', 403);
  // Lockstep waits for the slowest path, so the room should run near the players. A room's location is
  // fixed by the first request that reaches it, so only the host's creating connection (create=1) asks for
  // one: the region it picked, or by default the one nearest to it. Cloudflare treats the hint as a
  // preference: Durable Objects don't run in Africa or the Middle East, so those land in a nearby region.
  let hint;
  if (url.searchParams.get('create') === '1') {
    const pick = url.searchParams.get('region') || 'auto';
    if (pick !== 'auto' && !REGIONS.includes(pick)) return respond('Bad region', 400);
    hint = pick !== 'auto' ? pick : nearestRegion(request.cf);
  }
  return env.ROOMS.get(env.ROOMS.idFromName(code), hint ? { locationHint: hint } : {}).fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/netplay/')) return netplay(request, env, url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(request, env), 'Access-Control-Allow-Methods': 'GET' } });
    if (url.pathname === '/_netplay_ticket' && request.method === 'GET') {
      const secret = ticketSecret(env);
      if (!secret) return respond('Netplay is not configured (set the NETPLAY_SECRET secret)', 503, cors(request, env));
      const exp = Math.floor(Date.now() / 1000) + TICKET_SECONDS;
      const ticket = `${exp}.${await hmac(secret, `netplay:${exp}`)}`;
      return respond(JSON.stringify({ ticket, iceServers: await iceServers(env) }), 200,
        { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(request, env) });
    }
    return respond('Netplay room server. Open the game page with ?netplay=' + url.origin, 404);
  },
};
