// Browser tests for the page (web/), run against the stand-in engine (fake-engine/recomp.js), so they need
// no game files. Headless Chromium through Playwright; online tests also start the room server locally.
//
//   node tests/web/run.js [name filter]
//   BASE_URL=https://test.example.com node tests/web/run.js    the same tests against a deployed test site
//                                                              (deploy/vm), its own room server included
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

async function player(browser, url, name = 'player', init = null, contextOptions = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 },
    ignoreHTTPSErrors: !!process.env.BASE_URL, ...contextOptions });
  await ctx.addInitScript(STUB_GPU);
  for (const script of [init].flat()) if (script) await ctx.addInitScript(script);
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

test('netplay: hostile input messages are checked before the game or the input delay sees them', async () => {
  const sockets = [];
  global.WebSocket = class { constructor(url) { this.url = url; this.readyState = 1; this.bufferedAmount = 0; this.sent = []; sockets.push(this); setTimeout(() => this.onopen?.(), 0); }
    send(t) { this.sent.push(t); } close() { this.readyState = 3; } };
  const np = require('../../web/netplay.js');
  const left = [];
  const c = np.connect({ url: 'ws://test', name: 'host', version: 'v', onLobby() {}, onStart() {}, onLeft: (s) => left.push(s) });
  await sleep(10);
  const ws = sockets[0], say = (m) => ws.onmessage({ data: JSON.stringify(m) });
  const input = (s, f, lead = 4) => [s, f, 0, 0, 0, 0, 0, 16667, lead];   // slot, frame, buttons, axes, frame time, lead
  say({ t: 'lobby', you: 0, host: true, players: [{ slot: 0 }, { slot: 1 }] });
  say({ t: 'in', d: [input(1, 999999)] });   // before the start: nothing is due yet
  say({ t: 'start', players: 2, delay: 4, you: 0 });
  // before the game is attached: kept for it, but only so many
  for (let k = 0; k < 100; k++) say({ t: 'in', d: Array.from({ length: 50 }, (_, i) => input(1, 1 + k * 50 + i)) });
  const seen = [], hashes = [], delays = [];
  const M = {
    _netplay_remote_input: (s, f) => { seen.push([s, f]); return 0; },
    _netplay_remote_hash: (s) => hashes.push(s),
    _netplay_player_left() {},
    _netplay_set_delay: (n) => delays.push(n),
    _netplay_status: () => 0,
    _netplay_pop: () => 0,
    _netplay_msg: () => 0,
  };
  c.attach(M, 2 ** 31 - 1);
  assert.ok(seen.length > 1000 && seen.length <= 2048, `${seen.length} early inputs kept`);
  assert.ok(!seen.some(([, f]) => f === 999999), 'an input from before the start reached the game');
  seen.length = 0;
  // the game reads slots as 32-bit integers: aliases of player 1, our own slot and slots no game has never reach it
  say({ t: 'in', d: [input(1 + 2 ** 32, 1), input('1', 2), input(1.5, 3), input(-1, 4), input(0, 5), input(2, 6), input(1, -1), input(1, 2 ** 40), input(1, 7)],
    h: [[1 + 2 ** 32, 60, 1, 2], [3, 60, 1, 2], [1, 60, 1, 2]] });
  assert.deepStrictEqual(seen, [[1, 7]]);
  assert.deepStrictEqual(hashes, [1]);
  // a lag report from an alias of player 1 is ignored; player 1's own is capped at a second (the 30-frame ceiling)
  say({ t: 'in', d: [], by: 1 + 2 ** 32, lag: { 0: 1e9 } });
  await sleep(600);
  assert.deepStrictEqual(delays, []);
  say({ t: 'in', d: [], by: 1, lag: { 0: 1e9 } });
  await sleep(600);
  assert.deepStrictEqual(delays, [30]);
  say({ t: 'left', slot: 1 + 2 ** 32 });
  say({ t: 'left', slot: 1 });
  assert.deepStrictEqual(left, [1]);
  c.close();
  delete global.WebSocket;
});

test('serve.py: only the page and the build, only to this computer, no listings', async () => {
  const port = 9100 + Math.floor(Math.random() * 800);
  const proc = spawn('python3', [path.join(ROOT, 'web', 'serve.py'), '--port', String(port)]);
  const get = (p, host = `localhost:${port}`) => new Promise((resolve, reject) => {
    require('http').get({ host: '127.0.0.1', port, path: p, headers: { host } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  try {
    for (let i = 0; i < 50; i++) { try { await get('/'); break; } catch { await sleep(100); } }
    assert.strictEqual(await get('/'), 200);
    assert.strictEqual(await get('/loader.js'), 200);
    const secret = path.join(ROOT, 'README.md');
    for (const p of ['/build/' + secret, '/build//etc/passwd', '/../README.md', '/..%2fREADME.md', '/%2e%2e/README.md',
      '/build/..%2f..%2fREADME.md', '/..\\README.md', '/build/', '/fake-dir/'])
      assert.strictEqual(await get(p), 404, p);
    // a web page that points a name of its own at this computer (DNS rebinding) gets nothing
    assert.strictEqual(await get('/', 'evil.example'), 404);
    assert.strictEqual(await get('/', 'localhost.evil.example'), 404);
    assert.strictEqual(await get('/', `127.0.0.1:${port}`), 200);
  } finally { proc.kill(); }
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

// An install that stops for good where a write of `name` begins: the next visit must undo it exactly.
// The write never finishing is what a tab closed at that moment leaves behind (OPFS writes land on close).
async function interruptedInstall(browser, base, name) {
  const page = await player(browser, base, 'player', () => {
    const create = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function (...a) {
      return this.name === window.__stopAt ? new Promise(() => {}) : create.apply(this, a);
    };
  });
  await install(page);
  const original = await gameFolder(page);
  await planPatch(page, '#patch-folder', makePatch('Big', { 'Data/data.gob': 'replaced archive', 'Data/zz-new.fsh': 'new', 'Data/zzz.fsh': 'last' }));
  await page.evaluate((n) => { window.__stopAt = n; }, name);
  await page.click('#patch-install');
  await page.waitForFunction(() => /Installing [0-2] of 3/.test(document.getElementById('patch-msg').textContent));
  await sleep(300);
  await page.reload();   // as if the tab closed there
  await page.waitForSelector('#view-home:not(.hidden)');
  await page.waitForFunction(async () => !(await RcPatches.open().list()).length);
  const now = await gameFolder(page);
  delete now['.installed.json']; delete original['.installed.json'];
  const diff = [...new Set([...Object.keys(now), ...Object.keys(original)])].filter((k) => now[k] !== original[k]);
  assert.deepStrictEqual(diff, [], `game folder not restored: ${diff.map((k) => `${k} (${k in original ? 'changed' : 'extra'})`).join(', ')}`);
  assert.match(await page.textContent('#go-patches'), /^Patches & rosters$/);
}

test('patches: an install cut short by closing the tab is undone on the next visit', async ({ browser, base }) => {
  await interruptedInstall(browser, base, 'zz-new.fsh');   // data.gob already replaced, the next file half made
});

test('patches: a tab closed while keeping an original leaves the game file alone', async ({ browser, base }) => {
  await interruptedInstall(browser, base, 'data.gob');     // the kept copy of data.gob exists but is still empty
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

// Host and guest meet in a room and the host starts the game. Options: query (added to both pages' URLs, or
// one per player as [host's, guest's]), init (scripts for both pages, as for player()).
// delay: frames to start with instead of Auto (whose pick depends on how far away the room server is)
async function startOnline({ browser, base, netplay }, { query = '', init = null, delay = null } = {}) {
  const [hq, gq] = Array.isArray(query) ? query : [query, query];
  const np = `netplay=${encodeURIComponent(netplay)}`;
  const host = await player(browser, `${base}?${np}${hq}`, 'host', init);
  await install(host);
  await host.click('#go-online');
  await host.fill('#np-name', 'Host');
  await host.click('#np-host');
  await host.waitForSelector('#view-lobby:not(.hidden)');
  const code = (await host.textContent('#np-room')).trim();
  const guest = await player(browser, `${base}?join=${code}&${np}${gq}`, 'guest', init);
  await install(guest);
  await guest.fill('#np-name', 'Guest');
  await guest.click('#np-join');
  await guest.waitForSelector('#view-lobby:not(.hidden)');
  await host.waitForFunction(() => !document.getElementById('np-start').disabled);
  await sleep(1500);   // a few pings, for the auto delay
  if (delay) await host.evaluate((d) => { document.getElementById('np-delay').value = d; }, String(delay));
  await host.click('#np-start');
  return [host, guest];
}
const netInfo = (page) => page.evaluate(() => window.recomp._test_info().net);
async function noDesync(players) {
  for (const [i, p] of players.entries()) assert.strictEqual((await netInfo(p)).desync, 0, `${i ? 'guest' : 'host'} saw a desync`);
}
// Polls the players' input delays until ok(delays) holds, and returns them.
async function delaysUntil(players, what, ok, ms) {
  const t0 = Date.now();
  for (;;) {
    const d = await delays(players);
    if (ok(d)) return d;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what} (delays now ${d})`);
    await sleep(250);
  }
}

test('online: two players stay in lockstep', async (env) => {
  const [host, guest] = await startOnline(env);
  await Promise.all([waitFrames(host, 300, 30000), waitFrames(guest, 300, 30000)]);
  await noDesync([host, guest]);
  assert.match(await host.textContent('#netstatus'), /Online · player 1 of 2/);
}, { online: true });

test('online: the mouse works, the same for both players (the screens the PC version leaves to it)', async (env) => {
  const players = await startOnline(env);
  const [host, guest] = players;
  await Promise.all(players.map((p) => waitFrames(p, 120, 30000)));
  const use = (p, dx, dy) => p.evaluate(([dx, dy]) => {
    const canvas = document.getElementById('canvas');
    canvas.dispatchEvent(new MouseEvent('mousemove', { movementX: dx, movementY: dy, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
  }, [dx, dy]);
  const cursors = () => Promise.all(players.map((p) => p.evaluate(() => { const { x, y, clicks } = window.recomp._test_mouse(); return { x, y, clicks }; })));
  const until = async (want) => {
    for (const t0 = Date.now(); Date.now() - t0 < 10000; await sleep(100)) {
      const c = await cursors();
      if (c.every((m) => m.x === want.x && m.y === want.y && m.clicks === want.clicks)) return;
    }
    assert.fail(`cursors ${JSON.stringify(await cursors())}, wanted ${JSON.stringify(want)} on both`);
  };
  await use(guest, 30, 20);   // the guest moves and clicks: both games see it
  await until({ x: 350, y: 260, clicks: 1 });
  await use(host, -50, 5);    // then the host, the same cursor
  await until({ x: 300, y: 265, clicks: 2 });
  await waitFrames(host, 200, 30000);
  await noDesync(players);
}, { online: true });

// A bad connection for the online tests (an init script): everything the page sends waits window.__net.base
// ms plus up to window.__net.jitter ms first (both can change mid-game). The jitter holds for 50 ms at a time,
// as on a busy Wi-Fi link, so the repeats of a late input in the next direct packets are late too. The room's
// WebSocket keeps its order, as TCP does (a late message holds back the ones after it); the direct channels
// don't. On a page opened with &legacy, the game messages look like an older version's: no lead on its inputs
// and no reports, which an older netplay.js doesn't send.
function NET_SHAPER() {
  window.__net = { base: 0, jitter: 0, legacy: new URLSearchParams(location.search).has('legacy') };
  let slot = -1, r = 0;
  const delay = () => {
    const k = Math.floor(performance.now() / 50);
    if (k !== slot) { slot = k; r = Math.random(); }
    return window.__net.base + r * window.__net.jitter;
  };
  const legacy = (data) => {
    if (!window.__net.legacy || typeof data !== 'string' || !data.startsWith('{"t":"in"')) return data;
    const m = JSON.parse(data);
    return JSON.stringify({ t: 'in', d: m.d.map((e) => e.slice(0, 8)), h: m.h });
  };
  const wsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    data = legacy(data);
    const now = performance.now(), at = Math.max(now + delay(), this.rcAt || 0);
    this.rcAt = at;
    if (at <= now) return wsSend.call(this, data);
    setTimeout(() => { if (this.readyState === 1) wsSend.call(this, data); }, at - now);
  };
  const dcSend = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    data = legacy(data);
    const ms = delay();
    if (!ms) return dcSend.call(this, data);
    setTimeout(() => { if (this.readyState === 'open') dcSend.call(this, data); }, ms);
  };
}
const setNet = (players, net) => Promise.all(players.map((p) => p.evaluate((n) => Object.assign(window.__net, n), net)));
const BAD_NET = { base: 20, jitter: 100 };   // 20-120 ms each way
const delays = (players) => Promise.all(players.map(async (p) => (await netInfo(p)).delay));
// the delays once they have stayed put for 3 s (a start delay longer than the connection needs comes down first)
async function settledDelays(players, ms = 30000) {
  const t0 = Date.now();
  let last = await delays(players), since = Date.now();
  for (;;) {
    await sleep(250);
    const d = await delays(players);
    if (String(d) !== String(last)) { last = d; since = Date.now(); } else if (Date.now() - since >= 3000) return d;
    if (Date.now() - t0 > ms) throw new Error(`the delays did not settle (now ${d})`);
  }
}

test('online: the input delay rises with jitter and comes back down when it calms', async (env) => {
  const players = await startOnline(env, { init: NET_SHAPER, delay: 4 });
  await Promise.all(players.map((p) => waitFrames(p, 120, 30000)));
  const calm = await settledDelays(players);
  await setNet(players, BAD_NET);
  const t0 = Date.now();
  const up = await delaysUntil(players, `the delays to rise from ${calm}`, (d) => d.every((x, i) => x >= calm[i] + 2), 20000);
  const rose = Date.now() - t0;
  assert.match(await players[0].textContent('#netstatus'), /delay \d+ frames \(\d+ ms(, adjusting)?\) · direct( \((host|srflx|TURN)\))? \d+ ms/);
  await sleep(3000);
  const peak = await delays(players);
  await setNet(players, { base: 0, jitter: 0 });
  const t1 = Date.now();
  const down = await delaysUntil(players, `the delays to come down from ${peak}`, (d) => d.every((x, i) => x <= peak[i] - 2), 40000);
  console.log(`     delays (host, guest): calm ${calm}, ${up} after ${(rose / 1000).toFixed(1)} s of jitter, peak ${peak},` +
    ` ${down} after ${((Date.now() - t1) / 1000).toFixed(1)} s calm`);
  await noDesync(players);
}, { online: true });

test('online: the delay adapts with the room as the only path', async (env) => {
  // no direct channels (as when WebRTC can't connect): inputs and the reports on them go through the room server
  const noWebRTC = () => { delete window.RTCPeerConnection; };
  const players = await startOnline(env, { init: [noWebRTC, NET_SHAPER] });
  await Promise.all(players.map((p) => waitFrames(p, 120, 30000)));
  assert.match(await players[0].textContent('#netstatus'), /· through the room \d+ ms/);
  const calm = await settledDelays(players);
  await setNet(players, BAD_NET);
  await delaysUntil(players, `the delays to rise from ${calm}`, (d) => d.every((x, i) => x >= calm[i] + 2), 20000);
  await noDesync(players);
}, { online: true });

test('online: ?adaptive=0 keeps the delay the game started with', async (env) => {
  const players = await startOnline(env, { query: '&adaptive=0', init: NET_SHAPER, delay: 4 });
  await Promise.all(players.map((p) => waitFrames(p, 120, 30000)));
  const before = await delays(players);
  await setNet(players, BAD_NET);
  await sleep(8000);
  assert.deepStrictEqual(await delays(players), before);
  assert.ok((await netInfo(players[0])).stalls + (await netInfo(players[1])).stalls > 0, 'the jitter caused no stalls');
  await noDesync(players);
}, { online: true });

test('online: a peer without adaptive delay plays with one that has it', async (env) => {
  // the guest acts as an older version: it doesn't adapt, and its messages carry no leads or reports
  const players = await startOnline(env, { query: ['', '&adaptive=0&legacy'], init: NET_SHAPER });
  await Promise.all(players.map((p) => waitFrames(p, 120, 30000)));
  const before = await delays(players);
  await setNet(players, BAD_NET);
  await sleep(8000);
  // the host hears no reports, so it keeps the session's delay too
  assert.deepStrictEqual(await delays(players), before);
  const frames = await Promise.all(players.map(frameOf));
  await Promise.all(players.map((p, i) => waitFrames(p, frames[i] + 120, 30000)));
  await noDesync(players);
}, { online: true });

// ---- when the game stops (web/loader.js)

const haltShown = (page) => page.isVisible('#halt');
const engineInfo = (page) => page.evaluate(() => window.recomp._test_info());
async function playSolo(page) {
  await page.click('#play');
  await waitFrames(page, 10);
}

test('stops: an exception in a frame does not end the picture', async ({ browser, base }) => {
  const page = await player(browser, base);
  await install(page);
  await playSolo(page);
  await page.evaluate(() => window.recomp._test_throw_pump(5));
  await waitFrames(page, await frameOf(page) + 60);
  const reports = page.logs.filter((l) => /frame loop failed/.test(l));
  assert.strictEqual(reports.length, 1, `reported once: ${reports.join(' | ')}`);
  assert.match(reports[0], /stand-in: the frame pump failed/);
  assert.ok(!await haltShown(page), 'an overlay for a frame that recovered');
});

test('stops: running out of memory says so, the engine is left alone, Restart keeps the saves', async ({ browser, base }) => {
  const page = await player(browser, base);
  await install(page);
  await playSolo(page);
  await page.keyboard.press('s');   // the stand-in saves on S
  await sleep(200);
  await page.evaluate(() => {
    window.recomp._test_print('guest heap exhausted (1048576 bytes requested; 255 MB used, 2 MB of it in free blocks)');
    window.recomp._test_abort('native code called abort()');
  });
  await page.waitForSelector('#halt:not(.hidden)');
  assert.match(await page.textContent('#halt-title'), /The game stopped/);
  assert.match(await page.textContent('#halt-why'), /ran out of memory/);
  assert.match(await page.textContent('#halt-detail'), /^guest heap exhausted \(1048576 bytes requested/);
  assert.match(await page.textContent('#halt'), /Your saves are safe/);
  // nothing calls into the stopped engine: no frame pumps, no keys
  const before = await engineInfo(page);
  await page.keyboard.press('ArrowUp');
  await page.mouse.click(300, 300);
  await sleep(300);
  const after = await engineInfo(page);
  assert.strictEqual(after.pumps, before.pumps, 'the page still pumps the stopped engine');
  assert.strictEqual(after.keys, before.keys, 'keys still reach the stopped engine');
  await page.click('#halt-restart');
  await page.waitForSelector('#view-home:not(.hidden)');
  assert.ok(Object.keys(await savedFiles(page)).includes(DOCS + 'Saves/save-1.sav'), 'the save is gone');
});

test('stops: a trap, a worker error, a lost GPU and an exit each say what happened', async ({ browser, base }) => {
  const page = await player(browser, base);
  await install(page);
  const cases = [
    [(M) => { M._test_print('\n*** guest trap at 00412345: indirect call to unknown function (return address 00401234)\n' +
      '    eax=00000000 ecx=1234abcd'); M._test_abort('native code called abort()'); },
     /The game stopped/, /can’t recover/, /^\*\*\* guest trap at 00412345/],
    [(M) => M._test_worker_error('memory access out of bounds'), /The game stopped/, /crashed/, /worker sent an error!.*out of bounds/],
    [(M) => M._test_worker_error('unreachable', false), /The game stopped/, /crashed/, /RuntimeError: unreachable/],
    [(M) => M._test_print('[wgpu] device lost (reason 1): the GPU process exited'), /The game stopped/, /graphics device/, /device lost/],
    [(M) => M._test_print('[kernel32] ExitProcess(0) from thread 256, stack: 0040a000'), /has closed/, /has closed/, /ExitProcess/],
  ];
  for (const [fail, title, why, detail] of cases) {
    await page.reload();
    await page.waitForSelector('#view-home:not(.hidden)');
    await playSolo(page);
    await page.evaluate(`(${fail})(window.recomp)`);
    await page.waitForSelector('#halt:not(.hidden)');
    assert.match(await page.textContent('#halt-title'), title);
    assert.match(await page.textContent('#halt-why'), why);
    assert.match(await page.textContent('#halt-detail'), detail);
    assert.ok(!await page.isVisible('#halt-wait'), 'Keep waiting offered for a stopped game');
  }
});

test('stops: the watchdog offers Restart and diagnostics when frames stop, and goes when they resume', async ({ browser, base }) => {
  const page = await player(browser, base + '?watchdog=2&fps', 'player', null, { permissions: ['clipboard-read', 'clipboard-write'] });
  await install(page);
  await playSolo(page);
  await waitFrames(page, 130);   // two [mem] reports
  await page.evaluate(() => window.recomp._test_hang());
  await page.waitForSelector('#halt:not(.hidden)', { timeout: 6000 });
  assert.match(await page.textContent('#halt-title'), /isn’t responding/);
  assert.match(await page.textContent('#halt-why'), /No new picture for \d+ seconds/);
  await page.click('#halt-copy');
  await page.waitForFunction(() => document.getElementById('halt-report').value);
  const report = await page.inputValue('#halt-report');
  for (const want of [/^browser: .*Chrome/m, /^WebGPU adapter: /m, /^wasm memory: \d+ MB/m, /^frames presented: \d+, the last/m,
    /^URL options: watchdog=2 fps$/m, /^game: running \(not responding\), solo/m, /^\[mem\] guest heap \d+ MB/m,
    /^\[fake\] started/m])
    assert.match(report, want);
  if (/Copied/.test(await page.textContent('#halt-copy')))
    assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), report);
  // the game comes back by itself: the overlay goes
  await page.evaluate(() => window.recomp._test_unhang());
  await page.waitForSelector('#halt', { state: 'hidden' });
  // Keep waiting: away until the watchdog sees no frames for as long again
  await page.evaluate(() => window.recomp._test_hang());
  await page.waitForSelector('#halt:not(.hidden)', { timeout: 6000 });
  await page.click('#halt-wait');
  assert.ok(!await haltShown(page), 'Keep waiting left the overlay up');
  await page.waitForSelector('#halt:not(.hidden)', { timeout: 6000 });
});

test('stops: the watchdog leaves a hidden tab alone', async ({ browser, base }) => {
  const page = await player(browser, base + '?watchdog=1');
  await install(page);
  await playSolo(page);
  const setHidden = (hidden) => page.evaluate((hidden) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await setHidden(true);
  await page.evaluate(() => window.recomp._test_hang());   // a hidden tab presents nothing
  await sleep(3000);
  assert.ok(!await haltShown(page), 'the watchdog fired in a hidden tab');
  await setHidden(false);
  await page.waitForSelector('#halt:not(.hidden)', { timeout: 5000 });
});

test('online: the watchdog waits for the other player, and flags a stuck game', async ({ browser, base, netplay }) => {
  const [host, guest] = await startOnline({ browser, base, netplay }, { query: '&watchdog=2' });
  await Promise.all([waitFrames(host, 120, 30000), waitFrames(guest, 120, 30000)]);
  await guest.evaluate(() => window.recomp._test_hang());   // the guest's game freezes; the host waits for its input
  await guest.waitForSelector('#halt:not(.hidden)', { timeout: 8000 });
  assert.match(await guest.textContent('#halt-title'), /isn’t responding/);
  // its diagnostics leave out the room code (a way into the match) and the room server
  await guest.evaluate(() => { document.getElementById('halt-more').open = true; });
  await guest.waitForFunction(() => document.getElementById('halt-report').value);
  const report = await guest.inputValue('#halt-report'), code = new URL(guest.url()).searchParams.get('join');
  assert.match(report, /^URL options: join=… netplay=… watchdog=2$/m);
  assert.ok(code && !report.includes(code), 'the room code is in the diagnostics');
  await sleep(3000);
  assert.ok(await host.evaluate(() => window.recomp._netplay_status(4)), 'the host is not waiting for input');
  assert.ok(!await haltShown(host), 'the host, waiting for the other player, got the overlay');
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
  const server = process.env.BASE_URL ? null : await start(0);
  const base = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/?$/, '/') : `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch();
  let rooms = null, failed = 0;
  try {
    if (process.env.BASE_URL) rooms = { url: new URL(base).origin, stop() {} };   // the site's own room server
    else if (chosen.some((t) => t.online)) rooms = await roomServer();
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
    server?.close();
  }
  console.log(failed ? `${failed} of ${chosen.length} failed` : `all ${chosen.length} passed`);
  process.exit(failed ? 1 : 0);
})();
