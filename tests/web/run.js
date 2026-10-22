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
  await page.waitForFunction(() => /Automatic backups go to “picked-folder”/.test(document.getElementById('saves-folder-row').textContent));
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

// ---- patches and rosters (web/patches.js)

// a patch as a player has it after unpacking: <tmp>/<name>/...
function makePatch(name, files) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c07-patch-')), name);
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  }
  return dir;
}
const gameFolder = (page) => savedFiles(page, 'rcgame');
const markerVersion = (page) => page.evaluate(async () => JSON.parse(await (await (await (await (await navigator.storage.getDirectory())
  .getDirectoryHandle('rcgame')).getFileHandle('.installed.json')).getFile()).text()).version);

async function planPatch(page, input, file) {
  if (await page.isVisible('#go-patches')) await page.click('#go-patches');
  await page.setInputFiles(input, file);
  await page.waitForSelector('#patch-plan:not(.hidden), #patch-msg.warn');
  return page.textContent('#view-patches');
}
async function installPatch(page, input, file) {
  const plan = await planPatch(page, input, file);
  await page.click('#patch-install');
  await page.waitForFunction(() => /Installed “/.test(document.getElementById('patch-msg').textContent));
  return plan;
}
async function removeLastPatch(page, name) {
  page.once('dialog', (d) => d.accept());
  await page.click('#patch-list button');
  await page.waitForFunction((n) => document.getElementById('patch-msg').textContent === `Removed “${n}”.`, name);
}

const IPL = {
  'Data/data.gob': 'BIGF patched archive, IPL 4',
  'data/Kits/csk.fsh': 'kit: Chennai',
  'data/kits/mi.fsh': 'kit: Mumbai',
  'readme.txt': 'IPL 4 patch',
  'IPL4_TCF.ros/roster.dat': 'IPL 4 roster',
  'Cricket07.exe': 'MZ modified game program',
  'd3d8.dll': 'MZ wrapper library',
  'Data/sneaky.fsh': Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]),
  '__MACOSX/Data/._csk.fsh': 'mac junk',
};

test('patches: install from a folder, then remove it', async ({ browser, base }) => {
  const page = await player(browser, base);
  await install(page);
  await playAndSave(page, 0);   // the game makes its folder in My Documents on its first start
  const original = await gameFolder(page), version0 = await markerVersion(page);
  const plan = await installPatch(page, '#patch-folder', makePatch('IPL 4 Patch', IPL));
  assert.match(plan, /4 files for the game folder, 1 of them replacing the game's own/);
  assert.match(plan, /1 file of rosters/);
  assert.match(plan, /Skipped 3 files: /);
  for (const f of ['Cricket07.exe', 'd3d8.dll', 'Data/sneaky.fsh']) assert.ok(plan.includes(`${f} (a program)`), `${f} not refused`);
  const after = await gameFolder(page);
  assert.strictEqual(after['Data/data.gob'], IPL['Data/data.gob']);
  // Kits/ and kits/ in the patch become one folder (spelled as the first one met)
  const kits = Object.keys(after).filter((p) => /^Data\/kits\//i.test(p));
  assert.strictEqual(new Set(kits.map((p) => p.split('/')[1])).size, 1, kits.join(', '));
  assert.deepStrictEqual(kits.map((p) => after[p]).sort(), ['kit: Chennai', 'kit: Mumbai']);
  assert.ok(!Object.keys(after).some((p) => /^data\/|Cricket07\.exe$|\.dll$|sneaky|MACOSX/.test(p)), Object.keys(after).join(', '));
  assert.strictEqual(after['game.exe'], original['game.exe'], 'the game program changed');
  assert.strictEqual((await savedFiles(page))[DOCS + 'IPL4_TCF.ros/roster.dat'], 'IPL 4 roster');
  assert.notStrictEqual(await markerVersion(page), version0, 'online version ignores the patch');
  assert.match(await page.textContent('#patch-list'), /IPL 4 Patch/);
  // the game sees the patch
  await page.click('[data-go="home"]');
  await page.click('#play');
  await waitFrames(page, 5);
  assert.ok((await page.evaluate(() => window.recomp._test_files().map((f) => f.path))).some((p) => /^Data\/kits\/csk\.fsh$/i.test(p)));
  await page.reload();
  await page.waitForSelector('#view-home:not(.hidden)');
  assert.match(await page.textContent('#go-patches'), /\(1\)/);
  await page.click('#go-patches');
  await removeLastPatch(page, 'IPL 4 Patch');
  assert.deepStrictEqual(await gameFolder(page), { ...original, '.installed.json': (await gameFolder(page))['.installed.json'] });
  assert.ok(!(DOCS + 'IPL4_TCF.ros/roster.dat' in await savedFiles(page)), 'roster left behind');
  assert.strictEqual(await markerVersion(page), version0);
});

test('patches: install from a .zip with a wrapper folder', async ({ browser, base }) => {
  const page = await player(browser, base);
  await install(page);
  const zip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c07-pz-')), 'CWC 2011.zip');
  require('child_process').execFileSync('python3', ['-I', '-c', `
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('CWC 2011 v2/Data/data.gob', 'BIGF world cup archive ' * 500)
    z.writestr('CWC 2011 v2/Data/Stadiums/wankhede.o', 'stadium model')
    z.writestr('CWC 2011 v2/Data/', '')
`, zip]);
  const plan = await installPatch(page, '#patch-zip', zip);
  assert.match(plan, /CWC 2011/);
  assert.match(plan, /2 files for the game folder, 1 of them replacing/);
  const after = await gameFolder(page);
  assert.strictEqual(after['Data/data.gob'], 'BIGF world cup archive '.repeat(500));
  assert.strictEqual(after['Data/Stadiums/wankhede.o'], 'stadium model');
});

test('patches: stacked patches come off newest first', async ({ browser, base }) => {
  const page = await player(browser, base);
  await install(page);
  const original = await gameFolder(page);
  await installPatch(page, '#patch-folder', makePatch('A', { 'Data/data.gob': 'A archive', 'Data/a.fsh': 'A texture' }));
  const afterA = await gameFolder(page);
  await installPatch(page, '#patch-folder', makePatch('B', { 'Data/data.gob': 'B archive', 'Data/a.fsh': 'B texture', 'Data/b.fsh': 'B only' }));
  assert.strictEqual((await gameFolder(page))['Data/a.fsh'], 'B texture');
  await removeLastPatch(page, 'B');
  const back = await gameFolder(page);
  assert.strictEqual(back['Data/data.gob'], 'A archive');
  assert.strictEqual(back['Data/a.fsh'], 'A texture');
  assert.ok(!('Data/b.fsh' in back));
  assert.strictEqual(back['.installed.json'], afterA['.installed.json'], 'version after removing B should match A alone');
  await removeLastPatch(page, 'A');
  const clean = await gameFolder(page);
  delete clean['.installed.json'];
  delete original['.installed.json'];
  assert.deepStrictEqual(clean, original);
});

test('patches: refuses programs and explains rosters before the first start', async ({ browser, base }) => {
  const page = await player(browser, base);
  await install(page);
  let plan = await planPatch(page, '#patch-folder', makePatch('Ultimate EXE', { 'Cricket 07_Launcher.exe': 'MZ', 'binkw32.dll': 'MZ', 'tool.bat': 'echo' }));
  assert.match(plan, /Skipped 3 files/);
  assert.match(plan, /Programs are never installed/);
  assert.ok(await page.isDisabled('#patch-install'));
  plan = await planPatch(page, '#patch-folder', makePatch('IPL roster', { 'IPL4_TCF.ros/roster.dat': 'roster' }));
  assert.match(plan, /start the game once and save/);
  assert.ok(await page.isDisabled('#patch-install'));
  plan = await planPatch(page, '#patch-folder', makePatch('Bundle', { 'kits.rar': 'Rar!', 'Data/x.fsh': 'ok' }));
  assert.match(plan, /kits\.rar \(an archive inside the patch: unpack it first\)/);
});

test('online: players need the same patches', async ({ browser, base, netplay }) => {
  const patch = makePatch('IPL 4', { 'Data/data.gob': 'IPL archive', 'Data/kit.fsh': 'kit' });
  const q = `netplay=${encodeURIComponent(netplay)}`;
  const host = await player(browser, base + '?' + q, 'host');
  await install(host);
  await installPatch(host, '#patch-folder', patch);
  await host.click('[data-go="home"]');
  await host.click('#go-online');
  await host.click('#np-host');
  await host.waitForSelector('#view-lobby:not(.hidden)');
  const code = (await host.textContent('#np-room')).trim();
  const guest = await player(browser, `${base}?join=${code}&${q}`, 'guest');
  await install(guest);
  await guest.click('#np-join');
  await host.waitForFunction(() => /Has different game files or patches/.test(document.getElementById('np-players').textContent));
  assert.ok(await host.isDisabled('#np-start'));
  assert.match(await host.textContent('#np-lobbymsg'), /need the same patches/);
  // the guest installs the same patch and comes back
  await guest.goto(`${base}?${q}`);
  await guest.waitForSelector('#view-home:not(.hidden)');
  await installPatch(guest, '#patch-folder', patch);
  await guest.goto(`${base}?join=${code}&${q}`);
  await guest.waitForSelector('#view-online:not(.hidden)');
  await guest.click('#np-join');
  await host.waitForFunction(() => document.querySelectorAll('#np-players li').length === 2 &&
    !/different game files/.test(document.getElementById('np-players').textContent) && !document.getElementById('np-start').disabled);
}, { online: true });

// ---- saves in online matches (netplay.js offerFiles, saves.js unpack)

// host and guest in one room; the host has played solo (saves) and added a roster
async function roomWithSaves(browser, base, netplay) {
  const q = `netplay=${encodeURIComponent(netplay)}`;
  const host = await player(browser, base + '?' + q, 'host');
  await install(host);
  await playAndSave(host, 2);
  await installPatch(host, '#patch-folder', makePatch('IPL roster', { 'IPL4_TCF.ros/roster.dat': 'IPL 4 roster' }));
  await host.click('[data-go="home"]');
  await host.click('#go-online');
  await host.click('#np-host');
  await host.waitForSelector('#view-lobby:not(.hidden)');
  const code = (await host.textContent('#np-room')).trim();
  const guest = await player(browser, `${base}?join=${code}&${q}`, 'guest');
  await install(guest);
  await guest.click('#np-join');
  await host.waitForFunction(() => !document.getElementById('np-start').disabled && /\(\d+ files\)/.test(document.getElementById('np-bring-info').textContent));
  return { host, guest };
}
const savesAtStart = (page) => page.evaluate(() => window.recomp._test_saves_at_start().map((f) => `${f.path}:${f.size}`).sort());

test('online: the host brings their saves and rosters to the match', async ({ browser, base, netplay }) => {
  const { host, guest } = await roomWithSaves(browser, base, netplay);
  assert.ok(await host.isChecked('#np-bring'));
  await host.click('#np-start');
  await guest.waitForFunction(() => window.recomp?._test_info);
  await Promise.all([waitFrames(host, 200, 30000), waitFrames(guest, 200, 30000)]);
  const [a, b] = [await savesAtStart(host), await savesAtStart(guest)];
  assert.deepStrictEqual(b, a, 'the two games started from different saves');
  for (const want of [DOCS + 'IPL4_TCF.ros/roster.dat', DOCS + 'Saves/save-1.sav', DOCS + 'Settings.dat'])
    assert.ok(a.some((f) => f.startsWith(want + ':')), `${want} missing: ${a.join(', ')}`);
  assert.ok(!a.some((f) => f.includes('cricket07-saves.json')));
  const [ia, ib] = await Promise.all([host, guest].map((p) => p.evaluate(() => window.recomp._test_info())));
  assert.strictEqual(ia.net.desync + ib.net.desync, 0, 'desync');
  // the guest's own (solo) saves are untouched
  assert.deepStrictEqual(await savedFiles(guest), {});
}, { online: true });

test('online: without "Bring my saves" both games start fresh', async ({ browser, base, netplay }) => {
  const { host, guest } = await roomWithSaves(browser, base, netplay);
  await host.uncheck('#np-bring');
  await host.click('#np-start');
  await guest.waitForFunction(() => window.recomp?._test_info);
  await Promise.all([waitFrames(host, 60, 30000), waitFrames(guest, 60, 30000)]);
  assert.deepStrictEqual(await savesAtStart(host), []);
  assert.deepStrictEqual(await savesAtStart(guest), []);
}, { online: true });

// ---- hostile input (from the security review)

test('netplay: a hostile host or room server cannot flood a guest with save chunks', async () => {
  // web/netplay.js driven directly, with a stand-in WebSocket whose "server" is this test
  const sockets = [];
  global.WebSocket = class { constructor(url) { this.url = url; this.readyState = 1; this.bufferedAmount = 0; this.sent = []; sockets.push(this); setTimeout(() => this.onopen?.(), 0); }
    send(t) { this.sent.push(t); } close() { this.readyState = 3; } };
  const np = require('../../web/netplay.js');
  const errors = [], progress = [];
  const c = np.connect({ url: 'ws://test', name: 'guest', version: 'v', onError: (e) => errors.push(e), onFiles: (f) => progress.push(f), onLobby() {} });
  await sleep(10);
  const ws = sockets[0], say = (m) => ws.onmessage({ data: JSON.stringify(m) });
  say({ t: 'lobby', you: 1, host: false, players: [{ slot: 0 }, { slot: 1 }] });
  const big = 'A'.repeat(4 * 256 * 1024);   // 1 MB of base64 per chunk
  const before = process.memoryUsage().heapUsed;
  // a declared size of 1 byte in a billion chunks: refused outright
  say({ t: 'files', id: '0123456789abcdef', hash: 'a'.repeat(64), size: 1, n: 1e9 });
  for (let k = 0; k < 150; k++) say({ t: 'chunk', id: '0123456789abcdef', k, data: big });
  // a valid announcement, then chunks of the wrong size: dropped at the first
  say({ t: 'files', id: '0123456789abcdee', hash: 'b'.repeat(64), size: 3 * 192 * 1024, n: 3 });
  for (let k = 0; k < 150; k++) say({ t: 'chunk', id: '0123456789abcdee', k: k % 3, data: big });
  global.gc?.();
  const grown = (process.memoryUsage().heapUsed - before) / 1e6;
  assert.ok(grown < 40, `guest held ${grown.toFixed(0)} MB`);
  assert.ok(errors.some((e) => /damaged/.test(e)), 'wrong-size chunk not reported');
  assert.deepStrictEqual(progress, [0]);   // only the valid announcement registered, no chunk accepted
  c.close();
  delete global.WebSocket;
});

test('zip: an entry claiming a huge size is not allocated up front', async () => {
  // a few KB of deflated zeros that declare 900 MB when unpacked
  const zip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c07-big-')), 'claims.zip');
  require('child_process').execFileSync('python3', ['-I', '-c', `
import zipfile, sys, struct
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z: z.writestr('a.bin', b'\\0' * 200000)
b = bytearray(open(sys.argv[1], 'rb').read())
b[22:26] = struct.pack('<I', 900 << 20); cd = b.rfind(b'PK\\x01\\x02'); b[cd + 24:cd + 28] = struct.pack('<I', 900 << 20)
open(sys.argv[1], 'wb').write(b)`, zip]);
  const before = process.memoryUsage().rss;
  const [e] = await RcZip.read(new Blob([fs.readFileSync(zip)]));
  await assert.rejects(e.read(), /damaged/);
  assert.ok(process.memoryUsage().rss - before < 300e6, 'reader reserved the declared size');
});

test('patches: an install cut short by closing the tab is undone on the next visit', async ({ browser, base }) => {
  const page = await player(browser, base);
  await install(page);
  const original = await gameFolder(page);
  // the second file is big enough to still be copying when the page goes away
  const patch = makePatch('Big', { 'Data/data.gob': 'replaced archive', 'Data/zz-big.fsh': Buffer.alloc(120e6, 7), 'Data/zzz.fsh': 'last' });
  await planPatch(page, '#patch-folder', patch);
  await page.click('#patch-install');
  await page.waitForFunction(() => /Installing [12] of 3/.test(document.getElementById('patch-msg').textContent));
  await page.reload();   // as if the tab closed mid-install
  await page.waitForSelector('#view-home:not(.hidden)');
  await page.waitForFunction(async () => !(await RcPatches.open().list()).length);
  const now = await gameFolder(page);
  delete now['.installed.json']; delete original['.installed.json'];
  assert.deepStrictEqual(now, original, 'game folder not restored');
  assert.match(await page.textContent('#go-patches'), /^Patches & rosters$/);
});

test('patches and saves: no changes while the game runs in another tab', async ({ browser, base }) => {
  const page = await player(browser, base);
  await install(page);
  await playAndSave(page, 1);
  const file = await download(page);
  const other = await page.context().newPage();
  await other.goto(base);
  await other.waitForSelector('#view-home:not(.hidden)');
  await other.click('#play');   // the game runs in the second tab
  await waitFrames(other, 5);
  page.on('dialog', (d) => d.accept());
  await page.setInputFiles('#saves-import', file);
  await page.waitForFunction(() => /open in another tab/.test(document.getElementById('saves-msg').textContent), null, { timeout: 5000 })
    .catch(async (e) => { throw new Error(`saves-msg: "${await page.textContent('#saves-msg')}" ${e.message}`); });
  await page.click('#go-patches');
  await planPatch(page, '#patch-folder', makePatch('P', { 'Data/x.fsh': 'x' }));
  await page.click('#patch-install');
  await page.waitForFunction(() => /open in another tab/.test(document.getElementById('patch-msg').textContent), null, { timeout: 5000 })
    .catch(async (e) => { throw new Error(`patch-msg: "${await page.textContent('#patch-msg')}" plan hidden: ${await page.isHidden('#patch-plan')} ${e.message}`); });
  await other.close();
  await sleep(300);   // the closed tab lets go of the lock
  await page.click('#patch-install');
  await page.waitForFunction(() => /Installed “P”/.test(document.getElementById('patch-msg').textContent));
});

test('patches: a patch may not overwrite the page\'s own marker file', async ({ browser, base }) => {
  const page = await player(browser, base);
  await install(page);
  const plan = await planPatch(page, '#patch-folder', makePatch('Sneaky', { '.installed.json': '{"version":"forged"}', 'Data/ok.fsh': 'ok' }));
  assert.match(plan, /\.installed\.json \(a name this page uses itself\)/);
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
