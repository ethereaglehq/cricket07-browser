#!/usr/bin/env python3
"""Local server for the browser build (this machine only).

Threads in WebAssembly need SharedArrayBuffer, which browsers only enable on cross-origin isolated
pages, so every response carries COOP/COEP headers.

  /            web/ (the page)
  /build/      build_web/www (recomp.js / .wasm from build_web.sh)

The page never downloads game files: the player picks their own game folder, which the browser copies
into its private storage. The server answers only requests addressed to this machine (localhost or
127.0.0.1, so a web page can't reach it through a name of its own: DNS rebinding) and serves only the two
folders above, without listings.

Usage: python3 web/serve.py [--port 8007]
"""
import argparse
import http.server
import os
import re
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(os.path.dirname(HERE), "build_web", "www")
LOCAL = {"localhost", "127.0.0.1", "[::1]"}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm",
                      ".js": "text/javascript"}

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_head(self):
        host = (self.headers.get("Host") or "").lower()
        if (host if host.endswith("]") else host.rsplit(":", 1)[0]) not in LOCAL or self.translate_path(self.path) is None:
            self.send_error(404, "File not found")
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404, "File not found")
        return None

    # A file under web/ or the build, or None: "..", absolute paths and drive letters can't leave them.
    def translate_path(self, path):
        p = urllib.parse.unquote(urllib.parse.urlparse(path).path)
        root, rest = (BUILD, p[len("/build/"):]) if p.startswith("/build/") else (HERE, p)
        root = os.path.realpath(root)
        full = os.path.realpath(os.path.join(root, *[c for c in re.split(r"[/\\]", rest) if c not in ("", ".", "..")]))
        try:
            return full if os.path.commonpath([full, root]) == root else None
        except ValueError:   # another drive
            return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8007)
    a = ap.parse_args()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print(f"http://localhost:{a.port}/")
    srv.serve_forever()


if __name__ == "__main__":
    main()
