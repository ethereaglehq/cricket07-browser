// Stand-in for build/recomp.js (the recompiled game), for testing the page without the game.
//
// It exposes what web/loader.js and web/netplay.js use from the real build: createRecomp(), the rc_*
// render and audio exports, the input_* exports and the netplay_* exports of host/netplay.c. Like the game
// it starts from the folder the page copied into OPFS, keeps its saves under userdata/ in OPFS (where
// host/misc.c maps "My Documents"), and online it runs the same lockstep as host/netplay.c: at each
// Present f the local pad becomes the input for frame f + D, and frame f + 1 only runs once every player's
// input for it is known. Its "game state" is a hash of every input applied, so a desync shows.
//
// Test hooks on the module: _test_save(rel, text) writes a save file, _test_files() lists the game folder,
// _test_hang() stops presenting frames (a frozen game) and _test_unhang() resumes, _test_info() returns state for
// assertions. Failures as the real build reports them: _test_print(text) prints on the engine's stderr,
// _test_abort(what) is an abort on an engine thread (Emscripten prints "Aborted(...)" and calls onAbort),
// _test_worker_error(message, print) is a trap in a worker (Emscripten prints "worker sent an error!" unless
// print is false, then the error reaches the page), _test_throw_pump(n) makes the next n frame pumps throw.
// With RC_LOG_FPS (?fps) it prints [fps] and [mem] lines like host/d3d8.c.
'use strict';

async function createRecomp(opts) {
  const m = { ENV: {} };
  for (const f of opts.preRun || []) f(m);
  const ENV = m.ENV;
  const root = await navigator.storage.getDirectory();
  const opfs = (p) => p.replace(/^\/opfs\/?/, '');
  const log = (t) => (opts.print || console.log)(`[fake] ${t}`);

  // the game folder: missing executable = the real loader's load_image failure
  const game = await root.getDirectoryHandle(opfs(opts.arguments?.[0] || '/opfs/rcgame'));
  const exe = ENV.RC_EXE || 'game.exe';
  await game.getFileHandle(exe).catch(() => { throw new Error(`fake engine: no ${exe} in the game folder`); });
  const user = await root.getDirectoryHandle(ENV.RC_USERDATA ? opfs(ENV.RC_USERDATA) : 'userdata', { create: true });
  const DOCS = ['Documents and Settings', 'Player', 'My Documents', 'EA Sports Cricket 07'];

  async function writeFile(dir, rel, data) {
    const parts = rel.split('/');
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    await w.write(data);
    await w.close();
  }
  async function listFiles(dir, prefix = '') {
    const out = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') out.push(...await listFiles(h, prefix + name + '/'));
      else out.push({ path: prefix + name, size: (await h.getFile()).size });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }
  // what the game reads at start: every file of the folder by size, so tests can see a patch arrive
  const gameFiles = await listFiles(game);
  const savesAtStart = await listFiles(user);
  // like the game on first start: its own folder under My Documents
  await writeFile(user, [...DOCS, 'Settings.dat'].join('/'), 'fake settings\n');
  log(`started: ${gameFiles.length} game files, ${savesAtStart.length} saved files, userdata ${ENV.RC_USERDATA || '/opfs/userdata'}`);

  // ---- netplay: the lockstep of host/netplay.c
  const net = ENV.RC_NETPLAY && ENV.RC_DETERMINISTIC ? {
    players: Number(ENV.RC_NP_PLAYERS || 2), slot: Number(ENV.RC_NP_SLOT || 0), delay: Number(ENV.RC_NP_DELAY || 4),
    warmup: Number(ENV.RC_NP_DELAY || 4), lastSent: 0, inputs: [], left: [], out: [], popped: Array(11).fill(0),
    myHash: new Map(), theirHash: [], desync: 0, waitMs: 0, stalls: 0, waitingSince: 0, ranAt: 0,
  } : null;
  const FRAME_MS = 1000 / 60, NO_SLACK = -2147483648;
  if (net) for (let s = 0; s < 4; s++) { net.inputs.push(new Map()); net.left.push(false); net.theirHash.push(new Map()); }
  let local = { buttons: 0, axis: [0, 0, 0, 0] }, pressed = 0;
  // the mouse: online, like host/netplay.c, everyone's movement moves the one cursor and a button is down while
  // anyone holds it (mouse: movement and buttons not sent yet); the cursor and its clicks are game state
  const mouse = { dx: 0, dy: 0, held: 0, pressed: 0 }, cursor = { x: 320, y: 240, down: 0, clicks: 0 };
  const moveCursor = (dx, dy) => { cursor.x = Math.max(0, Math.min(639, cursor.x + dx)); cursor.y = Math.max(0, Math.min(479, cursor.y + dy)); };
  const pressCursor = (b) => { if (b & 1 & ~cursor.down) cursor.clicks++; cursor.down = b; };
  const pads = [];
  let frame = 0, hashLo = 0x811c9dc5, hashHi = 0x01000193, hung = false;
  const mix = (v) => {
    hashLo = Math.imul(hashLo ^ (v >>> 0), 16777619) >>> 0;
    hashHi = Math.imul(hashHi ^ ((v >>> 0) + 0x9e3779b9), 2246822519) >>> 0;
  };

  function push(msg) {
    net.out.push(msg);
    M.rcNetplayPump?.();
  }
  const have = (s, f) => f <= net.warmup || net.left[s] || net.inputs[s].has(f);

  // At Present `frame`: our input for frame + D (and, if D grew, for the frames in between; nothing if D shrank
  // and that frame went out already), each with how far ahead it went out, then a hash.
  function present() {
    if (!net) return;
    const target = frame + net.delay;
    if (target > net.lastSent) {
      const buttons = (local.buttons | pressed | (mouse.held | mouse.pressed) << 21) >>> 0;
      const moved = (mouse.dx & 0xffff) | (mouse.dy << 16);
      pressed = mouse.pressed = mouse.dx = mouse.dy = 0;
      const first = Math.max(net.lastSent + 1, net.warmup + 1);
      for (let f = first; f <= target; f++) {
        const m = f === first ? moved : 0;   // the movement once
        net.inputs[net.slot].set(f, { buttons, axis: [...local.axis], mouse: m });
        push([1, net.slot, f, buttons, ...local.axis, net.slot === 0 ? 16667 : 0, f - frame, m]);
      }
      net.lastSent = target;
    }
    if (frame % 60 === 0) {
      net.myHash.set(frame, [hashLo, hashHi]);
      push([2, net.slot, frame, 0, 0, 0, 0, 0, hashLo, hashHi, 0]);
      for (let s = 0; s < net.players; s++) check(s, frame);
    }
  }
  function check(s, f) {
    const mine = net.myHash.get(f), theirs = net.theirHash[s].get(f);
    if (mine && theirs && (mine[0] !== theirs[0] || mine[1] !== theirs[1]) && !net.desync) {
      net.desync = f;
      log(`DESYNC with player ${s} at frame ${f}`);
    }
  }

  // One game frame: online only once everyone's input for it is known (else 0: still waiting).
  function step() {
    if (hung) return 0;
    const next = frame + 1;
    if (net) {
      for (let s = 0; s < net.players; s++) {
        if (have(s, next)) continue;
        net.waitingSince ||= performance.now();
        return 0;
      }
      if (net.waitingSince) {
        const waited = performance.now() - net.waitingSince;
        net.waitMs += waited;
        if (waited > 10) net.stalls++;
        net.waitingSince = 0;
      }
      let mx = 0, my = 0, mb = 0;
      for (let s = 0; s < net.players; s++) {
        const e = next > net.warmup && !net.left[s] && net.inputs[s].get(next);
        mix(e ? e.buttons : 0);
        for (const a of e ? e.axis : [0, 0, 0, 0]) mix(a);
        if (e) { mx += (e.mouse << 16) >> 16; my += e.mouse >> 16; mb |= (e.buttons >>> 21) & 7; }
        net.inputs[s].delete(next - 512);
      }
      moveCursor(mx, my);
      pressCursor(mb);
      mix(cursor.x); mix(cursor.y); mix(cursor.clicks);
      net.ranAt = performance.now();
    } else for (const p of pads) mix(p.buttons);
    frame = next;
    present();
    if (ENV.RC_LOG_FPS && frame % 60 === 0) {   // what host/d3d8.c prints every 2 s with RC_LOG_FPS
      errLine(`[fps] 60.0  (frame ${frame}, 120 draws in the last frame)`);
      errLine(`[mem] guest heap ${100 + (frame >> 6)} MB (3 MB in free blocks), virtual allocations 580 MB (560 MB live), ` +
        `GPU textures 210 MB, bind groups made 1234; frame ${frame}, COM objects 2100, sound buffers 40, threads 6 of 9 ` +
        'running, code regions 12, import slots 712, heaps created 1 destroyed 0');
    }
    return 1;
  }
  const errLine = (t) => (opts.printErr || console.log)(t);

  let ctx = null;
  function draw() {
    if (!ctx) return;
    const c = ctx.canvas;
    ctx.fillStyle = '#0b3d1e';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.round(c.height / 20)}px sans-serif`;
    ctx.fillText(`Stand-in engine · frame ${frame}`, 20, c.height / 8);
    ctx.fillText(net ? `online · player ${net.slot + 1} · delay ${net.delay}` : 'solo', 20, c.height / 8 * 2);
    ctx.fillText(`${gameFiles.length} game files · state ${hashLo.toString(16)}`, 20, c.height / 8 * 3);
    ctx.fillText(`mouse clicks ${cursor.clicks}`, 20, c.height / 8 * 4);
    const x = cursor.x * c.width / 640, y = cursor.y * c.height / 480, r = c.height / 40;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 2 * r); ctx.lineTo(x + 1.3 * r, y + 1.4 * r); ctx.closePath(); ctx.fill();
  }

  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  new Uint32Array(memory.buffer).set([0, 0, 44100, 1024]);   // an empty audio ring (host/dsound.c layout)

  let saveCount = 0, pumps = 0, throwPumps = 0, keys = 0;
  const M = {
    wasmMemory: memory,
    _rc_audio_ring: () => 0,
    _rc_gpu_init(w, h) {
      const c = document.getElementById('canvas');
      ctx = c.getContext('2d');
      c.width = w; c.height = h;
    },
    _rc_set_canvas_size(w, h) { if (ctx) { ctx.canvas.width = w; ctx.canvas.height = h; } },
    _rc_gpu_pump(present) {
      pumps++;
      if (!present) return 0;
      if (throwPumps > 0) { throwPumps--; throw new Error('stand-in: the frame pump failed'); }
      const ok = step();
      if (ok) draw();
      return ok;
    },
    _input_key_hid(usage, down) {
      keys++;
      // S in solo play: the game writes a save (its Load / Save screen)
      if (usage === 22 && down && !net) M._test_save(`Saves/save-${++saveCount}.sav`, `save ${saveCount} at frame ${frame}\n`);
    },
    _input_mouse_button(b, down) {
      if (b < 0 || b > 2) return;
      if (net) { if (down) { mouse.held |= 1 << b; mouse.pressed |= 1 << b; } else mouse.held &= ~(1 << b); }
      else pressCursor(down ? cursor.down | 1 << b : cursor.down & ~(1 << b));
    },
    _input_mouse_move(dx, dy) {
      if (net) { mouse.dx = Math.max(-32768, Math.min(32767, mouse.dx + dx)); mouse.dy = Math.max(-32768, Math.min(32767, mouse.dy + dy)); }
      else moveCursor(dx, dy);
    },
    _input_gamepad(idx, connected, buttons, lx, ly, rx, ry) {
      if (net) {
        if (idx !== 0) return;
        local = { buttons: connected ? buttons : 0, axis: connected ? [lx, ly, rx, ry] : [0, 0, 0, 0] };
        pressed |= local.buttons;
      } else pads[idx] = { buttons, axis: [lx, ly, rx, ry] };
    },
    _netplay_pop() {
      if (!net || !net.out.length) return 0;
      net.popped = net.out.shift();
      return 1;
    },
    _netplay_msg: (i) => (net && i >= 0 && i < 11 ? net.popped[i] | 0 : 0),
    // Like host/netplay.c: how early the input came (ms before it's needed, negative if the stand-in was already
    // waiting for it), or NO_SLACK for a repeat or a frame already played. The stand-in runs a frame per
    // animation frame, so it needs frame + 1 at the first one after the last frame it ran.
    _netplay_remote_input(s, f, b, lx, ly, rx, ry, dt, mouse = 0) {
      if (!net || s < 0 || s >= net.players || s === net.slot || net.inputs[s].has(f) || f <= frame) return NO_SLACK;
      net.inputs[s].set(f, { buttons: b, axis: [lx, ly, rx, ry], mouse: mouse | 0 });
      if (!frame) return NO_SLACK;
      const now = performance.now();
      const need = (net.waitingSince || Math.max(now, net.ranAt + FRAME_MS)) + (f - frame - 1) * FRAME_MS;
      return Math.trunc(need - now);
    },
    _netplay_remote_hash(s, f, lo, hi) {
      if (!net || s < 0 || s >= 4) return;
      net.theirHash[s].set(f, [lo >>> 0, hi >>> 0]);
      check(s, f);
    },
    _netplay_player_left(s) { if (net && s >= 0 && s < 4) net.left[s] = true; },
    // host/netplay.c's netplay_status: frame, ms waited, desync frame, stalls, blocked on input now, delay now
    _netplay_status: (what) => (!net ? 0 : [frame, Math.round(net.waitMs), net.desync, net.stalls, net.waitingSince ? 1 : 0, net.delay][what] ?? 0),
    _netplay_set_delay(d) { if (net && d >= 1 && d <= 60) net.delay = d; },

    async _test_save(rel, text) { await writeFile(user, [...DOCS, rel].join('/'), text); },
    _test_files: () => gameFiles,
    _test_saves_at_start: () => savesAtStart,
    _test_hang() { hung = true; if (net) net.waitingSince = 0; },   // stuck, not waiting for other players
    _test_unhang() { hung = false; },
    _test_print(text) { for (const line of String(text).split('\n')) errLine(line); },
    _test_abort(what) { hung = true; errLine(`Aborted(${what})`); opts.onAbort?.(what); },
    _test_worker_error(message, print = true) {
      hung = true;
      if (print) errLine(`worker sent an error! ${location.origin}/build/recomp.js:1: Uncaught RuntimeError: ${message}`);
      setTimeout(() => { throw new WebAssembly.RuntimeError(message); });
    },
    _test_throw_pump(n = 1) { throwPumps = n; },
    _test_mouse: () => ({ ...cursor, frame }),
    _test_info: () => ({ frame, pumps, keys, hash: [hashLo, hashHi], net: net && { slot: net.slot, delay: net.delay, stalls: net.stalls, desync: net.desync, lastSent: net.lastSent } }),
  };
  return M;
}
