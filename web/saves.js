// Save backups. The game keeps its saves (profiles, rosters, tournaments, settings) in OPFS under
// userdata/: host/main.c puts the user folder there and host/misc.c maps "My Documents" into it. That
// storage belongs to this browser alone, and a browser may clear it: when the disk runs low, when the
// player clears site data, or (Safari) after some days without a visit. So the page offers
//   - a .zip of the saves to download, and restoring one (every browser), and
//   - an automatic copy into a folder the player picks once (File System Access API: Chrome, Edge).
// A restore keeps the saves it replaced in userdata.previous, so it can be undone.
//
//   const saves = RcSaves.open('userdata');
//   await saves.summary()            { files, bytes, newest }
//   await saves.exportZip()          Blob (with cricket07-saves.json, which a restore requires)
//   await saves.restoreZip(blob)     number of files restored
//   await saves.undo()               back to the saves before the last restore
//   await saves.folder()             { name, permission } of the backup folder, or null
//   await saves.chooseFolder()       asks for a folder (needs a click)
//   await saves.backupToFolder({ request, force })   { name } written, or { skipped: why }
(function (root) {
  'use strict';

  const MANIFEST = 'cricket07-saves.json';
  const KEEP = 10;                 // dated backups kept in the backup folder
  const MAX_FILE = 256 << 20;      // a save bigger than this is not a save
  const MAX_TOTAL = 1 << 30;
  const DATED = /^Cricket 07 saves (\d{4}-\d{2}-\d{2})\.zip$/;

  const today = () => new Date().toISOString().slice(0, 10);
  const zipName = () => `Cricket 07 saves ${today()}.zip`;

  async function walk(dir, prefix = '') {
    const out = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') out.push(...await walk(h, prefix + name + '/'));
      else out.push({ path: prefix + name, handle: h });
    }
    return out;
  }

  async function writeAt(dir, rel, data) {
    const parts = rel.split('/');
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    await w.write(data);
    await w.close();
  }

  async function copyDir(from, to) {
    for (const f of await walk(from)) await writeAt(to, f.path, await f.handle.getFile());
  }

  async function removeDir(parent, name) {
    try { await parent.removeEntry(name, { recursive: true }); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
  }

  async function exists(parent, name) {
    try { await parent.getDirectoryHandle(name); return true; } catch { return false; }
  }

  // A path from a zip is only written if it stays inside the saves folder: relative, no "..", no drive
  // letters or backslashes, no empty or control-character names.
  function safePath(p) {
    if (!p || p.length > 400 || /[\\:\0-\x1f]/.test(p) || p.startsWith('/')) return false;
    return p.split('/').every((s) => s && s !== '.' && s !== '..' && s.length <= 255);
  }

  // The backup folder's handle lives in IndexedDB (handles can't go in localStorage).
  function kv(mode, fn) {
    return new Promise((ok, fail) => {
      const req = indexedDB.open('rc-saves', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => fail(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', mode);
        const r = fn(tx.objectStore('kv'));
        tx.oncomplete = () => { req.result.close(); ok(r?.result); };
        tx.onerror = () => { req.result.close(); fail(tx.error); };
      };
    });
  }

  const lastKey = (dirName) => `rc-saves-last:${dirName}`;
  const readLast = (dirName) => { try { return JSON.parse(localStorage.getItem(lastKey(dirName))) || null; } catch { return null; } };
  const writeLast = (dirName, v) => { try { localStorage.setItem(lastKey(dirName), JSON.stringify(v)); } catch { /* storage blocked */ } };

  function open(dirName = 'userdata') {
    const opfs = () => navigator.storage.getDirectory();
    const savesDir = async (create = false) => (await opfs()).getDirectoryHandle(dirName, { create });

    async function files() {
      let dir;
      try { dir = await savesDir(); } catch { return []; }
      const list = await walk(dir);
      for (const f of list) f.file = await f.handle.getFile();
      return list.sort((a, b) => (a.path < b.path ? -1 : 1));
    }

    async function summary() {
      const list = await files();
      return { files: list.length, bytes: list.reduce((s, f) => s + f.file.size, 0),
        newest: list.reduce((t, f) => Math.max(t, f.file.lastModified || 0), 0) || null };
    }

    // changes whenever a save is added, removed or rewritten
    async function fingerprint(list) {
      const sig = list.map((f) => `${f.path}:${f.file.size}:${f.file.lastModified}`).join('\n');
      const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sig));
      return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    async function exportZip(list) {
      list ??= await files();
      const manifest = { kind: 'cricket07-saves', version: 1, created: new Date().toISOString(), files: list.length,
        from: location.host };
      return RcZip.write([{ path: MANIFEST, data: JSON.stringify(manifest, null, 2) },
        ...list.map((f) => ({ path: f.path, data: f.file, date: new Date(f.file.lastModified || Date.now()) }))]);
    }

    async function restoreZip(blob) {
      const entries = await RcZip.read(blob);
      const manifest = entries.find((e) => e.path === MANIFEST);
      if (!manifest) throw new Error('That file is not a Cricket 07 saves backup (it has no cricket07-saves.json).');
      let info;
      try { info = JSON.parse(new TextDecoder().decode(await manifest.read())); } catch { info = null; }
      if (info?.kind !== 'cricket07-saves') throw new Error('That file is not a Cricket 07 saves backup.');
      const list = entries.filter((e) => e !== manifest);
      const unsafe = list.find((e) => !safePath(e.path));
      if (unsafe) throw new Error(`The backup has a file outside the saves folder (${unsafe.path}); nothing was restored.`);
      if (list.some((e) => e.size > MAX_FILE) || list.reduce((s, e) => s + e.size, 0) > MAX_TOTAL)
        throw new Error('The backup is far larger than saves can be; nothing was restored.');
      // read (and check) everything before touching the current saves
      const data = [];
      for (const e of list) data.push({ path: e.path, bytes: await e.read() });
      const top = await opfs();
      await removeDir(top, dirName + '.previous');
      if (await exists(top, dirName)) await copyDir(await savesDir(), await top.getDirectoryHandle(dirName + '.previous', { create: true }));
      await removeDir(top, dirName);
      const dir = await savesDir(true);
      try {
        for (const d of data) await writeAt(dir, d.path, d.bytes);
      } catch (err) {   // put the old saves back
        await removeDir(top, dirName);
        if (await exists(top, dirName + '.previous')) await copyDir(await top.getDirectoryHandle(dirName + '.previous'), await savesDir(true));
        throw err;
      }
      return data.length;
    }

    const canUndo = async () => exists(await opfs(), dirName + '.previous');

    // swaps the saves and userdata.previous back
    async function undo() {
      const top = await opfs();
      if (!(await exists(top, dirName + '.previous'))) return false;
      const tmp = dirName + '.swap';
      await removeDir(top, tmp);
      if (await exists(top, dirName)) await copyDir(await savesDir(), await top.getDirectoryHandle(tmp, { create: true }));
      await removeDir(top, dirName);
      await copyDir(await top.getDirectoryHandle(dirName + '.previous'), await savesDir(true));
      await removeDir(top, dirName + '.previous');
      if (await exists(top, tmp)) {
        await copyDir(await top.getDirectoryHandle(tmp), await top.getDirectoryHandle(dirName + '.previous', { create: true }));
        await removeDir(top, tmp);
      }
      return true;
    }

    // ---- the backup folder (File System Access API)
    const folderSupported = typeof root.showDirectoryPicker === 'function';

    async function folderHandle() {
      try { return await kv('readonly', (s) => s.get('folder')) || null; } catch { return null; }
    }

    async function folder() {
      const h = await folderHandle();
      if (!h) return null;
      let permission = 'prompt';
      try { permission = await h.queryPermission({ mode: 'readwrite' }); } catch { /* treat as prompt */ }
      return { name: h.name, permission };
    }

    async function chooseFolder() {
      const h = await root.showDirectoryPicker({ id: 'cricket07-saves', mode: 'readwrite', startIn: 'documents' });
      await kv('readwrite', (s) => s.put(h, 'folder'));
      writeLast(dirName, null);   // a new folder gets a backup straight away
      return h.name;
    }

    // Writes today's backup into the folder (replacing an earlier one from today) and keeps the newest
    // KEEP. request: ask for permission if it lapsed (only from a click). force: even if nothing changed.
    async function backupToFolder({ request = false, force = false } = {}) {
      const h = await folderHandle();
      if (!h) return { skipped: 'no-folder' };
      let permission = await h.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
      if (permission !== 'granted' && request) permission = await h.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
      if (permission !== 'granted') return { skipped: 'permission' };
      const list = await files();
      if (!list.length) return { skipped: 'no-saves' };
      const print = await fingerprint(list);
      const last = readLast(dirName);
      if (!force && last?.fingerprint === print) return { skipped: 'unchanged', last };
      const name = zipName();
      const w = await (await h.getFileHandle(name, { create: true })).createWritable();
      await w.write(await exportZip(list));
      await w.close();
      const dated = [];
      for await (const [n, e] of h.entries()) if (e.kind === 'file' && DATED.test(n)) dated.push(n);
      for (const old of dated.sort().reverse().slice(KEEP)) await h.removeEntry(old).catch(() => {});
      const done = { at: Date.now(), fingerprint: print, name, folder: h.name };
      writeLast(dirName, done);
      return done;
    }

    // the newest backup of either kind, for the status line: { at, folder? }
    function last() {
      const f = readLast(dirName), d = readLast(dirName + ':download');
      return !f ? d : !d ? f : f.at >= d.at ? f : d;
    }
    const noteDownload = () => writeLast(dirName + ':download', { at: Date.now() });

    return { summary, exportZip, restoreZip, canUndo, undo, folderSupported, folder, chooseFolder, backupToFolder,
      last, noteDownload, zipName };
  }

  // Online: the host's saves, as exportZip made them, unpacked into a match's fresh saves folder. Every
  // player does this with the same bytes, so every game starts from the same saves (lockstep needs that).
  async function unpack(bytes, dirName) {
    const entries = (await RcZip.read(new Blob([bytes]))).filter((e) => e.path !== MANIFEST);
    if (entries.some((e) => !safePath(e.path)) || entries.reduce((s, e) => s + e.size, 0) > MAX_TOTAL) throw new Error('The saves bundle is not usable.');
    const top = await navigator.storage.getDirectory();
    await removeDir(top, dirName);
    const dir = await top.getDirectoryHandle(dirName, { create: true });
    for (const e of entries.sort((a, b) => (a.path < b.path ? -1 : 1))) await writeAt(dir, e.path, await e.read());
    return entries.length;
  }

  const api = { open, unpack, safePath, MANIFEST };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RcSaves = api;
})(typeof self !== 'undefined' ? self : this);
