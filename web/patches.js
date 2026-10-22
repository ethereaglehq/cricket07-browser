// Patches and rosters. Cricket 07's fan patches (kits, faces, stadiums, overlays, bat packs, fixtures) are
// files that go into the game folder; rosters are ".ros" folders that go into the game's own folder under
// My Documents (in OPFS: userdata/Documents and Settings/Player/My Documents/..., see host/misc.c). This
// installs them into OPFS from a folder or a .zip the player picks:
//   - Only game data. Programs and scripts (by name: .exe, .dll, .bat, ...; or by content: anything that
//     starts like a Windows, Linux or Mac program) are never installed. Patches built around a modified
//     game executable can't work in this port anyway: the engine is a translation of one executable.
//   - Paths are matched to the game folder ignoring case, as Windows and host/core.c map_path do, so
//     "data/x.fsh" lands in the existing "Data" folder instead of a second folder OPFS would keep apart.
//   - Every file a patch replaces is kept (in the store folder), so patches come off again, newest first.
//   - The game folder's version, which online players must share, includes the installed patches.
//
//   const patches = RcPatches.open({ game: 'rcgame', saves: 'userdata', store: 'rcpatches', marker: '.installed.json' })
//   const plan = await patches.plan({ files: FileList } or { zip: Blob }, name)
//   await patches.install(plan, onProgress)    onProgress({ done, total, file })
//   await patches.list()                       installed patches, oldest first
//   await patches.uninstallLast(onProgress)
(function (root) {
  'use strict';

  // never installed: programs, libraries, scripts and shortcuts, by extension...
  const PROGRAM = /\.(exe|dll|asi|com|scr|pif|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|msc|lnk|url|reg|sys|drv|cpl|ocx|ax|inf|jar|sh|command|app|dylib|so|elf|bin)$/i;
  // ...or by their first bytes: MZ (Windows), ELF, Mach-O, universal binaries, "#!" scripts
  const MAGIC = [[0x4d, 0x5a], [0x7f, 0x45, 0x4c, 0x46], [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe], [0x23, 0x21]];
  const ARCHIVE = /\.(zip|rar|7z|cab|tar|gz|tgz|bz2|xz)$/i;
  const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*)(\/|$)/i;
  const ROSTER = /\.ros$/i;
  const DOCS = ['Documents and Settings', 'Player', 'My Documents'];   // host/misc.c's "Personal" folder
  const MAX_FILE = 4 * 2 ** 30;

  const lower = (s) => s.toLowerCase();
  const safePath = (p) => !!p && p.length <= 400 && !/[\\:\0-\x1f]/.test(p) && !p.startsWith('/') &&
    p.split('/').every((s) => s && s !== '.' && s !== '..' && s.length <= 255);
  const hex = (buf, n = 12) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, n);
  const sha = async (text) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const isProgram = (bytes) => MAGIC.some((m) => m.every((b, i) => bytes[i] === b));

  // ---- OPFS helpers

  async function dirAt(dir, parts, create) {
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return dir;
  }
  async function fileAt(dir, rel) {
    const parts = rel.split('/');
    try { return await (await dirAt(dir, parts.slice(0, -1), false)).getFileHandle(parts[parts.length - 1]); } catch { return null; }
  }
  async function writeAt(dir, rel, source) {
    const parts = rel.split('/');
    const fh = await (await dirAt(dir, parts.slice(0, -1), true)).getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    if (source instanceof ReadableStream) { await source.pipeTo(w); return; }   // pipeTo closes w, or aborts it on error
    try { await w.write(source); await w.close(); } catch (e) { await w.abort().catch(() => {}); throw e; }
  }
  async function removeAt(dir, rel) {
    const parts = rel.split('/');
    try { await (await dirAt(dir, parts.slice(0, -1), false)).removeEntry(parts[parts.length - 1], { recursive: true }); }
    catch (e) { if (e.name !== 'NotFoundError') throw e; }
  }

  // Spells paths the way they already exist under `top`, ignoring case (one listing per folder), and the
  // way earlier paths of the same patch spelled new folders, so a patch never makes two folders that
  // differ only in case.
  function speller(top) {
    const listings = new Map();   // folder path (lower case) -> Map(lower name -> name), or null if new
    const planned = new Map();    // lower-case path -> spelling chosen for a new folder or file
    async function names(dir, key) {
      if (!listings.has(key)) {
        let m = null;
        if (dir) { m = new Map(); for await (const [n] of dir.entries()) m.set(lower(n), n); }
        listings.set(key, m);
      }
      return listings.get(key);
    }
    return async function spell(rel) {
      const parts = rel.split('/'), out = [];
      let dir = top;
      for (let i = 0; i < parts.length; i++) {
        const key = lower(out.join('/'));
        const name = (await names(dir, key))?.get(lower(parts[i]));
        const full = lower([...out, parts[i]].join('/'));
        const chosen = name || planned.get(full) || parts[i];
        if (!name) planned.set(full, chosen);
        out.push(chosen);
        if (i < parts.length - 1) dir = name && dir ? await dir.getDirectoryHandle(name).catch(() => null) : null;
      }
      return out.join('/');
    };
  }

  // ---- what a source holds: { path, size, file | entry }. A folder pick's paths start with its own name.

  async function itemsOf(source) {
    if (source.files) return [...source.files].map((f) => ({ path: f.webkitRelativePath || f.name, size: f.size, file: f }));
    return (await RcZip.read(source.zip)).map((e) => ({ path: e.path, size: e.size, entry: e }));
  }
  const streamOf = async (it) => (it.file ? it.file.stream() : it.entry.stream());
  async function head(it, n = 4) {
    if (it.file) return new Uint8Array(await it.file.slice(0, n).arrayBuffer());
    const reader = (await it.entry.stream()).getReader();
    const out = [];
    while (out.length < n) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      out.push(...value.subarray(0, n - out.length));
    }
    reader.cancel().catch(() => {});
    return new Uint8Array(out);
  }

  // Strips wrapper folders: "IPL Patch/Data/x" -> "Data/x", while every path shares a first folder that
  // isn't one of the game's own (Data, Audio) or a roster.
  function stripWrappers(items) {
    for (;;) {
      const first = new Set(items.map((it) => it.path.split('/')[0]));
      const [only] = first;
      if (first.size !== 1 || items.some((it) => !it.path.includes('/')) || /^(data|audio)$/i.test(only) || ROSTER.test(only)) return;
      for (const it of items) it.path = it.path.slice(only.length + 1);
    }
  }

  function open({ game = 'rcgame', saves = 'userdata', store = 'rcpatches', marker = '.installed.json' } = {}) {
    const opfs = () => navigator.storage.getDirectory();
    const gameDir = async () => (await opfs()).getDirectoryHandle(game);
    const savesDir = async (create) => (await opfs()).getDirectoryHandle(saves, { create });
    const storeDir = async () => (await opfs()).getDirectoryHandle(store, { create: true });

    async function readJson(dir, name, fallback) {
      try { return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()); } catch { return fallback; }
    }
    const list = async () => readJson(await storeDir(), 'patches.json', []);
    const saveList = async (l) => writeAt(await storeDir(), 'patches.json', JSON.stringify(l, null, 2));

    // The game's folder under My Documents (the game makes it), and where rosters go in it: beside the
    // rosters already there, else at its top. Null until the game has made the folder.
    async function rosterHome() {
      let dir;
      try { dir = await savesDir(false); } catch { return null; }
      const path = [];
      for (const want of DOCS) {
        let found = null;
        for await (const [n, h] of dir.entries()) if (h.kind === 'directory' && lower(n) === lower(want)) { found = n; break; }
        if (!found) return null;
        dir = await dir.getDirectoryHandle(found);
        path.push(found);
      }
      let docs = null;
      for await (const [n, h] of dir.entries()) if (h.kind === 'directory' && /cricket\s*0?7/i.test(n)) { docs = n; break; }
      if (!docs) return null;
      const find = async (d, rel, depth) => {
        for await (const [n, h] of d.entries()) {
          if (ROSTER.test(n)) return rel;
          if (h.kind === 'directory' && depth > 0) { const r = await find(h, [...rel, n], depth - 1); if (r) return r; }
        }
        return null;
      };
      return [...path, docs, ...(await find(await dir.getDirectoryHandle(docs), [], 2) || [])].join('/');
    }

    // What installing `source` would do, without changing anything.
    async function plan(source, name) {
      const items = (await itemsOf(source)).filter((it) => !JUNK.test(it.path));
      stripWrappers(items);
      const p = { name: String(name || 'Patch').slice(0, 80), game: [], rosters: [], refused: [], bytes: 0, replaces: 0, known: 0 };
      const spellGame = speller(await gameDir());
      let spellSaves = null, home;   // looked up once a roster turns up
      const seen = new Map();          // lower-case destination -> item (a later duplicate wins)
      for (const it of items) {
        const why = !safePath(it.path) ? 'outside the game folder'
          : PROGRAM.test(it.path) ? 'a program' : ARCHIVE.test(it.path) ? 'an archive inside the patch: unpack it first'
            : it.size > MAX_FILE ? 'too large' : isProgram(await head(it)) ? 'a program' : null;
        if (why) { p.refused.push({ path: it.path, why }); continue; }
        if (lower(it.path) === lower(marker)) { p.refused.push({ path: it.path, why: 'a name this page uses itself' }); continue; }
        const parts = it.path.split('/');
        const r = parts.findIndex((s) => ROSTER.test(s));
        if (r >= 0) {
          if (home === undefined) {
            home = await rosterHome();
            spellSaves = home && speller(await savesDir(false));
          }
          if (!home) { p.refused.push({ path: it.path, why: 'a roster, but the game has no saves folder yet' }); continue; }
          it.where = 'saves';
          it.dest = await spellSaves(home + '/' + parts.slice(r).join('/'));
        } else {
          it.where = 'game';
          it.dest = await spellGame(it.path);
        }
        seen.set(`${it.where}:${lower(it.dest)}`, it);
      }
      const savesRoot = spellSaves && await savesDir(false);
      const gameRoot = await gameDir();
      for (const it of seen.values()) {
        it.replaces = !!(await fileAt(it.where === 'game' ? gameRoot : savesRoot, it.dest));
        if (it.replaces) p.replaces++;
        if (it.where === 'game' && /^(data|audio)\//i.test(it.dest)) p.known++;
        (it.where === 'game' ? p.game : p.rosters).push(it);
        p.bytes += it.size;
      }
      p.refused.sort((a, b) => a.path.localeCompare(b.path));
      return p;
    }

    // The game folder's version (online players must share it): the folder as first copied (its version is
    // kept as `base`), plus every installed patch's content, in order.
    async function updateVersion(installed) {
      const dir = await gameDir();
      const m = await readJson(dir, marker, {});
      const base = m.base || m.version;
      const changes = installed.map((x) => x.content).filter(Boolean);
      const version = changes.length ? await sha([base, ...changes].join('\n')) : base;
      await writeAt(dir, marker, JSON.stringify({ ...m, version, base }));
      return version;
    }

    async function install(p, onProgress = () => {}) {
      const all = [...p.game, ...p.rosters];
      if (!all.length) throw new Error('Nothing to install: no game files or rosters in it.');
      const est = await navigator.storage.estimate?.();
      if (est?.quota && est.quota - (est.usage || 0) < p.bytes * 2.1)
        throw new Error(`Not enough browser storage for this patch (it needs about ${Math.ceil(p.bytes * 2 / 1e6)} MB).`);
      await recover();
      const installed = await list();
      const id = Date.now().toString(36);
      const keep = await (await storeDir()).getDirectoryHandle(id, { create: true });
      const roots = { game: await gameDir(), saves: await savesDir(true) };
      // The record goes down first, listing every file and whether it replaces one, as "installing": an
      // install cut short (a closed tab) is then undone on the next visit (recover) instead of leaving the
      // game half-patched with nothing to remove it by.
      const rec = { id, name: p.name, at: new Date().toISOString(), installing: true, files: [], refused: p.refused.map((r) => r.path) };
      for (const it of all) {
        const was = await fileAt(roots[it.where], it.dest);
        rec.files.push({ where: it.where, path: it.dest, replaced: !!was, ...(was ? { size: (await was.getFile()).size } : {}) });
      }
      installed.push(rec);
      await saveList(installed);
      const sums = [];
      try {
        for (let k = 0; k < all.length; k++) {
          const it = all[k];
          onProgress({ done: k, total: all.length, file: it.dest });
          if (rec.files[k].replaced) await writeAt(keep, `${it.where}/${it.dest}`, await (await fileAt(roots[it.where], it.dest)).getFile());   // the original
          let sum = 0;
          const counted = (await streamOf(it)).pipeThrough(new TransformStream({
            transform(chunk, ctl) { sum = RcZip.crc32(chunk, sum); ctl.enqueue(chunk); },
          }));
          await writeAt(roots[it.where], it.dest, counted);
          // Only game files count toward the online version: rosters are saves, which an online match
          // either starts without or gets from the host.
          if (it.where === 'game') sums.push(`${lower(it.dest)}:${it.size}:${sum}`);
        }
      } catch (err) {   // put back what was done so far
        await restore(rec, keep, roots, undefined, true).catch((e) => console.warn('patch rollback:', e));
        installed.pop();
        await saveList(installed);
        await (await storeDir()).removeEntry(id, { recursive: true }).catch(() => {});
        throw err;
      }
      rec.content = sums.length ? await sha(sums.sort().join('\n')) : null;
      delete rec.installing;
      await saveList(installed);
      await updateVersion(installed);
      onProgress({ done: all.length, total: all.length });
      return rec;
    }

    // Undoes rec's files, newest first: originals back, added files removed. partial: an install that
    // stopped part way, where a file with no kept original was never overwritten.
    async function restore(rec, keep, roots, onProgress = () => {}, partial = false) {
      const files = [...rec.files].reverse();
      for (let k = 0; k < files.length; k++) {
        const f = files[k];
        onProgress({ done: k, total: files.length, file: f.path });
        if (!f.replaced) { await removeAt(roots[f.where], f.path); continue; }
        // A kept original is only whole once its write finished: until then the file exists but is empty. One
        // that isn't whole means the tab closed before the game's file was touched, so it needs nothing back.
        const orig = await fileAt(keep, `${f.where}/${f.path}`);
        const whole = orig && (f.size === undefined || (await orig.getFile()).size === f.size);
        if (!whole && partial) continue;
        if (!whole) throw new Error(`The original of ${f.path} is missing, so this patch can't be removed. Choose your game folder again to start clean.`);
        await writeAt(roots[f.where], f.path, await orig.getFile());
      }
    }

    // An install that never finished (the tab closed part way) is undone. Returns its record, or null.
    async function recover() {
      const installed = await list();
      const rec = installed[installed.length - 1];
      if (!rec?.installing) return null;
      const keep = await (await storeDir()).getDirectoryHandle(rec.id, { create: true });
      await restore(rec, keep, { game: await gameDir(), saves: await savesDir(true) }, undefined, true);
      installed.pop();
      await saveList(installed);
      await (await storeDir()).removeEntry(rec.id, { recursive: true }).catch(() => {});
      return rec;
    }

    async function uninstallLast(onProgress) {
      await recover();
      const installed = await list();
      const rec = installed[installed.length - 1];
      if (!rec) return null;
      let keep;
      try { keep = await (await storeDir()).getDirectoryHandle(rec.id); }
      catch { throw new Error(`The files this patch replaced are missing, so it can't be removed. Choose your game folder again to start clean.`); }
      await restore(rec, keep, { game: await gameDir(), saves: await savesDir(true) }, onProgress);
      installed.pop();
      await saveList(installed);
      await updateVersion(installed);
      await (await storeDir()).removeEntry(rec.id, { recursive: true }).catch(() => {});
      return rec;
    }

    // a new game folder replaces the old one, patches and all
    async function forget() { await (await opfs()).removeEntry(store, { recursive: true }).catch(() => {}); }

    return { plan, install, list, uninstallLast, recover, forget, rosterHome };
  }

  const api = { open, safePath, PROGRAM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RcPatches = api;
})(typeof self !== 'undefined' ? self : this);
