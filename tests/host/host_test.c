/* Native tests for the Windows layer's resource handling (host/, runtime/), without the game: they call the
 * import handlers and COM methods the way the game does (stdcall, arguments on the guest stack) and check what a
 * long session depends on: memory and address space given back and reused, threads that end, critical sections,
 * GetProcAddress, dynamic code regions, Direct3D surface levels and DirectSound buffers. Also that sizes nothing can
 * hold, as a corrupt data file can give them, fail as they do on Windows.
 *
 *   tests/host/run.sh
 */
#include "win32.h"
#include "com.h"
#include "render.h"

#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>

/* not linked: the WebGPU executor and the native watchpoint */
size_t g_gpu_tex_bytes;
uint32_t g_gpu_bind_groups_made;
void watch_arm(uint32_t addr) { (void)addr; }

static CPU g_cpu, *c = &g_cpu;
static int g_failed, g_checks;
#define CHECK(cond, ...) do { g_checks++; if (!(cond)) { g_failed++; fprintf(stderr, "FAIL %s:%d: %s: ", __FILE__, __LINE__, \
    #cond); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } } while (0)
#define ARGS(...) (int)(sizeof((uint32_t[]){ __VA_ARGS__ }) / 4), (uint32_t[]){ __VA_ARGS__ }

static GuestFn import(const char *name) {
    GuestFn fn = find_import_handler(name);
    if (!fn) { fprintf(stderr, "no handler for %s\n", name); exit(2); }
    return fn;
}
/* An import called on `cpu` as the game calls it: arguments pushed right to left, then the return address. */
static uint32_t callv(CPU *cpu, GuestFn fn, int n, const uint32_t *a) {
    uint32_t esp = cpu->esp;
    for (int i = n - 1; i >= 0; i--) PUSH32(cpu, a[i]);
    PUSH32(cpu, GUEST_RETURN_SENTINEL);
    fn(cpu);
    if (cpu->esp != esp) { fprintf(stderr, "stack not balanced after a call\n"); exit(2); }
    return cpu->eax;
}
#define K(name, ...) callv(c, import("KERNEL32.DLL!" name), ARGS(__VA_ARGS__))
static uint32_t last_error(void) { return t_self->last_error; }

/* A COM method by name, through the object's vtable as the game's `call [reg+N]` does. */
static uint32_t comv(uint32_t obj, const char *method, int n, const uint32_t *a) {
    uint32_t vt = R32(obj);
    for (int i = 0; i < 128; i++) {
        uint32_t slot = R32(vt + 4u * (uint32_t)i);
        const char *name = import_name(slot), *m = name ? strstr(name, "::") : NULL;
        if (!m) break;
        if (strcmp(m + 2, method)) continue;
        uint32_t esp = c->esp;
        for (int k = n - 1; k >= 0; k--) PUSH32(c, a[k]);
        PUSH32(c, obj);
        PUSH32(c, GUEST_RETURN_SENTINEL);
        call_indirect(c, slot);
        if (c->esp != esp) { fprintf(stderr, "stack not balanced after %s\n", name); exit(2); }
        return c->eax;
    }
    fprintf(stderr, "no method %s\n", method);
    exit(2);
}
#define COM(obj, method, ...) comv(obj, method, ARGS(__VA_ARGS__))
static uint32_t release(uint32_t obj) { return comv(obj, "Release", 0, NULL); }
/* A create call that must fail with `hr` and leave NULL in the game's pointer at `out` */
#define CREATE_FAILS(hr, out, obj, method, ...) (W32(out, 0xDEADBEEFu), COM(obj, method, __VA_ARGS__) == (hr) && !R32(out))

static uint32_t gstr(const char *s) { return guest_strdup(s); }
static uint32_t gbuf(uint32_t n) { return heap_alloc(n, 1); }
void guest_mem_stats(uint32_t *heap_used, uint32_t *valloc_used);   /* core.c */
static uint32_t valloc_span(void) { uint32_t h, v; guest_mem_stats(&h, &v); return v; }
static int open_fds(void) {
    int n = 0;
    DIR *d = opendir("/dev/fd");
    while (d && readdir(d)) n++;
    if (d) closedir(d);
    return n;
}

/* ------------------------------------------------------------------ guest heap */

static void test_heap(void) {
    uint32_t big = heap_alloc(1 << 20, 0);
    heap_free(big);
    uint32_t small = heap_alloc(5000, 0);
    CHECK(small == big, "a 5000-byte request takes the freed 1 MB block (%08x, not %08x)", small, big);
    CHECK(heap_size(small) == 5008, "and only what it asked for: %u bytes", heap_size(small));
    uint32_t rest = heap_alloc(512 << 10, 0);
    CHECK(rest == big + 5008 + 16, "the rest of that block is used next (%08x)", rest);
    heap_free(small); heap_free(rest);
    /* best fit: of a free 64 KB and 32 KB block, a 20 KB request takes the 32 KB one */
    uint32_t a = heap_alloc(64 << 10, 0), sep = heap_alloc(16, 0), b = heap_alloc(32 << 10, 0), sep2 = heap_alloc(16, 0);
    heap_free(b); heap_free(a);   /* a is first on the free list */
    uint32_t x = heap_alloc(20 << 10, 0);
    CHECK(x == b, "best fit takes the 32 KB block (%08x), not the 64 KB one (%08x): got %08x", b, a, x);
    heap_free(x); heap_free(sep); heap_free(sep2);
}

/* Sizes as a corrupt data file can give them. One near 4 GiB wrapped the heap's top around, so the next block went
   over live ones; one that rounds up past 4 GiB took the first freed large block, whatever its size. */
static void test_heap_limits(void) {
    uint32_t used0, used, v;
    guest_mem_stats(&used0, &v);
    CHECK(!heap_alloc(0xFFFFFF00u, 0), "a block bigger than the whole heap is refused");
    guest_mem_stats(&used, &v);
    CHECK(used == used0, "and the heap's top stays where it was (%u bytes used, were %u)", used, used0);
    uint32_t big = heap_alloc(1 << 20, 0);
    heap_free(big);
    CHECK(!heap_alloc(0xFFFFFFF8u, 0), "so is one that rounds up past 4 GiB");
    uint32_t again = heap_alloc(1 << 20, 0);
    CHECK(again == big, "and the freed 1 MB block is still there for the next request (%08x, got %08x)", big, again);
    heap_free(again);
    /* as the game sees it: NULL, and ERROR_NOT_ENOUGH_MEMORY */
    uint32_t heap = callv(c, import("KERNEL32.DLL!GetProcessHeap"), 0, NULL);
    K("SetLastError", 0);
    CHECK(!K("HeapAlloc", heap, 0, 0xFFFFFF00u) && last_error() == 8, "HeapAlloc fails with ERROR_NOT_ENOUGH_MEMORY");
    K("SetLastError", 0);
    CHECK(!K("GlobalAlloc", 0, 0xFFFFFFF8u) && last_error() == 8, "and so does GlobalAlloc");
    uint32_t p = K("HeapAlloc", heap, 0, 100);
    memset(HP(p), 0x5A, 100);
    K("SetLastError", 0);
    CHECK(!K("HeapReAlloc", heap, 0, p, 0xFFFFFFF8u) && last_error() == 8, "HeapReAlloc to a size that rounds past 4 GiB fails");
    CHECK(!K("HeapReAlloc", heap, 0, p, 0xFFFFFF00u), "and to one bigger than the heap");
    CHECK(heap_size(p) == 112 && R8(p) == 0x5A && R8(p + 99) == 0x5A, "the block stays as it was");
    uint32_t q = K("HeapReAlloc", heap, 0, p, 5000);
    CHECK(q && heap_size(q) >= 5000 && R8(q) == 0x5A && R8(q + 99) == 0x5A, "an ordinary size still grows it");
    K("HeapFree", heap, 0, q);
    /* the largest block is the whole heap less its header; a byte more used to abort ("guest heap exhausted") */
    CHECK(!heap_alloc(GUEST_HEAP_HI - GUEST_HEAP_BASE - 15, 0), "a byte more than the largest block there can be is refused");
}

/* ------------------------------------------------------------------ the VirtualAlloc window */

static void test_valloc(void) {
    uint32_t span0 = valloc_span();
    uint32_t a = K("VirtualAlloc", 0, 3 << 20, 0x3000, 4);
    CHECK(a && !(a & 0xffff), "VirtualAlloc gives a 64 KB-aligned region (%08x)", a);
    memset(HP(a), 0xAB, 3 << 20);
    CHECK(K("VirtualFree", a, 0, 0x8000) == 1, "MEM_RELEASE succeeds");
    uint32_t b = K("VirtualAlloc", 0, 1 << 20, 0x3000, 4);
    CHECK(b == a, "the released range is handed out again (%08x, got %08x)", a, b);
    int zero = 1;
    for (uint32_t i = 0; i < (1u << 20); i++) if (R8(b + i)) { zero = 0; break; }
    CHECK(zero, "and it is zero again, as VirtualAlloc'd memory is");
    /* neighbours merge: x, y freed make room for one 2 MB region where they were */
    uint32_t x = K("VirtualAlloc", 0, 1 << 20, 0x3000, 4), y = K("VirtualAlloc", 0, 1 << 20, 0x3000, 4);
    uint32_t z = K("VirtualAlloc", 0, 1 << 20, 0x3000, 4);
    K("VirtualFree", x, 0, 0x8000); K("VirtualFree", y, 0, 0x8000);
    uint32_t xy = K("VirtualAlloc", 0, 2 << 20, 0x3000, 4);
    CHECK(xy == x, "two freed neighbours hold a 2 MB region (%08x, got %08x)", x, xy);
    /* a decommit, or a release with a size, keeps the region */
    K("VirtualFree", z, 1 << 20, 0x4000);
    K("VirtualFree", z, 1 << 20, 0x8000);
    uint32_t w = K("VirtualAlloc", 0, 1 << 20, 0x3000, 4);
    CHECK(w != z, "a decommitted region is not handed out again");
    K("VirtualFree", w, 0, 0x8000); K("VirtualFree", z, 0, 0x8000); K("VirtualFree", xy, 0, 0x8000);
    K("VirtualFree", b, 0, 0x8000);
    CHECK(valloc_span() == span0, "everything given back: the window is as it was (%u MB, was %u MB)", valloc_span() >> 20,
          span0 >> 20);
    /* each kind is given back only by its own call */
    uint32_t r = K("VirtualAlloc", 0, 1 << 16, 0x3000, 4);
    K("UnmapViewOfFile", r);
    uint32_t r2 = K("VirtualAlloc", 0, 1 << 16, 0x3000, 4);
    CHECK(r2 != r, "UnmapViewOfFile doesn't free a VirtualAlloc'd region");
    K("VirtualFree", r2, 0, 0x8000); K("VirtualFree", r, 0, 0x8000);
}

/* ------------------------------------------------------------------ file mappings, and a full window */

static void test_mapping(void) {
    char host[1200];
    snprintf(host, sizeof host, "%s/data.bin", g_game_root);
    FILE *f = fopen(host, "wb");
    for (int i = 0; i < 300000; i++) fputc(i * 7 & 255, f);
    fclose(f);
    uint32_t name = gstr(GUEST_ROOT "\\data.bin");
    int fds = open_fds();
    for (int round = 0; round < 3; round++) {
        uint32_t h = K("CreateFileA", name, 0x80000000u, 1, 0, 3, 0, 0);
        uint32_t m = K("CreateFileMappingA", h, 0, 2, 0, 0, 0);
        uint32_t v = K("MapViewOfFile", m, 4, 0, 0, 0);
        CHECK(v && R8(v + 1000) == (1000 * 7 & 255) && R8(v + 299999) == (299999 * 7 & 255), "the view holds the file");
        K("UnmapViewOfFile", v);
        K("CloseHandle", m); K("CloseHandle", h);
    }
    CHECK(open_fds() == fds, "closing a mapping closes its descriptor (%d open, were %d)", open_fds(), fds);
    uint32_t h = K("CreateFileA", name, 0x80000000u, 1, 0, 3, 0, 0), m = K("CreateFileMappingA", h, 0, 2, 0, 0, 0);
    CHECK(!K("MapViewOfFile", m, 4, 0, 400000, 0), "a view starting past the end fails");

    /* fill the window */
    uint32_t span0 = valloc_span(), regions[64], n = 0;
    for (uint32_t size = 256u << 20; size >= 0x10000; size >>= 1)
        for (uint32_t a; n < 64 && (a = K("VirtualAlloc", 0, size, 0x3000, 4)); ) regions[n++] = a;
    CHECK(!K("VirtualAlloc", 0, 0x10000, 0x3000, 4) && last_error() == 8, "a full window fails with ERROR_NOT_ENOUGH_MEMORY");
    /* the file used to be read to guest address 0 (over the main thread's TIB, and a bigger one over its stack and
       the game's data), and a new thread's TIB written there */
    for (uint32_t a = 0; a < 0x100000; a += 4) W32(a, 0x5EED0000u ^ a);
    CHECK(!K("MapViewOfFile", m, 4, 0, 0, 0) && last_error() == 8, "MapViewOfFile fails cleanly in a full window");
    CHECK(!K("CreateThread", 0, 0, 0x401000, 0, 0, 0) && last_error() == 8, "and so does CreateThread");
    int intact = 1;
    for (uint32_t a = 0; a < 0x100000; a += 4) if (R32(a) != (0x5EED0000u ^ a)) { intact = 0; break; }
    CHECK(intact, "low guest memory is untouched");
    memset(HP(0), 0, 0x100000);
    W32(GUEST_TIB + 0x00, 0xffffffffu); W32(GUEST_TIB + 0x18, GUEST_TIB);   /* as runtime_init left it */
    W32(GUEST_TIB + 0x04, GUEST_STACK_TOP); W32(GUEST_TIB + 0x08, GUEST_STACK_TOP - GUEST_STACK_SIZE);
    K("VirtualFree", regions[0], 0, 0x8000);
    uint32_t v = K("MapViewOfFile", m, 4, 0, 0, 0);
    CHECK(v == regions[0] && R8(v + 4242) == (4242 * 7 & 255), "once a region is freed, the view goes there (%08x)", v);
    K("UnmapViewOfFile", v);
    for (uint32_t i = 1; i < n; i++) K("VirtualFree", regions[i], 0, 0x8000);
    CHECK(valloc_span() == span0, "all given back (%u MB in use, was %u MB)", valloc_span() >> 20, span0 >> 20);
    K("CloseHandle", m); K("CloseHandle", h);
}

/* ------------------------------------------------------------------ threads */

static void thread_exits(CPU *t) { uint32_t code = R32(t->esp + 4); callv(t, import("KERNEL32.DLL!ExitThread"), 1, &code); }
static void thread_returns_7(CPU *t) { t->eax = 7; t->esp += 8; }
static uint32_t g_cs;
static void thread_keeps_cs(CPU *t) { callv(t, import("KERNEL32.DLL!EnterCriticalSection"), 1, &g_cs); t->eax = 0; t->esp += 8; }

static void test_threads(void) {
    uint32_t code = gbuf(4);
    uint32_t h = K("CreateThread", 0, 0, 0x401000, 42, 0, 0);
    CHECK(K("WaitForSingleObject", h, 5000) == 0, "a wait on a thread that called ExitThread returns");
    K("GetExitCodeThread", h, code);
    CHECK(R32(code) == 42, "with its exit code (%u)", R32(code));
    K("CloseHandle", h);
    uint32_t span0 = 0;
    for (int i = 0; i < 50; i++) {
        h = K("CreateThread", 0, 0, i & 1 ? 0x401000u : 0x401010u, 1, 0, 0);
        CHECK(K("WaitForSingleObject", h, 5000) == 0, "thread %d ends", i);
        K("GetExitCodeThread", h, code);
        CHECK(R32(code) == (i & 1 ? 1u : 7u), "thread %d exit code %u", i, R32(code));
        K("CloseHandle", h);
        if (!i) span0 = valloc_span();
    }
    CHECK(valloc_span() == span0, "50 threads later the window hasn't grown (%u MB, was %u MB)", valloc_span() >> 20, span0 >> 20);
}

/* A critical section initialized where an earlier one was left held (deleted while held, its memory reused)
   starts out unlocked. Before, the next EnterCriticalSection waited forever. */
static void on_alarm(int sig) { (void)sig; fprintf(stderr, "FAIL: EnterCriticalSection hung on a re-initialized section\n"); _exit(1); }
static void test_critical_section(void) {
    g_cs = gbuf(24);
    K("InitializeCriticalSection", g_cs);
    uint32_t h = K("CreateThread", 0, 0, 0x401020, 0, 0, 0);
    K("WaitForSingleObject", h, 5000);
    K("DeleteCriticalSection", g_cs);
    K("InitializeCriticalSection", g_cs);
    signal(SIGALRM, on_alarm);
    alarm(10);
    K("EnterCriticalSection", g_cs);
    K("LeaveCriticalSection", g_cs);
    alarm(0);
    /* the usual lifetime still works, nested */
    K("InitializeCriticalSection", g_cs);
    K("EnterCriticalSection", g_cs); K("EnterCriticalSection", g_cs);
    K("LeaveCriticalSection", g_cs); K("LeaveCriticalSection", g_cs);
    K("DeleteCriticalSection", g_cs);
}

/* ------------------------------------------------------------------ dynamic code regions */

static void test_dyncode(void) {
    int n0 = dyncode_regions();
    dyncode_register(0x30000000, 0x100);
    dyncode_register(0x30000080, 0x100);   /* overlaps */
    dyncode_register(0x30000180, 0x80);    /* touches */
    CHECK(dyncode_regions() == n0 + 1, "overlapping and touching blocks share a region (%d)", dyncode_regions() - n0);
    CHECK(dyncode_contains(0x30000000) && dyncode_contains(0x300001ff) && !dyncode_contains(0x30000200), "the union, no more");
    for (uint32_t i = 0; i < 5000; i++) dyncode_register(0x31000000 + i * 0x100, 0x10);
    CHECK(dyncode_regions() == 4096, "a full table stops at 4096 (%d)", dyncode_regions());
}

/* ------------------------------------------------------------------ Direct3D 8 surface levels */

static int g_surfaces_destroyed;
static void count_destroy_surface(Surface *s) { (void)s; g_surfaces_destroyed++; }
static RenderBackend g_counting = { "test", NULL, NULL, NULL, NULL, NULL, NULL, NULL, count_destroy_surface };

static void test_d3d(void) {
    g_render = &g_counting;
    uint32_t d3d = callv(c, import("D3D8.DLL!Direct3DCreate8"), ARGS(220));
    uint32_t pp = gbuf(13 * 4), out = gbuf(4);
    W32(pp, 640); W32(pp + 4, 480); W32(pp + 8, 22); W32(pp + 28, 1); W32(pp + 32, 1); W32(pp + 36, 80);
    COM(d3d, "CreateDevice", 0, 1, MAIN_HWND, 0x40, pp, out);
    uint32_t dev = R32(out);
    CHECK(com_get(dev) != NULL, "a device");
    int live0 = com_live_objects(), destroyed0 = g_surfaces_destroyed;
    for (int i = 0; i < 100; i++) {
        COM(dev, "CreateTexture", 256, 256, 1, 1 /* RENDERTARGET */, 21, 0, out);
        uint32_t tex = R32(out);
        COM(tex, "GetSurfaceLevel", 0, out);
        uint32_t surf = R32(out);
        CHECK(release(surf) == 1, "the texture keeps its level surface");
        release(tex);
    }
    CHECK(com_live_objects() == live0, "100 render-target textures later, no COM objects left over (%d)", com_live_objects() - live0);
    CHECK(g_surfaces_destroyed - destroyed0 == 100, "and their surfaces' GPU textures were freed (%d)", g_surfaces_destroyed - destroyed0);
    /* a surface the game still holds outlives its texture */
    COM(dev, "CreateTexture", 64, 64, 1, 0, 21, 0, out);
    uint32_t tex = R32(out);
    COM(tex, "GetSurfaceLevel", 0, out);
    uint32_t surf = R32(out);
    release(tex);
    CHECK(com_get(surf) != NULL, "the surface still held by the game is alive");
    release(surf);
    CHECK(com_get(surf) == NULL, "until the game releases it");
    /* one that is still the render target stays */
    COM(dev, "CreateTexture", 128, 128, 1, 1, 21, 0, out);
    tex = R32(out);
    COM(tex, "GetSurfaceLevel", 0, out);
    surf = R32(out);
    COM(dev, "SetRenderTarget", surf, 0);
    release(surf); release(tex);
    CHECK(com_get(surf) != NULL, "the current render target is kept");
    COM(dev, "GetBackBuffer", 0, 0, out);
    COM(dev, "SetRenderTarget", R32(out), 0);
    release(R32(out));
    g_render = &g_render_headless;
}

#define D3DERR_INVALIDCALL 0x8876086Cu
#define D3DERR_OUTOFVIDEOMEMORY 0x8876017Cu

/* Sizes from a texture file's header. Texture keeps 14 levels: a 16384-wide one wrote a 15th over the fields after
   them (GetSurfaceLevel(0) then gave the game 0x4), and a surface's width * height * bpp could wrap. */
static void test_d3d_sizes(void) {
    uint32_t d3d = callv(c, import("D3D8.DLL!Direct3DCreate8"), ARGS(220));
    uint32_t pp = gbuf(13 * 4), out = gbuf(4), desc = gbuf(32);
    W32(pp, 640); W32(pp + 4, 480); W32(pp + 8, 22); W32(pp + 28, 1); W32(pp + 32, 1); W32(pp + 36, 80);
    COM(d3d, "CreateDevice", 0, 1, MAIN_HWND, 0x40, pp, out);
    uint32_t dev = R32(out);
    int live0 = com_live_objects();
    W32(pp, 16384);
    CHECK(CREATE_FAILS(D3DERR_INVALIDCALL, out, d3d, "CreateDevice", 0, 1, MAIN_HWND, 0x40, pp, out),
          "a device with a 16384-wide back buffer fails with D3DERR_INVALIDCALL");
    CHECK(CREATE_FAILS(D3DERR_INVALIDCALL, out, dev, "CreateTexture", 16384, 1, 0, 0, 21, 0, out), "so does a 16384 x 1 texture");
    CHECK(CREATE_FAILS(D3DERR_INVALIDCALL, out, dev, "CreateTexture", 65536, 1, 0, 0, 21, 0, out), "and 65536 x 1");
    CHECK(CREATE_FAILS(D3DERR_INVALIDCALL, out, dev, "CreateTexture", 1, 16384, 0, 0, 21, 0, out), "and 1 x 16384");
    CHECK(CREATE_FAILS(D3DERR_INVALIDCALL, out, dev, "CreateTexture", 0, 64, 0, 0, 21, 0, out) &&
          CREATE_FAILS(D3DERR_INVALIDCALL, out, dev, "CreateTexture", 64, 0, 0, 0, 21, 0, out), "and one 0 wide or high");
    CHECK(CREATE_FAILS(D3DERR_INVALIDCALL, out, dev, "CreateCubeTexture", 16384, 1, 0, FMT_DXT1, 0, out) &&
          CREATE_FAILS(D3DERR_INVALIDCALL, out, dev, "CreateCubeTexture", 0, 1, 0, 21, 0, out), "a cube texture 16384 or 0 across");
    CHECK(CREATE_FAILS(D3DERR_INVALIDCALL, out, dev, "CreateImageSurface", 16384, 16, 21, out), "an image surface 16384 wide");
    CHECK(CREATE_FAILS(D3DERR_INVALIDCALL, out, dev, "CreateRenderTarget", 0x40000000, 16, 21, 0, 1, out),
          "a render target 2^30 wide (its pitch wrapped to 0)");
    CHECK(CREATE_FAILS(D3DERR_INVALIDCALL, out, dev, "CreateDepthStencilSurface", 16, 16384, 80, 0, out), "a depth buffer 16384 high");
    CHECK(CREATE_FAILS(D3DERR_OUTOFVIDEOMEMORY, out, dev, "CreateVertexBuffer", 0xFFFFFFF0u, 0, 0, 0, out) &&
          CREATE_FAILS(D3DERR_OUTOFVIDEOMEMORY, out, dev, "CreateIndexBuffer", 0xFFFFFFF8u, 0, 101, 0, out),
          "vertex and index buffers near 4 GiB (length + 16 wrapped) fail with D3DERR_OUTOFVIDEOMEMORY");
    /* the largest size, and ordinary ones, still work */
    CHECK(COM(dev, "CreateTexture", 16383, 1, 0, 0, 21, 0, out) == S_OK, "a 16383 x 1 texture is fine");
    uint32_t tex = R32(out);
    CHECK(comv(tex, "GetLevelCount", 0, NULL) == 14, "with all 14 levels");
    CHECK(COM(tex, "GetSurfaceLevel", 13, out) == S_OK && com_get(R32(out)), "the last one a surface");
    release(R32(out));
    COM(tex, "GetSurfaceLevel", 0, out);
    uint32_t surf = R32(out);
    CHECK(com_get(surf) && COM(surf, "GetDesc", desc) == S_OK && R32(desc + 24) == 16383, "level 0 is 16383 wide");
    release(surf);
    release(tex);
    CHECK(COM(dev, "CreateImageSurface", 16383, 1, 21, out) == S_OK && com_get(R32(out)), "so is a 16383 x 1 image surface");
    release(R32(out));
    CHECK(COM(dev, "CreateCubeTexture", 64, 0, 0, 21, 0, out) == S_OK && com_get(R32(out)), "a 64 cube texture");
    release(R32(out));
    CHECK(COM(dev, "CreateRenderTarget", 64, 64, 21, 0, 1, out) == S_OK && com_get(R32(out)), "a 64 x 64 render target");
    release(R32(out));
    CHECK(COM(dev, "CreateDepthStencilSurface", 64, 64, 80, 0, out) == S_OK && com_get(R32(out)), "a depth buffer");
    release(R32(out));
    CHECK(COM(dev, "CreateVertexBuffer", 4096, 0, 0, 0, out) == S_OK && com_get(R32(out)), "and a 4 KB vertex buffer");
    release(R32(out));
    CHECK(com_live_objects() == live0, "nothing left over (%d)", com_live_objects() - live0);
}

/* ------------------------------------------------------------------ DirectSound buffers */

static const uint8_t IID_Notify[16] = { 0x83, 0x07, 0x21, 0xB0, 0xCD, 0x89, 0xD0, 0x11, 0xAF, 0x08, 0x00, 0xA0, 0xC9, 0x25, 0xCD, 0x16 };
static const uint8_t IID_Buffer8[16] = { 0x49, 0xa4, 0x25, 0x68, 0x24, 0x75, 0x82, 0x4d, 0x92, 0x0f, 0x50, 0xe3, 0x6a, 0xb3, 0xab, 0x1e };
extern int dsound_live_buffers(void);

static void test_dsound(void) {
    setenv("RC_NO_AUDIO", "1", 1);
    uint32_t out = gbuf(4), p1 = gbuf(4), n1 = gbuf(4), p2 = gbuf(4), n2 = gbuf(4);
    callv(c, import("DSOUND.DLL!#1"), ARGS(0, out, 0));
    uint32_t ds = R32(out);
    uint32_t wfx = gbuf(18), desc = gbuf(20), iid = gbuf(16), iid8 = gbuf(16);
    W16(wfx, 1); W16(wfx + 2, 2); W32(wfx + 4, 44100); W32(wfx + 8, 176400); W16(wfx + 12, 4); W16(wfx + 14, 16);
    W32(desc, 20); W32(desc + 8, 176400); W32(desc + 16, wfx);
    memcpy(HP(iid), IID_Notify, 16);
    memcpy(HP(iid8), IID_Buffer8, 16);
    int live0 = dsound_live_buffers();
    for (int i = 0; i < 50; i++) {
        COM(ds, "CreateSoundBuffer", desc, out, 0);
        uint32_t b = R32(out);
        COM(b, "Lock", 0, 0, p1, n1, p2, n2, 2);
        uint32_t mem = R32(p1);
        CHECK(heap_size(mem) >= 176400, "the buffer's sound data is on the heap");
        COM(b, "Play", 0, 0, 1 /* looping */);
        COM(b, "QueryInterface", iid, out);
        uint32_t notify = R32(out);
        release(b);
        CHECK(dsound_live_buffers() == live0 + 1, "a Notify interface keeps its buffer");
        release(notify);
        CHECK(dsound_live_buffers() == live0, "the last release stops it and takes it out of the mixer");
        CHECK(heap_size(mem) == 0, "and frees its sound data");
    }
    /* duplicates share the sound data until the last one goes */
    COM(ds, "CreateSoundBuffer", desc, out, 0);
    uint32_t b = R32(out);
    COM(b, "Lock", 0, 0, p1, n1, p2, n2, 2);
    uint32_t mem = R32(p1);
    COM(ds, "DuplicateSoundBuffer", b, out);
    uint32_t dup = R32(out);
    COM(dup, "Play", 0, 0, 1);
    release(b);
    CHECK(heap_size(mem) != 0 && dsound_live_buffers() == live0 + 1, "a duplicate keeps the shared sound data");
    /* QueryInterface for the buffer itself adds a reference, as COM requires */
    COM(dup, "QueryInterface", iid8, out);
    CHECK(R32(out) == dup, "IDirectSoundBuffer8 is the same object");
    release(dup);
    CHECK(dsound_live_buffers() == live0 + 1, "still held through the reference QueryInterface added");
    release(dup);
    CHECK(dsound_live_buffers() == live0 && heap_size(mem) == 0, "then gone, sound data too");
}

/* A buffer's size comes from the game's sound data: size + 16 wrapped near 4 GiB into a 16-byte block. */
#define DSERR_INVALIDPARAM 0x80070057u
static void test_dsound_sizes(void) {
    uint32_t out = gbuf(4), p1 = gbuf(4), n1 = gbuf(4), p2 = gbuf(4), n2 = gbuf(4);
    callv(c, import("DSOUND.DLL!#1"), ARGS(0, out, 0));
    uint32_t ds = R32(out), wfx = gbuf(18), desc = gbuf(20);
    W16(wfx, 1); W16(wfx + 2, 2); W32(wfx + 4, 44100); W32(wfx + 8, 176400); W16(wfx + 12, 4); W16(wfx + 14, 16);
    W32(desc, 20); W32(desc + 16, wfx);
    int live0 = dsound_live_buffers();
    const uint32_t bad[] = { 0xFFFFFFF8u, 0x10000000u /* DSBSIZE_MAX + 1 */, 3, 0 };
    for (int i = 0; i < 4; i++) {
        W32(desc + 8, bad[i]);
        CHECK(CREATE_FAILS(DSERR_INVALIDPARAM, out, ds, "CreateSoundBuffer", desc, out, 0),
              "a %u-byte buffer fails with DSERR_INVALIDPARAM", bad[i]);
    }
    CHECK(dsound_live_buffers() == live0, "and no buffer (%d)", dsound_live_buffers() - live0);
    W32(desc + 8, 4);
    CHECK(COM(ds, "CreateSoundBuffer", desc, out, 0) == S_OK, "DSBSIZE_MIN, 4 bytes, is fine");
    uint32_t b = R32(out);
    CHECK(COM(b, "Lock", 0, 0, p1, n1, p2, n2, 2) == S_OK && R32(n1) == 4 && heap_size(R32(p1)) >= 4, "and holds 4 bytes");
    release(b);
    W32(desc + 4, 1 /* DSBCAPS_PRIMARYBUFFER */); W32(desc + 8, 0); W32(desc + 16, 0);
    CHECK(COM(ds, "CreateSoundBuffer", desc, out, 0) == S_OK && R32(out), "the primary buffer (size 0, no data) still works");
    release(R32(out));
    CHECK(dsound_live_buffers() == live0, "all released (%d)", dsound_live_buffers() - live0);
}

/* ------------------------------------------------------------------ GetProcAddress and the import table */

static void dummy(CPU *cpu) { (void)cpu; }
static void test_imports(void) {
    uint32_t mod = K("LoadLibraryA", gstr("d3d8.dll")), name = gstr("ValidateVertexShader");
    CHECK(mod, "d3d8.dll loads");
    uint32_t used = import_slots_used(), first = K("GetProcAddress", mod, name);
    for (int i = 0; i < 5000; i++) if (K("GetProcAddress", mod, name) != first) { CHECK(0, "lookup %d gave another address", i); break; }
    CHECK(first && import_slots_used() == used + 1, "5000 lookups of one function take one slot (%u)", import_slots_used() - used);
    while (add_dynamic_import("test::filler", dummy)) {}
    CHECK(import_slots_used() == 4096, "the table stops at 4096 slots (%u)", import_slots_used());
    CHECK(!K("GetProcAddress", mod, gstr("ValidatePixelShader")), "a new lookup then fails cleanly");
    CHECK(K("GetProcAddress", mod, name) == first, "known ones still resolve");
}

int main(void) {
    char tmp[] = "/tmp/rc-host-test-XXXXXX";
    if (!mkdtemp(tmp)) { perror("mkdtemp"); return 2; }
    snprintf(g_game_root, sizeof g_game_root, "%s/game", tmp);
    snprintf(g_user_root, sizeof g_user_root, "%s/userdata", tmp);
    mkdir(g_game_root, 0755);
    mkdir(g_user_root, 0755);
    static ImportHandler all[1024];
    uint32_t n = 0;
    const ImportTable *tables[] = { &kernel32_imports, &user32_imports, &gdi32_imports, &advapi32_imports, &winmm_imports,
                                    &directx_imports };
    for (size_t t = 0; t < sizeof tables / sizeof tables[0]; t++)
        for (uint32_t i = 0; i < tables[t]->count; i++) all[n++] = tables[t]->list[i];
    set_import_handlers(all, n);
    runtime_init(c);
    thread_main_init(c);
    register_function(0x401000, thread_exits);
    register_function(0x401010, thread_returns_7);
    register_function(0x401020, thread_keeps_cs);

    struct { const char *name; void (*fn)(void); } tests[] = {
        { "guest heap: best fit, split", test_heap },
        { "guest heap: a size it can never hold fails, as on Windows", test_heap_limits },
        { "VirtualAlloc window: release, reuse, zeroing, merging", test_valloc },
        { "file mappings: views, descriptors, a full window", test_mapping },
        { "threads: ExitThread wakes waiters, stacks reused", test_threads },
        { "critical sections: re-initialized while held", test_critical_section },
        { "dynamic code regions: merged, bounded", test_dyncode },
        { "Direct3D 8: surface levels go with their texture", test_d3d },
        { "Direct3D 8: sizes the level arrays can't hold fail", test_d3d_sizes },
        { "DirectSound: released buffers go away", test_dsound },
        { "DirectSound: buffer sizes outside its limits fail", test_dsound_sizes },
        { "GetProcAddress: one slot per function, bounded table", test_imports },
    };
    int failed_tests = 0, total = (int)(sizeof tests / sizeof tests[0]);
    for (int i = 0; i < total; i++) {
        int before = g_failed;
        tests[i].fn();
        printf("%s %s\n", g_failed == before ? "ok  " : "FAIL", tests[i].name);
        fflush(stdout);
        failed_tests += g_failed != before;
    }
    if (failed_tests) printf("%d of %d failed\n", failed_tests, total);
    else printf("all %d passed (%d checks)\n", total, g_checks);
    return failed_tests ? 1 : 0;
}
