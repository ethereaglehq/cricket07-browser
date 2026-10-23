// Cricket 07 for the desktop: the page (web/) and an engine built from the player's own copy of the game
// (desktop/build-mac.sh), in a window of their own. It downloads nothing and updates nothing: everything it
// runs is in this app, and the only things it talks to are the room server for online play (config.json) and,
// for direct connections between players, the STUN/TURN servers that room server names.
//
// The page is served from app://cricket07/ with the headers it needs (cross-origin isolation, for threads in
// WebAssembly), so it behaves as on a web server. Its storage (the game folder copied in, saves) lives in this
// app's own folder: ~/Library/Application Support/Cricket 07 on a Mac.
//
// Tests: CRICKET07_SITE (the folder to serve instead of ./site), CRICKET07_NETPLAY (the room server),
// CRICKET07_QUERY (more page options, e.g. watchdog=2), CRICKET07_USER_DATA (a storage folder of its own).
'use strict';
const { app, BrowserWindow, Menu, dialog, net, protocol, session, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SCHEME = 'app', HOST = 'cricket07', ORIGIN = `${SCHEME}://${HOST}`;
const SITE = fs.realpathSync(process.env.CRICKET07_SITE || path.join(__dirname, 'site'));
const config = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { return {}; }
})();
const NETPLAY = process.env.CRICKET07_NETPLAY ?? config.netplay ?? '';

if (process.env.CRICKET07_USER_DATA) app.setPath('userData', process.env.CRICKET07_USER_DATA);
// standard + secure: an origin of its own with storage, fetch and workers, treated like https
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const HEADERS = {
  // threads in WebAssembly need cross-origin isolation (as web/serve.py and the test VM send)
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-cache',
  'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
};

// A file under SITE, or null: "..", encoded separators and links out of it can't leave it.
function siteFile(url) {
  const u = new URL(url);
  if (u.host !== HOST) return null;
  let rel;
  try { rel = decodeURIComponent(u.pathname); } catch { return null; }
  if (rel.includes('\0') || rel.includes('\\')) return null;
  let file = path.join(SITE, path.normalize(rel));
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    file = fs.realpathSync(file);
  } catch { return null; }
  return file.startsWith(SITE + path.sep) && fs.statSync(file).isFile() ? file : null;
}

// The engine's ETag is its content's hash: the online lobby compares it, since players need the same build.
const hashes = new Map();
function contentHash(file, st) {
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  if (!hashes.has(key)) hashes.set(key, new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex').slice(0, 32)));
  }));
  return hashes.get(key);
}

async function serve(request) {
  const file = request.method === 'GET' || request.method === 'HEAD' ? siteFile(request.url) : null;
  if (!file) return new Response('Not found', { status: 404, headers: HEADERS });
  const st = fs.statSync(file);
  const headers = { ...HEADERS, 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': String(st.size) };
  if (file.endsWith('.wasm')) headers.ETag = `"${await contentHash(file, st)}"`;
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response((await net.fetch(pathToFileURL(file).href)).body, { status: 200, headers });
}

// What the page may ask for: picking the game and backup folders, copying a report or room code, the mouse
// held in the window and full screen. Nothing else (camera, microphone, location, notifications, ...).
const ALLOWED = new Set(['fileSystem', 'clipboard-sanitized-write', 'pointerLock', 'fullscreen']);
const ours = (url) => typeof url === 'string' && (url === ORIGIN || url.startsWith(ORIGIN + '/'));

// Links out of the app (credits, source) open in the browser; only https.
function openOutside(url) {
  try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch { /* not a URL */ }
}

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 800, minHeight: 520, show: false, title: 'Cricket 07', backgroundColor: '#0b1a12',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('render-process-gone', async (_, details) => {
    if (details.reason === 'clean-exit') return;
    await dialog.showMessageBox(win, { type: 'warning', message: 'The game stopped', detail: `(${details.reason}). It restarts now; your saves are kept.` });
    win.reload();
  });
  const query = new URLSearchParams(process.env.CRICKET07_QUERY || '');
  query.set('desktop', '');
  if (NETPLAY) query.set('netplay', NETPLAY);
  win.loadURL(`${ORIGIN}/index.html?${query.toString().replace(/=(&|$)/g, '$1')}`);
  win.on('closed', () => { win = null; });
}

function menu() {
  const mac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },   // copy and paste in the name and room code fields
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { type: 'separator' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
  ]);
}

// One copy at a time: two would share the game folder and saves.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('web-contents-created', (_, contents) => {
    contents.on('will-navigate', (e, url) => { if (!ours(url)) { e.preventDefault(); openOutside(url); } });
    contents.on('will-redirect', (e, url) => { if (!ours(url)) e.preventDefault(); });
    contents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
    contents.on('will-attach-webview', (e) => e.preventDefault());
    // During an online match the page asks before it closes (beforeunload); Electron leaves the asking to the app
    contents.on('will-prevent-unload', (e) => {
      const choice = dialog.showMessageBoxSync(BrowserWindow.fromWebContents(contents), {
        type: 'question', buttons: ['Leave', 'Stay'], defaultId: 1, cancelId: 1, message: 'Leave the match?',
        detail: 'Your friend’s game is waiting for yours. If you leave now, the match ends.',
      });
      if (choice === 0) e.preventDefault();   // leave anyway
    });
  });
  app.whenReady().then(() => {
    protocol.handle(SCHEME, serve);
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) =>
      callback(ALLOWED.has(permission) && ours(details.requestingUrl)));
    session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => ALLOWED.has(permission) && ours(origin));
    Menu.setApplicationMenu(menu());
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
