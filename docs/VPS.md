# OptiScan on a VPS — always-on market-hours scanning

Goal: OptiScan runs 24/7 on a cheap Linux box so callouts fire (and Discord
pings you) from 4:00 AM ET premarket through 8:00 PM ET after-hours, even with
your PC off. Single instance only — the cache and SQLite are process-local by
design (see README "Deployment notes").

## 1. Create the VPS (~$6/mo)

DigitalOcean (or Hetzner — same idea):

1. Create account → **Create → Droplet**
2. Image: **Ubuntu 24.04 LTS**
3. Size: **Basic → Regular → $6/mo (1 GB RAM / 1 vCPU)** — plenty; the build
   briefly needs swap on 1 GB (the setup script handles it via Docker build).
   If the Docker build is OOM-killed, resize to 2 GB once, build, resize back.
4. Auth: **SSH key** (recommended) — paste your public key. On Windows:
   `type $env:USERPROFILE\.ssh\id_ed25519.pub` (or create one: `ssh-keygen -t ed25519`)
5. Create, note the droplet IP.

## 2. Bootstrap (one command)

SSH in and run the bootstrap:

```bash
ssh root@YOUR_IP
curl -fsSL https://raw.githubusercontent.com/bexgonz37/optiscan/main/scripts/vps-setup.sh | bash
```

Private repo note: `curl` from raw.githubusercontent.com needs a token for a
private repo. Easiest instead:

```bash
apt-get update && apt-get install -y git
git clone https://YOUR_GITHUB_USERNAME:YOUR_PAT@github.com/bexgonz37/optiscan.git /opt/optiscan
bash /opt/optiscan/scripts/vps-setup.sh
```

(Create the PAT at github.com → Settings → Developer settings → Fine-grained
tokens → repo: optiscan, Contents: Read.)

When prompted, edit the env file:

```bash
nano /opt/optiscan/.env.production
```

Set at minimum:

- `POLYGON_API_KEY` — your Massive/Polygon key (top-tier real-time plan). **No space after `=`**
- `SCAN_API_TOKEN` — long random string: `openssl rand -hex 24`
- `STOCK_CALLOUTS=1` — enables share-momentum callouts (Market tab / extended hours)
- `DISCORD_WEBHOOK_OPTIONS` — Discord webhook for **0DTE BUY CALL/PUT** pings (regular hours)
- `DISCORD_WEBHOOK_STOCKS` — Discord webhook for **share momentum LONG/SHORT** pings
- `DISCORD_WEBHOOK_URL` — optional legacy fallback (same as options if you prefer one var)
- `PUBLIC_APP_URL=https://your-tunnel-or-domain` — used in Discord embed links (optional)

Example `.env.production`:

```bash
POLYGON_API_KEY=your_key_here
SCAN_API_TOKEN=your_long_random_token
STOCK_CALLOUTS=1
DISCORD_WEBHOOK_OPTIONS=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_STOCKS=https://discord.com/api/webhooks/...
PUBLIC_APP_URL=https://optiscan.yourdomain.com
NODE_ENV=production
```

After first boot, open Settings (via SSH tunnel) and turn **Discord alerts** and **Extended-hours Discord** **On** if you want premarket/after-hours stock pings.

Then the script runs `docker compose up -d --build`.

## 3. Verify

```bash
curl http://localhost:8780/api/health          # -> ok
docker compose -f /opt/optiscan/docker-compose.yml logs -f --tail 50
# expect: "[optiscan] scanner + alert tracker started at process boot"
#         "[0dte-loop] running every 1000ms over N symbols"
```

The scanner + alert tracker start at process boot (instrumentation.ts) — no
browser visit needed. SQLite lives in `/opt/optiscan/data` which is a compose
volume, so alert history survives rebuilds/restarts:

```bash
docker compose restart && sleep 5 && curl -s localhost:8780/api/alerts/stats | head -c 200
```

## 4. Secure access (do NOT expose 8780 to the world)

Option A — SSH tunnel (simplest). On your PC:

```powershell
ssh -L 8780:localhost:8780 root@YOUR_IP
```

then open http://localhost:8780. Keep the firewall closed:

```bash
ufw allow OpenSSH && ufw enable        # only port 22 open
```

Option B — Cloudflare Tunnel (access from phone, no open ports):

```bash
# on the VPS
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cf.deb && dpkg -i cf.deb
cloudflared tunnel login
cloudflared tunnel create optiscan
cloudflared tunnel route dns optiscan scanner.yourdomain.com
cat > /etc/cloudflared/config.yml <<CFG
tunnel: optiscan
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: scanner.yourdomain.com
    service: http://localhost:8780
  - service: http_status:404
CFG
cloudflared service install && systemctl start cloudflared
```

Put Cloudflare Access (Zero Trust → Applications) in front for real auth.

Either way, set the token once in the browser console:
`localStorage.setItem("optiscan:token", "YOUR_SCAN_API_TOKEN")`

## 5. Keepalive + auto-restart

Docker restarts the container on crash/boot (`restart: unless-stopped` in
docker-compose.yml). Optional watchdog cron that restarts on failed health:

```bash
crontab -e
# health probe every 5 min; restart if dead
*/5 * * * * curl -sf http://localhost:8780/api/health >/dev/null || (cd /opt/optiscan && docker compose restart)
```

## 6. Updating to a new version

```bash
cd /opt/optiscan && git pull --ff-only && docker compose up -d --build
```

## 7. What runs when (sessions are US/Eastern, weekends off)

| Session     | Time (ET)        | Callouts                                  |
|-------------|------------------|-------------------------------------------|
| Premarket   | 4:00 AM–9:30 AM  | **Stocks** — BUY LONG / BUY SHORT (shares) |
| Regular     | 9:30 AM–4:00 PM  | **0DTE options** — BUY CALL / BUY PUT      |
| After hours | 4:00 PM–8:00 PM  | **Stocks** — BUY LONG / BUY SHORT (shares) |
| Closed      | otherwise        | none — scanning paused, tracker finishes open alerts |

Discord: options TRADE alerts during RTH (existing bar: ≥82% confidence,
≥0.2%/min aligned speed); stock BUY alerts in premarket/after-hours with
stock wording (no contract line). Everything is research language — OptiScan
never places orders.

## 8. Accuracy audits

Run inside the container (or any checkout with the data volume):

```bash
cd /opt/optiscan
docker compose exec optiscan node scripts/audit-accuracy.mjs
docker compose exec optiscan node scripts/calibrate-accuracy.mjs
```

`calibrate-accuracy.mjs` suggests threshold changes toward the ≥70% early
hit-rate target; apply them in Settings → Capture thresholds.
