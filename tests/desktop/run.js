// Tests of the desktop app (desktop/app) in Electron, with the stand-in engine (tests/web/fake-engine): the
// page served from app://cricket07 and cross-origin isolated, the game folder and saves kept in the app's own
// storage across restarts, its guards (navigation, new windows, permissions, paths), and two copies of the
// app playing online through a room server.
//   ELECTRON=/path/to/electron node tests/desktop/run.js [filter]
// ELECTRON is an Electron binary (from electron-v<version>-<platform>.zip), running desktop/app; or, with
// PACKAGED=1, the packaged app's own (Cricket 07.app/Contents/MacOS/Electron), running what it holds.
// WRANGLER as for tests/web (the room server). Needs a display (xvfb-run on a headless Linux).
// REAL_GAME=<folder> adds a test of a real engine build: the folder of the program it was built from (CI builds
// one from tests/desktop/toy.c), with REAL_SITE=<build_web/www> (or, PACKAGED, the engine the app holds).
// ELECTRON_ARGS: more switches for Electron (a software GPU on a machine without one).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON = process.env.ELECTRON;
const PACKAGED = !!process.env.PACKAGED;
const tests = [];
const test = (name, fn, { online = false, real = false } = {}) => tests.push({ name, fn, online, real });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `c07-${name}-`));

// The page with the stand-in engine, as desktop/build-mac.sh --stand-in lays it out (and a link pointing out
// of it, which the app must not follow)
function standInSite() {
  const site = tmp('site');
  fs.cpSync(path.join(ROOT, 'web'), site, { recursive: true });
  for (const f of ['serve.py', 'node_env.js', 'node_stubs.c']) fs.rmSync(path.join(site, f), { force: true });
  fs.mkdirSync(path.join(site, 'build'));
  for (const f of ['recomp.js', 'recomp.wasm']) fs.copyFileSync(path.join(ROOT, 'tests/web/fake-engine/recomp.js'), path.join(site, 'build', f));
  fs.symlinkSync(os.tmpdir(), path.join(site, 'outside'));
  return site;
}
const SITE = PACKAGED ? null : standInSite();

// No GPU in a headless test machine: the page only checks that WebGPU answers, and the stand-in draws in 2D
const STUB_GPU = `Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true,
  get: () => ({ requestAdapter: async () => ({ isFallbackAdapter: false, info: {} }) }) });`;

function makeGameFolder() {
  const g = path.join(tmp('game'), 'Cricket 07');
  const files = { 'game.exe': 'MZ stand-in executable', 'Data/data.gob': 'BIGF stand-in archive', 'Audio/music.big': 'stand-in music' };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(g, rel)), { recursive: true });
    fs.writeFileSync(path.join(g, rel), text);
  }
  return g;
}

// One copy of the app, with storage of its own (or `userData`, to start it again on the same storage)
async function launch({ userData = tmp('user'), netplay = '', query = '', site = SITE, gpu = false } = {}) {
  const args = PACKAGED ? [] : [path.join(ROOT, 'desktop/app')];
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');   // root in a container
  args.push(...(process.env.ELECTRON_ARGS || '').split(' ').filter(Boolean));
  const env = { ...process.env, CRICKET07_USER_DATA: userData, CRICKET07_NETPLAY: netplay, CRICKET07_QUERY: query };
  if (site) env.CRICKET07_SITE = site;
  const app = await electron.launch({ executablePath: ELECTRON, args, env });
  const page = await app.firstWindow();
  if (!gpu) { await app.context().addInitScript(STUB_GPU); await page.reload(); }
  page.logs = [];
  page.on('console', (m) => { page.logs.push(m.text()); if (process.env.VERBOSE) console.log(`  [app] ${m.text()}`); });
  page.on('pageerror', (e) => console.log(`  [app] pageerror: ${e.message}`));
  return { app, page, userData };
}

async function install(page, folder = makeGameFolder()) {
  await page.waitForSelector('#pick:not(.hidden)');
  await page.setInputFiles('#folder', folder);
  await page.waitForSelector('#view-home:not(.hidden)');
}
const frameOf = (page) => page.evaluate(() => window.recomp?._test_info().frame || 0);
async function waitFrames(page, n, ms = 20000) {
  for (const t0 = Date.now(); await frameOf(page) < n;) {
    if (Date.now() - t0 > ms) throw new Error(`game stuck at frame ${await frameOf(page)} (wanted ${n})`);
    await sleep(100);
  }
}
// the files under a folder of the page's storage (OPFS), as paths
const opfsFiles = (page, dir) => page.evaluate(async (dir) => {
  const out = [];
  async function walk(d, pre) {
    for await (const [name, h] of d.entries()) {
      if (h.kind === 'directory') await walk(h, `${pre}${name}/`); else out.push(pre + name);
    }
  }
  let d = await navigator.storage.getDirectory();
  try { for (const p of dir.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p); } catch { return []; }
  await walk(d, '');
  return out.sort();
}, dir);

// ------------------------------------------------------------------ tests

test('the page comes from app://cricket07, cross-origin isolated, with storage of its own', async () => {
  const { app, page } = await launch();
  try {
    const got = await page.evaluate(async () => ({
      origin: location.origin, desktop: new URLSearchParams(location.search).has('desktop'),
      isolated: crossOriginIsolated, sab: typeof SharedArrayBuffer, opfs: !!(await navigator.storage.getDirectory()),
      coep: (await fetch('/index.html')).headers.get('cross-origin-embedder-policy'),
      csp: (await fetch('/index.html')).headers.get('content-security-policy'),
      wasm: (await fetch('/build/recomp.wasm')).headers.get('content-type'),
      etag: (await fetch('/build/recomp.wasm', { method: 'HEAD' })).headers.get('etag'),
    }));
    // the engine's ETag is its content hash: the lobby compares it between players
    const engine = SITE ? path.join(SITE, 'build/recomp.wasm') : null;
    const etag = engine ? `"${require('crypto').createHash('sha256').update(fs.readFileSync(engine)).digest('hex').slice(0, 32)}"` : got.etag;
    assert.deepStrictEqual(got, { origin: 'app://cricket07', desktop: true, isolated: true, sab: 'function', opfs: true,
      coep: 'require-corp', csp: "frame-ancestors 'none'; object-src 'none'; base-uri 'none'", wasm: 'application/wasm', etag });
    assert.match(got.etag, /^"[0-9a-f]{32}"$/);
    assert.strictEqual(await page.title(), 'Cricket 07');
  } finally { await app.close(); }
});

test('pick the game folder, play, save, and find it all again after a restart', async () => {
  let { app, page, userData } = await launch();
  try {
    await install(page);
    await page.click('#play');
    await waitFrames(page, 30);
    await page.keyboard.press('KeyS');   // the stand-in saves on S, as the game's Load / Save screen does
    for (const t0 = Date.now(); !(await opfsFiles(page, 'userdata')).some((f) => f.endsWith('save-1.sav'));) {
      if (Date.now() - t0 > 10000) assert.fail('no save written');
      await sleep(200);
    }
  } finally { await app.close(); }
  ({ app, page } = await launch({ userData }));
  try {
    await page.waitForSelector('#view-home:not(.hidden)', { timeout: 15000 });   // no folder to pick again
    assert.ok((await opfsFiles(page, 'rcgame')).includes('game.exe'), 'the game folder is gone');
    assert.ok((await opfsFiles(page, 'userdata')).some((f) => f.endsWith('save-1.sav')), 'the save is gone');
  } finally { await app.close(); }
});

test('links open in the browser (https only); the window stays on the game', async () => {
  const { app, page } = await launch();
  try {
    await app.evaluate(({ shell }) => { global.opened = []; shell.openExternal = async (u) => { global.opened.push(u); }; });
    await page.evaluate(() => {
      window.open('https://example.com/new-window');
      window.open('file:///etc/passwd');
      const a = Object.assign(document.createElement('a'), { href: 'https://example.com/link' });
      document.body.append(a);
      a.click();
    });
    await sleep(1500);
    assert.deepStrictEqual(await app.evaluate(() => global.opened), ['https://example.com/new-window', 'https://example.com/link']);
    assert.ok(page.url().startsWith('app://cricket07/'), `the window went to ${page.url()}`);
    assert.strictEqual(app.windows().length, 1);
  } finally { await app.close(); }
});

test('no permissions beyond the game\'s (location, notifications, camera are refused)', async () => {
  const { app, page } = await launch();
  try {
    const got = await page.evaluate(async () => ({
      geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state,
      notifications: await Notification.requestPermission(),
      camera: await navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', (e) => e.name),
    }));
    assert.strictEqual(got.geolocation, 'denied');
    assert.strictEqual(got.notifications, 'denied');
    assert.notStrictEqual(got.camera, 'granted');
  } finally { await app.close(); }
});

test('app:// serves only the app\'s own files', async () => {
  const { app, page } = await launch();
  try {
    const codes = await page.evaluate(async () => {
      const get = async (p) => (await fetch(p)).status;
      return [await get('/index.html'), await get('/../../../etc/passwd'), await get('/%2e%2e/%2e%2e/etc/passwd'),
        await get('/build/..%2f..%2f..%2f..%2fetc%2fpasswd'), await get('/build/..%5c..%5cpackage.json'),
        await get('/outside/'), await get('/main.js')];
    });
    // the page; then out of it by "..", encoded "..", encoded slashes, backslashes, a link out, the app's own code
    assert.deepStrictEqual(codes, [200, 404, 404, 404, 404, 404, 404]);
  } finally { await app.close(); }
});

test('online: two copies of the app play each other through the room server', async ({ netplay }) => {
  const a = await launch({ netplay }), b = await launch({ netplay });
  try {
    for (const { page } of [a, b]) await install(page);
    await a.page.click('#go-online');
    await a.page.fill('#np-name', 'Host');
    await a.page.click('#np-host');
    await a.page.waitForSelector('#view-lobby:not(.hidden)');
    const code = (await a.page.textContent('#np-room')).trim();
    // in the app the invite is the code, and how to use it
    assert.strictEqual(await a.page.textContent('#np-copy'), 'Copy room code');
    assert.match(await a.page.textContent('#invite'), new RegExp(`Play Multiplayer and join with the code ${code}$`));
    await b.page.click('#go-online');
    await b.page.fill('#np-name', 'Guest');
    await b.page.fill('#np-code', code);
    await b.page.click('#np-join');
    await b.page.waitForSelector('#view-lobby:not(.hidden)');
    await a.page.waitForFunction(() => !document.getElementById('np-start').disabled);
    await sleep(1500);
    await a.page.click('#np-start');
    await Promise.all([waitFrames(a.page, 200, 40000), waitFrames(b.page, 200, 40000)]);
    for (const { page } of [a, b]) assert.strictEqual(await page.evaluate(() => window.recomp._netplay_status(2)), 0, 'desync');
  } finally { await a.app.close(); await b.app.close(); }
}, { online: true });

test('a real engine build runs in the app: threads, its files in storage, WebGPU', async () => {
  // the program (tests/desktop/toy.c) writes hello.txt into its folder and exits
  let site = null;
  if (!PACKAGED) {
    site = tmp('real');
    fs.cpSync(path.join(ROOT, 'web'), site, { recursive: true });
    fs.cpSync(process.env.REAL_SITE, path.join(site, 'build'), { recursive: true });
  }
  const { app, page } = await launch({ site, gpu: true });
  try {
    await install(page, process.env.REAL_GAME);
    await page.click('#play');
    await page.waitForSelector('#halt:not(.hidden)', { timeout: 60000 });   // the program ended: the page says so
    assert.match(await page.textContent('#halt'), /exit|ended|quit/i);
    const hello = await page.evaluate(async () => {
      const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('rcgame');
      return (await (await d.getFileHandle('hello.txt')).getFile()).text();
    });
    assert.strictEqual(hello, 'recompiled ok: fib(20) = 6765\n');
    assert.ok(await page.evaluate(() => crossOriginIsolated));
  } finally { await app.close(); }
}, { real: true });

// ------------------------------------------------------------------ runner

async function roomServer() {
  const port = 8787 + Math.floor(Math.random() * 500);
  // allowing the app's origin alone, as the test VM's room server does (deploy/vm/setup.sh)
  const proc = spawn(process.env.WRANGLER || 'wrangler', ['dev', '--local', '--port', String(port), '--var', 'NETPLAY_SECRET:test',
    '--var', 'ALLOWED_ORIGINS:app://cricket07', '--persist-to', tmp('rooms')],
  { cwd: path.join(ROOT, 'server'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url + '/_netplay_ticket')).ok) return { url, stop: () => proc.kill() }; } catch { /* not up yet */ }
    if (proc.exitCode !== null) break;
    await sleep(500);
  }
  proc.kill();
  throw new Error('room server did not start:\n' + out.slice(-2000));
}

(async () => {
  if (!ELECTRON) { console.error('set ELECTRON to an Electron binary (see the top of this file)'); process.exit(2); }
  const chosen = tests.filter((t) => t.name.includes(process.argv[2] || '') && (!t.real || process.env.REAL_GAME));
  const rooms = chosen.some((t) => t.online) ? await roomServer() : null;
  let failed = 0;
  try {
    for (const t of chosen) {
      const t0 = Date.now();
      try {
        await t.fn({ netplay: rooms?.url });
        console.log(`ok   ${t.name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      } catch (e) {
        failed++;
        console.log(`FAIL ${t.name}: ${e.stack || e}`);
      }
    }
  } finally { rooms?.stop(); }
  console.log(failed ? `${failed} of ${chosen.length} failed` : `all ${chosen.length} passed`);
  process.exit(failed ? 1 : 0);
})();
