# Security

What this page does and doesn't do with your computer, your files and the network. If you find a problem,
please report it to whoever runs the site (for this repository: open an issue, or contact its owner).

## The page

- **Code comes only from the page's own address**: `web/` and the engine in `build/`. No third-party
  scripts, no analytics or trackers, no `eval` or code built from strings.
- **Network**: besides its own files, the page only talks to the room server for online play (a ticket
  request and a WebSocket; by default the page's own address, and the online screen names the server
  when an invite link chose another one) and, for direct connections between players, the STUN/TURN
  servers that room server hands out. Links (credits, source) are only followed if you click them.
- **Your game folder** is copied into the browser's private storage (OPFS) and never uploaded.
- **The diagnostics report** (offered when the game stops) holds the browser, GPU and the game's last console
  lines, without the room code or room server of an online game.
- **Playing locally** with `web/serve.py`: it answers only requests addressed to this computer (`localhost`, so
  a web page can't reach it through a name of its own), serves only `web/` and the engine build, and lists no
  folders.

## Patches and rosters (`web/patches.js`)

- **Only game data is installed. Programs never are**: files are refused by name (`.exe`, `.dll`,
  `.asi`, `.bat`, `.cmd`, `.ps1`, `.vbs`, `.js`, `.jar`, `.sh`, `.msi`, `.lnk`, `.reg`, `.sys` and
  more) and by content (anything that starts like a Windows, Linux or Mac program, or a `#!` script), and
  archives inside a patch are refused too. Nothing installed is ever run by the page; the engine only
  reads it as game data, inside the browser's sandbox, and refuses heap blocks, sound buffers and textures of
  sizes nothing could hold (as Windows does) rather than wrapping its own arithmetic on them.
- **Paths can't escape**: absolute paths, `..`, drive letters, backslashes and control characters are
  refused; everything lands inside the game folder (or, for rosters, the game's saves folder).
- **Nothing changes before you confirm a plan** that lists every file and what it replaces; every replaced
  file is kept so the patch can be removed, and an install cut short is undone on the next visit.
- **Fan patches often ship as Windows installers**: don't run those. Unpack them instead (The Unarchiver
  or `innoextract` on a Mac, 7-Zip on Windows) and install the unpacked folder. Download patches from
  their makers' own pages; "serial key", "crack" or "full game" downloads are a common way to spread
  malware.

## Zip files (`web/zip.js`) and save backups (`web/saves.js`)

- Every entry's size and CRC-32 is checked; encrypted, split and ZIP64 archives are refused.
- Decompression stops at an entry's declared size and only holds what actually arrives, so a "zip bomb"
  can't fill memory; save backups are limited to 64 MB a file and 256 MB in all.
- A restore only accepts a backup made by this page (`cricket07-saves.json`), keeps the saves it replaces
  so it can be undone, and is refused while the game runs in another tab.

## Online play (`web/netplay.js`, `server/worker.js`)

- Only controller inputs, the mouse's moves and clicks, state checksums, how late each player's inputs
  arrive (for the adaptive input delay), lobby details (the name you type) and, if the host chooses, the
  host's saves travel between players. Game files never do.
- **Everything another player (or a room server) sends is checked** before the game or the page keeps it:
  inputs and reports only for the slots of the players in the match, frames and delays in range, and only so
  many held before the game starts. So a hostile peer can't grow the other player's memory or reach the game
  with input for players that don't exist.
- **The host's saves** are announced with their size and SHA-256 and checked on arrival: at most 32 MB,
  one bundle at a time, in exactly the chunks the size implies, so a hostile host (or a hostile room
  server) can't flood the other player's memory. The room server only relays saves from the host, before
  the match starts, and at most 160 MB per room.
- **Direct connections** between players (WebRTC, for the lowest lag) show each player's public IP address to
  the other, as any peer-to-peer game does. `?turn=only` sends them through the room server's relay instead,
  which keeps it hidden.
- Room tickets are signed with a secret only the server knows (`NETPLAY_SECRET`).

## The desktop app (`desktop/`)

- **Built on your Mac from your own copy** (`desktop/build-mac.sh`): no game files or engine come from
  anywhere else.
  - Its tools are each checked against checksums written in the script: Electron, the Java runtime, Ghidra,
    Emscripten's archives, and the translator's two Python packages (by hash, wheels only).
  - Emscripten installs only from the archives the script checked.
- **The app downloads, updates and runs nothing else.** It serves only its own files (`app://cricket07`, with
  no way out of its folder).
- **It talks only to** the room server it was built with and the STUN/TURN servers that server names.
- **Its window** is sandboxed (no Node.js, context isolation). Links open in your browser, https only. The page
  may ask only for folder pickers, the clipboard, pointer lock and full screen.
- **Signing:** the app is signed ad hoc for the Mac that built it.

## Hosting a test site (`deploy/vm/setup.sh`)

- Serves the page with the **stand-in engine**, never game files or a game engine build, with a banner
  saying so.
- **Downloads are pinned:**
  - Node and Caddy are checked against checksums written in the script. Node's come from its release's signed
    checksum list (the signature checked against Node's release keys); Caddy's from its release, signed by
    Caddy's release workflow on GitHub.
  - wrangler is exactly the packages in `deploy/vm/tools/package-lock.json`, checked against its hashes, and
    none of their install scripts run.
  - Everything installed belongs to root.
- **Both servers run as an unprivileged `cricket07` user in a systemd sandbox:** they can write only to their
  own state folder, can't see `/home` or gain privileges, and Caddy keeps only the right to listen on 80/443.
  Caddy's admin API is off.
- **The room-server secret** is generated on the VM, readable by root and that user only from the moment it's
  written, and kept out of the repository and command lines.
- **Only ports 80 and 443 are opened.** Caddy forwards only the room server's own paths to it; its developer
  tools (`wrangler dev`'s inspector and local explorer) listen on the VM's localhost only, so keep the VM's
  logins to people you trust. HTTPS certificates come from Let's Encrypt (Caddy), and no other site may frame
  the page.

## Tests on GitHub

`.github/workflows/web-tests.yml` runs the tests with GitHub's own actions pinned to exact commits, a read-only
token that isn't left on disk for later steps, Playwright at an exact version, and wrangler from the same
lockfile as the test VM (no install scripts run).
