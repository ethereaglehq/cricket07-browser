// Netplay transport, shared by the page (loader.js) and the headless Node harness (node_env.js).
//
// Connects to a room on the Worker (worker.js: NetplayRoom), shows the lobby through callbacks, and once the
// host starts the session moves lockstep messages between this peer's game (host/netplay.c) and the room:
// it drains the game's outbox (our pad inputs, state hashes) into the socket and feeds what other peers
// send into the game. Plain script: the page loads it with <script>, Node with require().
(function (root) {
  'use strict';


  // Room client. opts: { url (ws(s)://.../netplay/<CODE>?ticket=...), name, version, iceServers (STUN/TURN
  // for the direct channels, from the ticket), relayOnly (direct channels only through TURN), adaptive (false:
  // keep the session's input delay all game), testLoss (tests: drop this fraction of direct packets on arrival),
  // onLobby(lobby),
  // onStart(session), onLeft(slot), onError(message), onClose(), reconnectUrl() (async: a fresh url with a
  // new ticket), onReconnect(state) }. If the room connection drops during a game it reconnects, rejoins
  // its slot and resends its recent inputs (the others wait in lockstep meanwhile).
  //
  // Inputs go through the room (a relay every peer can reach) and, where WebRTC is available, also over a
  // direct data channel to each peer, set up through the room in the lobby. The game stores each frame's
  // input idempotently, so duplicates are harmless and the faster path wins. The direct channels don't
  // retransmit (a resend would come long after the room's copy); instead every packet also repeats our last
  // few inputs, so a lost one is covered by the next, a frame later. Round trips to the room and
  // over each direct channel are measured (pings 4 times a second; the 90th percentile of the last 40, so
  // jitter counts) and reported, so the lobby can pick an input delay that covers the slowest pair of
  // players (autoDelay).
  //
  // In the game the delay adapts (host/netplay.c: netplay_set_delay). Inputs are keyed by frame, so each
  // player can change how far ahead it sends its own (its lead) without asking anyone. The game times every
  // remote input's arrival (netplay_remote_input returns how many ms before it was needed, negative if it was
  // already waiting), and every input carries the lead it went out with. The lead minus that slack is the
  // input's lag: how long after its sender's Present it arrived, in this game's frame time, whatever the lead.
  // Each player keeps the worst lag of each quarter-second, and four times a second reports to each sender the
  // second-worst quarter-second of the last 4 s: lateness that recurs, not one hiccup (a longer lead after a
  // one-off freeze would only add lag; it can't undo the freeze). The reports ride in its 'in' messages (the
  // room relays them as they are; older peers ignore the extra fields), and the sender (nextLead):
  //  - raises its lead at once to cover the worst report and a margin,
  //  - lowers it once every report has left room for a shorter lead for 2 s, halfway each time,
  //  - but doesn't raise when the two leads already cover the round trip with plenty to spare: then the other
  //    game is running ahead of this one (a faster machine, or one that started first), and would only run
  //    further ahead into a longer lead.
  // Leads stay within 2-30 frames. Without reports (an older peer) or after an error the lead stays at, or goes
  // back to, the session's delay; opts.adaptive false (?adaptive=0) keeps it there.

  const FRAME_MS = 1000 / 60;
  const NO_SLACK = -2147483648;      // netplay_remote_input: a repeat, or an input it can't time
  const MAX_SLOTS = 4;               // players in a room (server/worker.js MAX_PLAYERS, host/netplay.c NP_SLOTS)
  const EARLY_MAX = 2048;            // inputs and hashes kept for a game not attached yet: far more than a
                                     // peer sends before it waits for ours
  const PERIODS = 16, MIN_PERIODS = 8;   // reports cover 4 s of quarter-seconds, once 2 s of them had inputs
  const MARGIN_MS = 4;               // slack a raise leaves
  const SPARE_MS = 6;                // and more on top before lowering, so a lower lead doesn't flap back up
  const LOWER_AFTER_MS = 2000;
  const PAIR_SPARE_MS = 5 * FRAME_MS;
  const MIN_LEAD = 2, MAX_LEAD = 30;

  // Saves the host brings to a match travel through the room as base64 chunks (a room message holds at
  // most 1 MB), and are checked with SHA-256 on arrival.
  const CHUNK = 192 * 1024;
  const MAX_FILES = 32 << 20;
  const b64e = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const b64d = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
  const sha256 = async (u8) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))].map((b) => b.toString(16).padStart(2, '0')).join('');

  // Round-trip samples over one path, summarised as a 90th percentile.
  function trip() {
    const samples = [];
    return {
      add(ms) { samples.push(ms); if (samples.length > 40) samples.shift(); },
      p90() {
        if (!samples.length) return 0;
        const sorted = [...samples].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
      },
    };
  }

  // The lead to send with next. st: { lead, okSince } (okSince: since when lowering has been possible, 0 if
  // it isn't); reps: for each player with a fresh report, { lag: their report on our inputs (ms), mine: ours
  // on theirs (null if unknown), theirs: their lead (0 if unknown) }. tests/netplay/sim.c has a copy in C.
  function nextLead(st, reps, now) {
    let up = 0, low = MIN_LEAD;   // a raise, and the lowest lead every report leaves room for
    for (const r of reps) {
      const need = Math.ceil((r.lag + MARGIN_MS) / FRAME_MS);
      if (need > st.lead && (r.mine == null || !r.theirs ||
          (st.lead + r.theirs) * FRAME_MS - (r.lag + r.mine) < PAIR_SPARE_MS)) up = Math.max(up, need);
      low = Math.max(low, Math.ceil((r.lag + MARGIN_MS + SPARE_MS) / FRAME_MS));
    }
    if (up || st.lead <= low) { st.okSince = 0; return up ? Math.min(MAX_LEAD, up) : st.lead; }
    st.okSince ||= now;
    return now - st.okSince >= LOWER_AFTER_MS ? st.lead - Math.ceil((st.lead - low) / 2) : st.lead;
  }

  function connect(opts) {
    let ws = null;
    let started = false, closing = false, retries = 0, heard = Date.now();
    const history = [];       // our recent input batches, resent after a reconnect
    const HISTORY = 600;
    const recent = [];        // our last few inputs, repeated in every direct packet
    const REPEAT = 8;
    let game = null;          // the Emscripten module once attached
    let timer = null;
    let me = -1, players = 0;   // our slot, and the number of players once the game starts
    const early = [];         // input batches that arrive before the game is attached (checked: see checkIn)
    let earlyN = 0;
    const roomTrip = trip();
    let rtt = 0, reported = 0;   // round trip to the room (90th percentile), and the value the room last heard
    const peers = new Map();  // slot -> { pc, dc, trip, rtt, via }
    const p2pReported = {};
    // the host's saves for the match (offerFiles): what each player has received, and who confirmed it
    const incoming = new Map(), received = new Map(), acks = new Map();
    let offered = null, lobby = null;
    // adaptive delay (see the top): our lead, the session's delay, when the lead last changed (performance.now())
    const adapt = { on: opts.adaptive !== false, lead: 0, initial: 0, changedAt: 0, okSince: 0, heardFrame: 0, broken: false };
    const lags = new Map();      // slot -> { worst, periods }: lags of that player's inputs, worst this quarter-second and in the last 16
    const reports = new Map();   // slot -> { lag, at }: that player's latest report on our inputs
    const leads = new Map();     // slot -> [frame, lead]: that player's newest input and the lead it went out with
    const gone = new Set();      // players who left
    let report = null;           // our latest report, sent with the next 'in' message
    let startDelay = 0;
    const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
    const ping = setInterval(() => {
      // in a game, a room connection that has gone quiet (pongs come 4 times a second) is dead even if the
      // browser hasn't noticed yet: drop it and reconnect
      if (started && !closing && ws && ws.readyState === 1 && Date.now() - heard > 5000) abandon();
      send({ t: 'ping', ts: Date.now() });
      for (const p of peers.values()) if (p.dc?.readyState === 'open') p.dc.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
      // direct round trips, for the lobby and the auto delay: sent when one moves by more than 5 ms
      const p2p = {};
      let changed = false;
      for (const [slot, p] of peers) {
        if (!p.rtt) continue;
        p2p[slot] = Math.round(p.rtt);
        if (Math.abs(p2p[slot] - (p2pReported[slot] || 0)) > 5) changed = true;
      }
      if (changed) { Object.assign(p2pReported, p2p); send({ t: 'p2p', rtt: p2p }); }
      if (game && !adapt.broken) {
        try { adaptTick(performance.now()); }
        catch (e) {   // never worse than a fixed delay: back to the session's, and no more adapting
          console.warn('[netplay] adaptive delay off:', e);
          adapt.broken = true;
          report = null;
          try { setLead(adapt.initial, performance.now()); } catch { /* the game is gone */ }
        }
      }
    }, 250);

    function open(url, rejoin) {
      ws = new WebSocket(url);
      heard = Date.now();
      ws.onopen = () => {
        retries = 0;
        heard = Date.now();
        if (rejoin) send({ t: 'rejoin', slot: me, version: opts.version });
        else send({ t: 'hello', name: opts.name, version: opts.version });
        send({ t: 'ping', ts: Date.now() });
      };
      ws.onclose = () => {
        if (started && !closing) { reconnect(); return; }
        if (timer) clearInterval(timer);
        clearInterval(ping);
        for (const p of peers.values()) p.pc?.close();
        opts.onClose?.();
      };
      ws.onerror = () => { if (!started) opts.onError?.('Connection to the game room failed.'); };
      ws.onmessage = (ev) => { heard = Date.now(); onSocketMessage(ev); };
    }
    function abandon() {
      const old = ws;
      old.onclose = old.onmessage = old.onerror = null;
      try { old.close(); } catch { /* already gone */ }
      reconnect();
    }
    async function reconnect() {
      opts.onReconnect?.('connecting');
      await new Promise((r) => setTimeout(r, Math.min(5000, 500 * 2 ** retries++)));
      try { open(opts.reconnectUrl ? await opts.reconnectUrl() : opts.url, true); }
      catch { reconnect(); }
    }

    function onMessage(m, from) {
      if (from && opts.testLoss && Math.random() < opts.testLoss) return;
      if (m.t === 'in') {
        const c = checkIn(m, from);
        if (!c) return;
        if (game) deliver(game, c);
        else if ((earlyN += c.d.length + c.h.length + 1) <= EARLY_MAX) early.push(c);
      }
      else if (m.t === 'ping' && from) from.dc.send(JSON.stringify({ t: 'pong', ts: m.ts }));
      else if (m.t === 'pong') {
        const ms = Date.now() - m.ts;
        if (from) { from.trip.add(ms); from.rtt = from.trip.p90(); }
        else {
          roomTrip.add(ms);
          rtt = roomTrip.p90();
          if (Math.abs(rtt - reported) > 5 || !reported) { reported = rtt; send({ t: 'rtt', ms: rtt }); }
        }
      }
    }

    // ---- direct channels (browser only)
    const webrtc = typeof RTCPeerConnection !== 'undefined';
    function peer(slot) {
      let p = peers.get(slot);
      if (p) return p;
      const pc = new RTCPeerConnection({ iceServers: opts.iceServers || [], iceTransportPolicy: opts.relayOnly ? 'relay' : 'all' });
      p = { slot, pc, dc: null, trip: trip(), rtt: 0, via: '' };
      peers.set(slot, p);
      const use = (dc) => {
        p.dc = dc;
        dc.onopen = () => describePath(slot, p);
        dc.onmessage = (ev) => { try { onMessage(JSON.parse(ev.data), p); } catch { /* bad frame */ } };
      };
      pc.onicecandidate = (ev) => { if (ev.candidate) send({ t: 'sig', to: slot, data: { candidate: ev.candidate.toJSON() } }); };
      pc.ondatachannel = (ev) => use(ev.channel);
      if (me < slot) {   // the lower slot makes the offer
        use(pc.createDataChannel('inputs', { ordered: false, maxRetransmits: 0 }));
        pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => send({ t: 'sig', to: slot, data: { sdp: pc.localDescription.toJSON() } }));
      }
      return p;
    }
    // Logs how a direct channel connected, and keeps it for the status line (p.via): host = on the same
    // network, srflx = straight between the players through their routers, TURN = through a relay server.
    async function describePath(slot, p) {
      try {
        const stats = await p.pc.getStats();
        let pair = null;
        stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
        stats.forEach((r) => { if (!pair && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
        const local = pair && stats.get(pair.localCandidateId), remote = pair && stats.get(pair.remoteCandidateId);
        const a = local?.candidateType || '?', b = remote?.candidateType || '?';
        p.via = a === 'relay' || b === 'relay' ? 'TURN' : a === '?' || b === '?' ? '' : a === 'host' && b === 'host' ? 'host' : 'srflx';
        console.log(`[netplay] direct channel to player ${slot + 1}: ${a} -> ${b}`);
      } catch (e) { console.warn('[netplay] getStats:', e); }
    }
    async function onSignal(from, data) {
      const { pc } = peer(from);
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          send({ t: 'sig', to: from, data: { sdp: pc.localDescription.toJSON() } });
        }
      } else if (data.candidate) await pc.addIceCandidate(data.candidate).catch(() => {});
    }

    function onSocketMessage(ev) {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'lobby') {
        me = m.you;
        lobby = m;
        if (webrtc) {
          const present = new Set(m.players.map((p) => p.slot));
          for (const [slot, p] of peers) if (!present.has(slot)) { p.pc.close(); peers.delete(slot); }
          for (const p of m.players) if (slotOk(p.slot) && p.slot > me) peer(p.slot);
        }
        opts.onLobby?.(m);
      } else if (m.t === 'start') {
        started = true;
        startDelay = m.delay;
        players = Number.isInteger(m.players) && m.players >= 1 && m.players <= MAX_SLOTS ? m.players : 0;
        // the saves every game starts from: the host's own copy, or what this player received and checked
        if (m.files) m.filesBytes = offered?.id === m.files.id ? offered.bytes : received.get(m.files.id) || null;
        if (m.files && !m.filesBytes) {
          // starting without the saves every other game starts from would only part ways with them later
          opts.onError?.('The host\'s saves did not arrive here, so this match can\'t start on this computer. Rejoin and try again.');
          closing = true;
          ws.close();
          return;
        }
        opts.onStart?.(m);
      }
      else if (m.t === 'files') {
        // One bundle at a time, of at most MAX_FILES, in exactly the chunks its size implies: a hostile host
        // (or a hostile room server, through a crafted invite link) can't make this page hold more.
        const n = Math.ceil(m.size / CHUNK);
        if (!(Number.isInteger(m.size) && m.size > 0 && m.size <= MAX_FILES && m.n === n && typeof m.id === 'string' &&
          /^[0-9a-f]{16}$/.test(m.id) && /^[0-9a-f]{64}$/.test(m.hash))) return;
        incoming.clear();
        received.clear();
        incoming.set(m.id, { hash: m.hash, size: m.size, parts: new Array(n), got: 0 });
        opts.onFiles?.(0, m.size);
      } else if (m.t === 'chunk') {
        const f = incoming.get(m.id);
        if (!f || !Number.isInteger(m.k) || m.k < 0 || m.k >= f.parts.length || f.parts[m.k] || typeof m.data !== 'string') return;
        const want = m.k < f.parts.length - 1 ? CHUNK : f.size - CHUNK * (f.parts.length - 1);
        let part = null;
        if (m.data.length === Math.ceil(want / 3) * 4) try { part = b64d(m.data); } catch { /* not base64 */ }
        if (!part || part.length !== want) {
          incoming.delete(m.id);
          opts.onError?.('The host\'s saves arrived damaged; ask them to start again.');
          return;
        }
        f.parts[m.k] = part;
        opts.onFiles?.(++f.got / f.parts.length, f.size);
        if (f.got === f.parts.length) {
          incoming.delete(m.id);
          const bytes = new Uint8Array(f.size);
          let at = 0;
          for (const p of f.parts) { bytes.set(p, at); at += p.length; }
          sha256(bytes).then((h) => {
            if (h !== f.hash) { opts.onError?.('The host\'s saves arrived damaged; ask them to start again.'); return; }
            received.clear();
            received.set(m.id, bytes);
            send({ t: 'files-ok', id: m.id, hash: h });
            opts.onFiles?.(1, f.size, true);
          });
        }
      } else if (m.t === 'files-ok' && m.id === offered?.id) acks.get(m.id)?.add(m.from);
      else if (m.t === 'rejoined') {   // back in the game: resend what may have been lost
        for (const text of history) ws.send(text);
        opts.onReconnect?.('rejoined');
      }
      else if (m.t === 'error') opts.onError?.(m.msg);
      else if (m.t === 'sig' && webrtc && slotOk(m.from) && m.from !== me) onSignal(m.from, m.data).catch((e) => console.warn('webrtc:', e));
      else if (m.t === 'left' && slotOk(m.slot)) { gone.add(m.slot); if (game) game._netplay_player_left(m.slot); opts.onLeft?.(m.slot); }
      else onMessage(m, null);
    }

    // An 'in' message, checked and copied: inputs and hashes only for the other players' slots (over a direct
    // channel, only the sender's own), frames and a lead in range, and a lag report from a player of this game,
    // within a second. The game reads a slot as a 32-bit integer, so 1 + 2^32 would pass there as player 1:
    // unchecked, a hostile peer or room server could make this page keep, time and report on any number of
    // players. Null before our game starts: the room's copy of any input comes after its start message.
    function checkIn(m, from) {
      if (!players) return null;
      const ok = (s) => Number.isInteger(s) && s >= 0 && s < players && s !== me && (!from || s === from.slot);
      const frame = (f) => Number.isInteger(f) && f >= 0 && f <= 0x7fffffff;
      const d = [], h = [];
      if (Array.isArray(m.d)) for (const v of m.d) {
        if (!Array.isArray(v) || !ok(v[0]) || !frame(v[1])) continue;
        const lead = Number.isInteger(v[8]) && v[8] >= 1 && v[8] <= 60 ? v[8] : 0;
        d.push([v[0], v[1], v[2] | 0, v[3] | 0, v[4] | 0, v[5] | 0, v[6] | 0, v[7] >>> 0, lead, v[9] | 0]);
      }
      if (Array.isArray(m.h)) for (const v of m.h) if (Array.isArray(v) && ok(v[0]) && frame(v[1])) h.push([v[0], v[1], v[2] >>> 0, v[3] >>> 0]);
      const said = ok(m.by) && m.lag ? m.lag[me] : undefined;   // the sender's report on our inputs
      return Number.isFinite(said) ? { d, h, by: m.by, lag: Math.max(-1000, Math.min(1000, said)) } : { d, h, by: -1, lag: 0 };
    }
    const slotOk = (s) => Number.isInteger(s) && s >= 0 && s < MAX_SLOTS;

    function deliver(M, c) {
      const now = performance.now();
      for (const [s, f, b, lx, ly, rx, ry, dt, lead, mouse] of c.d) {
        const slack = M._netplay_remote_input(s, f, b, lx, ly, rx, ry, dt, mouse);
        if (!lead) continue;   // an older peer, or an input not to time (host/netplay.c)
        if (f > (leads.get(s)?.[0] || 0)) leads.set(s, [f, lead]);
        if (typeof slack !== 'number' || slack === NO_SLACK) continue;   // a repeat, or an older build
        const lag = lead * FRAME_MS - slack;
        if (lag > 1000) continue;   // an outage or a reconnect, not something a longer lead could cover
        if (!lags.has(s)) lags.set(s, { worst: -Infinity, periods: [] });
        const q = lags.get(s);
        q.worst = Math.max(q.worst, lag);
      }
      for (const [s, f, lo, hi] of c.h) M._netplay_remote_hash(s, f, lo, hi);
      if (c.by >= 0) reports.set(c.by, { lag: c.lag, at: now });
    }

    // Every 250 ms: our report on each player's inputs, then our lead from theirs on ours.
    function adaptTick(now) {
      const lag = {};
      for (const [slot, q] of lags) {
        q.periods.push(q.worst > -Infinity ? q.worst : null);   // null: no inputs this quarter-second
        if (q.periods.length > PERIODS) q.periods.shift();
        q.worst = -Infinity;
        const seen = q.periods.filter((x) => x != null).sort((a, b) => b - a);
        if (seen.length >= MIN_PERIODS) lag[slot] = Math.round(seen[1]);
      }
      report = Object.keys(lag).length ? lag : null;
      if (!adapt.on) return;
      const reps = [];
      for (const [slot, r] of reports)
        if (!gone.has(slot) && now - r.at < 3000) reps.push({ lag: r.lag, mine: lag[slot] ?? null, theirs: leads.get(slot)?.[1] || 0 });
      const frame = game._netplay_status(0);
      if (reps.length) { adapt.heardFrame = frame; setLead(nextLead(adapt, reps, now), now); }
      // nobody reports (an older peer, or the reports stopped) while the game runs: the session's delay
      else if (frame - adapt.heardFrame > 300) setLead(adapt.initial, now);
    }
    function setLead(n, now) {
      if (n === adapt.lead) return;
      game._netplay_set_delay(n);
      adapt.lead = n; adapt.changedAt = now; adapt.okSince = 0;
    }

    // Drains the game's outbox to the room and every open direct channel.
    function pump() {
      if (!game) return;
      const d = [], h = [];
      while (game._netplay_pop()) {
        const v = [];
        for (let i = 0; i < 11; i++) v.push(game._netplay_msg(i));
        // input: slot, frame, buttons (and mouse buttons), axes, frame time (us), lead (frames ahead it went out;
        // 0: don't time it), mouse movement (x in the low 16 bits, y in the high 16)
        if (v[0] === 1) d.push([...v.slice(1, 8), v[8] >>> 0, v[9], v[10]]);
        else if (v[0] === 2) h.push([v[1], v[2], v[8] >>> 0, v[9] >>> 0]);   // hash: slot, frame, lo, hi
      }
      if (!d.length && !h.length) return;
      const text = JSON.stringify({ t: 'in', d, h });
      history.push(text);   // without our report: resent after a reconnect, it would be stale
      if (history.length > HISTORY) history.shift();
      const rep = report && { by: me, lag: report };
      report = null;
      if (ws.readyState === 1) ws.send(rep ? JSON.stringify({ t: 'in', d, h, ...rep }) : text);
      recent.push(...d);
      recent.splice(0, recent.length - REPEAT);
      const direct = JSON.stringify({ t: 'in', d: recent, h, ...rep });
      for (const p of peers.values()) if (p.dc?.readyState === 'open') p.dc.send(direct);
    }

    open(opts.url, false);

    return {
      // files: what offerFiles resolved to, so every game starts from the host's saves
      start(delay, files) { send({ t: 'start', delay, ...(files ? { files } : {}) }); },
      // Host: sends `bytes` (the saves to bring) to every other player in the room and resolves once each
      // has received and checked them: { id, hash, size } for start(). onProgress(fraction sent).
      async offerFiles(bytes, onProgress) {
        if (bytes.length > MAX_FILES) throw new Error(`too big to send (${Math.round(bytes.length / 1e6)} MB)`);
        const hash = await sha256(bytes), id = hash.slice(0, 16), n = Math.max(1, Math.ceil(bytes.length / CHUNK));
        offered = { id, hash, size: bytes.length, bytes };
        acks.clear();
        acks.set(id, new Set());
        send({ t: 'files', id, hash, size: bytes.length, n });
        for (let k = 0; k < n; k++) {
          send({ t: 'chunk', id, k, data: b64e(bytes.subarray(k * CHUNK, (k + 1) * CHUNK)) });
          onProgress?.((k + 1) / n);
          while (ws && ws.readyState === 1 && ws.bufferedAmount > 1 << 20) await new Promise((r) => setTimeout(r, 20));
        }
        const others = () => (lobby?.players || []).filter((p) => p.slot !== me).map((p) => p.slot);
        for (const t0 = Date.now(); ;) {
          if (others().every((s) => acks.get(id).has(s))) return { id, hash, size: bytes.length };
          if (Date.now() - t0 > 60000) throw new Error('your friend did not receive them in time');
          if (!ws || ws.readyState !== 1) throw new Error('the connection to the room dropped');
          await new Promise((r) => setTimeout(r, 100));
        }
      },
      // Hooks a running game up to the room (after it was started with the session's settings).
      // The game thread kicks the pump as soon as it queues a message (host/netplay.c); the timer is a
      // safety net.
      attach(M, pollMs = 8) {
        game = M;
        // a build that can't change its delay (older than this page) keeps the session's
        adapt.on &&= typeof M._netplay_set_delay === 'function' && startDelay > 0;
        adapt.lead = adapt.initial = startDelay;
        M.rcNetplayPump = pump;
        for (const m of early.splice(0)) deliver(M, m);
        timer = setInterval(pump, pollMs);
      },
      close() { closing = true; ws.close(); },
      testDrop() { abandon(); },   // tests: lose the room connection as a network drop would
      rtt: () => rtt,
      direct: () => [...peers.entries()].filter(([, p]) => p.dc?.readyState === 'open').map(([slot]) => slot),
      // for the game's status line: the round trip the inputs are riding on (the slowest direct channel and
      // how it connected, else the room)
      trips: () => {
        const open = [...peers.values()].filter((p) => p.dc?.readyState === 'open');
        const slow = open.reduce((a, p) => (!a || p.rtt > a.rtt ? p : a), null);
        return { room: Math.round(rtt), direct: slow ? Math.round(slow.rtt) : 0, via: slow?.via || '' };
      },
      // and the input delay our inputs go out with (frames), since when (performance.now()), and whether it adapts
      delay: () => ({ frames: adapt.lead || startDelay, changedAt: adapt.changedAt, adaptive: adapt.on && !adapt.broken }),
    };
  }

  // Input delay (frames at 60 Hz) covering the slowest pair of players. An input sent at Present f is
  // needed by the others at their Present f + D - 1, so D - 1 frames must cover the one-way trip (half the
  // direct round trip where there is one, else the two trips to the room) plus up to one frame: each
  // player's Presents follow their own display, and the two displays' phases differ by anything up to a
  // frame (headless peers on one machine showed a 14 ms offset stalling every frame at D = 2). The round
  // trips are 90th percentiles of the lobby's pings, so jitter is already in them; 3 ms covers the rest.
  function autoDelay(players) {
    let oneWay = 0;
    for (const a of players)
      for (const b of players) {
        if (a.slot >= b.slot) continue;
        const direct = Math.max(a.p2p?.[b.slot] || 0, b.p2p?.[a.slot] || 0);
        const viaRoom = ((a.rtt || 0) + (b.rtt || 0)) / 2;
        oneWay = Math.max(oneWay, direct ? Math.min(direct / 2, viaRoom) : viaRoom);
      }
    return Math.max(2, Math.min(30, Math.ceil((oneWay + 3) / (1000 / 60)) + 2));
  }

  // Environment for a peer's game: deterministic simulation, this peer's slot, the session's settings.
  function gameEnv(session) {
    return {
      RC_DETERMINISTIC: '1', RC_NETPLAY: '1', RC_NP_PLAYERS: String(session.players),
      RC_NP_SLOT: String(session.you), RC_NP_DELAY: String(session.delay), RC_PADS: String(session.players),
    };
  }

  const api = { connect, gameEnv, autoDelay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RcNetplay = api;
})(typeof self !== 'undefined' ? self : this);
