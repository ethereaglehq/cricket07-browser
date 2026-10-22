#!/bin/bash
# Builds "Cricket 07.app" on this Mac: the page and an engine built here from YOUR copy of the game (its .exe is
# translated to C and compiled to WebAssembly on this Mac; no game files or engine come from anywhere else), in a
# window of its own, with online play through a room server.
#
#   bash desktop/build-mac.sh "/path/to/Cricket 07"   the installed game's folder (the .exe, Data, Audio, ...)
#   bash desktop/build-mac.sh --stand-in             the app with the stand-in engine: try it without the game
#
# Options: --exe NAME     the game's executable in that folder (default: the largest .exe in it)
#          --room URL     the room server for online play (default https://cricket.wealthtape.live)
#          --out DIR      where the app goes (default: dist/ in this repository)
#
# The first build downloads its tools into ~/.cricket07-tools (about 1.5 GB: Electron, a Java runtime, Ghidra,
# Emscripten and two Python packages), each checked against the checksum written below, and can take an hour
# (Ghidra analyses the whole executable); later builds reuse them and redo only what changed. Needs Apple's
# command line tools (xcode-select --install). Everyone who plays online together needs the same build: the
# same version of the game and of this repository (the lobby compares the engines and says if they differ).
set -euo pipefail

ELECTRON_VERSION=44.7.0
ELECTRON_SHA256_arm64=e04e411b58a0a14375dd21b0ab4a378fd38930a702e4e20e322fee4849404c0b
ELECTRON_SHA256_x64=4fe494a7159b10a81e2098dab388719582065e99e604c4510bb117e282213566
# Temurin, the Java runtime Ghidra needs (from the release's .sha256.txt files)
JDK_TAG=jdk-21.0.12+8 JDK_FILE_VERSION=21.0.12_8
JDK_SHA256_arm64=021d629349ebc12a409faa517b837ec80ceee8f58a5ac85c788ecad07ca6881c
JDK_SHA256_x64=6b85c260eea574a995eacd0b3ee23c8042aa93b23a08e6478edafca0a0333d7f
# Ghidra 12.1.4 (from its release notes); it finds the functions in the executable
GHIDRA_VERSION=12.1.4 GHIDRA_DATE=20260921
GHIDRA_SHA256=ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db
# Emscripten 6.0.12: emsdk at its release commit, and the archives emsdk would download, fetched and checked
# here instead (Node's match nodejs.org's own checksums)
EMSDK_VERSION=6.0.12 EMSDK_COMMIT=35ff8a6d150541276abbc6bae512ca90bcfbe220
EMSDK_BUILD=6e9f6885cb17a3d6c8fd488a5cff730f50aba61d
EMSDK_NODE=24.19.0 EMSDK_PYTHON=3.13.3
EMSDK_SHA256_arm64="8e91c0eca2b8728aa2babb32b805318eaf5e8d6652c6535163d0ea467a6d907c 8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d 2b0899d7ade9463b0c909ef23aeea27546a4f412637998d817a49718bc2bac19"
EMSDK_SHA256_x64="2a36ac0619ad5e065d8b520c62ca8228ddf18aaf9624d4e1959b06fc4b9ebfab d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316 d3f30e1b78354d6f74fae951175dc2bd22b386aafeab13edd6ac7c9613b0d33c"
# the translator's two Python packages, by hash (wheels only: nothing is built or run while installing)
REQUIREMENTS="capstone==5.0.9 \\
  --hash=sha256:58a874d9a6cb15122135b1385a782e5b54c8a4d9396161b6498465046d2e0442 \\
  --hash=sha256:fc269c5082e17d7f9f265cd6980e2fdc6ab572df913951d76db0357e06b8001d \\
  --hash=sha256:8c4a1d7134d7d5290e5d77066500385f2c7a4bf66835ccbfde5180042d508b3c
pefile==2024.8.26 --hash=sha256:76f8b485dcd3b1bb8166f1128d395fa3d87af26360c2358fb75b80019b957c6f"

R=$(cd "$(dirname "$0")/.." && pwd)
T=${CRICKET07_TOOLS:-$HOME/.cricket07-tools}
say() { printf '\n== %s\n' "$*"; }
die() { printf 'build-mac: %s\n' "$*" >&2; exit 1; }

GAME="" EXE="" STANDIN="" ROOM=https://cricket.wealthtape.live OUT="$R/dist"
while [ $# -gt 0 ]; do
  case "$1" in
    --stand-in) STANDIN=1 ;;
    --exe) EXE=${2:?--exe needs a name}; shift ;;
    --room) ROOM=${2:?--room needs a URL}; shift ;;
    --out) OUT=${2:?--out needs a folder}; shift ;;
    -*) die "unknown option $1" ;;
    *) GAME=$1 ;;
  esac
  shift
done
[ -n "$STANDIN" ] || [ -n "$GAME" ] || die 'usage: bash desktop/build-mac.sh "/path/to/Cricket 07"   (or --stand-in)'
[[ "$ROOM" =~ ^https?://[A-Za-z0-9.:-]+/?$ ]] || die "--room: that doesn't look like a server address: $ROOM"
[ "$(uname -s)" = Darwin ] || die "this builds a Mac app: run it on a Mac"
case "$(uname -m)" in
  arm64) ARCH=arm64 JARCH=aarch64 ;;
  x86_64) ARCH=x64 JARCH=x64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac
mkdir -p "$T" "$OUT"

# fetch URL SHA256 FILE: downloads FILE unless it's there already with that checksum
fetch() {
  if [ -f "$3" ] && echo "$2  $3" | shasum -a 256 -c --status; then return 0; fi
  echo "   downloading $(basename "$3")"
  curl -fL --retry 3 --progress-bar -o "$3.part" "$1" || die "couldn't download $1"
  echo "$2  $3.part" | shasum -a 256 -c --status || { rm -f "$3.part"; die "$(basename "$3") doesn't match its checksum: not using it"; }
  mv "$3.part" "$3"
}

say "Electron $ELECTRON_VERSION (the app's window)"
E=$T/electron-$ELECTRON_VERSION-$ARCH
if [ ! -d "$E/Electron.app" ]; then
  sha=ELECTRON_SHA256_$ARCH
  fetch "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-darwin-$ARCH.zip" \
    "${!sha}" "$T/electron-$ELECTRON_VERSION-$ARCH.zip"
  rm -rf "$E.part" && mkdir -p "$E.part" && ditto -x -k "$T/electron-$ELECTRON_VERSION-$ARCH.zip" "$E.part" && mv "$E.part" "$E"
fi

if [ -z "$STANDIN" ]; then
  [ -d "$GAME" ] || die "no folder at $GAME"
  GAME=$(cd "$GAME" && pwd)
  xcode-select -p >/dev/null 2>&1 || die "Apple's command line tools are needed first: run  xcode-select --install  then this again"
  if [ -z "$EXE" ]; then   # the largest .exe at the top of the folder
    EXE=$(find "$GAME" -maxdepth 1 -type f -iname '*.exe' -exec stat -f '%z %N' {} + | sort -rn | head -1 | cut -d' ' -f2-)
    [ -n "$EXE" ] || die "no .exe in $GAME: pick the installed game's folder"
    EXE=$(basename "$EXE")
  fi
  [ -f "$GAME/$EXE" ] || die "no $EXE in $GAME"
  [[ "$EXE" =~ ^[A-Za-z0-9._\ -]+$ ]] || die "unexpected characters in the executable's name: $EXE"
  echo "   game: $GAME"
  echo "   executable: $EXE"

  say "Java runtime ($JDK_TAG) and Ghidra $GHIDRA_VERSION"
  J=$T/$JDK_TAG-$ARCH
  if [ ! -x "$J/Contents/Home/bin/java" ]; then
    sha=JDK_SHA256_$ARCH
    f=OpenJDK21U-jdk_${JARCH}_mac_hotspot_$JDK_FILE_VERSION.tar.gz
    fetch "https://github.com/adoptium/temurin21-binaries/releases/download/${JDK_TAG/+/%2B}/$f" "${!sha}" "$T/$f"
    rm -rf "$J.part" && mkdir -p "$J.part" && tar -xzf "$T/$f" -C "$J.part" --strip-components=1 && mv "$J.part" "$J"
  fi
  export JAVA_HOME=$J/Contents/Home PATH=$J/Contents/Home/bin:$PATH
  G=$T/ghidra_${GHIDRA_VERSION}_PUBLIC
  if [ ! -x "$G/support/analyzeHeadless" ]; then
    f=ghidra_${GHIDRA_VERSION}_PUBLIC_$GHIDRA_DATE.zip
    fetch "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/$f" "$GHIDRA_SHA256" "$T/$f"
    rm -rf "$G.part" && mkdir -p "$G.part" && ditto -x -k "$T/$f" "$G.part" && mv "$G.part/ghidra_${GHIDRA_VERSION}_PUBLIC" "$G" && rm -rf "$G.part"
  fi

  say "Emscripten $EMSDK_VERSION"
  M=$T/emsdk-$EMSDK_VERSION
  if [ ! -f "$M/.installed" ]; then
    [ -d "$M/.git" ] || git clone -q --depth 1 --branch "$EMSDK_VERSION" https://github.com/emscripten-core/emsdk "$M"
    [ "$(git -C "$M" rev-parse HEAD)" = "$EMSDK_COMMIT" ] || die "emsdk $EMSDK_VERSION isn't the commit it should be: not using it"
    mkdir -p "$M/downloads"
    sums=EMSDK_SHA256_$ARCH
    read -r sum_llvm sum_node sum_python <<<"${!sums}"
    if [ $ARCH = arm64 ]; then bin=wasm-binaries-arm64.tar.xz node=node-v$EMSDK_NODE-darwin-arm64.tar.gz py=python-$EMSDK_PYTHON-0-macos-arm64.tar.gz
    else bin=wasm-binaries.tar.xz node=node-v$EMSDK_NODE-darwin-x64.tar.gz py=python-$EMSDK_PYTHON-0-macos-x86_64.tar.gz; fi
    S=https://storage.googleapis.com/webassembly/emscripten-releases-builds
    fetch "$S/mac/$EMSDK_BUILD/$bin" "$sum_llvm" "$M/downloads/$EMSDK_BUILD-$bin"
    fetch "$S/deps/$node" "$sum_node" "$M/downloads/$node"
    fetch "$S/deps/$py" "$sum_python" "$M/downloads/$py"
    # emsdk uses the checked archives above instead of downloading its own
    (cd "$M" && EMSDK_KEEP_DOWNLOADS=1 ./emsdk install "$EMSDK_VERSION" >/dev/null && ./emsdk activate "$EMSDK_VERSION" >/dev/null) ||
      die "Emscripten didn't install"
    rm -rf "$M/downloads"
    touch "$M/.installed"
  fi

  say "Python packages for the translator"
  V=$T/venv
  PY=$(ls -d "$M"/python/*/bin/python3 2>/dev/null | head -1)
  [ -x "$PY" ] || die "no Python in Emscripten's folder ($M/python)"
  if ! "$V/bin/python" -c 'import capstone, pefile' 2>/dev/null; then
    rm -rf "$V" && "$PY" -m venv "$V"
    printf '%s\n' "$REQUIREMENTS" >"$T/requirements.txt"
    "$V/bin/pip" install -q --disable-pip-version-check --require-hashes --only-binary :all: --no-deps -r "$T/requirements.txt" ||
      die "the Python packages didn't install"
  fi

  W=$R/work
  mkdir -p "$W"
  say "Finding the game's functions (Ghidra; the first time takes a while)"
  sum=$(shasum -a 256 "$GAME/$EXE" | cut -d' ' -f1)
  if [ "$(cat "$W/exe.sha256" 2>/dev/null)" != "$sum" ] || [ ! -s "$W/functions.json" ]; then
    rm -f "$W/exe.sha256"
    GHIDRA=$G sh "$R/ghidra/export.sh" "$GAME/$EXE" "$W/functions.json" >"$W/ghidra.log" 2>&1 ||
      { tail -20 "$W/ghidra.log"; die "Ghidra couldn't analyse $EXE (the log: $W/ghidra.log)"; }
    echo "$sum" >"$W/exe.sha256"
  else
    echo "   (done before for this executable)"
  fi

  say "Translating it to C"
  # where the game believes it is installed; it finds its files next to its executable
  cat >"$W/profile.h" <<EOF
#ifndef RC_PROFILE_H
#define RC_PROFILE_H
#define PROFILE_EXE        "$EXE"
#define PROFILE_GUEST_ROOT "C:\\\\Program Files\\\\EA SPORTS\\\\Cricket 07"
#define PROFILE_GUEST_EXE  "$EXE"
#define PROFILE_TITLE      "Cricket 07"
#define PROFILE_REGISTRY
#endif
EOF
  (cd "$R" && "$V/bin/python" -I translator/x86toc.py "$GAME/$EXE" "$W/functions.json" "$R/out_all" --all --per-file 300 \
    >"$W/translate.log" 2>&1) || { tail -20 "$W/translate.log"; die "the translation failed (the log: $W/translate.log)"; }
  echo "   $(head -1 "$W/translate.log")"

  say "Compiling it to WebAssembly (the first time takes a while)"
  # shellcheck disable=SC1091
  (source "$M/emsdk_env.sh" >/dev/null 2>&1 && cd "$R" && PROFILE=$W/profile.h sh build_web.sh >"$W/build_web.log" 2>&1) ||
    { tail -30 "$W/build_web.log"; die "the build failed (the log: $W/build_web.log)"; }
  [ -s "$R/build_web/www/recomp.wasm" ] || die "the build made no engine"
fi

say "The app"
APP="$OUT/Cricket 07.app"
rm -rf "$APP"
ditto "$E/Electron.app" "$APP"
rm -f "$APP/Contents/Resources/default_app.asar"
A="$APP/Contents/Resources/app"
mkdir -p "$A/site/build"
cp "$R/desktop/app/main.js" "$R/desktop/app/package.json" "$A/"
printf '{\n  "netplay": "%s"\n}\n' "${ROOM%/}" >"$A/config.json"
cp -R "$R/web/." "$A/site/"
rm -f "$A/site/serve.py" "$A/site/node_env.js" "$A/site/node_stubs.c"
if [ -n "$STANDIN" ]; then
  cp "$R/tests/web/fake-engine/recomp.js" "$A/site/build/recomp.js"
  cp "$R/tests/web/fake-engine/recomp.js" "$A/site/build/recomp.wasm"
  banner='<div style="position:fixed;left:0;right:0;top:0;z-index:99;padding:4px 10px;background:#7a4a00;color:#fff;font:13px system-ui,sans-serif;text-align:center">Stand-in engine, not the game: build again with your game folder to play.</div>'
  sed -i '' "s|<main>|$banner<main>|" "$A/site/index.html"
else
  cp -R "$R/build_web/www/." "$A/site/build/"
fi
P="$APP/Contents/Info.plist"
plutil -replace CFBundleName -string "Cricket 07" "$P"
plutil -replace CFBundleDisplayName -string "Cricket 07" "$P"
plutil -replace CFBundleIdentifier -string "com.ethereaglehq.cricket07" "$P"
# signed for this Mac alone (ad hoc): the app was changed after Electron's own signature
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || die "couldn't sign the app"
codesign --verify --deep --strict "$APP" || die "the app's signature doesn't verify"

say "Done"
echo "   $APP"
[ -n "$STANDIN" ] && echo "   (the stand-in engine: build again with your game folder to play the game)"
echo "   Drag it to Applications and open it. Online play goes through $ROOM."
echo "   The game folder you pick in the app is copied into its own storage (~/Library/Application Support/Cricket 07)."
