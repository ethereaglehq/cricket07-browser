/* Two players' lockstep on one machine: host/netplay.c built once per player (peer.h prefixes each copy), for
 * testing the input delay as it changes mid-game.
 *
 * Each player has a game thread that simulates a frame (3-6 ms), presents it (netplay_frame), and renders at
 * most QUEUE frames ahead of its own 60 Hz display, as in the browser. A transport thread does web/netplay.js's
 * job over a simulated network: it drains each player's outbox onto an ordered path (the room) and a lossy,
 * unordered direct path whose packets repeat the last 8 inputs, delivers what arrives, turns the arrival times
 * netplay_remote_input returns into reports, and with adaptation on sets each player's delay with a copy of
 * netplay.js's nextLead. The network adds latency, per-packet noise, loss, and bursts of extra delay (busy
 * Wi-Fi), the same bursts for the same seed.
 *
 * Scenarios, each in its own process (netplay.c's state is global):
 *   scripted       the delay jumps at random between 1 and 30 frames, both players independently and from the
 *                  first frame on, on a jittery lossy network, while the pads tap buttons between frames
 *   fixed          bursty jitter at the delay the lobby would pick for these pings (3 frames)
 *   adaptive       the same network with adaptation, then a calm spell
 *   late-fixed     player 2's game starts 2 s after player 1's, on a quiet network
 *   late-adaptive  the same with adaptation
 * Every scenario checks that both players apply identical inputs every frame, that each frame's input is the
 * sample its player sent (taps included), and that nothing deadlocks. Past the first seconds, each adaptive one
 * must stall, and wait for inputs, well under half as much as its fixed one, having raised its delay (and lowered
 * it again in the calm).
 *
 *   tests/netplay/run.sh [scenario]   (all of them, in parallel, by default)
 */
#include <math.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* ------------------------------------------------------------------ the two copies of host/netplay.c */

#define PEER_API(p)                                                                                         \
    uint32_t p##_netplay_frame_dt_us(void);                                                                 \
    int p##_netplay_local_pad(int idx, int connected, uint32_t buttons, const int32_t axis[4]);            \
    int p##_netplay_local_mouse_move(int dx, int dy);                                                       \
    int p##_netplay_local_mouse_button(int b, int down);                                                    \
    void p##_netplay_frame(uint32_t frame, uint64_t (*state_hash)(void));                                   \
    int p##_netplay_pop(void);                                                                              \
    int32_t p##_netplay_msg(int i);                                                                         \
    int32_t p##_netplay_remote_input(int slot, uint32_t frame, uint32_t buttons, int lx, int ly, int rx, int ry, \
                                     uint32_t dt_us, int32_t mouse);                                        \
    void p##_netplay_remote_hash(int slot, uint32_t frame, uint32_t lo, uint32_t hi);                       \
    void p##_netplay_set_delay(int frames);                                                                 \
    uint32_t p##_netplay_status(int what);
PEER_API(p0)
PEER_API(p1)

typedef struct {
    uint32_t (*frame_dt_us)(void);
    int (*local_pad)(int, int, uint32_t, const int32_t[4]);
    int (*local_mouse_move)(int, int);
    int (*local_mouse_button)(int, int);
    void (*frame)(uint32_t, uint64_t (*)(void));
    int (*pop)(void);
    int32_t (*msg)(int);
    int32_t (*remote_input)(int, uint32_t, uint32_t, int, int, int, int, uint32_t, int32_t);
    void (*remote_hash)(int, uint32_t, uint32_t, uint32_t);
    void (*set_delay)(int);
    uint32_t (*status)(int);
} Api;
#define API_OF(p) { p##_netplay_frame_dt_us, p##_netplay_local_pad, p##_netplay_local_mouse_move,                  \
                    p##_netplay_local_mouse_button, p##_netplay_frame, p##_netplay_pop, p##_netplay_msg,               \
                    p##_netplay_remote_input, p##_netplay_remote_hash, p##_netplay_set_delay, p##_netplay_status }
static const Api API[2] = { API_OF(p0), API_OF(p1) };

/* what netplay.c needs from the rest of the host: one clock for both, guest memory it never touches here */
uint8_t *g_mem;
uint32_t g_state_lo, g_state_hi;
int deterministic(void) { return 1; }
double host_seconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + ts.tv_nsec * 1e-9;
}

/* ------------------------------------------------------------------ scenario */

typedef struct {
    const char *name, *versus;  /* versus: the fixed-delay scenario this adaptive one must beat */
    uint32_t frames;            /* both players stop after presenting this frame */
    int delay, adaptive, scripted;
    double late;                /* player 2's game starts this many seconds later (a slower boot) */
    double direct_ms, room_ms, noise_ms, loss;   /* one way; noise is uniform per packet; loss on the direct path */
    double burst_rate, burst_lo, burst_hi, burst_len_lo, burst_len_hi;   /* per second; extra ms; seconds */
    double calm_at;             /* seconds from the start: no more bursts (0: never calm) */
} Scenario;

/* The first player to start runs ahead until it waits for the other's first input, and with both at 60 frames
   a second it stays that far ahead: every input arrives just as it's needed (late start). */
static const Scenario SCENARIOS[] = {
    { "scripted", NULL, 60 * 14, 3, 0, 1, 0, 8, 25, 6, 0.10, 1.0, 10, 40, 0.05, 0.2, 0 },
    { "fixed", NULL, 60 * 22, 3, 0, 0, 0, 8, 20, 3, 0.03, 1.5, 20, 70, 0.05, 0.3, 0 },
    { "adaptive", "fixed", 60 * 36, 3, 1, 0, 0, 8, 20, 3, 0.03, 1.5, 20, 70, 0.05, 0.3, 22 },
    { "late-fixed", NULL, 60 * 22, 3, 0, 0, 2, 8, 20, 5, 0.01, 0, 0, 0, 0, 0, 0 },
    { "late-adaptive", "late-fixed", 60 * 22, 3, 1, 0, 2, 8, 20, 5, 0.01, 0, 0, 0, 0, 0, 0 },
};
static const Scenario *S;
#define MEASURE_FROM 5.0        /* stalls are compared from here (seconds) to the calm (or the end) */
#define MEASURE_TO 22.0
#define QUEUE 2                 /* frames rendered ahead of the display (RC_QUEUE) */
#define FRAME_S (1.0 / 60)
#define FRAME_MS (1000.0 / 60)
#define NO_SLACK INT32_MIN

static double g_start;
static volatile int g_done;

static uint64_t rnd(uint64_t *s) { *s ^= *s << 13; *s ^= *s >> 7; *s ^= *s << 17; return *s; }
static double rnd01(uint64_t *s) { return (double)(rnd(s) >> 11) / 9007199254740992.0; }
static void sleep_until(double t) {
    double d = t - host_seconds();
    if (d > 0) usleep((useconds_t)(d * 1e6));
}

/* Bursts of extra delay on the link, both ways: start, end (seconds from the start), extra ms. */
#define MAX_BURSTS 512
static struct { double start, end, extra; } g_burst[MAX_BURSTS];
static int g_nburst;
static void make_bursts(uint64_t seed) {
    double t = 0, until = S->calm_at ? S->calm_at : 1e9;
    while (S->burst_rate && g_nburst < MAX_BURSTS) {
        t += -log(1 - rnd01(&seed)) / S->burst_rate;   /* Poisson arrivals */
        if (t >= until) break;
        double len = S->burst_len_lo + (S->burst_len_hi - S->burst_len_lo) * rnd01(&seed);
        g_burst[g_nburst].start = t;
        g_burst[g_nburst].end = t + len < until ? t + len : until;
        g_burst[g_nburst++].extra = S->burst_lo + (S->burst_hi - S->burst_lo) * rnd01(&seed);
    }
}
static double extra_ms(double now) {
    double t = now - g_start, e = 0;
    for (int i = 0; i < g_nburst; i++) if (t >= g_burst[i].start && t < g_burst[i].end && g_burst[i].extra > e) e = g_burst[i].extra;
    return e;
}

/* ------------------------------------------------------------------ what each player's game does */

#define MAX_FRAMES 4096
typedef struct { uint32_t buttons; int32_t axis[4]; } Pad;
static Pad g_applied[2][MAX_FRAMES][2];   /* [player][frame][slot]: the pads its netplay.c applied */
static uint32_t g_dt[2][MAX_FRAMES];      /* [player][frame]: the frame time it used */
static Pad g_sent[2][MAX_FRAMES];         /* [slot][frame]: the sample that slot's player sent for the frame */
typedef struct { int32_t dx, dy; uint32_t buttons; int changed; } Mouse;
static Mouse g_mouse_applied[2][MAX_FRAMES];   /* [player][frame]: the mouse its netplay.c applied (buttons: if changed) */
static Mouse g_mouse_sent[2][MAX_FRAMES];      /* [slot][frame]: the mouse that slot's player sent for the frame */
static uint32_t g_mouse_down[2];          /* each player's game: the mouse buttons down */
static uint32_t g_applying[2];            /* the frame each player's netplay_frame is applying */
static uint64_t g_state[2];               /* each player's game state: a hash of every pad applied (for netplay.c's desync check) */
static volatile uint32_t g_frame[2];      /* last frame each player presented */
static uint32_t g_stalls_at[2][2];        /* netplay.c's stall count and total wait (ms) at MEASURE_FROM and */
static uint32_t g_waited_at[2][2];        /* MEASURE_TO */
static uint32_t g_hitches[2][2];          /* display refreshes with no new frame, before MEASURE_FROM and MEASURE_TO */

static char g_delay_env[16];
static char *peer_env(int k, const char *name) {
    if (!strcmp(name, "RC_NETPLAY")) return "1";
    if (!strcmp(name, "RC_NP_PLAYERS")) return "2";
    if (!strcmp(name, "RC_NP_SLOT")) return k ? "1" : "0";
    if (!strcmp(name, "RC_NP_DELAY")) return g_delay_env;
    return NULL;
}
char *p0_getenv(const char *name) { return peer_env(0, name); }
char *p1_getenv(const char *name) { return peer_env(1, name); }

static void apply_pad(int k, int slot, uint32_t buttons, const int32_t axis[4]) {
    uint32_t f = g_applying[k];
    if (f < MAX_FRAMES) { g_applied[k][f][slot].buttons = buttons; memcpy(g_applied[k][f][slot].axis, axis, 16); }
    g_state[k] = (g_state[k] ^ (buttons + 0x9e3779b97f4a7c15ull * (slot + 1))) * 0x100000001b3ull;
    for (int i = 0; i < 4; i++) g_state[k] = (g_state[k] ^ (uint32_t)axis[i]) * 0x100000001b3ull;
}
void p0_dinput_pad(int idx, int connected, uint32_t b, const int32_t axis[4]) { (void)connected; apply_pad(0, idx, b, axis); }
void p1_dinput_pad(int idx, int connected, uint32_t b, const int32_t axis[4]) { (void)connected; apply_pad(1, idx, b, axis); }
void p0_input_key_usage_sync(int usage, int down) { (void)usage; (void)down; }
void p1_input_key_usage_sync(int usage, int down) { (void)usage; (void)down; }
static void apply_mouse_move(int k, int dx, int dy) {
    uint32_t f = g_applying[k];
    if (f < MAX_FRAMES) { g_mouse_applied[k][f].dx += dx; g_mouse_applied[k][f].dy += dy; }
    g_state[k] = (g_state[k] ^ ((uint32_t)dx * 31u + (uint32_t)dy)) * 0x100000001b3ull;
}
static void apply_mouse_button(int k, int b, int down) {
    uint32_t f = g_applying[k];
    if (down) g_mouse_down[k] |= 1u << b; else g_mouse_down[k] &= ~(1u << b);
    if (f < MAX_FRAMES) { g_mouse_applied[k][f].buttons = g_mouse_down[k]; g_mouse_applied[k][f].changed = 1; }
    g_state[k] = (g_state[k] ^ (0x1000u + g_mouse_down[k])) * 0x100000001b3ull;
}
void p0_dinput_mouse_move(int dx, int dy) { apply_mouse_move(0, dx, dy); }
void p1_dinput_mouse_move(int dx, int dy) { apply_mouse_move(1, dx, dy); }
void p0_input_mouse_button_sync(int b, int down) { apply_mouse_button(0, b, down); }
void p1_input_mouse_button_sync(int b, int down) { apply_mouse_button(1, b, down); }
static uint64_t hash0(void) { return g_state[0]; }
static uint64_t hash1(void) { return g_state[1]; }

static void *game(void *arg) {
    int k = (int)(intptr_t)arg;
    uint64_t rng = 0x243f6a8885a308d3ull * (k + 1);
    double t0 = g_start + (k ? S->late + 0.009 : 0);   /* the two displays' vsyncs are 9 ms apart */
    sleep_until(t0);
    uint32_t shown = 0, held = 0, acc = 0, last_target = (uint32_t)S->delay;
    uint32_t mouse_held = 0, mouse_acc = 0;
    int32_t mouse_dx = 0, mouse_dy = 0;
    long vsync = 0;
    int32_t axis[4] = { 0, 0, 0, 0 };
    for (uint32_t f = 1; f <= S->frames; f++) {
        usleep((useconds_t)(3000 + 3000 * rnd01(&rng)));   /* simulate frame f */
        /* the pad while it ran: now and then a quick tap (down and up again before the Present, so only
           netplay.c's "pressed" bits can carry it), a button held for a while, the stick moving */
        if (rnd01(&rng) < 0.2) {
            uint32_t b = 1u << (rnd(&rng) % 12);
            API[k].local_pad(0, 1, held | b, axis);
            acc |= held | b;
        }
        if (rnd01(&rng) < 0.05) held ^= 1u << (12 + rnd(&rng) % 4);
        axis[0] = (int32_t)(rnd(&rng) % 65536) - 32768;
        axis[3] = (int32_t)f;
        API[k].local_pad(0, 1, held, axis);
        acc |= held;
        /* the mouse: moving now and then, a quick click, the right button held for a while */
        if (rnd01(&rng) < 0.3) {
            int dx = (int)(rnd(&rng) % 41) - 20, dy = (int)(rnd(&rng) % 41) - 20;
            API[k].local_mouse_move(dx, dy);
            mouse_dx += dx; mouse_dy += dy;
        }
        if (rnd01(&rng) < 0.05) { API[k].local_mouse_button(0, 1); API[k].local_mouse_button(0, 0); mouse_acc |= 1; }
        if (rnd01(&rng) < 0.02) { mouse_held ^= 2; API[k].local_mouse_button(1, (mouse_held & 2) != 0); }
        mouse_acc |= mouse_held;
        g_applying[k] = f + 1;
        API[k].frame(f, k ? hash1 : hash0);
        if (f + 1 < MAX_FRAMES) g_dt[k][f + 1] = API[k].frame_dt_us();
        /* the frames this Present sent, with the delay it applied: last one sent + 1 .. f + delay */
        uint32_t target = f + API[k].status(5);
        if (target > last_target) {
            for (uint32_t F = last_target + 1; F <= target && F < MAX_FRAMES; F++) {
                g_sent[k][F].buttons = acc;
                memcpy(g_sent[k][F].axis, axis, 16);
                /* the movement goes with the first of these frames */
                g_mouse_sent[k][F] = (Mouse){ F == last_target + 1 ? mouse_dx : 0, F == last_target + 1 ? mouse_dy : 0, mouse_acc, 0 };
            }
            last_target = target;
            acc = 0;   /* netplay.c starts its "pressed" bits again */
            mouse_acc = 0; mouse_dx = mouse_dy = 0;
        }
        g_frame[k] = f;
        /* the display: each refresh shows the next queued frame, if there is one */
        double now = host_seconds();
        while (t0 + (vsync + 1) * FRAME_S <= now) {
            vsync++;
            if (f - 1 > shown) shown++;
            else {
                double t = t0 + vsync * FRAME_S - g_start;
                if (t >= MEASURE_FROM) g_hitches[k][0]++;
                if (t >= MEASURE_TO) g_hitches[k][1]++;
            }
        }
        while (f - shown >= QUEUE) {   /* frame f is queued: wait while the queue is full */
            sleep_until(t0 + (vsync + 1) * FRAME_S);
            vsync++;
            shown++;
        }
        double t = host_seconds() - g_start;
        uint32_t stalls = API[k].status(3), waited = API[k].status(1);
        if (t < MEASURE_FROM) { g_stalls_at[k][0] = stalls; g_waited_at[k][0] = waited; }
        if (t < MEASURE_TO) { g_stalls_at[k][1] = stalls; g_waited_at[k][1] = waited; }
    }
    return NULL;
}

/* ------------------------------------------------------------------ the transport: web/netplay.js's job */

/* nextLead's settings (web/netplay.js) */
#define PERIODS 16
#define MIN_PERIODS 8
#define MARGIN_MS 4.0
#define SPARE_MS 6.0
#define LOWER_AFTER_S 2.0
#define PAIR_SPARE_MS (5 * FRAME_MS)
#define MIN_LEAD 2
#define MAX_LEAD 30
#define REPEAT 8

typedef struct {
    int lead, initial;
    double ok_since, changed_at;
    double worst, periods[PERIODS];    /* lags of the other player's inputs: worst this quarter-second, and in */
    int nperiods;                      /* the last 16 (NAN: no inputs), oldest first */
    uint32_t newest;                   /* the other player's newest input, and the lead it went out with */
    int their_lead;
    int have_report;                   /* the other player's report on our inputs */
    double report_lag, report_at;
    int report_ready;                  /* ours, for the next packet */
    int32_t report;
    uint32_t heard_frame;
    int max_lead;                      /* in the jitter, after the first seconds */
} Policy;
static Policy g_pol[2];

/* web/netplay.js: nextLead, for one other player (mine is NAN when unknown) */
static int next_lead(Policy *st, double lag, double mine, int theirs, double now) {
    int up = 0, low = MIN_LEAD;
    int need = (int)ceil((lag + MARGIN_MS) / FRAME_MS);
    if (need > st->lead && (isnan(mine) || !theirs || (st->lead + theirs) * FRAME_MS - (lag + mine) < PAIR_SPARE_MS)) up = need;
    int room = (int)ceil((lag + MARGIN_MS + SPARE_MS) / FRAME_MS);
    if (room > low) low = room;
    if (up || st->lead <= low) { st->ok_since = 0; return up ? (up < MAX_LEAD ? up : MAX_LEAD) : st->lead; }
    if (!st->ok_since) st->ok_since = now;
    return now - st->ok_since >= LOWER_AFTER_S ? st->lead - (st->lead - low + 1) / 2 : st->lead;
}
static void set_lead(int k, int lead, double now) {
    Policy *p = &g_pol[k];
    if (lead == p->lead) return;
    API[k].set_delay(lead);
    p->lead = lead; p->changed_at = now; p->ok_since = 0;
}
/* every 250 ms, as netplay.js's adaptTick: our report on the other player's inputs (the second-worst
   quarter-second of the last 16), then our lead from theirs */
static void adapt_tick(int k, double now) {
    Policy *p = &g_pol[k];
    if (p->nperiods == PERIODS) memmove(p->periods, p->periods + 1, sizeof(double) * (PERIODS - 1));
    else p->nperiods++;
    p->periods[p->nperiods - 1] = p->worst;
    p->worst = NAN;
    double worst = -INFINITY, second = -INFINITY, mine = NAN;
    int seen = 0;
    for (int i = 0; i < p->nperiods; i++) {
        double v = p->periods[i];
        if (isnan(v)) continue;
        seen++;
        if (v > worst) { second = worst; worst = v; }
        else if (v > second) second = v;
    }
    p->report_ready = seen >= MIN_PERIODS;
    if (p->report_ready) p->report = (int32_t)(mine = round(second));
    if (!S->adaptive) return;
    uint32_t frame = API[k].status(0);
    if (p->have_report && now - p->report_at < 3) {
        p->heard_frame = frame;
        set_lead(k, next_lead(p, p->report_lag, mine, p->their_lead, now), now);
    } else if (frame - p->heard_frame > 300) set_lead(k, p->initial, now);
    double t = now - g_start;
    if (t >= MEASURE_FROM && t < MEASURE_TO && p->lead > p->max_lead) p->max_lead = p->lead;
}

typedef struct { uint32_t v[10]; } Entry;   /* an input as web/netplay.js sends it: slot, frame, buttons, axes, frame time, lead, mouse */
typedef struct Packet {
    double at;
    int to, n, nh, has_report;
    int32_t report;
    uint32_t h[4][4];
    Entry d[];
} Packet;
#define MAX_FLIGHT 8192
static Packet *g_flight[MAX_FLIGHT];
static int g_nflight;
static Entry g_recent[2][REPEAT];
static int g_nrecent[2];
static double g_room_at[2];   /* when the room delivers the last packet sent: it keeps them in order */
static uint64_t g_net_rng = 0x9e3779b97f4a7c15ull;

static double one_way(double base_ms, double now) {
    return (base_ms + extra_ms(now) + S->noise_ms * rnd01(&g_net_rng)) / 1000;
}
static void send_packet(int to, double at, const Entry *d, int n, uint32_t h[][4], int nh, int has_report, int32_t report) {
    if (g_nflight == MAX_FLIGHT) { fprintf(stderr, "too many packets in flight\n"); exit(1); }
    Packet *p = malloc(sizeof *p + sizeof(Entry) * (size_t)n);
    p->at = at; p->to = to; p->n = n; p->nh = nh; p->has_report = has_report; p->report = report;
    memcpy(p->d, d, sizeof(Entry) * (size_t)n);
    memcpy(p->h, h, sizeof(uint32_t) * 4 * (size_t)nh);
    g_flight[g_nflight++] = p;
}

/* drains player k's outbox, like netplay.js's pump */
static void pump(int k, double now) {
    Entry d[128];
    uint32_t h[4][4];
    int n = 0, nh = 0;
    while (API[k].pop()) {
        uint32_t v[11];
        for (int i = 0; i < 11; i++) v[i] = (uint32_t)API[k].msg(i);
        if (v[0] == 1 && n < 128) {
            Entry e = { { v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10] } };
            d[n++] = e;
            if (g_nrecent[k] == REPEAT) memmove(g_recent[k], g_recent[k] + 1, sizeof(Entry) * (REPEAT - 1));
            else g_nrecent[k]++;
            g_recent[k][g_nrecent[k] - 1] = e;
        } else if (v[0] == 2 && nh < 4) {
            uint32_t hv[4] = { v[1], v[2], v[8], v[9] };
            memcpy(h[nh++], hv, sizeof hv);
        }
    }
    if (!n && !nh) return;
    Policy *p = &g_pol[k];
    int has_report = p->report_ready;
    p->report_ready = 0;
    double room = now + one_way(S->room_ms, now);
    if (room < g_room_at[k]) room = g_room_at[k];
    g_room_at[k] = room;
    send_packet(1 - k, room, d, n, h, nh, has_report, p->report);
    if (rnd01(&g_net_rng) >= S->loss)
        send_packet(1 - k, now + one_way(S->direct_ms, now), g_recent[k], g_nrecent[k], h, nh, has_report, p->report);
}

/* hands player k what arrived, like netplay.js's deliver */
static void deliver(Packet *pk, double now) {
    int k = pk->to;
    Policy *p = &g_pol[k];
    for (int i = 0; i < pk->n; i++) {
        const uint32_t *e = pk->d[i].v;
        int32_t slack = API[k].remote_input((int)e[0], e[1], e[2], (int)e[3], (int)e[4], (int)e[5], (int)e[6], e[7], (int32_t)e[9]);
        int lead = (int)e[8];
        if (lead <= 0) continue;
        if (e[1] > p->newest) { p->newest = e[1]; p->their_lead = lead; }
        if (slack == NO_SLACK) continue;
        double lag = lead * FRAME_MS - slack;
        if (lag > 1000) continue;
        if (isnan(p->worst) || lag > p->worst) p->worst = lag;
    }
    for (int i = 0; i < pk->nh; i++) API[k].remote_hash((int)pk->h[i][0], pk->h[i][1], pk->h[i][2], pk->h[i][3]);
    if (pk->has_report) { p->have_report = 1; p->report_lag = pk->report; p->report_at = now; }
}

static void *transport(void *arg) {
    (void)arg;
    uint64_t rng = 0x452821e638d01377ull;
    double next_tick = g_start + 0.25, next_script = g_start + 0.5;
    while (!g_done) {
        double now = host_seconds();
        for (int k = 0; k < 2; k++) pump(k, now);
        for (int i = 0; i < g_nflight;) {
            if (g_flight[i]->at <= now) { Packet *p = g_flight[i]; g_flight[i] = g_flight[--g_nflight]; deliver(p, now); free(p); }
            else i++;
        }
        if (now >= next_tick) {
            next_tick += 0.25;
            for (int k = 0; k < 2; k++) adapt_tick(k, now);
        }
        if (S->scripted && now >= next_script) {   /* one player's delay jumps somewhere in 1..30, often to an end */
            next_script += 0.35 + 0.35 * rnd01(&rng);
            int k = (int)(rnd(&rng) & 1), r = (int)(rnd(&rng) % 4);
            set_lead(k, r == 0 ? 1 : r == 1 ? 30 : 1 + (int)(rnd(&rng) % 30), now);
        }
        usleep(200);
    }
    return NULL;
}

/* ------------------------------------------------------------------ one scenario, then the checks */

static int failures;
#define CHECK(cond, ...) do { if (!(cond)) { failures++; if (failures <= 10) { fprintf(stderr, "  FAIL: " __VA_ARGS__); fputc('\n', stderr); } } } while (0)

static int same_pad(const Pad *a, const Pad *b) { return a->buttons == b->buttons && !memcmp(a->axis, b->axis, 16); }

static int run(const Scenario *sc, FILE *out) {
    S = sc;
    snprintf(g_delay_env, sizeof g_delay_env, "%d", S->delay);
    for (int k = 0; k < 2; k++) { g_pol[k].lead = g_pol[k].initial = g_pol[k].max_lead = S->delay; g_pol[k].worst = NAN; }
    make_bursts(0x13198a2e03707344ull);
    g_start = host_seconds();
    /* scripted: the delays change in the warm-up too, from the first Present: one up past it, one down below it */
    if (S->scripted) { set_lead(0, 20, g_start); set_lead(1, 1, g_start); }
    pthread_t gt[2], tt;
    pthread_create(&tt, NULL, transport, NULL);
    for (int k = 0; k < 2; k++) pthread_create(&gt[k], NULL, game, (void *)(intptr_t)k);
    /* no deadlock: both players must keep presenting */
    uint32_t seen[2] = { 0, 0 };
    double moved = host_seconds();
    while (g_frame[0] < S->frames || g_frame[1] < S->frames) {
        usleep(100000);
        if (g_frame[0] != seen[0] || g_frame[1] != seen[1]) { seen[0] = g_frame[0]; seen[1] = g_frame[1]; moved = host_seconds(); }
        else if (host_seconds() - moved > 5) {
            fprintf(stderr, "  FAIL: deadlock: frames %u and %u, delays %u and %u, nothing for 5 s\n", g_frame[0], g_frame[1],
                    API[0].status(5), API[1].status(5));
            return 1;
        }
    }
    for (int k = 0; k < 2; k++) pthread_join(gt[k], NULL);
    g_done = 1;
    pthread_join(tt, NULL);
    double secs = host_seconds() - g_start;

    /* both applied the same pads and frame times every frame, and each pad is what its player sent */
    int checked = 0;
    for (uint32_t f = 2; f <= S->frames + 1 && f < MAX_FRAMES; f++) {
        CHECK(g_dt[0][f] == g_dt[1][f], "frame %u: frame times differ (%u, %u us)", f, g_dt[0][f], g_dt[1][f]);
        for (int s = 0; s < 2; s++) {
            const Pad *a = &g_applied[0][f][s], *b = &g_applied[1][f][s];
            CHECK(same_pad(a, b), "frame %u, player %d's pad: %x/%d on one, %x/%d on the other", f, s + 1, a->buttons, a->axis[3],
                  b->buttons, b->axis[3]);
            Pad want = { 0, { 0, 0, 0, 0 } };
            if (f > (uint32_t)S->delay) want = g_sent[s][f];
            CHECK(same_pad(a, &want), "frame %u, player %d's pad: applied %x/%d, sent %x/%d", f, s + 1, a->buttons, a->axis[3],
                  want.buttons, want.axis[3]);
            checked++;
        }
    }
    /* and the same mouse: everyone's movement added up, each button down while anyone held it */
    uint32_t down[2] = { 0, 0 };
    for (uint32_t f = 2; f <= S->frames + 1 && f < MAX_FRAMES; f++) {
        const Mouse *a = &g_mouse_applied[0][f], *b = &g_mouse_applied[1][f];
        for (int k = 0; k < 2; k++) if (g_mouse_applied[k][f].changed) down[k] = g_mouse_applied[k][f].buttons;
        CHECK(a->dx == b->dx && a->dy == b->dy && down[0] == down[1], "frame %u: the mouse %d,%d/%x on one, %d,%d/%x on the other",
              f, a->dx, a->dy, down[0], b->dx, b->dy, down[1]);
        Mouse want = { 0, 0, 0, 0 };
        if (f > (uint32_t)S->delay)
            for (int s = 0; s < 2; s++) {
                want.dx += g_mouse_sent[s][f].dx; want.dy += g_mouse_sent[s][f].dy; want.buttons |= g_mouse_sent[s][f].buttons;
            }
        CHECK(a->dx == want.dx && a->dy == want.dy && down[0] == want.buttons, "frame %u: the mouse applied %d,%d/%x, sent %d,%d/%x",
              f, a->dx, a->dy, down[0], want.dx, want.dy, want.buttons);
    }
    for (int k = 0; k < 2; k++) CHECK(API[k].status(2) == 0, "player %d's netplay.c saw a desync at frame %u", k + 1, API[k].status(2));

    uint32_t stalls = 0, hitches = 0, waited = 0;
    for (int k = 0; k < 2; k++) {
        stalls += g_stalls_at[k][1] - g_stalls_at[k][0];
        waited += g_waited_at[k][1] - g_waited_at[k][0];
        hitches += g_hitches[k][0] - g_hitches[k][1];
    }
    int lead_max = g_pol[0].max_lead > g_pol[1].max_lead ? g_pol[0].max_lead : g_pol[1].max_lead;
    int lead_end = API[0].status(5) > API[1].status(5) ? (int)API[0].status(5) : (int)API[1].status(5);
    printf("%-9s %u frames in %.1f s, %d pads checked, delays now %u and %u; from %.0f to %.0f s: %u stalls, waited %u ms, "
           "%u display hitches", S->name, S->frames, secs, checked, API[0].status(5), API[1].status(5), MEASURE_FROM, MEASURE_TO,
           stalls, waited, hitches);
    if (S->adaptive) printf(", delay up to %d", lead_max);
    printf("\n");
    if (S->adaptive) {
        CHECK(lead_max > S->delay, "the delay never rose");
        if (S->calm_at) CHECK(lead_end < lead_max, "the delay didn't come down in the calm (%d, was up to %d)", lead_end, lead_max);
    }
    if (out) fprintf(out, "%s %u %u %d %d\n", S->name, stalls, waited, lead_max, failures);
    return failures != 0;
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    int n = (int)(sizeof SCENARIOS / sizeof SCENARIOS[0]);
    if (argc > 1) {   /* one scenario in this process */
        for (int i = 0; i < n; i++) if (!strcmp(argv[1], SCENARIOS[i].name)) return run(&SCENARIOS[i], NULL);
        fprintf(stderr, "unknown scenario %s\n", argv[1]);
        return 2;
    }
    /* all of them, each in a child process, in parallel */
    int fds[16][2];
    pid_t pid[16];
    for (int i = 0; i < n; i++) {
        if (pipe(fds[i])) { perror("pipe"); return 2; }
        if (!(pid[i] = fork())) {
            close(fds[i][0]);
            FILE *out = fdopen(fds[i][1], "w");
            int r = run(&SCENARIOS[i], out);
            fclose(out);
            _exit(r);
        }
        close(fds[i][1]);
    }
    int bad = 0;
    unsigned stalls[16] = { 0 }, waited[16] = { 0 };
    for (int i = 0; i < n; i++) {
        char name[32] = "";
        int lead_max = 0, fails = 1, status = 0;
        FILE *in = fdopen(fds[i][0], "r");
        if (fscanf(in, "%31s %u %u %d %d", name, &stalls[i], &waited[i], &lead_max, &fails) != 5) fails = 1;
        fclose(in);
        waitpid(pid[i], &status, 0);
        if (fails || !WIFEXITED(status) || WEXITSTATUS(status)) { bad++; printf("FAIL %s\n", SCENARIOS[i].name); }
        else printf("ok   %s\n", SCENARIOS[i].name);
    }
    /* Past the first seconds, adapting must cut both the stalls and the time spent waiting for the other player's
       inputs at a fixed delay on the same network to well under half. (The fixed delay must have had a problem:
       10 stalls, or half a second of waiting. A game that runs ahead of the other waits a little every frame,
       most of it under the 10 ms that counts as a stall.) */
    for (int i = 0; i < n; i++) {
        if (!SCENARIOS[i].versus) continue;
        int j = 0;
        while (j < n && strcmp(SCENARIOS[j].name, SCENARIOS[i].versus)) j++;
        if (j == n) continue;
        int ok = (stalls[j] >= 10 || waited[j] >= 500) && stalls[i] * 2 <= stalls[j] && waited[i] * 2 < waited[j];
        if (!ok) bad++;
        printf("%s %s vs %s from %.0f to %.0f s: %u stalls vs %u, waited %u ms vs %u\n", ok ? "ok  " : "FAIL",
               SCENARIOS[i].name, SCENARIOS[i].versus, MEASURE_FROM, MEASURE_TO, stalls[i], stalls[j], waited[i], waited[j]);
    }
    printf(bad ? "%d failed\n" : "all passed\n", bad);
    return bad != 0;
}
