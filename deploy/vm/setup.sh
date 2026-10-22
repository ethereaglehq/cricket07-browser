#!/usr/bin/env bash
# Hosts a TEST version of this site on a Linux VM: the page with the stand-in engine (tests/web/fake-engine)
# instead of the game, so the launcher, saves, patches and online play can be tried over the internet. It
# never installs game files or a game engine build. A banner on every page says it's a test site.
#
#   sudo bash deploy/vm/setup.sh <domain> [branch]       e.g. sudo bash deploy/vm/setup.sh cricket.example.com
#
# Installs, all checksum-verified: Node 22 and Caddy (the web server: HTTPS from Let's Encrypt for the domain,
# and the cross-origin isolation headers the page needs), plus wrangler, which runs the room server for
# online play (server/worker.js) on this VM behind Caddy at the same address. Adds two systemd services
# (cricket07-web, cricket07-rooms) and opens ports 80 and 443 in the VM's own firewall. Oracle Cloud also
# has a cloud firewall (the VCN's security list) that must allow them: see README.md next to this script.
# Run it again to update to the newest code of the branch.
#
# Testing the script itself: CRICKET07_NO_SYSTEMD=1 starts the two servers in the background instead of as
# services, and CRICKET07_TLS=internal uses Caddy's own certificate authority (for a name like localhost).
set -euo pipefail

DOMAIN=${1:?usage: sudo bash deploy/vm/setup.sh <domain> [branch]}
BRANCH=${2:-main}
REPO=${CRICKET07_REPO:-https://github.com/ethereaglehq/cricket07-browser}
NODE_VERSION=22.12.0
CADDY_VERSION=2.9.1
WRANGLER_VERSION=4.151.3
DIR=/opt/cricket07          # code, site and tools (root-owned)
DATA=/var/lib/cricket07     # the services' writable state
ETC=/etc/cricket07

say() { printf '\n== %s\n' "$*"; }
die() { printf 'setup: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run it with sudo"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "that doesn't look like a domain name: $DOMAIN"
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64; CADDY_ARCH=amd64 ;;
  aarch64 | arm64) NODE_ARCH=arm64; CADDY_ARCH=arm64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac

say "Packages"
if command -v apt-get >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -yq git curl tar xz-utils openssl ca-certificates >/dev/null
elif command -v dnf >/dev/null; then
  dnf install -yq git curl tar xz openssl ca-certificates >/dev/null
else
  die "no apt-get or dnf: install git, curl, tar, xz and openssl, then run this again"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DIR" "$DATA" "$ETC"

say "Node $NODE_VERSION"
if [ "$("$DIR/node/bin/node" -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  f=node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz
  curl -fsSL -o "$TMP/$f" "https://nodejs.org/dist/v$NODE_VERSION/$f"
  curl -fsSL -o "$TMP/sums" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$TMP" && grep " $f\$" sums | sha256sum -c --quiet -) || die "Node download failed its checksum"
  rm -rf "$DIR/node" && mkdir -p "$DIR/node"
  tar -xJf "$TMP/$f" -C "$DIR/node" --strip-components=1
fi
export PATH="$DIR/node/bin:$PATH"

say "Caddy $CADDY_VERSION"
if [ "$(/usr/local/bin/caddy version 2>/dev/null | cut -d' ' -f1)" != "v$CADDY_VERSION" ]; then
  f=caddy_${CADDY_VERSION}_linux_$CADDY_ARCH.tar.gz
  base=https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION
  curl -fsSL -o "$TMP/$f" "$base/$f"
  curl -fsSL -o "$TMP/sums" "$base/caddy_${CADDY_VERSION}_checksums.txt"
  (cd "$TMP" && grep " $f\$" sums | sha512sum -c --quiet -) || die "Caddy download failed its checksum"
  tar -xzf "$TMP/$f" -C "$TMP" caddy
  install -m 755 "$TMP/caddy" /usr/local/bin/caddy
fi

say "Code: $REPO ($BRANCH)"
if [ -d "$DIR/repo/.git" ]; then
  git -C "$DIR/repo" fetch -q --depth 1 origin "$BRANCH"
  git -C "$DIR/repo" checkout -q -B "$BRANCH" FETCH_HEAD
else
  git clone -q --depth 1 -b "$BRANCH" "$REPO" "$DIR/repo"
fi
git -C "$DIR/repo" log -1 --format='   %h %s'

say "Wrangler $WRANGLER_VERSION (runs the room server)"
if [ ! -x "$DIR/tools/node_modules/.bin/wrangler" ] || ! grep -q "\"version\": \"$WRANGLER_VERSION\"" "$DIR/tools/node_modules/wrangler/package.json"; then
  mkdir -p "$DIR/tools"
  npm install -q --no-fund --no-audit --prefix "$DIR/tools" "wrangler@$WRANGLER_VERSION" >/dev/null
fi

say "Site"
# web/ is the page; /build/ is the stand-in engine. recomp.wasm only answers the page's size check.
rm -rf "$DIR/site.new" && mkdir -p "$DIR/site.new/build"
cp -r "$DIR/repo/web/." "$DIR/site.new/"
rm -f "$DIR/site.new/serve.py" "$DIR/site.new/node_env.js"
cp "$DIR/repo/tests/web/fake-engine/recomp.js" "$DIR/site.new/build/recomp.js"
cp "$DIR/repo/tests/web/fake-engine/recomp.js" "$DIR/site.new/build/recomp.wasm"
banner='<div style="position:fixed;left:0;right:0;top:0;z-index:99;padding:4px 10px;background:#7a4a00;color:#fff;font:13px system-ui,sans-serif;text-align:center">Test site: a stand-in engine, not the game. For trying saves, patches and online play.</div>'
sed -i "s|<main>|$banner\n<main>|" "$DIR/site.new/index.html"
grep -q 'Test site: a stand-in engine' "$DIR/site.new/index.html" || die "couldn't add the test-site banner"
rm -rf "$DIR/site.old"
[ -d "$DIR/site" ] && mv "$DIR/site" "$DIR/site.old"
mv "$DIR/site.new" "$DIR/site"

say "Room server"
id cricket07 >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin cricket07
rm -rf "$DATA/server" && cp -r "$DIR/repo/server" "$DATA/server"
# the ticket secret is made once and kept; it stays out of the command line (ps) and the repo
[ -f "$ETC/netplay-secret" ] || (umask 077 && openssl rand -hex 32 >"$ETC/netplay-secret")
printf 'NETPLAY_SECRET=%s\nALLOWED_ORIGINS=https://%s\n' "$(cat "$ETC/netplay-secret")" "$DOMAIN" >"$DATA/server/.dev.vars"
mkdir -p "$DATA/rooms" "$DATA/caddy"
chown -R cricket07: "$DATA"
chmod 600 "$DATA/server/.dev.vars"

say "Web server"
cat >"$ETC/Caddyfile" <<EOF
$DOMAIN {
	${CRICKET07_TLS:+tls $CRICKET07_TLS}
	encode zstd gzip
	header {
		# threads in WebAssembly need cross-origin isolation (see web/serve.py)
		Cross-Origin-Opener-Policy "same-origin"
		Cross-Origin-Embedder-Policy "require-corp"
		Cross-Origin-Resource-Policy "same-origin"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		Cache-Control "no-cache"
	}
	# the room server: tickets and room WebSockets, at the page's own address
	@rooms path /_netplay_ticket /netplay/*
	handle @rooms {
		reverse_proxy 127.0.0.1:8787
	}
	handle {
		root * $DIR/site
		file_server
	}
}
EOF
/usr/local/bin/caddy validate --config "$ETC/Caddyfile" --adapter caddyfile >/dev/null 2>&1 || die "the web server's configuration didn't validate"

WRANGLER_CMD="$DIR/node/bin/node $DIR/tools/node_modules/wrangler/bin/wrangler.js dev --ip 127.0.0.1 --port 8787 --persist-to $DATA/rooms"
# SELinux (on by default on Oracle Linux) only lets services start programs labelled as such
if command -v getenforce >/dev/null && [ "$(getenforce)" = Enforcing ]; then
  chcon -t bin_t "$DIR/node/bin/node" /usr/local/bin/caddy
fi
if [ -n "${CRICKET07_NO_SYSTEMD:-}" ]; then
  say "Starting (no systemd)"
  pkill -f "wrangler dev --ip 127.0.0.1 --port 8787" 2>/dev/null || true
  pkill -f "caddy run --config $ETC/Caddyfile" 2>/dev/null || true
  (cd "$DATA/server" && WRANGLER_SEND_METRICS=false CI=1 HOME="$DATA" nohup $WRANGLER_CMD >"$DATA/rooms.log" 2>&1 &)
  (XDG_DATA_HOME="$DATA/caddy" XDG_CONFIG_HOME="$DATA/caddy" nohup /usr/local/bin/caddy run --config "$ETC/Caddyfile" --adapter caddyfile >"$DATA/web.log" 2>&1 &)
else
  say "Services"
  cat >/etc/systemd/system/cricket07-rooms.service <<EOF
[Unit]
Description=Cricket 07 test site: room server for online play (server/worker.js)
After=network-online.target
Wants=network-online.target

[Service]
User=cricket07
WorkingDirectory=$DATA/server
Environment=HOME=$DATA PATH=$DIR/node/bin:/usr/bin:/bin WRANGLER_SEND_METRICS=false CI=1
ExecStart=$WRANGLER_CMD
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  cat >/etc/systemd/system/cricket07-web.service <<EOF
[Unit]
Description=Cricket 07 test site: web server (Caddy)
After=network-online.target cricket07-rooms.service
Wants=network-online.target

[Service]
User=cricket07
Environment=XDG_DATA_HOME=$DATA/caddy XDG_CONFIG_HOME=$DATA/caddy
ExecStart=/usr/local/bin/caddy run --config $ETC/Caddyfile --adapter caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable -q cricket07-rooms cricket07-web
  systemctl restart cricket07-rooms cricket07-web

  say "Firewall (this VM's own)"
  if command -v firewall-cmd >/dev/null && systemctl is-active -q firewalld; then
    firewall-cmd -q --permanent --add-service=http --add-service=https && firewall-cmd -q --reload
  elif command -v iptables >/dev/null; then
    # Oracle's Ubuntu images end the INPUT chain with a REJECT: the ports go in front of it
    for p in 80 443; do iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport $p -j ACCEPT; done
    if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1 || true; fi
  fi
fi

say "Done"
cat <<EOF
   The test site will be at https://$DOMAIN once:
     - the domain's DNS points at this VM's public IP (Cloudflare: an A record, "DNS only"), and
     - the cloud firewall allows TCP 80 and 443 (Oracle: the VCN's security list).
   The first visit can take a minute while Caddy gets the HTTPS certificate.
   Logs:   journalctl -u cricket07-web -u cricket07-rooms -f
   Update: run this script again.
EOF
