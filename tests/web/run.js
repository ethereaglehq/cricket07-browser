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

// ---- saves (web/saves.js)

const RcZip = require('../../web/zip.js');
const DOCS = 'Documents and Settings/Player/My Documents/EA Sports Cricket 07/';
const savedFiles = (page, dir = 'userdata') => page.evaluate(async (dir) => {
  const out = {};
  async function walk(d, p) {
    for await (const [n, h] of d.entries()) {
      if (h.kind === 'directory') await walk(h, p + n + '/');
      else out[p + n] = await (await h.getFile()).text();
    }
  }
  try { await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(dir), ''); } catch { /* none */ }
  return out;
}, dir);
const removeSaves = (page) => page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('userdata', { recursive: true }));

// plays solo and saves twice (the stand-in engine writes a save file on S), then back to the home screen
async function playAndSave(page, times = 2) {
  await page.click('#play');
  await waitFrames(page, 10);
  for (let i = 0; i < times; i++) { await page.keyboard.press('s'); await sleep(150); }
  await page.reload();
  await page.waitForSelector('#view-home:not(.hidden)');
}

async function download(page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#saves-export')]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c07-dl-')), dl.suggestedFilename());
  await dl.saveAs(file);
  return file;
}

async function zipFiles(file) {
  const out = {};
  for (const e of await RcZip.read(new Blob([fs.readFileSync(file)]))) out[e.path] = Buffer.from(await e.read()).toString();
  return out;
}

async function makeZip(entries) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c07-zip-')), 'test.zip');
  fs.writeFileSync(file, Buffer.from(await (await RcZip.write(entries)).arrayBuffer()));
  return file;
}

test('saves: download a backup, lose the saves, restore them', async ({ browser, base }) => {
  const page = await player(browser, base);
  await install(page);
  await playAndSave(page);
  const before = await savedFiles(page);
  assert.deepStrictEqual(Object.keys(before).sort(), [DOCS + 'Saves/save-1.sav', DOCS + 'Saves/save-2.sav', DOCS + 'Settings.dat']);
  await page.waitForFunction(() => /3 files, not backed up yet/.test(document.getElementById('saves-status').textContent));
  const file = await download(page);
  assert.match(path.basename(file), /^Cricket 07 saves \d{4}-\d{2}-\d{2}\.zip$/);
  const zipped = await zipFiles(file);
  assert.strictEqual(JSON.parse(zipped['cricket07-saves.json']).kind, 'cricket07-saves');
  for (const [p, text] of Object.entries(before)) assert.strictEqual(zipped[p], text, p);
  await page.waitForFunction(() => /backed up today/.test(document.getElementById('saves-status').textContent));
  // the browser loses the saves
  await removeSaves(page);
  await page.reload();
  await page.waitForFunction(() => /none yet/.test(document.getElementById('saves-status').textContent));
  await page.setInputFiles('#saves-import', file);
  await page.waitForFunction(() => /Restored 3 files/.test(document.getElementById('saves-msg').textContent));
  assert.deepStrictEqual(await savedFiles(page), before);
  // and the game finds them on its next start
  await page.click('#play');
  await waitFrames(page, 5);
  const seen = await page.evaluate(() => window.recomp._test_saves_at_start().map((f) => f.path));
  assert.deepStrictEqual(seen.sort(), Object.keys(before).sort());
});

test('saves: a restore can be undone', async ({ browser, base }) => {
  const page = await player(browser, base);
  await install(page);
  await playAndSave(page, 1);
  const file = await download(page);
  await playAndSave(page, 2);   // newer saves: save-1 again (rewritten) and save-2
  const newer = await savedFiles(page);
  page.once('dialog', (d) => d.accept());
  await page.setInputFiles('#saves-import', file);
  await page.waitForFunction(() => /Restored 2 files/.test(document.getElementById('saves-msg').textContent));
  assert.strictEqual(Object.keys(await savedFiles(page)).length, 2);
  await page.click('#saves-msg button');
  await page.waitForFunction(() => /earlier saves are back/.test(document.getElementById('saves-msg').textContent));
  assert.deepStrictEqual(await savedFiles(page), newer);
});

test('saves: restore refuses files that are not a saves backup', async ({ browser, base }) => {
  const page = await player(browser, base);
  await install(page);
  await playAndSave(page, 1);
  const before = await savedFiles(page);
  page.on('dialog', (d) => d.accept());
  const cases = [
    [[{ path: 'Roster/x.ros', data: 'not a backup' }], /not a Cricket 07 saves backup/],
    [[{ path: 'cricket07-saves.json', data: '{"kind":"cricket07-saves"}' }, { path: '../escape.txt', data: 'x' }], /outside the saves folder/],
    [[{ path: 'cricket07-saves.json', data: '{"kind":"cricket07-saves"}' }, { path: 'C:/Windows/evil.dll', data: 'x' }], /outside the saves folder/],
  ];
  for (const [entries, why] of cases) {
    await page.setInputFiles('#saves-import', await makeZip(entries));
    await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('saves-msg').textContent), why.source);
    assert.deepStrictEqual(await savedFiles(page), before, 'saves changed after a refused restore');
  }
  const junk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c07-junk-')), 'junk.zip');
  fs.writeFileSync(junk, 'this is not a zip file at all');
  await page.setInputFiles('#saves-import', junk);
  await page.waitForFunction(() => /Not a usable .zip file/.test(document.getElementById('saves-msg').textContent));
  assert.deepStrictEqual(await savedFiles(page), before);
});

test('saves: automatic backups into a folder', async ({ browser, base }) => {
  const page = await player(browser, base);
  // the folder picker can't be driven headless: hand the page an OPFS folder instead (same interface)
  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder', { create: true });
  });
  await page.reload();
  await install(page);
  await playAndSave(page, 1);
  // ten old backups are already there: the eleventh pushes the oldest out
  await page.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder', { create: true });
    for (let i = 1; i <= 10; i++) await d.getFileHandle(`Cricket 07 saves 2025-01-${String(i).padStart(2, '0')}.zip`, { create: true });
    await d.getFileHandle('my notes.txt', { create: true });   // not ours: left alone
  });
  await page.click('#saves-folder-row button');
  await page.waitForFunction(() => /Backed up to “picked-folder”/.test(document.getElementById('saves-msg').textContent));
  const listing = () => page.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder');
    const out = [];
    for await (const [n] of d.entries()) out.push(n);
    return out.sort();
  });
  const names = await listing();
  assert.strictEqual(names.length, 11);
  assert.ok(!names.includes('Cricket 07 saves 2025-01-01.zip'), 'oldest backup kept');
  assert.ok(names.includes('my notes.txt'));
  assert.match(await page.textContent('#saves-folder-row'), /Automatic backups go to “picked-folder”/);
  // next visit after more saving: the folder copy is refreshed by itself
  await playAndSave(page, 2);
  await page.waitForFunction(() => /backed up today/.test(document.getElementById('saves-status').textContent));
  const today = (await listing()).find((n) => n.startsWith(`Cricket 07 saves ${new Date().toISOString().slice(0, 10)}`));
  const zipped = await page.evaluate(async (n) => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder');
    const entries = await RcZip.read(await (await d.getFileHandle(n)).getFile());
    return entries.map((e) => e.path);
  }, today);
  assert.ok(zipped.includes(DOCS + 'Saves/save-2.sav'), 'automatic backup missed the new save');
});

test('saves: warns when the browser may clear its storage', async ({ browser, base }) => {
  const page = await player(browser, base);
  await install(page);
  await page.waitForFunction(() => document.getElementById('saves-note').classList.contains('warn'));
  assert.match(await page.textContent('#saves-note'), /may clear the game’s storage/);
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
