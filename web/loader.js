// Cricket 07 in the browser: copies the player's own game folder into OPFS (once; it never leaves the
// computer), starts the recompiled build (build/recomp.js), replays its frames with WebGPU and feeds it
// input and audio.
//
// URL options: ?mute (no audio) ?fps (frame rate in the console) ?log (host log) ?autoplay
//              ?exe=<name> (the executable inside the game folder, if not the profile's default)
//              ?pads=N (game controllers to expose, default 1, at most 4)
//              ?queue=1 (frames queued ahead of the display, default 2: 1 cuts 16 ms of input latency online
//              on a machine that simulates a frame well within 16 ms, else it hitches)
//              ?netplay=<url> (the room server for online play, see server/; default: this page's origin)
//              ?join=<room code>
//              ?watchdog=N (seconds without a new frame before the page offers a restart, default 15; 0: never)
//              ?adaptive=0 (online: keep the input delay the game started with, instead of adapting it to
//              the connection as it goes)
//
// Online play (netplay.js, host/netplay.c): players meet in a room on the server; when the host starts,
// every page boots the game in deterministic lockstep mode with fresh saves, and only pad inputs travel.
// Each player's keyboard and first gamepad merge into one local pad; mouse and raw keys are off.
'use strict';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const OPFS_DIR = 'rcgame';
const MARKER = '.installed.json';   // { version } once every file is copied
const NETPLAY_BASE = new URL(params.get('netplay') || './', location.href).href.replace(/\/?$/, '/');
const status = (t) => { $('status').textContent = t; };
// the launcher's screens (index.html): loading, home, online, lobby
const show = (view) => { for (const v of document.querySelectorAll('#panel .view')) v.classList.toggle('hidden', v.id !== 'view-' + view); };
const fail = (e) => { status('Error: ' + e.message); $('panel').classList.remove('hidden'); show('loading'); };
const mb = (n) => (n / 1e6).toFixed(0);

// ------------------------------------------------------------------ game files in OPFS

async function gameDir(create) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create });
}

async function readMarker() {
  try {
    const f = await (await (await gameDir(false)).getFileHandle(MARKER)).getFile();
    return JSON.parse(await f.text());
  } catch { return null; }
}

async function writeMarker(version) {
  const fh = await (await gameDir(true)).getFileHandle(MARKER, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify({ version, at: new Date().toISOString() }));
  await w.close();
}

async function fileHandle(dir, relPath, create) {
  const parts = relPath.split('/');
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return dir.getFileHandle(parts[parts.length - 1], { create });
}

async function importFromPicker(fileList) {
  // the whole folder, minus its own name: <picked>/a/b.dat -> a/b.dat
  const list = [...fileList].map((f) => ({ f, dest: f.webkitRelativePath.split('/').slice(1).join('/') }))
    .filter((e) => e.dest);
  if (!list.some((e) => e.dest.toLowerCase().endsWith('.exe'))) throw new Error('No .exe in that folder.');
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry(OPFS_DIR, { recursive: true }); } catch {}
  await patches.forget();   // patches belonged to the folder copied before
  await navigator.storage.persist?.();
  const dir = await gameDir(true);
  const total = list.reduce((s, e) => s + e.f.size, 0);
  let done = 0;
  $('progress').classList.remove('hidden');
  for (const e of list) {
    status(`Copying ${e.dest} (${mb(done)} / ${mb(total)} MB)`);
    const w = await (await fileHandle(dir, e.dest, true)).createWritable();
    await w.write(e.f);
    await w.close();
    done += e.f.size;
    $('progress').value = done / total;
  }
  const sig = list.map((e) => `${e.dest}:${e.f.size}`).sort().join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sig));
  await writeMarker([...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join(''));
  $('progress').classList.add('hidden');
}

// ------------------------------------------------------------------ input

// KeyboardEvent.code -> USB HID usage (what host/input.c's key table uses)
const HID = {};
for (let i = 0; i < 26; i++) HID['Key' + String.fromCharCode(65 + i)] = 4 + i;
for (let i = 1; i <= 9; i++) HID['Digit' + i] = 29 + i;
HID.Digit0 = 39;
Object.assign(HID, {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48,
  Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
  PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78,
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85,
  NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88, Numpad0: 98, NumpadDecimal: 99,
  ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227, ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
});
for (let i = 1; i <= 12; i++) HID['F' + i] = 57 + i;
for (let i = 1; i <= 9; i++) HID['Numpad' + i] = 88 + i;

// Netplay: the keyboard drives this player's pad (the game itself gets no keys or mouse, which would desync).
// Bit 4 is LB, which the game sees as L1: its modifier for lofted shots (the in-game tutorial: "L1 + shot
// button" to hit a six; on the keyboard that's Shift), so Shift holds it as well as Q. The game pauses only
// on the keyboard's Esc, not the pad's Start, so Esc is bit 20: host/netplay.c applies it to the DirectInput
// keyboard on every peer, with the pad inputs (NP_KEY_ESC). Backspace is B, back in menus.
const NET_KEYS = {   // KeyboardEvent.code -> standard-gamepad bit (20: Esc key)
  Enter: 0, Space: 0, KeyS: 0, Escape: 20, Backspace: 1, KeyD: 1, KeyA: 2, KeyW: 3, KeyQ: 4, KeyE: 5,
  ShiftLeft: 4, ShiftRight: 4,
  Digit1: 6, Digit3: 7, Tab: 8, KeyP: 9, ArrowUp: 12, ArrowDown: 13, ArrowLeft: 14, ArrowRight: 15,
};
let netKeyBits = 0;
let netKeyPressed = 0;   // keys pressed since the last poll, so a tap shorter than a frame still counts

// Nothing reaches a game that has stopped. While the overlay saying so is up, presses go to its buttons
// instead; releases still reach the game, so no key stays held.
const pressOff = (down) => engineDead || (down && haltMode);

function hookInput(M, net) {
  const canvas = $('canvas');
  if (net) {
    const key = (down) => (e) => {
      const bit = NET_KEYS[e.code];
      if (bit === undefined || pressOff(down)) return;
      if (!haltMode) e.preventDefault();
      if (down) { netKeyBits |= 1 << bit; netKeyPressed |= 1 << bit; } else netKeyBits &= ~(1 << bit);
      pollLocalPad(M);   // straight to the game: waiting for the next animation frame would add up to 16 ms
    };
    window.addEventListener('keydown', key(true));
    window.addEventListener('keyup', key(false));
    window.addEventListener('blur', () => { netKeyBits = 0; if (!engineDead) pollLocalPad(M); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    return;
  }
  const key = (down) => (e) => {
    const u = HID[e.code];
    if (u === undefined || e.repeat || pressOff(down)) return;
    if (!haltMode && !(e.metaKey && !down)) e.preventDefault();
    M._input_key_hid(u, down ? 1 : 0);
  };
  window.addEventListener('keydown', key(true));
  window.addEventListener('keyup', key(false));
  // The game draws its own cursor and reads relative motion. Lock the pointer when the browser allows
  // it (then the system cursor can't leave the game); without a lock, motion over the canvas still works.
  canvas.addEventListener('mousedown', (e) => {
    if (pressOff(true)) return;
    if (document.pointerLockElement !== canvas) {
      const p = canvas.requestPointerLock?.();
      if (p && p.catch) p.catch(() => {});
    }
    M._input_mouse_button([0, 2, 1][e.button] ?? 0, 1);
  });
  window.addEventListener('mouseup', (e) => { if (!engineDead) M._input_mouse_button([0, 2, 1][e.button] ?? 0, 0); });
  canvas.addEventListener('mousemove', (e) => { if (!pressOff(true)) M._input_mouse_move(e.movementX, e.movementY); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Gamepads (Gamepad API, polled every animation frame). Browsers only expose a pad after a button press
// on it. The game sees each pad as a DirectInput "Logitech Dual Action USB" (host/dinput.c); ?pads=N exposes
// N of them (default 1, at most 4). Like the native feeder (host/window.c), slots are DirectInput pad
// numbers handed out in connection order, not the browser's gamepad.index (which can start above 0, e.g.
// after a reconnect), and a pad keeps its slot until it is unplugged.
// With mapping 'standard' buttons and axes are already in the layout input_gamepad() takes. Other pads
// (older DirectInput-era ones such as the Logitech Precision) report buttons in HID order, as Windows
// DirectInput presents them and as the game's controltypes.csv expects; their axes are indexed by HID
// usage (X Y Z Rx Ry Rz ...), so the right stick is Z/Rz and Chrome puts the hat switch at axes[9].
const PAD_SLOTS = 4;
const padLast = Array.from({ length: PAD_SLOTS }, () => '');
const padSlotIndex = Array(PAD_SLOTS).fill(-1);   // slot -> gamepad.index
const padHats = new Set();   // gamepad.index of pads whose axes[9] is a hat switch
// raw button n -> standard-layout bit that host/dinput.c turns back into DirectInput button n
const STD_FOR_RAW = [2, 0, 1, 3, 4, 5, 6, 7, 9, 8, 10, 11];
// Chrome's hat axis: -1 = up, then clockwise in steps of 2/7; anything outside [-1, 1] is centred
const HAT_DIRS = [1 << 12, (1 << 12) | (1 << 15), 1 << 15, (1 << 13) | (1 << 15), 1 << 13, (1 << 13) | (1 << 14), 1 << 14, (1 << 12) | (1 << 14)];
const axis16 = (v) => Math.round(Math.max(-1, Math.min(1, v || 0)) * 32767);

function readPad(g) {
  let buttons = 0;
  if (g.mapping === 'standard') {
    g.buttons.forEach((b, i) => { if (i < 17 && (b.pressed || b.value > 0.3)) buttons |= 1 << i; });
    return { buttons, ax: [0, 1, 2, 3].map((i) => axis16(g.axes[i])) };
  }
  g.buttons.forEach((b, i) => { if (i < STD_FOR_RAW.length && (b.pressed || b.value > 0.3)) buttons |= 1 << STD_FOR_RAW[i]; });
  // axes[9] is only taken as a hat once it has shown the centred value, so a plain axis resting at 0 isn't
  // read as d-pad down
  const hat = g.axes[9];
  if (hat > 1.1) padHats.add(g.index);
  else if (padHats.has(g.index) && hat >= -1.01) buttons |= HAT_DIRS[Math.round((hat + 1) * 3.5) % 8];
  const ry = g.axes.length > 5 ? g.axes[5] : g.axes[3];
  return { buttons, ax: [axis16(g.axes[0]), axis16(g.axes[1]), axis16(g.axes[2]), axis16(ry)] };
}

// Netplay: one local pad, the first connected gamepad merged with the keyboard (host/netplay.c sends it).
// Called from the key handlers and from a 1 ms timer (not just the animation frame), so a change reaches
// the game thread within a few ms wherever it is in its frame.
let netLast = '';
function pollLocalPad(M) {
  const g = (navigator.getGamepads ? [...navigator.getGamepads()] : []).find((p) => p && p.connected);
  const { buttons, ax } = g ? readPad(g) : { buttons: 0, ax: [0, 0, 0, 0] };
  const b = buttons | netKeyBits | netKeyPressed;
  netKeyPressed = 0;
  const key = `${b}:${ax.join(',')}`;
  if (key === netLast) return;
  netLast = key;
  M._input_gamepad(0, 1, b, ax[0], ax[1], ax[2], ax[3]);
}

function pollGamepads(M) {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((g) => g && g.connected) : [];
  // free the slots of unplugged pads, then give new pads the lowest free slot
  for (let s = 0; s < PAD_SLOTS; s++)
    if (padSlotIndex[s] >= 0 && !pads.some((g) => g.index === padSlotIndex[s])) { padHats.delete(padSlotIndex[s]); padSlotIndex[s] = -1; }
  for (const g of pads) {
    if (padSlotIndex.includes(g.index)) continue;
    const s = padSlotIndex.indexOf(-1);
    if (s < 0) break;
    padSlotIndex[s] = g.index;
    console.log(`gamepad ${g.index} -> pad ${s}: ${g.id} (${g.mapping || 'non-standard'} mapping, ${g.buttons.length} buttons, ${g.axes.length} axes)`);
  }
  for (let slot = 0; slot < PAD_SLOTS; slot++) {
    const g = pads.find((p) => p.index === padSlotIndex[slot]);
    const { buttons, ax } = g ? readPad(g) : { buttons: 0, ax: [0, 0, 0, 0] };
    const connected = g ? 1 : 0;
    const key = `${connected}:${buttons}:${ax.join(',')}`;
    if (key === padLast[slot]) continue;
    padLast[slot] = key;
    M._input_gamepad(slot, connected, buttons, ax[0], ax[1], ax[2], ax[3]);
  }
}

// ------------------------------------------------------------------ audio

async function startAudio(M) {
  if (params.has('mute')) return null;
  const ctx = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('audio-worklet.js');
  const node = new AudioWorkletNode(ctx, 'rc-ring', { outputChannelCount: [2] });
  node.port.postMessage({ memory: M.wasmMemory, ring: M._rc_audio_ring() });
  node.connect(ctx.destination);
  const resume = () => { if (!engineDead) ctx.resume(); };
  window.addEventListener('pointerdown', resume);
  window.addEventListener('keydown', resume);
  return ctx;
}

// ------------------------------------------------------------------ run

function sizeCanvas() {
  const canvas = $('canvas');
  const r = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(640, Math.round(r.width * dpr));
  canvas.height = Math.max(480, Math.round(r.height * dpr));
}

// A netplay session: every peer starts from the same empty saves folder, kept apart from this browser's
// normal saves (one per player slot, so two tabs of one browser can play each other).
const netSaves = (session) => `rcnetplay-${session.you}`;
async function clearNetSaves(session) {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry(netSaves(session), { recursive: true }); } catch { /* not there yet */ }
}

function showNetStatus(M, session) {
  const el = $('netstatus');
  el.classList.remove('hidden');
  let lastFrame = 0, lastT = performance.now();
  const stallLog = [];   // [time, stalls so far], a minute of them
  setInterval(() => {
    if (engineDead) { el.classList.add('hidden'); return; }
    const frame = M._netplay_status(0), desync = M._netplay_status(2), stalls = M._netplay_status(3);
    const now = performance.now();
    // the game thread always idles until the next frame's inputs arrive; it's only "waiting" when that
    // holds the game below full speed
    const fps = ((frame - lastFrame) * 1000) / Math.max(1, now - lastT);
    lastFrame = frame; lastT = now;
    el.classList.toggle('bad', !!desync);
    // the input delay (it adapts to the connection: netplay.js), the path the inputs ride on and its round
    // trip, and how often lately the delay failed to cover it (a stall is a frame that waited over 10 ms for
    // the others' inputs: the game froze that long)
    const delay = session.client.delay();
    const adjusting = delay.changedAt && now - delay.changedAt < 3000 ? ', adjusting' : '';
    const trips = session.client.trips();
    const path = trips.direct ? `direct${trips.via ? ` (${trips.via})` : ''} ${trips.direct} ms` : `through the room ${trips.room} ms`;
    stallLog.push([now, stalls]);
    while (now - stallLog[0][0] > 60000) stallLog.shift();
    const recent = stalls - stallLog[0][1];
    el.textContent = desync ? `Out of sync since frame ${desync}: restart the session`
      : `Online · player ${session.you + 1} of ${session.players}` +
        ` · delay ${delay.frames} frames (${Math.round(delay.frames * 1000 / 60)} ms${adjusting})` +
        ` · ${path}` + (recent ? ` · ${recent} stalls/min` : '') +
        (session.reconnecting ? ' · reconnecting…' : frame > 300 && fps < 50 ? ' · waiting for players' : '') +
        (session.left?.size ? ` · ${session.left.size} left` : '');
  }, 1000);
}

async function run(session) {
  $('panel').classList.add('hidden');
  fullscreenTip();
  // the game has its files open from now on: no other tab may restore saves or change patches until this one closes
  navigator.locks?.request('rc-game-files', () => new Promise(() => {})).catch(() => {});
  if (session) {
    await clearNetSaves(session);
    // the saves the host brought: every game unpacks the same bytes, so all start alike
    if (session.filesBytes) await RcSaves.unpack(session.filesBytes, netSaves(session));
  } else {
    // Ask again for persistent storage, so the browser doesn't evict the saves: Chrome grants it silently
    // once the site is bookmarked or used often, so a later visit can succeed where the first didn't.
    navigator.storage.persist?.().catch(() => {});
    setInterval(() => backupToFolder(false), BACKUP_EVERY_MS);
  }
  sizeCanvas();
  const script = document.createElement('script');
  script.src = 'build/recomp.js';
  await new Promise((ok, fail) => { script.onload = ok; script.onerror = fail; document.head.appendChild(script); });
  const M = await createRecomp({
    arguments: ['/opfs/' + OPFS_DIR],
    print: engineLine,
    printErr: engineLine,
    // Emscripten calls this for an abort on any of the engine's threads (a worker's is forwarded here)
    onAbort: (what) => engineStopped('crash', 'The game crashed.', `Aborted(${what ?? ''})`),
    preRun: [(m) => {
      if (params.has('mute')) m.ENV.RC_NO_AUDIO = '1';
      if (params.get('exe')) m.ENV.RC_EXE = params.get('exe');
      if (params.has('log')) m.ENV.RC_LOG = '1';
      if (params.has('pads')) m.ENV.RC_PADS = params.get('pads');
      if (params.has('queue')) m.ENV.RC_QUEUE = params.get('queue');
      if (session) Object.assign(m.ENV, RcNetplay.gameEnv(session), { RC_USERDATA: '/opfs/' + netSaves(session) });
      m.ENV.RC_LOG_FPS = params.has('fps') ? '1' : '';
      if (!params.has('fps')) delete m.ENV.RC_LOG_FPS;
    }],
  });
  engine = { M, session, audio: null };
  const canvas = $('canvas');
  M._rc_gpu_init(canvas.width, canvas.height);
  new ResizeObserver(() => { sizeCanvas(); if (!engineDead) M._rc_set_canvas_size(canvas.width, canvas.height); }).observe(canvas);
  hookInput(M, !!session);
  if (session) { session.client.attach(M); showNetStatus(M, session); }
  startAudio(M).then((ctx) => { engine.audio = ctx; if (engineDead) ctx?.close(); }).catch((e) => console.warn('audio unavailable:', e));
  const poll = session ? pollLocalPad : pollGamepads;
  // Every call into the engine from here on goes through live(): none once it has stopped, and one that
  // throws is reported (once) without ending the loop it runs in.
  const live = (where, fn) => { if (engineDead) return; try { fn(); } catch (e) { pageError(where, e); } };
  const pump = (present) => { const n = M._rc_gpu_pump(present); if (n) framesPresented(n); return n; };
  // Online, present at most 60 times a second: every Present is a lockstep frame, and the input delay and
  // the time a frame has to simulate are counted in those (netplay.js: autoDelay), so following a 120 Hz
  // display would halve both. Solo play follows the display. A frame is due every 1/60 s, with a little
  // tolerance so a 60 Hz display's own jitter doesn't skip one.
  let due = 0;
  const frame = (t) => {
    if (engineDead) return;
    // the next frame first: an exception below used to end the picture for good, while the game and its
    // sound played on
    requestAnimationFrame(frame);
    live('frame loop', () => {
      poll(M);
      if (!session || t >= due - 4) {
        if (pump(1)) { due = Math.max(due + 1000 / 60, t - 4); }
      } else pump(0);   // mid-frame readbacks only
    });
  };
  requestAnimationFrame(frame);
  // readbacks mid-frame are answered without waiting for vsync; online, the pad is also sampled here
  setInterval(() => live('readback pump', () => { if (session) poll(M); pump(0); }), 1);
  // Online, a hidden tab still has to present frames (browsers pause requestAnimationFrame there), or the
  // lockstep would freeze every other player with it.
  if (session) setInterval(() => { if (document.hidden) live('hidden-tab frames', () => { poll(M); pump(1); }); }, 16);
  watchdog(M, session);
  canvas.focus();
  window.recomp = M;
}

async function boot() {
  if (!crossOriginIsolated) { status('This page needs cross-origin isolation (COOP/COEP headers; see web/serve.py).'); return; }
  if (!navigator.gpu) { status('This browser has no WebGPU. Use a current Chrome, Edge or Safari.'); return; }
  // navigator.gpu can exist with no usable adapter (GPU or driver blocklisted, hardware acceleration off,
  // Remote Desktop / VM): say so instead of starting a game that can only show a black screen
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null) ||
    await navigator.gpu.requestAdapter().catch(() => null) ||
    await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }).catch(() => null);
  if (!adapter) {
    const firefox = /Firefox\//.test(navigator.userAgent);
    status('WebGPU is switched on in this browser but it found no usable graphics adapter. ' +
      (firefox ? 'Firefox only enables WebGPU for some GPUs and drivers (see about:support, "WebGPU"); Chrome or Edge usually work. '
        : 'Check that hardware acceleration is on in the browser settings and the graphics driver is up to date. ') +
      'Remote Desktop and virtual machines often have no GPU for the browser.');
    return;
  }
  gpuInfo = describeAdapter(adapter);
  if (adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter)
    console.warn('WebGPU: only a software (fallback) adapter is available; the game will be slow');
  if (!navigator.storage?.getDirectory) { status('This browser has no Origin Private File System.'); return; }
  let onlineReady = false;
  const goOnline = () => {
    if (!onlineReady) { setupOnline(); onlineReady = true; }
    show('online');
    ($('np-code').value ? $('np-join') : $('np-name')).focus();
  };
  const ready = () => {
    show('home');
    showSaves();
    backupToFolder(false);   // what the last session saved, if a backup folder is set up and allowed
    if (params.get('join')) goOnline();   // an invite link goes straight to joining
    if (params.has('autoplay')) $('play').click();
  };
  setupSaves();
  setupPatches();
  $('play').onclick = () => run().catch(fail);
  $('go-online').onclick = goOnline;
  for (const b of document.querySelectorAll('[data-go]')) b.onclick = () => show(b.dataset.go);
  $('folder').onchange = async (e) => {
    $('pick').classList.add('hidden');
    try { await importFromPicker(e.target.files); ready(); }
    catch (err) { status(err.message); $('pick').classList.remove('hidden'); }
  };
  const showPicker = (msg) => {
    status(msg);
    $('pick').classList.remove('hidden');
    $('help').classList.remove('hidden');
  };

  $('reset').onclick = (e) => { e.preventDefault(); show('loading'); showPicker('Choose your Cricket 07 folder.'); };
  if (!(await readMarker())) {
    showPicker('Choose your Cricket 07 folder to start.');
    return;
  }
  ready();
}

// ------------------------------------------------------------------ when the game stops

// When one of the engine's threads aborted or trapped, the page went on showing the last frame (often with the
// sound still playing) and logged a line. Now it notices: Emscripten's onAbort, an engine error reaching the page,
// or a line the engine prints just before it gives up. Then it stops calling into the engine (a call waiting on a
// lock the dead thread held would hang the tab) and says what happened, with Restart. A watchdog does the same
// for a game that stops presenting frames without a word. Either way the player can copy a diagnostics report.
const WATCHDOG_MS = (params.has('watchdog') ? Number(params.get('watchdog')) || 0 : 15) * 1000;
// What the engine prints when it can't go on (each is followed by an abort or a trap), as a player reads it.
const FATAL_LINES = [
  [/guest heap exhausted/, 'The game ran out of memory.'],
  [/too many live COM objects|^out of handles/, 'The game ran out of resources.'],
  [/\*\*\* guest trap|guest write of .* outside guest memory/, 'The game hit an error it can’t recover from.'],
  [/^\[wgpu\] device lost/, 'The browser lost the graphics device: the graphics driver restarted, or the GPU ran out of memory.'],
  [/^\[sched\] deadlock/, 'The game got stuck.'],
  [/sent an error!|^Aborted\(/, 'The game crashed.'],
  [/^\[kernel32\] FatalAppExit/, 'The game stopped with an error.'],
  [/^\[kernel32\] (ExitProcess|TerminateProcess)|^game returned/, 'The game has closed.', 'exit'],
];

let engine = null;       // { M, session, audio } once the game runs
let engineDead = null;   // { why, detail } once it has stopped: nothing calls into it any more
let haltMode = null;     // the overlay: null (hidden), 'stall', 'crash' or 'exit'
const health = { started: performance.now(), frames: 0, lastFrameAt: performance.now(), netFrame: 0 };
let gpuInfo = 'not checked';

// The engine's console output, kept for the diagnostics: the last lines, its memory reports ([mem], with ?fps or
// ?log) and whatever looks like trouble.
const recent = [], memLines = [], errorLines = [];
const keep = (list, line, n) => { list.push(line); if (list.length > n) list.shift(); };
const noteError = (line) => keep(errorLines, `${(performance.now() / 1000).toFixed(1)} s: ${line}`, 40);

function engineLine(text) {
  const line = String(text);
  console.log(line);
  keep(recent, line, 200);
  if (line.startsWith('[mem]')) keep(memLines, line, 6);
  else if (/error|fail|exhausted|trap|abort|lost|full|too many|not supported|out of |can't/i.test(line)) noteError(line);
  for (const [re, why, mode] of FATAL_LINES) if (re.test(line)) { engineStopped(mode || 'crash', why, line.trim()); break; }
}

function engineStopped(mode, why, detail) {
  if (engineDead) return;
  engineDead = { why, detail };
  console.error(`[page] the game has stopped: ${detail || why}`);
  noteError(`the game stopped: ${detail || why}`);
  if (engine) {
    engine.audio?.close().catch(() => {});
    // online, leave the room: the others' games carry on with this player's pad at rest
    if (engine.session) { engine.M.rcNetplayPump = null; engine.session.client.close(); }
  }
  halt(mode, why, detail);
}

// An exception in a loop that calls the engine: reported once per loop, counted after that.
const pageErrors = new Map();
function pageError(where, e) {
  const seen = pageErrors.get(where);
  if (seen) { seen.count++; return; }
  pageErrors.set(where, { count: 1, message: String(e?.stack || e) });
  console.error(`[page] ${where} failed (reported once; it goes on): ${e?.stack || e}`);
  noteError(`${where}: ${e?.message || e}`);
}

function framesPresented(n) {
  health.frames += n;
  health.lastFrameAt = performance.now();
  if (haltMode === 'stall') unhalt();   // it recovered by itself
}

// Errors that reach the page: the engine's own (a trap or an abort in WebAssembly, a worker's error) stop the
// game; others are only noted for the diagnostics.
function pageLevelError(err, message) {
  const msg = String(message || err?.message || err);
  noteError(`page: ${msg}`);
  const fromEngine = (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) ||
    (typeof ErrorEvent !== 'undefined' && err instanceof ErrorEvent) || /RuntimeError|Aborted\(|sent an error/.test(msg);
  if (engine && fromEngine) engineStopped('crash', 'The game crashed.', msg);
}
window.addEventListener('error', (e) => pageLevelError(e.error, e.message));
window.addEventListener('unhandledrejection', (e) => pageLevelError(e.reason));

function halt(mode, why, detail) {
  if (haltMode && haltMode !== 'stall') return;   // the first stop is the one to explain
  haltMode = mode;
  $('halt-title').textContent = { stall: 'The game isn’t responding', exit: 'The game has closed' }[mode] || 'The game stopped';
  $('halt-why').textContent = why;
  $('halt-detail').textContent = detail || '';
  $('halt-wait').classList.toggle('hidden', mode !== 'stall');
  $('halt').classList.remove('hidden');
  if ($('halt-more').open) $('halt-report').value = diagnostics();
  document.exitPointerLock?.();
  (mode === 'stall' ? $('halt-wait') : $('halt-copy')).focus();   // not Restart: a key meant for the game could press it
}
function unhalt() {
  haltMode = null;
  $('halt').classList.add('hidden');
  $('canvas').focus();
}

// The watchdog: no frame for WATCHDOG_MS in a visible tab is a stuck game (the first frame may take a minute:
// the game loads). A hidden tab presents nothing (browsers pause animation frames there), and online the game
// also waits, frozen, for the other players' input: neither counts.
function watchdog(M, session) {
  health.started = health.lastFrameAt = performance.now();
  document.addEventListener('visibilitychange', () => { health.lastFrameAt = performance.now(); });
  if (!WATCHDOG_MS) return;
  setInterval(() => {
    if (engineDead) return;
    const now = performance.now();
    let waiting = document.visibilityState !== 'visible';
    if (session && !waiting) {
      try { health.netFrame = M._netplay_status(0); waiting = M._netplay_status(4) || session.reconnecting; }
      catch (e) { pageError('watchdog', e); }
    }
    if (waiting) { health.lastFrameAt = now; return; }
    const quiet = now - health.lastFrameAt, s = Math.round(quiet / 1000);
    if (haltMode || quiet < (health.frames ? WATCHDOG_MS : Math.max(WATCHDOG_MS, 60000))) return;
    halt('stall', health.frames ? `No new picture for ${s} seconds. It may still recover by itself.`
      : `The game hasn’t shown a picture in ${s} seconds.`);
  }, 1000);
}

function describeAdapter(a) {
  const i = a.info || {};
  const name = [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' / ') || 'no details';
  return name + (a.isFallbackAdapter || i.isFallbackAdapter ? ' (software fallback)' : '') +
    (a.features ? `, BC textures ${a.features.has('texture-compression-bc') ? 'yes' : 'no'}` : '') +
    (a.limits ? `, max texture ${a.limits.maxTextureDimension2D}, max buffer ${mb(a.limits.maxBufferSize)} MB` : '');
}

// A report for bug reports: the browser and GPU, the game's state, and its last console lines.
function diagnostics() {
  const now = performance.now(), sec = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const ua = navigator.userAgentData, s = engine?.session, canvas = $('canvas');
  const memory = engine?.M.wasmMemory?.buffer.byteLength;
  return [
    'Cricket 07 diagnostics', `when: ${new Date().toISOString()}`, `page: ${location.origin}${location.pathname}`,
    `URL options: ${location.search || '(none)'}`,
    `browser: ${navigator.userAgent}`,
    ...(ua ? [`platform: ${ua.platform || '?'}${ua.mobile ? ' (mobile)' : ''}; ${ua.brands.map((b) => `${b.brand} ${b.version}`).join(', ')}`] : []),
    `display: ${screen.width}x${screen.height} at ${devicePixelRatio}x, canvas ${canvas.width}x${canvas.height}, ` +
      `${document.fullscreenElement ? 'fullscreen' : 'in the page'}, tab ${document.visibilityState}`,
    `computer: ${navigator.hardwareConcurrency || '?'} threads, ${navigator.deviceMemory || '?'} GB memory, ` +
      `cross-origin isolated ${crossOriginIsolated}`,
    `WebGPU adapter: ${gpuInfo}`,
    `wasm memory: ${memory ? `${mb(memory)} MB` : 'none yet'}`,
    `game: ${engineDead ? `stopped: ${engineDead.detail || engineDead.why}` : engine ? 'running' : 'not started'}` +
      `${haltMode === 'stall' ? ' (not responding)' : ''}, ${s ? `online, player ${s.you + 1} of ${s.players}, delay ${s.delay}, ` +
      `lockstep frame ${health.netFrame}` : 'solo'}`,
    `frames presented: ${health.frames}, the last ${health.frames ? `${sec(now - health.lastFrameAt)} ago` : 'never'}, ` +
      `in ${sec(now - health.started)} of play`,
    ...[...pageErrors].map(([where, e]) => `${where}: ${e.count} exception${e.count > 1 ? 's' : ''}, the first: ${e.message.split('\n')[0]}`),
    '', 'memory reports (every 2 s with ?fps, every 10 s with ?log):',
    ...(memLines.length ? memLines : ['(none: open the game with ?log or ?fps for them)']),
    '', 'errors and warnings:', ...(errorLines.length ? errorLines : ['(none)']),
    '', `the game's last ${recent.length} lines:`, ...recent,
  ].join('\n');
}

async function copyDiagnostics() {
  const b = $('halt-copy'), text = diagnostics();
  $('halt-report').value = text;
  try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
  catch { $('halt-more').open = true; $('halt-report').select(); b.textContent = 'Copy the text below'; }
  setTimeout(() => { b.textContent = 'Copy diagnostics'; }, 3000);
}

function setupHalt() {
  $('halt-restart').onclick = () => location.reload();
  $('halt-wait').onclick = () => { health.lastFrameAt = performance.now(); unhalt(); };
  $('halt-copy').onclick = copyDiagnostics;
  $('halt-more').ontoggle = () => { if ($('halt-more').open) $('halt-report').value = diagnostics(); };
}

// ------------------------------------------------------------------ fullscreen

// The stage (game + overlays) goes fullscreen; the canvas grows with it and the game letterboxes its 4:3
// picture inside. Alt+Enter (Option+Enter on a Mac) toggles it, as in PC games of the time; it is caught
// before the game's own key handling so Enter doesn't also reach a menu.
function setupFullscreen() {
  const stage = $('stage');
  const active = () => document.fullscreenElement || document.webkitFullscreenElement;
  const toggle = () => {
    if (active()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (stage.requestFullscreen || stage.webkitRequestFullscreen).call(stage)?.catch?.(() => {});
    $('canvas').focus();
  };
  if (!stage.requestFullscreen && !stage.webkitRequestFullscreen) { $('fs').classList.add('hidden'); return; }
  $('fs').onclick = toggle;
  const swallow = (e) => {
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
    if (!e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'keydown' && !e.repeat) toggle();
  };
  window.addEventListener('keydown', swallow, true);
  window.addEventListener('keyup', swallow, true);
  const sync = () => {
    $('fs-icon').setAttribute('d', active() ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5');
    $('fs').title = active() ? 'Exit fullscreen (Alt+Enter or Esc)' : 'Fullscreen (Alt+Enter)';
  };
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  // the button shows while the mouse moves over the stage and fades after a few still seconds
  let idle;
  const wake = () => { stage.classList.add('awake'); clearTimeout(idle); idle = setTimeout(() => stage.classList.remove('awake'), 2500); };
  stage.addEventListener('mousemove', wake);
  stage.addEventListener('mouseleave', () => stage.classList.remove('awake'));
  wake();
}

// once the game starts: a short hint, so players learn the shortcut
function fullscreenTip() {
  const tip = $('fstip');
  if (document.fullscreenElement || document.webkitFullscreenElement || $('fs').classList.contains('hidden')) return;
  tip.classList.remove('hidden');
  tip.style.opacity = '1';
  setTimeout(() => { tip.style.opacity = '0'; }, 5000);
  setTimeout(() => tip.classList.add('hidden'), 5500);
}

// ------------------------------------------------------------------ saves (saves.js)

// The game's saves folder in OPFS: host/main.c puts it beside the game folder (/opfs/<OPFS_DIR>/../userdata).
// The home screen backs it up (a .zip download, or automatic copies into a folder the player picks) and
// restores it; while playing solo, the folder copy is refreshed every few minutes.
const USER_DIR = 'userdata';
const saves = RcSaves.open(USER_DIR);
const BACKUP_EVERY_MS = 5 * 60 * 1000;

function when(t) {
  const d = new Date(t);
  if (d.toDateString() === new Date().toDateString()) return `today at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return `on ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
}

function savesMsg(text, undo) {
  const el = $('saves-msg');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
  if (!undo) return;
  const b = document.createElement('button');
  b.className = 'linkish';
  b.textContent = 'Undo';
  b.onclick = async () => {
    try { savesMsg(await RcSaves.exclusive(() => saves.undo()) ? 'Your earlier saves are back.' : 'Nothing to undo.'); }
    catch (e) { savesMsg(`Undo failed: ${e.message}`); }
    showSaves();
  };
  el.append(' ', b);
}

async function showSaves() {
  const s = await saves.summary().catch(() => ({ files: 0 }));
  const last = saves.last();
  $('saves-status').textContent = !s.files ? '· none yet'
    : `· ${s.files} file${s.files === 1 ? '' : 's'}, ${last ? `backed up ${when(last.at)}` : 'not backed up yet'}`;
  $('saves-export').disabled = !s.files;
  if (saves.folderSupported) {
    const f = await saves.folder();
    const row = $('saves-folder-row');
    const link = (text, fn) => { const b = document.createElement('button'); b.className = 'linkish'; b.textContent = text; b.onclick = fn; return b; };
    row.textContent = '';
    if (!f) row.append(link('Back up automatically to a folder on this computer', chooseBackupFolder));
    else if (f.permission === 'granted') row.append(`Automatic backups go to “${f.name}”. `, link('Change folder', chooseBackupFolder));
    else row.append(link(`Allow automatic backups to “${f.name}”`, () => backupToFolder(true)), ' · ', link('Change folder', chooseBackupFolder));
    row.classList.remove('hidden');
  }
  // Without persistent storage the browser may evict the whole site, saves included (Safari also clears
  // sites not visited for a while), so say so next to the backup buttons.
  const kept = await navigator.storage.persisted?.().catch(() => false);
  $('saves-note').classList.toggle('warn', !kept);
  $('saves-note').innerHTML = (kept ? '' : 'This browser may clear the game’s storage, saves included, when the disk gets full ' +
    'or after you haven’t visited for a while, so keep a backup. ') + 'The game keeps only what you save in <b>My Cricket → Load / Save</b>.';
}

async function backupToFolder(asked) {
  try {
    const r = await saves.backupToFolder({ request: asked, force: asked });
    if (r.name) savesMsg(`Backed up to “${r.folder}” as ${r.name}.`);
    else if (asked && r.skipped === 'permission') savesMsg('The browser did not allow writing to that folder.');
    else if (asked && r.skipped === 'no-saves') savesMsg('No saves yet. Backups start once the game has saved something.');
  } catch (e) { if (asked) savesMsg(`Backup failed: ${e.message}`); else console.warn('save backup:', e); }
  showSaves();
}

async function chooseBackupFolder() {
  try { await saves.chooseFolder(); }
  catch (e) { if (e.name !== 'AbortError') savesMsg(`Couldn't use that folder: ${e.message}`); return; }
  await backupToFolder(true);
}

function setupSaves() {
  $('saves-export').onclick = async () => {
    try {
      const blob = await saves.exportZip();
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: saves.zipName() });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      saves.noteDownload();
      savesMsg('Backup downloaded. Keep it somewhere safe: Restore puts it back, in this or another browser.');
    } catch (e) { savesMsg(`Couldn't make the backup: ${e.message}`); }
    showSaves();
  };
  $('saves-import').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const s = await saves.summary();
    if (s.files && !confirm(`Replace your ${s.files} saved files with the backup “${file.name}”? You can undo this afterwards.`)) return;
    try { savesMsg(`Restored ${await RcSaves.exclusive(() => saves.restoreZip(file))} files from ${file.name}.`, true); }
    catch (err) { savesMsg(err.message); }
    showSaves();
  };
}

// ------------------------------------------------------------------ patches and rosters (patches.js)

const patches = RcPatches.open({ game: OPFS_DIR, saves: USER_DIR, store: 'rcpatches', marker: MARKER });

function patchMsg(text, warn) {
  $('patch-msg').textContent = text;
  $('patch-msg').classList.toggle('warn', !!warn);
}

async function showPatches() {
  const list = (await patches.list().catch(() => [])).filter((p) => !p.installing);
  const ul = $('patch-list');
  ul.innerHTML = '';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  if (!list.length) ul.append(el('li', null, 'None yet: the game is as it came.'));
  list.forEach((p, i) => {
    const li = el('li');
    const who = el('div', 'who');
    who.append(el('b', null, p.name), el('small', null,
      `${p.files.length} file${p.files.length === 1 ? '' : 's'} · ${new Date(p.at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`));
    li.append(who);
    if (i === list.length - 1) {
      const b = el('button', 'btn ghost slim', 'Remove');
      b.onclick = () => removePatch(p);
      li.append(b);
    }
    ul.append(li);
  });
  $('go-patches').textContent = list.length ? `Patches & rosters (${list.length})` : 'Patches & rosters';
}

let pendingPlan = null;
async function planPatch(source, name) {
  $('patch-plan').classList.add('hidden');
  patchMsg('Checking the patch…');
  try { pendingPlan = await patches.plan(source, name); }
  catch (e) { patchMsg(e.message, true); return; }
  const p = pendingPlan, lines = [];
  const files = (n) => `${n} file${n === 1 ? '' : 's'}`;
  const size = p.bytes < 1e6 ? `${Math.max(1, Math.round(p.bytes / 1e3))} KB` : `${mb(p.bytes)} MB`;
  if (p.game.length) lines.push([`${files(p.game.length)} for the game folder, ${p.replaces ? `${p.replaces} of them replacing the game's own` : 'all new'} (${size}).`]);
  if (p.rosters.length) lines.push([`${files(p.rosters.length)} of rosters, for the game's saves.`]);
  const shown = p.refused.slice(0, 4).map((r) => `${r.path} (${r.why})`).join(', ');
  if (p.refused.length) lines.push([`Skipped ${files(p.refused.length)}: ${shown}${p.refused.length > 4 ? ` and ${p.refused.length - 4} more` : ''}.`, 'warn']);
  if (p.refused.some((r) => r.why === 'a program')) lines.push(['Programs are never installed. If this patch needs its own game program, it may not work here.', 'warn']);
  if (p.refused.some((r) => r.why.startsWith('a roster'))) lines.push(['To add its rosters, start the game once and save (My Cricket → Load / Save), then install this again.', 'warn']);
  if (p.game.length && !p.known && !p.replaces) lines.push(['None of these files go into the game\'s Data or Audio folders. Check that you chose the folder laid out like the game folder.', 'warn']);
  $('patch-plan-name').textContent = p.name;
  $('patch-plan-lines').innerHTML = '';
  for (const [text, cls] of lines) { const li = document.createElement('li'); li.textContent = text; if (cls) li.className = cls; $('patch-plan-lines').append(li); }
  $('patch-install').disabled = !p.game.length && !p.rosters.length;
  $('patch-plan').classList.remove('hidden');
  patchMsg('');
}

async function removePatch(p) {
  if (!confirm(`Remove “${p.name}”? The game files it replaced are put back.`)) return;
  try {
    await RcSaves.exclusive(() => patches.uninstallLast(({ done, total }) => patchMsg(`Removing… ${done} of ${total}`)));
    patchMsg(`Removed “${p.name}”.`);
  } catch (e) { patchMsg(e.message, true); }
  showPatches();
}

function setupPatches() {
  $('go-patches').onclick = () => { show('patches'); patchMsg(''); showPatches(); };
  $('patch-folder').onchange = (e) => {
    const files = e.target.files;
    if (files.length) planPatch({ files }, files[0].webkitRelativePath.split('/')[0]);
    e.target.value = '';
  };
  $('patch-zip').onchange = (e) => {
    const f = e.target.files[0];
    if (f) planPatch({ zip: f }, f.name.replace(/\.zip$/i, ''));
    e.target.value = '';
  };
  $('patch-cancel').onclick = () => { pendingPlan = null; $('patch-plan').classList.add('hidden'); };
  // an install the last visit didn't finish (the tab closed part way) is undone first
  RcSaves.exclusive(() => patches.recover()).then((r) => r && console.log(`patches: undid the unfinished install of ${r.name}`))
    .catch(() => {}).finally(showPatches);
  $('patch-install').onclick = async () => {
    const p = pendingPlan;
    if (!p) return;
    $('patch-install').disabled = true;
    try {
      await RcSaves.exclusive(() => patches.install(p, ({ done, total, file }) => patchMsg(`Installing ${done} of ${total}${file ? `: ${file}` : ''}`)));
      $('patch-plan').classList.add('hidden');
      patchMsg(`Installed “${p.name}”. It shows the next time the game starts.`);
      pendingPlan = null;
    } catch (e) { patchMsg(`Not installed: ${e.message}`, true); }   // the plan stays, to try again
    $('patch-install').disabled = false;
    showPatches();
  };
}

// ------------------------------------------------------------------ online lobby

async function buildVersion() {
  // peers must run the same build and game files, or their simulations diverge
  const marker = await readMarker();
  const wasm = await fetch('build/recomp.wasm', { method: 'HEAD' }).catch(() => null);
  // the ETag comes back weak (W/"...") when the response is compressed: compare only its value
  const etag = (wasm?.headers.get('ETag') || '').replace(/^W\//, '').replace(/"/g, '');
  return `${marker?.version || 'local'}:${etag || wasm?.headers.get('Content-Length') || '?'}`;
}

function setupOnline() {
  const msg = (t) => { $('np-msg').textContent = t; $('np-lobbymsg').textContent = t; };
  try {
    $('np-name').value = localStorage.getItem('rc-name') || '';
    const region = localStorage.getItem('rc-region');
    if ([...$('np-region').options].some((o) => o.value === region)) $('np-region').value = region;
  } catch { /* storage blocked */ }
  if (params.get('join')) $('np-code').value = params.get('join').toUpperCase();
  // an invite link can name another room server: say which, so a stranger's server doesn't go unnoticed
  if (params.get('netplay')) { $('np-server').textContent = `Room server: ${new URL(NETPLAY_BASE).host}`; $('np-server').classList.remove('hidden'); }
  let client = null;
  let lastPlayers = [];
  let bringChecked = false;   // the host's saves summary for "Bring my saves", looked up once

  // create: the host's first connection, which places the room in `region` (the Worker's location hint)
  async function enter(code, create) {
    if (client) return;
    const name = $('np-name').value.trim() || 'Player';
    try { localStorage.setItem('rc-name', name); localStorage.setItem('rc-region', $('np-region').value); } catch { /* storage blocked */ }
    msg('Connecting…');
    let iceServers;   // from the first ticket (TURN credentials last a day)
    const roomUrl = async () => {   // a fresh ticket each time (they expire after an hour)
      const res = await fetch(NETPLAY_BASE + '_netplay_ticket', { cache: 'no-store' });
      if (!res.ok) throw new Error('Online play is not available on this server.');
      const { ticket, iceServers: ice } = await res.json();
      iceServers ??= ice;
      const url = new URL(`netplay/${code}?ticket=${encodeURIComponent(ticket)}`, NETPLAY_BASE);
      if (create) { url.searchParams.set('create', '1'); url.searchParams.set('region', $('np-region').value); create = false; }
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return url.href;
    };
    let url;
    try { url = await roomUrl(); } catch (e) { msg(e.message); return; }
    const invite = new URL(location.href);
    invite.search = `?join=${code}` + (params.get('netplay') ? `&netplay=${encodeURIComponent(params.get('netplay'))}` : '');
    $('np-room').textContent = code;
    $('invite').textContent = invite.href;
    const version = await buildVersion();
    let session = null;
    const left = new Set();
    const me = client = RcNetplay.connect({
      url, name, version, reconnectUrl: roomUrl, iceServers, relayOnly: params.get('turn') === 'only',
      adaptive: params.get('adaptive') !== '0',
      onReconnect(state) { if (session) session.reconnecting = state === 'connecting'; },
      onFiles(done, size, ok) {
        msg(ok ? 'The host’s saves arrived: this match starts from them.' : `Receiving the host’s saves… ${Math.round(done * 100)}%`);
      },
      onLobby(l) {
        if (client !== me) return;   // a room this page already left
        if (l.started) { msg('That game has already started.'); leave(); return; }
        if ($('view-lobby').classList.contains('hidden')) { msg(''); show('lobby'); }
        $('np-colo').textContent = l.colo ? `Server in ${l.colo}` : '';
        $('np-players').innerHTML = '';
        const mine = l.players.find((p) => p.slot === l.you);
        const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
        // the same build and game files, patches included, or the two games would part ways
        const differs = l.players.filter((p) => p.slot !== l.you && p.version && p.version !== version);
        for (const p of l.players) {
          const li = el('li');
          const direct = p.slot === l.you ? 0 : Math.max(mine?.p2p?.[p.slot] || 0, p.p2p?.[l.you] || 0);
          const link = p.slot === l.you ? (p.rtt ? `${p.rtt} ms to the room` : 'Connected')
            : direct ? `Direct connection · ${direct} ms` : 'Connected through the room';
          const who = el('div', 'who');
          who.append(el('b', null, p.name), el('small', null, link));
          if (differs.includes(p)) who.append(el('small', 'warn', 'Has different game files or patches'));
          li.append(el('div', 'avatar', (p.name || '?').trim().charAt(0).toUpperCase() || '?'), who);
          if (p.slot === 0) li.append(el('span', 'tag', 'Host'));
          if (p.slot === l.you) li.append(el('span', 'tag', 'You'));
          $('np-players').appendChild(li);
        }
        if (l.players.length < 2) {
          const li = el('li', 'empty');
          li.append(el('div', 'avatar', '?'), el('div', 'who', 'Waiting for your friend to join…'));
          $('np-players').appendChild(li);
        }
        $('np-hostctl').classList.toggle('hidden', !l.host);
        if (l.host && !bringChecked) {
          bringChecked = true;
          saves.summary().then((s) => {
            $('np-bring').disabled = !s.files;
            if (!s.files) $('np-bring').checked = false;
            $('np-bring-info').textContent = s.files ? `(${s.files} file${s.files === 1 ? '' : 's'})` : '(you have none yet)';
          });
        }
        $('np-start').disabled = l.players.length !== 2 || differs.length > 0;
        if (l.players.length > 2) msg('This is a 1v1 game: only two players can be in the room.');
        else if (differs.length) msg('You need the same patches to play each other: compare Patches & rosters on both computers, then both reload.');
        else if ($('np-lobbymsg').textContent.startsWith('You need the same patches')) msg('');
        lastPlayers = l.players;
        const auto = RcNetplay.autoDelay(l.players);
        $('np-delay').options[0].textContent = `Auto (${auto} frames, ${Math.round(auto * 1000 / 60)} ms)`;
        $('np-wait').classList.toggle('hidden', l.host);
      },
      onStart(s) {
        session = { ...s, client, left };
        run(session).catch(fail);
      },
      onLeft(slot) { left.add(slot); },
      onError(e) { msg(e); setTimeout(() => { if ($('np-msg').textContent === e) msg(''); }, 8000); },
      onClose() { if (!session && client === me) { client = null; show('online'); msg('Disconnected from the room.'); } },
    });
  }
  function leave() {
    const c = client;
    client = null;
    c?.close();
    show('online');
  }
  $('np-leave').onclick = () => { leave(); msg(''); };
  $('np-copy').onclick = async () => {
    const b = $('np-copy');
    try { await navigator.clipboard.writeText($('invite').textContent); b.textContent = 'Link copied'; }
    catch { b.textContent = 'Copy failed: share the code instead'; }
    setTimeout(() => { b.textContent = 'Copy invite link'; }, 2000);
  };

  const code5 = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  $('np-host').onclick = () => enter(code5(), true).catch((e) => msg(e.message));
  $('np-join').onclick = () => {
    const code = $('np-code').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(code)) { msg('Enter the room code from the host.'); return; }
    enter(code).catch((e) => msg(e.message));
  };
  $('np-start').onclick = async () => {
    const v = $('np-delay').value;
    const delay = v === 'auto' ? RcNetplay.autoDelay(lastPlayers) : Number(v);
    let files = null;
    if ($('np-bring').checked && !$('np-bring').disabled) {
      // Online games start from empty saves so that every game is the same; bringing the host's saves keeps
      // that true by sending them to everyone first.
      $('np-start').disabled = true;
      try {
        const bytes = new Uint8Array(await (await saves.exportZip()).arrayBuffer());
        files = await client.offerFiles(bytes, (f) => msg(`Sending your saves… ${Math.round(f * 100)}%`));
        msg('');
      } catch (e) {
        msg(`Couldn't send your saves: ${e.message}. Untick “Bring my saves” to play without them.`);
        $('np-start').disabled = false;
        return;
      }
    }
    client?.start(delay, files);
    $('np-start').disabled = false;
  };
}

// Keyboard cheat sheet beside the stage: in-game prompts use controller glyphs (triangle/circle/×/square,
// L1, R1), so keyboard players need a reference. The CSS (index.html) reserves the panel's space on
// viewports wide enough and shrinks the stage to match; the body's .kbd-off class (set when the player
// dismisses the panel, remembered in localStorage) hides the panel and lets the stage reclaim the space.
function setupKbdHelp() {
  const off = () => { try { return localStorage.getItem('rc-kbd') === 'hide'; } catch { return false; } };
  const save = (v) => { try { localStorage.setItem('rc-kbd', v); } catch { /* storage blocked */ } };
  const apply = () => document.body.classList.toggle('kbd-off', off());
  $('kbd-close').onclick = () => { save('hide'); apply(); };
  $('kbd-show').onclick = () => { save('show'); apply(); };
  apply();
}

setupFullscreen();
setupKbdHelp();
setupHalt();
boot();
