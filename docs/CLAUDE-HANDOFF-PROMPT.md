# Claude Handoff Prompt — OptiScan VPS + Stocks Mode

Copy everything below the line into Claude or a new Cursor agent chat.

---

## CRITICAL — correct repo folder (read first)

**GitHub repo:** https://github.com/bexgonz37/optiscan (private)

**ONLY work in this local folder:**
```
C:\Users\bexgo\Downloads\optiscan-main
```

**DO NOT use** `C:\Users\bexgo\optiscan` — that is an **old stale clone** (missing early-accuracy, Docker, VPS scripts, signal gates).

**Before writing any code, verify you are in the right place:**
```powershell
cd C:\Users\bexgo\Downloads\optiscan-main
git log -1 --oneline
```
Must show commit **58dae80** or newer (e.g. `docs: add Claude handoff prompt`).

**These files MUST exist** (if missing, you are in the wrong folder):
- `lib/early-accuracy.ts`
- `docker-compose.yml`
- `scripts/vps-setup.sh`
- `CLAUDE-PROMPT.txt`

If using Cursor: **File → Open Folder →** `C:\Users\bexgo\Downloads\optiscan-main` before starting.

---

You are working on **OptiScan**, a Next.js 15 trading scanner.

The user is on the **top-tier Massive/Polygon plan** (real-time). Deploy to a VPS, audit and improve the app, and add regular-stocks mode with session-based routing.

## Part 1 — VPS deployment (do this first)

Deploy OptiScan to an always-on Linux VPS (~$6/mo DigitalOcean or Hetzner Ubuntu 24.04).

**Already in repo (commit 073d80c):**
- Dockerfile, docker-compose.yml, env.production.example
- scripts/vps-setup.sh — one-command bootstrap
- instrumentation.ts starts scanner + alert tracker on boot
- Port 8780, SQLite at data/optiscan.db

**Tasks:**
1. Guide user through VPS creation (or use credentials if provided)
2. SSH in, run: curl -fsSL https://raw.githubusercontent.com/bexgonz37/optiscan/main/scripts/vps-setup.sh | bash
3. Configure /opt/optiscan/.env.production: POLYGON_API_KEY, SCAN_API_TOKEN, DISCORD_WEBHOOK_URL
4. docker compose up -d --build
5. Verify: curl http://localhost:8780/api/health
6. Secure access: SSH tunnel (ssh -L 8780:localhost:8780 root@IP) or Cloudflare Tunnel — do NOT expose 8780 publicly without auth
7. Add docs/VPS.md with steps
8. Optional cron: */5 * * * * curl -sf http://localhost:8780/api/health

**Deployment audit:**
- Scanner loop + alert tracker start without browser visit
- Discord sends on clear TRADE signals
- SQLite persists across restarts
- Run node scripts/audit-accuracy.mjs and node scripts/calibrate-accuracy.mjs

## Part 2 — Audit & improve options scanner

Key files: lib/scanner-loop.ts, lib/zero-dte.js, lib/alert-capture.ts, lib/trade-verdict.ts, lib/early-accuracy.ts, lib/alert-store.ts, app/alert-lab/page.tsx, components/AppNav.tsx

Recent work: early-move accuracy @ 1m/5m, tighter signal gates, capture_action in DB. Target: 70% early hit rate @ 5m on TRADE-at-capture callouts while keeping volume high.

Checklist: callouts fire appropriately, accuracy KPIs honest, npm test + tsc + build pass, Docker standalone works, settings expose all thresholds. Fix bugs, implement sensible improvements.

## Part 3 — Regular stocks mode (NEW)

**Session schedule (US/Eastern):**

| Session      | Time           | Callouts              |
|-------------|----------------|------------------------|
| Premarket   | 4:00–9:30 AM   | Regular stocks only   |
| Regular     | 9:30 AM–4:00 PM| 0DTE options only     |
| After hours | 4:00–8:00 PM   | Regular stocks only   |
| Closed      | otherwise      | No new callouts       |

**Implement:**

1. lib/trading-session.ts — marketSession() returns premarket|regular|afterhours|closed; isOptionsSession(), isStockSession()

2. Stock scanner — reuse 1s tape (accel, surge, VWAP, HOD/LOD). No option chain in extended hours. Verdict: BUY LONG / BUY SHORT. DB fields: asset_class (stock|options), session (premarket|regular|afterhours). Migration in lib/db.ts

3. Session router in capture — stock session → stock capture only; options session → existing 0DTE capture; closed → no new alerts

4. Nav restructure (components/AppNav.tsx):
   - Top level: Options | Stocks | Alerts | Settings
   - Options: dashboard, scanner, alerts (0DTE)
   - Stocks: dashboard, scanner, alerts (premarket/after-hours)

5. Alerts UI — filter Options | Stocks | All; stock rows show LONG/SHORT not strike/DTE; separate accuracy if possible

6. Discord — stock alerts extended hours; options alerts RTH only

7. Tests — session detection with fixed ET timestamps; stock capture skips chains; options suppressed outside RTH

## Part 4 — Constraints

- Signals only, never orders
- Single VPS instance (no serverless)
- No AI in signal path
- Catalysts never block alerts
- Keep existing options accuracy working
- npm test, tsc, npm run build before commit
- Push to main on github.com/bexgonz37/optiscan

## Part 5 — Deliverables

1. VPS URL / SSH instructions
2. Audit fixes summary
3. Nav map before/after
4. Session schedule table
5. How to test premarket vs RTH (dev simulation)
6. Git commit SHAs

Start by reading README, lib/trading-session.ts, components/AppNav.tsx, lib/scanner-loop.ts. Ask user for VPS IP and keys only if blocked.
