#!/bin/sh
# Native tests for the Windows layer (tests/host/host_test.c): builds them with host/ and runtime/ (no game, no
# WebGPU, no window) and runs them. Needs a C compiler with pthreads: clang or gcc, Linux or macOS.
#   tests/host/run.sh
set -e
R=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${TMPDIR:-/tmp}/rc-host-test
LIBS=-lm
[ "$(uname)" = Darwin ] && LIBS="$LIBS -framework AudioToolbox"
${CC:-cc} -O1 -g -w -D_GNU_SOURCE -pthread -I"$R/runtime" -I"$R/host" -o "$OUT" "$R/tests/host/host_test.c" \
    "$R/runtime/runtime.c" "$R/runtime/interp.c" "$R/host/core.c" "$R/host/kernel32.c" "$R/host/com.c" "$R/host/d3d8.c" \
    "$R/host/dsound.c" "$R/host/sched.c" "$R/host/misc.c" "$R/host/user32.c" "$R/host/dinput.c" "$R/host/input.c" \
    "$R/host/netplay.c" $LIBS
"$OUT" "$@"
