/* Lockstep netplay core (transport-agnostic). Every peer runs the same deterministic simulation
 * (RC_DETERMINISTIC=1, sched.c) from boot and feeds it the same pad inputs on the same frames, so only
 * inputs travel. The page (web/loader.js) or the Node harness (web/node_env.js) moves messages between peers.
 *
 * Frames are Present calls. At Present f the local pad state becomes this player's input for frame f + D
 * (D = input delay) and goes into the outbox; then the game thread waits until every player's input for
 * frame f + 1 is known and applies all of them at once, before the game reads input again. Frames 1..D
 * are neutral for everyone. Physical input never reaches the game directly in netplay: input_gamepad()
 * for the local pad, and input_mouse_move() / input_mouse_button() for the mouse, only update the sample
 * taken at the next Present. The mouse is shared: everyone's movement moves the one cursor the game draws,
 * and a button is down while anyone holds it (some of the PC version's screens only answer the mouse:
 * without it, players were stuck on Innings Highlights between innings).
 *
 * Frame time is an input too: in deterministic mode the game's clock only moves by what Present gives it,
 * so a fixed 1/60 s per frame would make the game run in slow motion whenever the players manage fewer
 * than 60 fps. The host (slot 0) measures the real time between its frames and sends it with its input;
 * every peer advances the clock by exactly that much for that frame (vclock_frame), so the game keeps real
 * speed (choppier, not slower, when someone is slow) and every peer still sees the same times.
 *
 * Every NP_HASH_EVERY frames each peer also sends a hash of the game's global data; a mismatch means the
 * simulations diverged (desync) and is reported.
 *
 * The delay can change mid-game (netplay_set_delay; web/netplay.js adapts it to how early our inputs
 * reach the others). Inputs are keyed by frame, so each peer changes how far ahead it sends its own without
 * asking anyone: a longer delay also sends the frames in between (repeating the current sample), a shorter
 * one sends nothing until f + D passes the last frame already sent. Either way every frame gets exactly one
 * input. The neutral warm-up stays keyed to the delay the session started with.
 *
 * Inputs from the transport arrive on another host thread (the page's main thread), so each buffer entry
 * carries the frame it holds, published with release/acquire ordering; the game thread sleeps on a futex
 * that every delivery wakes. Outgoing messages wake the page's pump the same way (an async main-thread
 * call), so neither direction waits for a timer tick. */
#include "win32.h"

#include <pthread.h>
#include <unistd.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/threading.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

#define NP_SLOTS 4
#define NP_RING 512          /* frames of input kept per player */
#define NP_HASH_EVERY 60

typedef struct { uint32_t frame; uint32_t buttons; int32_t axis[4]; uint32_t dt_us; int32_t mouse; } NpInput;   /* frame 0 = empty */
/* buttons: standard-gamepad bits 0-16, plus keys the game only takes from the keyboard (pause is Esc, not
   Start): they travel with the pad and are applied to the DirectInput keyboard on every peer; and the mouse
   buttons (left, right, middle). mouse: its movement since the previous input, x in the low 16 bits and y in
   the high 16 (both signed). */
#define NP_PAD_BITS 0x1FFFFu
#define NP_KEY_ESC (1u << 20)
#define NP_MOUSE_SHIFT 21
typedef struct { uint32_t kind, slot, frame, buttons; int32_t axis[4]; uint32_t hash_lo, hash_hi; int32_t mouse; } NpMsg;
enum { MSG_INPUT = 1, MSG_HASH = 2 };

static int g_np = -1;                       /* netplay on */
static int g_np_players, g_np_slot, g_np_delay;   /* g_np_delay: the session's delay (frames 1..D are neutral) */
static int g_np_lead;                       /* the delay our inputs are sent with now */
static int g_np_want;                       /* the page's choice (netplay_set_delay), applied at the next Present */
static uint32_t g_last_sent;                /* last frame our input went out for */
static NpInput g_in[NP_SLOTS][NP_RING];
static int g_left[NP_SLOTS];                /* peer gone: its pad reads neutral from then on */
static NpInput g_local;                     /* latest physical/scripted state of the local pad */
static uint32_t g_local_pressed;            /* buttons pressed since the last sample sent (see netplay_frame) */
static int32_t g_local_mx, g_local_my;      /* local mouse movement not sent yet */
static uint32_t g_local_mouse, g_local_mouse_pressed;   /* local mouse buttons held, and pressed since the last sample */
static pthread_mutex_t g_local_lock = PTHREAD_MUTEX_INITIALIZER;

#define OUTBOX 1024
static NpMsg g_out[OUTBOX];
static uint32_t g_out_w, g_out_r;           /* single producer (game thread), single consumer (transport) */
static uint32_t g_in_seq;                   /* bumped whenever remote input lands; the game thread sleeps on it */

/* Desync detection: our hashes and theirs, by frame / NP_HASH_EVERY */
#define NP_HASHES 64
static uint64_t g_my_hash[NP_HASHES]; static uint32_t g_my_hash_frame[NP_HASHES];
static uint32_t g_desync_frame;             /* first frame found to differ (0 = none) */
static uint32_t g_frame;                    /* last frame processed */
static uint64_t g_present_us;               /* when the last Present began (host clock, us), and whether it is */
static int g_waiting;                       /* still waiting for the next frame's inputs (for arrival_slack) */
static uint32_t g_wait_ms;                  /* time spent waiting for remote input, for the page's status line */
static uint32_t g_stalls;                   /* frames that waited over 10 ms for remote input (the delay didn't cover it) */
static uint32_t g_blocked;                  /* the game thread is blocked on remote input now (the watchdog's "waiting") */
static uint32_t g_frame_dt_us = 16667;      /* game time for the next frame (see top) */
int netplay_on(void);
uint32_t netplay_frame_dt_us(void) { return netplay_on() ? g_frame_dt_us : 0; }

int netplay_on(void) {
    if (g_np < 0) {
        g_np = getenv("RC_NETPLAY") != NULL && deterministic();
        if (getenv("RC_NETPLAY") && !deterministic())
            fprintf(stderr, "[netplay] RC_NETPLAY needs RC_DETERMINISTIC=1; netplay off\n");
        if (g_np) {
            g_np_players = getenv("RC_NP_PLAYERS") ? atoi(getenv("RC_NP_PLAYERS")) : 2;
            g_np_slot = getenv("RC_NP_SLOT") ? atoi(getenv("RC_NP_SLOT")) : 0;
            g_np_delay = getenv("RC_NP_DELAY") ? atoi(getenv("RC_NP_DELAY")) : 4;
            if (g_np_players < 1 || g_np_players > NP_SLOTS || g_np_slot < 0 || g_np_slot >= g_np_players ||
                g_np_delay < 1 || g_np_delay > 60) {
                fprintf(stderr, "[netplay] bad configuration (players %d, slot %d, delay %d)\n", g_np_players,
                        g_np_slot, g_np_delay);
                exit(1);
            }
            fprintf(stderr, "[netplay] %d players, local slot %d, input delay %d frames\n", g_np_players, g_np_slot,
                    g_np_delay);
            g_np_lead = g_np_delay;
            g_last_sent = (uint32_t)g_np_delay;   /* frames up to the delay are neutral: never sent */
        }
    }
    return g_np;
}

/* input_gamepad() lands here in netplay mode: only the local player's first pad counts. */
int netplay_local_pad(int idx, int connected, uint32_t buttons, const int32_t axis[4]) {
    if (!netplay_on()) return 0;
    if (idx != 0) return 1;
    pthread_mutex_lock(&g_local_lock);
    g_local.buttons = connected ? buttons : 0;
    g_local_pressed |= g_local.buttons;
    for (int i = 0; i < 4; i++) g_local.axis[i] = connected ? axis[i] : 0;
    pthread_mutex_unlock(&g_local_lock);
    return 1;
}

/* input_mouse_move() and input_mouse_button() land here in netplay mode. */
int netplay_local_mouse_move(int dx, int dy) {
    if (!netplay_on()) return 0;
    pthread_mutex_lock(&g_local_lock);
    g_local_mx += dx; g_local_my += dy;
    pthread_mutex_unlock(&g_local_lock);
    return 1;
}
int netplay_local_mouse_button(int b, int down) {
    if (!netplay_on()) return 0;
    pthread_mutex_lock(&g_local_lock);
    if (down) { g_local_mouse |= 1u << b; g_local_mouse_pressed |= 1u << b; }
    else g_local_mouse &= ~(1u << b);
    pthread_mutex_unlock(&g_local_lock);
    return 1;
}
static int32_t clamp16(int32_t v) { return v < -32768 ? -32768 : v > 32767 ? 32767 : v; }

static void outbox_push(const NpMsg *m) {
    uint32_t w = g_out_w;
    if (w - __atomic_load_n(&g_out_r, __ATOMIC_ACQUIRE) >= OUTBOX) { fprintf(stderr, "[netplay] outbox full\n"); return; }
    g_out[w % OUTBOX] = *m;
    __atomic_store_n(&g_out_w, w + 1, __ATOMIC_RELEASE);
#ifdef __EMSCRIPTEN__
    /* wake the page's pump now rather than at its next timer tick (which the browser clamps to ~4 ms and
       runs after any rendering work): the message is on the wire a few ms sooner */
    MAIN_THREAD_ASYNC_EM_ASM({ if (Module.rcNetplayPump) Module.rcNetplayPump(); });
#endif
}

/* Remote input (or a player leaving) may unblock the game thread's wait in netplay_frame. */
static void inputs_changed(void) {
    __atomic_add_fetch(&g_in_seq, 1, __ATOMIC_RELEASE);
#ifdef __EMSCRIPTEN__
    emscripten_futex_wake(&g_in_seq, 1);
#endif
}

static void store_input(int slot, uint32_t frame, uint32_t buttons, const int32_t axis[4], uint32_t dt_us, int32_t mouse) {
    NpInput *e = &g_in[slot][frame % NP_RING];
    e->buttons = buttons;
    e->dt_us = dt_us;
    e->mouse = mouse;
    for (int i = 0; i < 4; i++) e->axis[i] = axis[i];
    __atomic_store_n(&e->frame, frame, __ATOMIC_RELEASE);
}

static int have_input(int slot, uint32_t frame) {
    if (frame <= (uint32_t)g_np_delay || __atomic_load_n(&g_left[slot], __ATOMIC_ACQUIRE)) return 1;
    return __atomic_load_n(&g_in[slot][frame % NP_RING].frame, __ATOMIC_ACQUIRE) == frame;
}

static void check_hash(uint32_t frame, uint64_t theirs, int slot) {
    int k = (int)((frame / NP_HASH_EVERY) % NP_HASHES);
    if (g_my_hash_frame[k] != frame) return;   /* ours isn't computed yet or already overwritten */
    if (g_my_hash[k] != theirs && !g_desync_frame) {
        g_desync_frame = frame;
        fprintf(stderr, "[netplay] DESYNC with player %d at frame %u (%016llx vs %016llx)\n", slot, frame,
                (unsigned long long)g_my_hash[k], (unsigned long long)theirs);
    }
}

/* Remote hashes that arrive before ours is computed wait here. */
static struct { uint32_t frame; int slot; uint64_t hash; } g_pending[NP_SLOTS][NP_HASHES];

/* Called at every Present on the game thread, with the frame just presented and a hash of global state. */
void netplay_frame(uint32_t frame, uint64_t (*state_hash)(void)) {
    if (!netplay_on()) return;
    double t_present = host_seconds();
    /* from here until the wait below ends, frame + 1's inputs are needed (for arrival_slack, on other threads) */
    __atomic_store_n(&g_present_us, (uint64_t)(t_present * 1e6), __ATOMIC_RELAXED);
    __atomic_store_n(&g_waiting, 1, __ATOMIC_RELAXED);
    __atomic_store_n(&g_frame, frame, __ATOMIC_RELEASE);
    int want = __atomic_load_n(&g_np_want, __ATOMIC_ACQUIRE);
    if (want && want != g_np_lead) {
        fprintf(stderr, "[netplay] input delay %d -> %d frames (frame %u)\n", g_np_lead, want, frame);
        __atomic_store_n(&g_np_lead, want, __ATOMIC_RELAXED);
    }
    uint32_t dt_us = 0;
    if (g_np_slot == 0) {   /* the host's real frame time, for the frame this input belongs to */
        static double last;
        double dt = last ? t_present - last : 1.0 / 60;
        last = t_present;
        if (dt < 0.004) dt = 0.004;     /* high-refresh displays present more often: still real time */
        if (dt > 0.033) dt = 0.033;     /* a longer gap (a stall, or under 30 fps) briefly slows the game down rather
                                           than jumping ahead: a slowdown reads as "lag", a jump as broken */
        dt_us = (uint32_t)(dt * 1e6);
    }
    /* our input for frame + D. If D just grew, the frames in between get the same sample; if it shrank, nothing
       goes out until frame + D passes the last frame sent (taps wait in g_local_pressed for the next sample). */
    uint32_t first = g_last_sent + 1, target = frame + (uint32_t)g_np_lead;
    /* Each input says how far ahead it went out, so the others can time its arrival. Not after a slow frame of
       ours (over 50 ms between getting the inputs and the next Present: a load, say): that input leaves late
       through no fault of the network, and 0 tells the others not to count it. */
    static double wait_end;
    int slow = wait_end && t_present - wait_end > 0.05;
    if (target >= first) {
        NpMsg m = { MSG_INPUT, (uint32_t)g_np_slot, 0, 0, { 0 }, dt_us, 0, 0 };
        /* A button pressed and released since the last sample still counts as held for this one: the pad
           is only sampled here, once a frame, so a quick tap between two samples would otherwise be lost (and
           the slower the game runs, the more taps fall between samples). */
        pthread_mutex_lock(&g_local_lock);
        m.buttons = g_local.buttons | g_local_pressed | (g_local_mouse | g_local_mouse_pressed) << NP_MOUSE_SHIFT;
        g_local_pressed = g_local_mouse_pressed = 0;
        for (int i = 0; i < 4; i++) m.axis[i] = g_local.axis[i];
        int32_t mx = clamp16(g_local_mx), my = clamp16(g_local_my);
        g_local_mx -= mx; g_local_my -= my;   /* more than fits goes with the next */
        pthread_mutex_unlock(&g_local_lock);
        for (uint32_t f = first; f <= target; f++) {
            m.frame = f;
            m.hash_hi = slow ? 0 : f - frame;
            /* the movement once (the frames in between hold the buttons, not another move) */
            m.mouse = f == first ? (int32_t)((uint32_t)(uint16_t)mx | (uint32_t)(uint16_t)my << 16) : 0;
            store_input(g_np_slot, f, m.buttons, m.axis, dt_us, m.mouse);
            outbox_push(&m);
        }
        g_last_sent = target;
        static int log_input = -1;   /* RC_NP_LOG_INPUT=1: log every non-neutral input this player sends */
        if (log_input < 0) log_input = getenv("RC_NP_LOG_INPUT") != NULL;
        if (log_input && m.buttons) fprintf(stderr, "[netplay] sent buttons %x for frames %u-%u\n", m.buttons, first, target);
    }
    /* test only: RC_NP_PERTURB=<frame> flips a byte of the game's globals here, to check desync detection */
    static int perturb = -1;
    if (perturb < 0) perturb = getenv("RC_NP_PERTURB") ? atoi(getenv("RC_NP_PERTURB")) : 0;
    if (perturb && frame == (uint32_t)perturb) { uint32_t a = g_state_lo + (g_state_hi - g_state_lo) / 2; W8(a, R8(a) ^ 1); fprintf(stderr, "[netplay] test: perturbed state at frame %u\n", frame); }
    if (frame % NP_HASH_EVERY == 0) {
        uint64_t h = state_hash();
        int k = (int)((frame / NP_HASH_EVERY) % NP_HASHES);
        g_my_hash[k] = h; g_my_hash_frame[k] = frame;
        NpMsg hm = { MSG_HASH, (uint32_t)g_np_slot, frame, 0, { 0 }, (uint32_t)h, (uint32_t)(h >> 32), 0 };
        outbox_push(&hm);
        for (int s = 0; s < g_np_players; s++)
            if (g_pending[s][k].frame == frame) check_hash(frame, g_pending[s][k].hash, s);
    }
    /* wait for everyone's input for the next frame (wall time only; the game's clock doesn't move) */
    uint32_t next = frame + 1;
    double t0 = host_seconds(), last_note = t0;
    for (;;) {
        uint32_t seq = __atomic_load_n(&g_in_seq, __ATOMIC_ACQUIRE);   /* before the check: a delivery in between wakes us */
        int all = 1;
        for (int s = 0; s < g_np_players; s++) if (!have_input(s, next)) { all = 0; break; }
        __atomic_store_n(&g_blocked, !all, __ATOMIC_RELAXED);
        if (all) break;
#ifdef __EMSCRIPTEN__
        emscripten_futex_wait(&g_in_seq, seq, 2.0);   /* woken by inputs_changed(); the timeout is a safety net */
#else
        (void)seq;
        usleep(500);
#endif
        double now = host_seconds();
        if (now - last_note > 5) { last_note = now; fprintf(stderr, "[netplay] waiting for players (frame %u, %.0f s)\n", next, now - t0); }
    }
    __atomic_store_n(&g_waiting, 0, __ATOMIC_RELEASE);
    wait_end = host_seconds();
    double waited = wait_end - t0;
    g_wait_ms += (uint32_t)(waited * 1000);
    if (waited > 0.010) g_stalls++;
    /* every 10 s: how the lockstep is doing (the page's console, or stderr headless) */
    static double worst, period_t0;
    static uint32_t period_stalls;
    if (waited > worst) worst = waited;
    if (frame % 600 == 0) {
        double now = host_seconds();
        if (period_t0) fprintf(stderr, "[netplay] frame %u: %.1f fps, %u stalls (worst %.0f ms), waited %u ms in all, delay %d\n",
                               frame, 600 / (now - period_t0), g_stalls - period_stalls, worst * 1000, g_wait_ms, g_np_lead);
        period_t0 = now; period_stalls = g_stalls; worst = 0;
    }
    /* apply every player's pad for the next frame */
    static const int32_t zero[4] = { 0, 0, 0, 0 };
    extern void dinput_pad(int idx, int connected, uint32_t std_buttons, const int32_t axis[4]);
    uint32_t keys = 0;
    int32_t mx = 0, my = 0;
    for (int s = 0; s < g_np_players; s++) {
        NpInput *e = &g_in[s][next % NP_RING];
        int live = next > (uint32_t)g_np_delay && !g_left[s] && e->frame == next;
        uint32_t b = live ? e->buttons : 0;
        keys |= b;
        dinput_pad(s, 1, b & NP_PAD_BITS, live ? e->axis : zero);
        if (live) { mx += (int16_t)(uint16_t)e->mouse; my += (int16_t)(uint16_t)((uint32_t)e->mouse >> 16); }
    }
    /* keyboard keys carried with the inputs: either player's Esc pauses, on every peer alike */
    extern void input_key_usage_sync(int usage, int down);
    static int esc_down;
    int esc = (keys & NP_KEY_ESC) != 0;
    if (esc != esc_down) { esc_down = esc; input_key_usage_sync(41 /* HID: Escape */, esc); }
    /* and the mouse: everyone's movement, and a button down while anyone holds it */
    extern void dinput_mouse_move(int dx, int dy);
    extern void input_mouse_button_sync(int b, int down);
    static uint32_t mouse_down;
    uint32_t mouse = keys >> NP_MOUSE_SHIFT & 7u;
    if (mx || my) dinput_mouse_move(mx, my);
    for (int k = 0; k < 3; k++) if ((mouse ^ mouse_down) >> k & 1u) input_mouse_button_sync(k, (int)(mouse >> k & 1u));
    mouse_down = mouse;
    /* the frame time every peer uses for the next frame: the host's (1/60 s before inputs start or if the
       host has left) */
    NpInput *h = &g_in[0][next % NP_RING];
    g_frame_dt_us = next > (uint32_t)g_np_delay && !g_left[0] && h->frame == next && h->dt_us ? h->dt_us : 16667;
}

/* ------------------------------------------------------------------ transport side (any thread) */

/* Next outgoing message: netplay_pop() loads it (0 if none), netplay_msg(i) reads its fields: kind, slot,
   frame, buttons, axes x4, hash lo, hash hi (an input's frame time, and how many frames ahead it was sent),
   mouse movement. (Fields by call, so the transport needs no view of wasm memory.) */
static uint32_t g_popped[11];
EXPORT int netplay_pop(void) {
    uint32_t r = g_out_r;
    if (r == __atomic_load_n(&g_out_w, __ATOMIC_ACQUIRE)) return 0;
    NpMsg *m = &g_out[r % OUTBOX];
    uint32_t v[11] = { m->kind, m->slot, m->frame, m->buttons, (uint32_t)m->axis[0], (uint32_t)m->axis[1],
                       (uint32_t)m->axis[2], (uint32_t)m->axis[3], m->hash_lo, m->hash_hi, (uint32_t)m->mouse };
    memcpy(g_popped, v, sizeof v);
    __atomic_store_n(&g_out_r, r + 1, __ATOMIC_RELEASE);
    return 1;
}
EXPORT int32_t netplay_msg(int i) { return i >= 0 && i < 11 ? (int32_t)g_popped[i] : 0; }

/* How early a remote input for `frame` arrives: ms before this game needs it, negative when it has already been
   waiting that long. Waiting at Present g, it has needed frame g + 1 since that Present began; past the wait it
   needs g + 2 at its next Present, about a frame later (or any moment, in a slow frame such as a load); later
   frames follow a frame apart. web/netplay.js turns these into the reports that set each sender's delay. */
#define NP_FRAME_US 16667
#define NP_NO_SLACK INT32_MIN
static int32_t arrival_slack(uint32_t frame) {
    uint32_t g = __atomic_load_n(&g_frame, __ATOMIC_ACQUIRE);
    int waiting = __atomic_load_n(&g_waiting, __ATOMIC_RELAXED);
    int64_t tp = (int64_t)__atomic_load_n(&g_present_us, __ATOMIC_RELAXED), now = (int64_t)(host_seconds() * 1e6);
    uint32_t first = g + (waiting ? 1 : 2);   /* the next frame it will wait for */
    if (!g || (int32_t)(frame - first) < 0 || frame - first > 600) return NP_NO_SLACK;   /* not started, or played */
    int64_t need = waiting ? tp : now > tp + NP_FRAME_US ? now : tp + NP_FRAME_US;
    return (int32_t)((need + (int64_t)(frame - first) * NP_FRAME_US - now) / 1000);
}

/* Returns how early the input arrived (arrival_slack), or NP_NO_SLACK if it was here already: inputs come over
   two paths, and every direct packet repeats the last few. */
EXPORT int32_t netplay_remote_input(int slot, uint32_t frame, uint32_t buttons, int lx, int ly, int rx, int ry,
                                    uint32_t dt_us, int32_t mouse) {
    if (!netplay_on() || slot < 0 || slot >= g_np_players || slot == g_np_slot) return NP_NO_SLACK;
    if (__atomic_load_n(&g_in[slot][frame % NP_RING].frame, __ATOMIC_ACQUIRE) == frame) return NP_NO_SLACK;
    int32_t slack = arrival_slack(frame);   /* before storing it: the game thread may take it and move on at once */
    const int32_t axis[4] = { lx, ly, rx, ry };
    store_input(slot, frame, buttons, axis, dt_us, mouse);
    inputs_changed();
    return slack;
}

/* The delay to send our inputs with, from the next Present on (web/netplay.js adapts it); any thread. */
EXPORT void netplay_set_delay(int frames) {
    if (frames >= 1 && frames <= 60) __atomic_store_n(&g_np_want, frames, __ATOMIC_RELEASE);
}

EXPORT void netplay_remote_hash(int slot, uint32_t frame, uint32_t lo, uint32_t hi) {
    if (!netplay_on() || slot < 0 || slot >= NP_SLOTS) return;
    uint64_t h = (uint64_t)hi << 32 | lo;
    int k = (int)((frame / NP_HASH_EVERY) % NP_HASHES);
    /* hashes are compared on the game thread when ours exists; this runs on the transport's thread, so
       just record it there and compare if ours is already done */
    g_pending[slot][k].frame = frame; g_pending[slot][k].slot = slot; g_pending[slot][k].hash = h;
    if (g_my_hash_frame[k] == frame) check_hash(frame, h, slot);
}

EXPORT void netplay_player_left(int slot) {
    if (slot < 0 || slot >= NP_SLOTS) return;
    __atomic_store_n(&g_left[slot], 1, __ATOMIC_RELEASE);
    inputs_changed();
    fprintf(stderr, "[netplay] player %d left; their pad is neutral from now on\n", slot);
}

/* For the page's status line: last frame, total ms spent waiting for others, first desync frame, stalls, and
   whether the game is waiting for other players' input right now (the page's watchdog leaves that alone), and
   the delay our inputs go out with now. */
EXPORT uint32_t netplay_status(int what) {
    switch (what) {
    case 0: return __atomic_load_n(&g_frame, __ATOMIC_RELAXED);
    case 1: return g_wait_ms;
    case 2: return g_desync_frame;
    case 3: return g_stalls;
    case 4: return __atomic_load_n(&g_blocked, __ATOMIC_RELAXED);
    case 5: return (uint32_t)__atomic_load_n(&g_np_lead, __ATOMIC_RELAXED);
    default: return 0;
    }
}
