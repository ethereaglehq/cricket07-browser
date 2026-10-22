/* Forced include (-include, see run.sh) for building host/netplay.c once per simulated player: everything it
 * defines, and the callbacks it calls (getenv for its settings, the pad and key it applies), gets the player's
 * prefix (p0_, p1_), so two copies with their own globals link into one program. */
#define NP_CAT2(a, b) a##b
#define NP_CAT(a, b) NP_CAT2(a, b)
#define NP_PEER(name) NP_CAT(NP_CAT(p, PEER), NP_CAT(_, name))

#define netplay_on NP_PEER(netplay_on)
#define netplay_frame_dt_us NP_PEER(netplay_frame_dt_us)
#define netplay_local_pad NP_PEER(netplay_local_pad)
#define netplay_frame NP_PEER(netplay_frame)
#define netplay_pop NP_PEER(netplay_pop)
#define netplay_msg NP_PEER(netplay_msg)
#define netplay_remote_input NP_PEER(netplay_remote_input)
#define netplay_remote_hash NP_PEER(netplay_remote_hash)
#define netplay_player_left NP_PEER(netplay_player_left)
#define netplay_set_delay NP_PEER(netplay_set_delay)
#define netplay_status NP_PEER(netplay_status)
#define getenv NP_PEER(getenv)
#define dinput_pad NP_PEER(dinput_pad)
#define input_key_usage_sync NP_PEER(input_key_usage_sync)
