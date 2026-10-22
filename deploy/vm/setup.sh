#!/usr/bin/env bash
# Hosts a TEST version of this site on a Linux VM: the page with the stand-in engine (tests/web/fake-engine)
# instead of the game, so the launcher, saves, patches and online play can be tried over the internet. It
# never installs game files or a game engine build. A banner on every page says it's a test site.
#
#   sudo bash deploy/vm/setup.sh <domain> [branch]       e.g. sudo bash deploy/vm/setup.sh cricket.example.com
#
# Installs Node 22 and Caddy (the web server: HTTPS from Let's Encrypt for the domain, and the cross-origin
# isolation headers the page needs), each checked against the checksum written below, plus wrangler, which
# runs the room server for online play (server/worker.js) on this VM behind Caddy at the same address: exactly
# the packages in deploy/vm/tools/package-lock.json, checked against its hashes, with none of their install
# scripts run. Adds two sandboxed systemd services (cricket07-web, cricket07-rooms) and opens ports 80 and 443
# in the VM's own firewall. Oracle Cloud also has a cloud firewall (the VCN's security list) that must allow
# them: see README.md next to this script. Run it again to update to the newest code of the branch.
#
# A VM that already serves other sites on ports 80/443: CRICKET07_LISTEN=127.0.0.1:8017 makes this site plain
# HTTP on that local address only (no certificate, no firewall change), for the existing web server or a
# Cloudflare Tunnel to put the domain in front of (it must pass WebSocket upgrades on /netplay/).
#
# Testing the script itself: CRICKET07_NO_SYSTEMD=1 starts the two servers in the background instead of as
# services, and CRICKET07_TLS=internal uses Caddy's own certificate authority (for a name like localhost).
set -euo pipefail

DOMAIN=${1:?usage: sudo bash deploy/vm/setup.sh <domain> [branch]}
BRANCH=${2:-main}
REPO=${CRICKET07_REPO:-https://github.com/ethereaglehq/cricket07-browser}
NODE_VERSION=22.12.0
CADDY_VERSION=2.9.1
# Node's from nodejs.org/dist/v22.12.0/SHASUMS256.txt (its signature checked against Node's release keys); Caddy's
# from the release's checksums.txt (its signature made by Caddy's release workflow on GitHub)
NODE_SHA256_x64=22982235e1b71fa8850f82edd09cdae7e3f32df1764a9ec298c72d25ef2c164f
NODE_SHA256_arm64=8cfd5a8b9afae5a2e0bd86b0148ca31d2589c0ea669c2d0b11c132e35d90ed68
CADDY_SHA512_amd64=0412057ba591c33bdb66034d7f32209619ce635147dac3084c79abcbc118a761145e695199f57c6798d88fab077f2b0d9cb999f52ded904c6d464a4eba202932
CADDY_SHA512_arm64=80b917c2bd8aa0892f1386ff97af9e776067dd8cdc4793238869aca7e13f7280f89d1799a1fef08b49af92dbd86684c3ba7a38b9d44afc55ef2eeb33b49e1cbd
DIR=/opt/cricket07          # code, site and tools (root-owned)
DATA=/var/lib/cricket07     # the services' writable state
ETC=/etc/cricket07

say() { printf '\n== %s\n' "$*"; }
die() { printf 'setup: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run it with sudo"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "that doesn't look like a domain name: $DOMAIN"
[[ "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || die "that doesn't look like a branch name: $BRANCH"
[[ "$REPO" =~ ^(https://|/) ]] || die "CRICKET07_REPO must be an https:// address or a folder on this VM"
case "${CRICKET07_TLS:-}" in "" | internal) ;; *) die "CRICKET07_TLS can only be internal" ;; esac
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64; CADDY_ARCH=amd64; NODE_SHA=$NODE_SHA256_x64; CADDY_SHA=$CADDY_SHA512_amd64 ;;
  aarch64 | arm64) NODE_ARCH=arm64; CADDY_ARCH=arm64; NODE_SHA=$NODE_SHA256_arm64; CADDY_SHA=$CADDY_SHA512_arm64 ;;
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
# Installed afresh unless it's this one and all root's: the tarball's files belong to uid 1000, and whoever has
# that uid here could otherwise change the program that root and the room server run.
if [ "$(cat "$DIR/node/.sha256" 2>/dev/null)" != "$NODE_SHA" ] || [ -n "$(find "$DIR/node" ! -user root -print -quit)" ]; then
  f=node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz
  curl -fsSL -o "$TMP/$f" "https://nodejs.org/dist/v$NODE_VERSION/$f"
  echo "$NODE_SHA  $TMP/$f" | sha256sum -c --quiet - || die "Node download failed its checksum"
  rm -rf "$DIR/node" && mkdir -p "$DIR/node"
  tar -xJf "$TMP/$f" -C "$DIR/node" --strip-components=1 --no-same-owner
  chown -R root:root "$DIR/node"
  echo "$NODE_SHA" >"$DIR/node/.sha256"
fi
export PATH="$DIR/node/bin:$PATH"

say "Caddy $CADDY_VERSION"
if [ "$(/usr/local/bin/caddy version 2>/dev/null | cut -d' ' -f1)" != "v$CADDY_VERSION" ]; then
  f=caddy_${CADDY_VERSION}_linux_$CADDY_ARCH.tar.gz
  curl -fsSL -o "$TMP/$f" "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/$f"
  echo "$CADDY_SHA  $TMP/$f" | sha512sum -c --quiet - || die "Caddy download failed its checksum"
  tar -xzf "$TMP/$f" -C "$TMP" --no-same-owner caddy
  install -m 755 -o root -g root "$TMP/caddy" /usr/local/bin/caddy
fi

say "Code: $REPO ($BRANCH)"
if [ -d "$DIR/repo/.git" ]; then
  git -C "$DIR/repo" fetch -q --depth 1 origin "$BRANCH"
  git -C "$DIR/repo" checkout -q -B "$BRANCH" FETCH_HEAD
else
  git clone -q --depth 1 -b "$BRANCH" "$REPO" "$DIR/repo"
fi
git -C "$DIR/repo" log -1 --format='   %h %s'

LOCK=$DIR/repo/deploy/vm/tools
say "Wrangler $(sed -n 's/.*"wrangler": "\(.*\)".*/\1/p' "$LOCK/package.json") (runs the room server)"
# exactly the packages in the lockfile, checked against its hashes; none of their install scripts run (as root,
# they could do anything)
if ! cmp -s "$LOCK/package-lock.json" "$DIR/tools/package-lock.json" || [ ! -f "$DIR/tools/node_modules/.package-lock.json" ]; then
  rm -rf "$DIR/tools" && mkdir -p "$DIR/tools"
  cp "$LOCK/package.json" "$LOCK/package-lock.json" "$DIR/tools/"
  (cd "$DIR/tools" && npm ci -q --ignore-scripts --no-fund --no-audit >/dev/null)
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
# the ticket secret is made once and kept; it stays out of the command line (ps) and the repo, and every copy is
# readable by its owner alone from the moment it's written
[ -f "$ETC/netplay-secret" ] || (umask 077 && openssl rand -hex 32 >"$ETC/netplay-secret")
(umask 077 && printf 'NETPLAY_SECRET=%s\nALLOWED_ORIGINS=https://%s\n' "$(cat "$ETC/netplay-secret")" "$DOMAIN" >"$DATA/server/.dev.vars")
mkdir -p "$DATA/rooms" "$DATA/caddy"
chown -R cricket07: "$DATA"
chmod 700 "$DATA"

say "Web server"
LISTEN=${CRICKET07_LISTEN:-}
[ -z "$LISTEN" ] || [[ "$LISTEN" =~ ^127\.0\.0\.1:[0-9]{2,5}$ ]] || die "CRICKET07_LISTEN must look like 127.0.0.1:8017"
if [ -n "$LISTEN" ]; then SITE="http://:${LISTEN##*:}"; BIND="bind 127.0.0.1"; else SITE=$DOMAIN; BIND=""; fi
cat >"$ETC/Caddyfile" <<EOF
{
	# no admin API: on localhost:2019 it would let anyone on this VM reconfigure the server (restarts reload)
	admin off
	${LISTEN:+auto_https off}
}
$SITE {
	$BIND
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
		# no other site may frame this one (clickjacking), and no plugins or base-URL tricks
		Content-Security-Policy "frame-ancestors 'none'; object-src 'none'; base-uri 'none'"
		X-Frame-Options "DENY"
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
# Both servers run as cricket07 in a sandbox: nothing to write outside $DATA, no new privileges, no view of /home
# or other programs' temporary files, and Caddy keeps only the right to listen on ports 80/443.
SANDBOX="NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$DATA
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
UMask=0077"
if [ -n "${CRICKET07_NO_SYSTEMD:-}" ]; then
  say "Starting (no systemd)"
  pkill -f "wrangler.js dev --ip 127.0.0.1 --port 8787" 2>/dev/null || true
  pkill -f "caddy run --config $ETC/Caddyfile" 2>/dev/null || true
  # with the services' environment and nothing of this shell's; Caddy as root here (binding 443 needs the
  # capability systemd gives it)
  RUNUSER=$(command -v runuser)
  (cd "$DATA/server" && nohup env -i HOME="$DATA" PATH="$DIR/node/bin:/usr/bin:/bin" WRANGLER_SEND_METRICS=false CI=1 \
    "$RUNUSER" -u cricket07 -- $WRANGLER_CMD >"$DATA/rooms.log" 2>&1 &)
  (nohup env -i XDG_DATA_HOME="$DATA/caddy" XDG_CONFIG_HOME="$DATA/caddy" \
    /usr/local/bin/caddy run --config "$ETC/Caddyfile" --adapter caddyfile >"$DATA/web.log" 2>&1 &)
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
$SANDBOX
CapabilityBoundingSet=

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
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=3
$SANDBOX

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable -q cricket07-rooms cricket07-web
  systemctl restart cricket07-rooms cricket07-web

  say "Firewall (this VM's own)"
  if [ -n "$LISTEN" ]; then
    echo "   none: the site only listens on $LISTEN"
  elif command -v firewall-cmd >/dev/null && systemctl is-active -q firewalld; then
    firewall-cmd -q --permanent --add-service=http --add-service=https && firewall-cmd -q --reload
  elif command -v iptables >/dev/null; then
    # Oracle's Ubuntu images end the INPUT chain with a REJECT: the ports go in front of it
    for p in 80 443; do iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport $p -j ACCEPT; done
    if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1 || true; fi
  fi
fi

say "Checking"
# both servers answer, or say why not
up() { for _ in $(seq 60); do curl -fsS -o /dev/null --max-time 2 "$@" 2>/dev/null && return 0; sleep 1; done; return 1; }
why() { if [ -n "${CRICKET07_NO_SYSTEMD:-}" ]; then tail -n 30 "$DATA/$1.log"; else journalctl -u "cricket07-$1" -n 30 --no-pager; fi; }
up http://127.0.0.1:8787/_netplay_ticket || { why rooms; die "the room server didn't start (above: its last lines)"; }
echo "   room server: answering"
if [ -n "$LISTEN" ]; then
  up "http://$LISTEN/" || { why web; die "the web server didn't start (above: its last lines)"; }
  echo "   web server: answering on $LISTEN"
elif [ -n "${CRICKET07_NO_SYSTEMD:-}" ]; then
  pgrep -f "caddy run --config $ETC/Caddyfile" >/dev/null || { why web; die "the web server didn't start (above: its last lines)"; }
  echo "   web server: running"
else
  sleep 2
  systemctl is-active -q cricket07-web || { why web; die "the web server didn't start (above: its last lines)"; }
  echo "   web server: running"
fi

say "Done"
if [ -n "$LISTEN" ]; then cat <<EOF
   The test site runs on http://$LISTEN (this VM only). Put https://$DOMAIN in front of it with the web server
   that owns ports 80/443, or a Cloudflare Tunnel, forwarding everything (WebSocket upgrades included) there.
   Logs:   journalctl -u cricket07-web -u cricket07-rooms -f
   Update: run this script again (with the same CRICKET07_LISTEN).
EOF
exit 0
fi
cat <<EOF
   The test site will be at https://$DOMAIN once:
     - the domain's DNS points at this VM's public IP (Cloudflare: an A record, "DNS only"), and
     - the cloud firewall allows TCP 80 and 443 (Oracle: the VCN's security list).
   The first visit can take a minute while Caddy gets the HTTPS certificate.
   Logs:   journalctl -u cricket07-web -u cricket07-rooms -f
   Update: run this script again.
EOF
