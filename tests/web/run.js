// Browser tests for the page (web/), run against the stand-in engine (fake-engine/recomp.js), so they need
// no game files. Headless Chromium through Playwright; online tests also start the room server locally.
//
//   node tests/web/run.js [name filter]
//
// Needs Playwright (npm i -g playwright, or NODE_PATH pointing at it) and, for the online tests, wrangler
// (npx wrangler, or WRANGLER=/path/to/wrangler). Each player is its own browser context: its own OPFS,
// like two computers.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { start } = require('./server');

const ROOT = path.join(__dirname, '..', '..');
const tests = [];
const test = (name, fn, { online = false } = {}) => tests.push({ name, fn, online });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Headless Chromium here may have no GPU: the page only checks that WebGPU answers, and the stand-in
// engine draws with a 2D canvas, so a stub adapter is enough.
const STUB_GPU = `Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true,
  get: () => ({ requestAdapter: async () => ({ isFallbackAdapter: false, info: {} }) }) });`;

// A game folder on disk, as a player would pick it: <tmp>/Cricket 07/{game.exe, Data/..., Audio/...}
function makeGameFolder(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c07-game-'));
  const g = path.join(dir, 'Cricket 07');
  const files = { 'game.exe': 'MZ stand-in executable', 'Data/data.gob': 'BIGF stand-in archive', 'Data/controltypes.csv': 'a,b\n',
    'Audio/music.big': 'stand-in music', ...extra };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(g, rel)), { recursive: true });
    fs.writeFileSync(path.join(g, rel), text);
  }
  return g;
}

async function player(browser, url, name = 'player') {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(STUB_GPU);
  const page = await ctx.newPage();
  page.logs = [];
  page.on('console', (m) => { page.logs.push(m.text()); if (process.env.VERBOSE) console.log(`  [${name}] ${m.text()}`); });
  page.on('pageerror', (e) => { page.logs.push('pageerror: ' + e.message); console.log(`  [${name}] pageerror: ${e.message}`); });
  await page.goto(url);
  return page;
}

// First visit: pick the game folder, wait for the home screen (or the online screen, for an invite link).
async function install(page, folder = makeGameFolder()) {
  await page.waitForSelector('#pick:not(.hidden)');
  await page.setInputFiles('#folder', folder);
  await page.waitForSelector('#view-home:not(.hidden), #view-online:not(.hidden)');
}

const frameOf = (page) => page.evaluate(() => window.recomp?._test_info().frame || 0);
async function waitFrames(page, n, ms = 15000) {
  const t0 = Date.now();
  while (await frameOf(page) < n) {
    if (Date.now() - t0 > ms) throw new Error(`game stuck at frame ${await frameOf(page)} (wanted ${n})`);
    await sleep(100);
  }
}

// ------------------------------------------------------------------ tests

test('solo: pick the game folder and play', async ({ browser, base }) => {
  const page = await player(browser, base);
  await install(page);
  await page.click('#play');
  await waitFrames(page, 30);
  const files = await page.evaluate(() => window.recomp._test_files().map((f) => f.path));
  assert.deepStrictEqual(files, ['.installed.json', 'Audio/music.big', 'Data/controltypes.csv', 'Data/data.gob', 'game.exe']);
});

test('online: two players stay in lockstep', async ({ browser, base, netplay }) => {
  const q = `?netplay=${encodeURIComponent(netplay)}`;
  const host = await player(browser, base + q, 'host');
  await install(host);
  await host.click('#go-online');
  await host.fill('#np-name', 'Host');
  await host.click('#np-host');
  await host.waitForSelector('#view-lobby:not(.hidden)');
  const code = (await host.textContent('#np-room')).trim();
  const guest = await player(browser, `${base}?join=${code}&netplay=${encodeURIComponent(netplay)}`, 'guest');
  await install(guest);
  await guest.fill('#np-name', 'Guest');
  await guest.click('#np-join');
  await guest.waitForSelector('#view-lobby:not(.hidden)');
  await host.waitForFunction(() => !document.getElementById('np-start').disabled);
  await sleep(1500);   // a few pings, for the auto delay
  await host.click('#np-start');
  await Promise.all([waitFrames(host, 300, 30000), waitFrames(guest, 300, 30000)]);
  const [a, b] = await Promise.all([host, guest].map((p) => p.evaluate(() => window.recomp._test_info())));
  assert.strictEqual(a.net.desync, 0, 'host saw a desync');
  assert.strictEqual(b.net.desync, 0, 'guest saw a desync');
  assert.match(await host.textContent('#netstatus'), /Online · player 1 of 2/);
}, { online: true });

// ------------------------------------------------------------------ runner

async function roomServer() {
  const bin = process.env.WRANGLER;
  const port = 8787 + Math.floor(Math.random() * 500);
  const args = ['dev', '--local', '--port', String(port), '--var', 'NETPLAY_SECRET:test', '--persist-to',
    fs.mkdtempSync(path.join(os.tmpdir(), 'c07-rooms-'))];
  const proc = bin ? spawn(bin, args, { cwd: path.join(ROOT, 'server') })
    : spawn('npx', ['--yes', 'wrangler', ...args], { cwd: path.join(ROOT, 'server') });
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
  const filter = process.argv[2] || '';
  const chosen = tests.filter((t) => t.name.includes(filter));
  const server = await start(0);
  const base = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch();
  let rooms = null, failed = 0;
  try {
    if (chosen.some((t) => t.online)) rooms = await roomServer();
    for (const t of chosen) {
      const t0 = Date.now();
      try {
        await t.fn({ browser, base, netplay: rooms?.url });
        console.log(`ok   ${t.name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      } catch (e) {
        failed++;
        console.log(`FAIL ${t.name}: ${e.stack || e}`);
      }
      for (const c of browser.contexts()) await c.close();
    }
  } finally {
    rooms?.stop();
    await browser.close();
    server.close();
  }
  console.log(failed ? `${failed} of ${chosen.length} failed` : `all ${chosen.length} passed`);
  process.exit(failed ? 1 : 0);
})();
