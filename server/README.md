# Netplay room server

Online play needs a small server where players meet: it hands out tickets, relays the lobby, and
relays inputs when two players can't connect to each other directly. This folder is that server, as a
Cloudflare Worker with a Durable Object per room. It never sees the game: no page, no build, no files.

```bash
cd server
npx wrangler deploy
npx wrangler secret put NETPLAY_SECRET    # any random string; signs the room tickets
# optional: Cloudflare Realtime TURN, for players whose networks block direct connections
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

Then open the game page with `?netplay=https://cricket07-netplay.<your-subdomain>.workers.dev`. Both
players use the same server URL, and both must run the same build from the same game files.

In a running match, a player whose connection drops keeps their place for 3 minutes: the others' games
wait, told why, and the player's page rejoins by itself with a key only it holds. A player who leaves on
purpose or closes the page is gone at once. Settings (wrangler vars): `ALLOWED_ORIGINS`, the pages that may
use the server (comma-separated, default any); `REJOIN_GRACE_MS`, the wait for a dropped player (default
180000).
