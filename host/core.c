/* Host services shared by the Windows API layer: guest heap, handles, path mapping, time. */
#include "win32.h"

#include <ctype.h>
#include <dirent.h>
#include <pthread.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

int g_log;
char g_game_root[1024];
char g_user_root[1024];

/* ------------------------------------------------------------------ guest heap
 * Lives entirely in guest memory so the game can hold pointers into it. 16-byte header before each
 * block: [size][magic][0][0]. Size classes in 16-byte steps up to 4 KiB; larger blocks go on a list.
 */

#define HEAP_LO GUEST_HEAP_BASE
#define HEAP_HI GUEST_HEAP_HI
#define HEAP_MAGIC 0x4EA911C8u
#define NCLASS 256
static pthread_mutex_t g_heap_lock = PTHREAD_MUTEX_INITIALIZER;
static uint32_t g_heap_top = HEAP_LO;
static uint32_t g_free[NCLASS + 1];  /* singly linked through the first payload word */
static uint32_t g_heap_free_bytes;   /* payload of the blocks on those lists (for the [mem] log) */

static uint32_t round16(uint32_t n) { return (n + 15) & ~15u; }

uint32_t heap_alloc(uint32_t size, int zero) {
    uint32_t sz = round16(size ? size : 1), a = 0;
    pthread_mutex_lock(&g_heap_lock);
    uint32_t cls = sz / 16;
    if (cls <= NCLASS && g_free[cls]) {
        a = g_free[cls];
        g_free[cls] = R32(a);
        g_heap_free_bytes -= sz;
    } else if (cls > NCLASS) {
        /* Best fit among large free blocks, and what a much bigger block has left over becomes a free block of
           its own: first fit without splitting let a 5 KB request take a freed 10 MB texture whole, so the heap
           kept growing from match to match until it ran out. */
        uint32_t prev = 0, p = g_free[0], bprev = 0, best = 0;
        for (; p; prev = p, p = R32(p)) {
            uint32_t s = R32(p - 16);
            if (s >= sz && (!best || s < R32(best - 16))) { best = p; bprev = prev; if (s == sz) break; }
        }
        if (best) {
            a = best;
            if (bprev) W32(bprev, R32(best)); else g_free[0] = R32(best);
            uint32_t have = R32(a - 16);
            g_heap_free_bytes -= have;
            if (have - sz > 16 + 16 * NCLASS) {   /* the rest is still a large block: it goes back on this list */
                uint32_t r = a + sz + 16;
                W32(r - 16, have - sz - 16); W32(r - 12, 0);
                W32(r, g_free[0]); g_free[0] = r;
                g_heap_free_bytes += have - sz - 16;
                W32(a - 16, sz);
            }
            sz = R32(a - 16);
        }
    }
    if (!a) {
        if (g_heap_top + 16 + sz > HEAP_HI) {
            uint32_t used = g_heap_top - HEAP_LO, free_bytes = g_heap_free_bytes;
            pthread_mutex_unlock(&g_heap_lock);
            fprintf(stderr, "guest heap exhausted (%u bytes requested; %u MB used, %u MB of it in free blocks)\n", size,
                    used >> 20, free_bytes >> 20);
            abort();
        }
        a = g_heap_top + 16;
        g_heap_top += 16 + sz;
        W32(a - 16, sz);
    }
    W32(a - 12, HEAP_MAGIC);
    pthread_mutex_unlock(&g_heap_lock);
    if (zero) memset(HP(a), 0, R32(a - 16));
    return a;
}

void heap_free(uint32_t a) {
    if (!a) return;
    if (a < HEAP_LO || a >= HEAP_HI || R32(a - 12) != HEAP_MAGIC) {
        LOG("[heap] free of non-heap pointer %08x ignored\n", a);
        return;
    }
    pthread_mutex_lock(&g_heap_lock);
    W32(a - 12, 0);
    uint32_t cls = R32(a - 16) / 16;
    g_heap_free_bytes += R32(a - 16);
    if (cls > NCLASS) cls = 0;
    W32(a, g_free[cls]);
    g_free[cls] = a;
    pthread_mutex_unlock(&g_heap_lock);
}

uint32_t heap_size(uint32_t a) {
    return (a >= HEAP_LO && a < HEAP_HI && R32(a - 12) == HEAP_MAGIC) ? R32(a - 16) : 0;
}

uint32_t heap_realloc(uint32_t a, uint32_t size, int zero) {
    if (!a) return heap_alloc(size, zero);
    uint32_t old = heap_size(a);
    if (round16(size) <= old) return a;
    uint32_t b = heap_alloc(size, 0);
    memcpy(HP(b), HP(a), old);
    if (zero) memset(HP(b + old), 0, R32(b - 16) - old);
    heap_free(a);
    return b;
}

/* The VirtualAlloc window: VirtualAlloc'd memory, mapped file views and guest thread stacks, 64 KiB-granular.
   Each region is remembered by its base and kind, so VirtualFree(MEM_RELEASE), UnmapViewOfFile and a thread's exit
   give it back; without that the window filled up a few matches in. Freed ranges are kept sorted by address and
   merged with their neighbours, reused first fit, and a range ending at the top lowers the top again. */
#define VALLOC_LO GUEST_VALLOC_LO
#define VALLOC_HI GUEST_VALLOC_HI
#define VREGIONS 4096
typedef struct { uint32_t base, size; int kind; } VRange;
static VRange g_vlive[VREGIONS], g_vfree[VREGIONS];   /* live: any order; free: sorted, never touching */
static int g_nvlive, g_nvfree;
static uint32_t g_valloc_top = VALLOC_LO;
static uint32_t g_valloc_hwm = VALLOC_LO;   /* everything above it is still zero, as calloc/mmap left it */
static uint32_t g_valloc_live;   /* bytes in live regions */

uint32_t guest_valloc_as(uint32_t size, int kind) {
    if (size > VALLOC_HI - VALLOC_LO) return 0;
    size = size ? (size + 0xffff) & ~0xffffu : 0x10000u;  /* Windows allocation granularity */
    pthread_mutex_lock(&g_heap_lock);
    uint32_t a = 0;
    for (int i = 0; i < g_nvfree; i++)
        if (g_vfree[i].size >= size) {
            a = g_vfree[i].base;
            g_vfree[i].base += size; g_vfree[i].size -= size;
            if (!g_vfree[i].size) memmove(&g_vfree[i], &g_vfree[i + 1], (size_t)(--g_nvfree - i) * sizeof *g_vfree);
            break;
        }
    if (!a) {
        if (size > VALLOC_HI - g_valloc_top) { pthread_mutex_unlock(&g_heap_lock); return 0; }
        a = g_valloc_top;
        g_valloc_top += size;
    }
    static int warned;
    if (g_nvlive < VREGIONS) g_vlive[g_nvlive++] = (VRange){ a, size, kind };
    else if (!warned++) fprintf(stderr, "[valloc] region table full (%d): later regions are never given back\n", VREGIONS);
    g_valloc_live += size;
    uint32_t dirty = a + size < g_valloc_hwm ? a + size : g_valloc_hwm;   /* part of it was used before */
    if (a + size > g_valloc_hwm) g_valloc_hwm = a + size;
    pthread_mutex_unlock(&g_heap_lock);
    if (dirty > a) memset(HP(a), 0, dirty - a);   /* VirtualAlloc'd memory starts out zero */
    return a;
}
uint32_t guest_valloc(uint32_t size) { return guest_valloc_as(size, VA_ALLOC); }

int guest_vfree(uint32_t base, int kind) {
    pthread_mutex_lock(&g_heap_lock);
    int i = 0;
    while (i < g_nvlive && !(g_vlive[i].base == base && g_vlive[i].kind == kind)) i++;
    if (i == g_nvlive) { pthread_mutex_unlock(&g_heap_lock); return 0; }
    uint32_t size = g_vlive[i].size;
    g_vlive[i] = g_vlive[--g_nvlive];
    g_valloc_live -= size;
    int k = 0;
    while (k < g_nvfree && g_vfree[k].base < base) k++;
    int prev = k > 0 && g_vfree[k - 1].base + g_vfree[k - 1].size == base;
    int next = k < g_nvfree && base + size == g_vfree[k].base;
    if (prev && next) {
        g_vfree[k - 1].size += size + g_vfree[k].size;
        memmove(&g_vfree[k], &g_vfree[k + 1], (size_t)(--g_nvfree - k) * sizeof *g_vfree);
    } else if (prev) g_vfree[k - 1].size += size;
    else if (next) { g_vfree[k].base = base; g_vfree[k].size += size; }
    else if (g_nvfree < VREGIONS) {
        memmove(&g_vfree[k + 1], &g_vfree[k], (size_t)(g_nvfree++ - k) * sizeof *g_vfree);
        g_vfree[k] = (VRange){ base, size, 0 };
    } else { pthread_mutex_unlock(&g_heap_lock); return 1; }   /* nowhere to note it: stays unusable, as before */
    VRange *last = &g_vfree[g_nvfree - 1];
    if (last->base + last->size == g_valloc_top) {   /* lower the top (still below the high-water mark: zeroed on reuse) */
        g_valloc_top = last->base;
        g_nvfree--;
    }
    pthread_mutex_unlock(&g_heap_lock);
    return 1;
}

void guest_mem_ranges(uint32_t r[4]) { r[0] = HEAP_LO; r[1] = g_heap_top; r[2] = VALLOC_LO; r[3] = g_valloc_top; }
void guest_mem_stats(uint32_t *heap_used, uint32_t *valloc_used) {
    *heap_used = g_heap_top - HEAP_LO;
    *valloc_used = g_valloc_top - VALLOC_LO;
}
/* For the [mem] log: the heap's bytes in free blocks, the VirtualAlloc window's bytes in live regions. */
void guest_mem_free(uint32_t *heap_free, uint32_t *valloc_live) {
    pthread_mutex_lock(&g_heap_lock);
    *heap_free = g_heap_free_bytes; *valloc_live = g_valloc_live;
    pthread_mutex_unlock(&g_heap_lock);
}

uint32_t guest_strdup(const char *s) {
    uint32_t a = heap_alloc((uint32_t)strlen(s) + 1, 0);
    strcpy((char *)HP(a), s);
    return a;
}

/* ------------------------------------------------------------------ handles */

#define MAX_HANDLES 4096
static WinHandle g_handles[MAX_HANDLES];
static pthread_mutex_t g_handle_lock = PTHREAD_MUTEX_INITIALIZER;

uint32_t handle_new(int type) {
    pthread_mutex_lock(&g_handle_lock);
    for (int i = 16; i < MAX_HANDLES; i++) {
        if (g_handles[i].type == H_FREE) {
            memset(&g_handles[i], 0, sizeof g_handles[i]);
            g_handles[i].type = type;
            g_handles[i].fd = -1;
            pthread_mutex_unlock(&g_handle_lock);
            return 0x1000u + 4u * (uint32_t)i;
        }
    }
    pthread_mutex_unlock(&g_handle_lock);
    fprintf(stderr, "out of handles\n");
    abort();
}

WinHandle *handle_get(uint32_t h, int type) {
    if (h < 0x1000u || (h & 3)) return NULL;
    uint32_t i = (h - 0x1000u) / 4;
    if (i >= MAX_HANDLES || g_handles[i].type == H_FREE) return NULL;
    if (type != -1 && g_handles[i].type != type) return NULL;
    return &g_handles[i];
}

void handle_close(uint32_t h) {
    WinHandle *x = handle_get(h, -1);
    if (!x) return;
    /* a file mapping holds its own dup() of the file's descriptor */
    if ((x->type == H_FILE || x->type == H_MAPPING) && x->fd >= 0) close(x->fd);
    if (x->type == H_FIND && x->ptr) free(x->ptr);
    x->type = H_FREE;
}

/* ------------------------------------------------------------------ paths */

/* Finds `name` in directory `dir` ignoring case; writes the real name into `out`. */
static int find_ci(const char *dir, const char *name, char *out, size_t n) {
    DIR *d = opendir(*dir ? dir : ".");
    if (!d) return 0;
    struct dirent *e;
    int found = 0;
    while ((e = readdir(d))) {
        if (!strcasecmp(e->d_name, name)) {
            snprintf(out, n, "%s", e->d_name);
            found = 1;
            break;
        }
    }
    closedir(d);
    return found;
}

static char g_cwd[1024] = GUEST_ROOT;  /* the game's current directory, in Windows form */

const char *guest_cwd(void) { return g_cwd; }
void guest_set_cwd(const char *p) { snprintf(g_cwd, sizeof g_cwd, "%s", p); }

int map_path(const char *guest, char *host, size_t n) {
    char full[1024];
    /* make absolute in Windows form */
    if (isalpha((unsigned char)guest[0]) && guest[1] == ':')
        snprintf(full, sizeof full, "%s", guest);
    else if (guest[0] == '\\' || guest[0] == '/')
        snprintf(full, sizeof full, "C:%s", guest);
    else
        snprintf(full, sizeof full, "%s\\%s", g_cwd, guest);
    for (char *p = full; *p; p++) if (*p == '/') *p = '\\';

    const char *rest;
    const char *base;
    size_t rl = strlen(GUEST_ROOT);
    if (!strncasecmp(full, GUEST_ROOT, rl) && (full[rl] == '\\' || full[rl] == 0)) {
        base = g_game_root;
        rest = full + rl;
    } else {
        base = g_user_root;  /* anything outside the game folder: profiles, temp files, ... */
        rest = full + 2;
    }

    char out[1024];
    snprintf(out, sizeof out, "%s", base);
    int exists = 1;
    char comp[512];
    while (*rest) {
        while (*rest == '\\') rest++;
        if (!*rest) break;
        size_t k = 0;
        while (rest[k] && rest[k] != '\\') k++;
        snprintf(comp, sizeof comp, "%.*s", (int)k, rest);
        rest += k;
        if (!strcmp(comp, ".")) continue;
        if (!strcmp(comp, "..")) {
            char *sl = strrchr(out, '/');
            if (sl && sl > out + strlen(base) - 1) *sl = 0;
            continue;
        }
        char real[512];
        if (exists && find_ci(out, comp, real, sizeof real)) {
            size_t L = strlen(out);
            snprintf(out + L, sizeof out - L, "/%s", real);
        } else {
            exists = 0;
            size_t L = strlen(out);
            snprintf(out + L, sizeof out - L, "/%s", comp);
        }
    }
    snprintf(host, n, "%s", out);
    struct stat st;
    return stat(host, &st) == 0;
}

/* ------------------------------------------------------------------ time */

uint64_t host_time_100ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return ((uint64_t)ts.tv_sec + 11644473600ull) * 10000000ull + (uint64_t)ts.tv_nsec / 100;
}

/* Seconds since the process started, plus a minute: like uptime on a freshly booted PC. Games turn
   GetTickCount/timeGetTime into 32-bit floats, so the values must stay small; the raw monotonic clock
   is epoch-based in WebAssembly (~1.8e12 ms) and broke games' timer scheduling there. */
double host_seconds(void) {
    static double start = -1;
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    double now = (double)ts.tv_sec + ts.tv_nsec * 1e-9;
    if (start < 0) start = now;   /* first call happens during startup, before other threads exist */
    return now - start + 60.0;
}

/* ------------------------------------------------------------------ the game's clock */

/* With RC_DETERMINISTIC=1 the game sees a virtual clock driven by the deterministic scheduler (sched.c):
   it jumps to the next deadline when every thread is blocked, and every read adds 1 us so a spin-wait on
   the clock still makes progress. Present blocks until the next 1/60 s tick (vsync). */
static int g_det = -1;
uint64_t g_vtime_us;             /* virtual microseconds (sched.c advances it) */
uint32_t g_det_sleeps, g_det_waits, g_det_reads;   /* game-thread counters for the hash log */
static GuestThread g_main_thread;

int deterministic(void) {
    if (g_det < 0) g_det = getenv("RC_DETERMINISTIC") != NULL;
    return g_det;
}
int on_game_thread(void) { return t_self == &g_main_thread; }

double guest_seconds(void) {
    if (!deterministic()) return host_seconds();
    if (on_game_thread()) g_det_reads++;
    return 60.0 + (double)__atomic_add_fetch(&g_vtime_us, 1, __ATOMIC_RELAXED) * 1e-6;
}
double guest_peek_seconds(void) {   /* the game's clock without advancing it */
    if (!deterministic()) return host_seconds();
    return 60.0 + (double)__atomic_load_n(&g_vtime_us, __ATOMIC_RELAXED) * 1e-6;
}
uint64_t guest_time_100ns(void) {
    if (!deterministic()) return host_time_100ns();
    /* 2006-01-01 00:00 UTC in FILETIME units, plus the virtual clock */
    return 127804032000000000ull + (uint64_t)((guest_seconds() - 60.0) * 1e7);
}
/* Present: wait for the next vsync tick (exact multiples of 1/60 s); online, the frame lasts the time the
   host measured for it (netplay.c), counted from the previous frame's boundary. */
void vclock_frame(void) {
    if (!deterministic() || !on_game_thread()) return;
    extern int sched_wait(int (*)(void *), void *, uint64_t, uint64_t (*)(void));
    extern uint32_t netplay_frame_dt_us(void);
    uint64_t now = __atomic_load_n(&g_vtime_us, __ATOMIC_RELAXED);
    uint32_t dt = netplay_frame_dt_us();
    if (dt) {
        static uint64_t boundary;
        boundary += dt;
        if (boundary < now) boundary = now;   /* the frame already took longer in game time (loading) */
        sched_wait(NULL, NULL, boundary, NULL);
        return;
    }
    uint64_t k = now * 60ull / 1000000ull + 1;
    sched_wait(NULL, NULL, (k * 1000000ull + 59ull) / 60ull, NULL);
}
static uint64_t vclock_rdtsc(void) { return (uint64_t)(guest_seconds() * 2e9); }   /* 2 GHz, as the registry says */
/* A thread preempted after a full quantum has used CPU time, so the clock moves on by RC_DET_PREEMPT_US
   (default 1000) before the next participant is picked. Without it a thread that spins on memory without
   reading the clock (Cricket's loading screen polling its async loader) never lets a timer come due, and
   the timer callback it waits for never runs. */
static void vclock_preempt(void) {
    static int64_t us = -1;
    if (us < 0) { const char *e = getenv("RC_DET_PREEMPT_US"); us = e ? atoll(e) : 1000; }
    __atomic_add_fetch(&g_vtime_us, (uint64_t)us, __ATOMIC_RELAXED);
    sched_yield_det();
}
void vclock_init(void) {
    extern uint64_t (*g_rdtsc_hook)(void);
    extern int g_preempt_on;
    extern void (*g_preempt_fn)(void);
    if (deterministic()) {
        g_rdtsc_hook = vclock_rdtsc;
        g_preempt_fn = vclock_preempt;
        g_preempt_on = 1;
        fprintf(stderr, "deterministic mode: virtual clock + scheduler\n");
    }
}

/* ------------------------------------------------------------------ threads */

__thread GuestThread *t_self;

GuestThread *thread_main_init(CPU *c) {
    (void)c;
    g_main_thread.id = 0x100;
    g_main_thread.tib = GUEST_TIB;
    t_self = &g_main_thread;
    return t_self;
}
