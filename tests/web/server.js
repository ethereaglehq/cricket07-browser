// Test server for the page: like web/serve.py (web/ at /, cross-origin isolation headers), but /build/ is
// the stand-in engine (fake-engine/) unless --build points at a real build_web/www.
//   node tests/web/server.js [--port 8017] [--build build_web/www]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'web');
const FAKE = path.join(__dirname, 'fake-engine');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.css': 'text/css' };

function start(port = 0, build = null) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file;
    if (p.startsWith('/build/')) {
      const rel = p.slice('/build/'.length);
      file = path.join(build || FAKE, rel);
      // the fake has no .wasm; the page only asks for its ETag/size (buildVersion)
      if (!build && rel === 'recomp.wasm') file = path.join(FAKE, 'recomp.js');
    } else file = path.join(WEB, p === '/' ? 'index.html' : p);
    const base = p.startsWith('/build/') ? (build || FAKE) : WEB;
    if (!path.resolve(file).startsWith(path.resolve(base)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': body.length,
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (require.main === module) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  start(Number(arg('--port') || 8017), arg('--build')).then((s) => console.log(`http://localhost:${s.address().port}/`));
}

module.exports = { start };
