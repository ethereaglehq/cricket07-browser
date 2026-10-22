#!/bin/sh
# Native test of the lockstep core (host/netplay.c) with two simulated players on a simulated network; see
# sim.c. Builds netplay.c once per player (peer.h gives each copy its own prefix) and runs every scenario, or
# the one named. Needs only a C compiler: no game, no Emscripten.
#   tests/netplay/run.sh [scripted|fixed|adaptive]
set -e
R=$(cd "$(dirname "$0")/../.." && pwd)
B=${TMPDIR:-/tmp}/rc-netplay-sim
CC=${CC:-cc}
FLAGS="-std=gnu11 -O2 -g -pthread -Wall -Wextra"
mkdir -p "$B"
for p in 0 1; do
    $CC $FLAGS -DPEER=$p -include "$R/tests/netplay/peer.h" -I"$R/runtime" -I"$R/host" -c "$R/host/netplay.c" -o "$B/peer$p.o"
done
$CC $FLAGS "$R/tests/netplay/sim.c" "$B/peer0.o" "$B/peer1.o" -o "$B/sim" -lm
exec "$B/sim" "$@"
