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

## Patches and rosters (`web/patches.js`)

- **Only game data is installed. Programs never are**: files are refused by name (`.exe`, `.dll`,
  `.asi`, `.bat`, `.cmd`, `.ps1`, `.vbs`, `.js`, `.jar`, `.sh`, `.msi`, `.lnk`, `.reg`, `.sys` and
  more) and by content (anything that starts like a Windows, Linux or Mac program, or a `#!` script), and
  archives inside a patch are refused too. Nothing installed is ever run by the page; the engine only
  reads it as game data, inside the browser's sandbox.
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

- Only controller inputs, state checksums, lobby details (the name you type) and, if the host chooses,
  the host's saves travel between players. Game files never do.
- **The host's saves** are announced with their size and SHA-256 and checked on arrival: at most 32 MB,
  one bundle at a time, in exactly the chunks the size implies, so a hostile host (or a hostile room
  server) can't flood the other player's memory. The room server only relays saves from the host, before
  the match starts, and at most 160 MB per room.
- Room tickets are signed with a secret only the server knows (`NETPLAY_SECRET`).

## Hosting a test site (`deploy/vm/setup.sh`)

- Serves the page with the **stand-in engine**, never game files or a game engine build, with a banner
  saying so.
- Downloads are pinned and verified: Node and Caddy against their publishers' SHA-256/SHA-512 checksums,
  wrangler at an exact version from npm (whose packages carry integrity hashes).
- Both servers run as an unprivileged `cricket07` user; the room-server secret is generated on the VM,
  readable by root and that user only, and kept out of the repository and command lines.
- Only ports 80 and 443 are opened. HTTPS certificates come from Let's Encrypt (Caddy).

## Tests on GitHub

`.github/workflows/web-tests.yml` runs the tests with GitHub's own actions pinned to exact commits, and
Playwright and wrangler at exact versions.
