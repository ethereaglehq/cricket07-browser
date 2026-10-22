/* A tiny Windows program for testing the build pipeline without a game (tests/desktop, the Desktop app
 * workflow): Ghidra finds its functions, translator/x86toc.py turns them into C, build_web.sh compiles that to
 * WebAssembly, and the app runs it. It writes hello.txt next to itself, with a number it computes, and exits.
 * No C runtime, kernel32 only, like a game's own code:
 *   i686-w64-mingw32-gcc -O1 -nostdlib -nostartfiles -e _start@0 -Wl,--subsystem,windows -o game.exe toy.c -lkernel32
 */
#include <windows.h>

static volatile unsigned calls = 1;   /* an initialised global: the program gets a .data section, as a game's executable has */

static unsigned fib(unsigned n) { calls++; return n < 2 ? n : fib(n - 1) + fib(n - 2); }

void __stdcall start(void) {
    char text[64] = "recompiled ok: fib(20) = ";
    unsigned v = fib(20), i = 25, d = 1;
    while (v / d >= 10) d *= 10;
    for (; d; d /= 10) text[i++] = (char)('0' + v / d % 10);
    text[i++] = '\n';
    HANDLE h = CreateFileA("hello.txt", GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    DWORD n;
    if (h != INVALID_HANDLE_VALUE) { WriteFile(h, text, i, &n, NULL); CloseHandle(h); }
    ExitProcess(h != INVALID_HANDLE_VALUE ? 0 : 1);
}
