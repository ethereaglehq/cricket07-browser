# Cricket 07 for the Mac

`Cricket 07.app` is the browser version in a window of its own. It includes everything in the page: saves
you can back up, patches and rosters, and online play with adaptive delay and a shared mouse. It is built **on
your Mac from your own copy of the game**. The game's `.exe` is translated to C and compiled to WebAssembly
there, and you pick the game folder in the app. No game files or engine come from anywhere else, and
the app downloads and updates nothing by itself.

## Build it

You need a Mac (Apple Silicon or Intel), Apple's command line tools (`xcode-select --install`, once), and
your copy of Cricket 07 installed, with the folder that holds its `.exe`, `Data` and `Audio`.

```sh
git clone https://github.com/ethereaglehq/cricket07-browser
cd cricket07-browser
bash desktop/build-mac.sh "/path/to/Cricket 07"
```

The app appears in `dist/`; drag it to Applications.

- **The first build** takes about an hour, most of it Ghidra analysing the executable. It also downloads
  about 1.5 GB of tools into `~/.cricket07-tools`, each checked against a checksum in the script. Later builds
  reuse them.
- **The executable:** the script picks the largest `.exe` in the folder; `--exe NAME` names another.
- **No game yet?** `bash desktop/build-mac.sh --stand-in` builds the app with a stand-in engine, so you can try
  the app itself.

## Play

- **The first time:** choose your game folder. The app copies it into its own storage
  (`~/Library/Application Support/Cricket 07`), as the browser version does.
- **Saves:** live there too. Use "Your saves" on the home screen to back them up.
- **Online:** one player creates a room and copies the room code; the other chooses Play Multiplayer and
  joins with it. Rooms run on the room server set when building (`--room`, default
  `https://cricket.wealthtape.live`, which must allow the app: `deploy/vm/setup.sh` does).
- **Two players need the same build.** They need the same game version and this repository at the same
  commit. The script pins every tool, so two Macs build the same engine; if the builds differ, the lobby says
  so.

## What it does and doesn't do

- **Talks only to:** the room server, and the STUN/TURN servers that server names for direct
  connections between players.
- **Its window:**
  - sandboxed, with no Node.js in the page;
  - links open in your browser, https only;
  - the page can't ask for your camera, microphone, location or notifications.
- **Signing:** signed "ad hoc" for your Mac (`codesign --sign -`), not by a developer account, so give it
  only to people who build it themselves.

`tests/desktop/run.js` tests the app; the "Desktop app" workflow builds and tests it on a Mac on every push.
