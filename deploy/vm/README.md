# Test site on a VM

`setup.sh` hosts a **test version** of this site on a Linux VM. It serves the page with the stand-in engine
(`tests/web/fake-engine`) instead of the game, so you can try the launcher, saves, patches, rosters and online
play over the internet, and check that a change still works before it goes anywhere else. It never installs game
files or a game engine build, and a banner on every page says it's a test site.

## What you need

- A Linux VM: Ubuntu, Debian, Oracle Linux or another distribution with `apt-get` or `dnf`, on an x86-64 or
  ARM (Ampere) CPU.
- A domain name whose DNS you control.

## Set up

1. **DNS**: point a name at the VM's public IP with an `A` record. On Cloudflare, set it to "DNS only" (grey
   cloud), so Caddy can get its own HTTPS certificate.
2. **Cloud firewall**: allow TCP 80 and 443 in. On Oracle Cloud, add two ingress rules to the VCN's security list
   (source `0.0.0.0/0`, TCP, destination ports 80 and 443). The script opens them in the VM's own firewall itself.
3. **Run the script** on the VM:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/ethereaglehq/cricket07-browser/main/deploy/vm/setup.sh -o setup.sh
   sudo bash setup.sh cricket.example.com          # optionally a branch: sudo bash setup.sh cricket.example.com main
   ```

   It ends by checking that both servers answer. The first visit can take a minute while Caddy gets the
   certificate.

**A VM that already serves other sites on 80/443:** run it with `CRICKET07_LISTEN=127.0.0.1:8017`. The site
then listens only there, over plain HTTP, and the script changes no firewall. Put the domain in front of it
with the existing web server or a Cloudflare Tunnel, forwarding everything to `http://127.0.0.1:8017`,
WebSocket upgrades included (online play uses them on `/netplay/`).

## Update, logs, remove

- **Update** to the newest code of the branch: run the same command again, with the same `CRICKET07_LISTEN` if
  you used one.
- **Logs:** `journalctl -u cricket07-web -u cricket07-rooms -f`
- **Remove:**

  ```sh
  sudo systemctl disable --now cricket07-web cricket07-rooms
  sudo rm -rf /etc/systemd/system/cricket07-*.service /opt/cricket07 /var/lib/cricket07 /etc/cricket07 /usr/local/bin/caddy
  sudo userdel cricket07
  ```

## What it installs

- **Node 22 and Caddy**, each checked against the checksum written in the script.
- **wrangler**, which runs the room server (`server/`). It installs exactly the packages in
  `tools/package-lock.json`, checked against its hashes, and runs none of their install scripts.
- **Two services:**
  - `cricket07-web`: Caddy, the page and HTTPS.
  - `cricket07-rooms`: the room server, on 127.0.0.1:8787 behind Caddy.

  Both run as the unprivileged user `cricket07` in a systemd sandbox. They can write only to
  `/var/lib/cricket07`, see nothing in `/home`, and can't gain privileges.
- **The room server's ticket secret:**
  - Made on the VM, in `/etc/cricket07/netplay-secret`.
  - Readable by root and the service alone.
  - Kept out of command lines and the repository.

See [SECURITY.md](../../SECURITY.md) for more.
