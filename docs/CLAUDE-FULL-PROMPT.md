# FULL PROMPT — Copy everything below this line into Claude

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
Must show commit **17778aa** or newer.

**These files MUST exist** (if missing, you are in the wrong folder):
- `lib/early-accuracy.ts`
- `docker-compose.yml`
- `scripts/vps-setup.sh`
- `scripts/audit-accuracy.mjs`
- `scripts/calibrate-accuracy.mjs`

If using Cursor: **File → Open Folder →** `C:\Users\bexgo\Downloads\optiscan-main` before starting.

---

You are working on **OptiScan**, a Next.js 15 trading scanner at https://github.com/bexgonz37/optiscan.

The user is on the **top-tier Massive/Polygon plan** (real-time). They want you to **deploy to a VPS**, **audit and improve the app**, and **add a regular-stocks mode** with session-based routing.

---

## Part 1 — VPS deployment (do this first)

Deploy OptiScan to an always-on Linux VPS (~$6/mo DigitalOcean or Hetzner Ubuntu 24.04) so it runs during market hours when the user is away from their PC.

**Already in repo:**
- `Dockerfile`, `docker-compose.yml`, `env.production.example`
- `scripts/vps-setup.sh` — one-command bootstrap
- Production boot: `instrumentation.ts` starts scanner + alert tracker on process start
- App runs on port **8780**, SQLite at `data/optiscan.db`

**Your tasks:**
1. Guide the user through creating a VPS (or use their credentials if provided)
2. SSH in, run the bootstrap script, configure `.env.production` with:
   - `POLYGON_API_KEY`
   - `SCAN_API_TOKEN` (random secure string)
   - `DISCORD_WEBHOOK_URL` (if they use Discord alerts)
3. Run: `docker compose up -d --build`
4. Verify: `curl http://localhost:8780/api/health`
5. Set up **secure access**: SSH tunnel (`ssh -L 8780:localhost:8780 root@IP`) or Cloudflare Tunnel — do NOT leave 8780 open to the world without auth
6. Document exact steps in `docs/VPS.md`
7. Add a **keepalive cron** optional: `*/5 * * * * curl -sf http://localhost:8780/api/health >/dev/null`

**Audit the deployment:**
- Confirm scanner loop (`lib/scanner-loop.ts`) and alert tracker (`lib/alert-tracker.ts`) start without a browser visit
- Confirm Discord sends on clear TRADE signals
- Confirm SQLite volume persists across container restarts
- Run `node scripts/audit-accuracy.mjs` and `node scripts/calibrate-accuracy.mjs` and report results

---

## Part 2 — Audit & improve existing options scanner

Review the full codebase and improve signal quality + UX. Key files:

| Area | Files |
|------|-------|
| 0DTE trigger/capture | `lib/scanner-loop.ts`, `lib/zero-dte.js`, `lib/alert-capture.ts` |
| BUY verdict | `lib/trade-verdict.ts` |
| Accuracy | `lib/early-accuracy.ts`, `lib/alert-store.ts`, `app/alert-lab/page.tsx` |
| Nav | `components/AppNav.tsx` |

**Recent work (already shipped):**
- Early-move accuracy @ 1m/5m (not peak move)
- Tighter gates: speed persistence, fake-breakout filter, capture verdict stored in DB
- Target: **≥70% early hit rate @ 5m** on TRADE-at-capture callouts (user wants high volume + quality)

**Audit checklist:**
- [ ] Are callouts firing only during appropriate conditions?
- [ ] Is accuracy KPI honest (all-tier vs TRADE-at-capture)?
- [ ] Are pre-existing tests passing? (`npm test`, `tsc`, `npm run build`)
- [ ] Any bugs in VPS/Docker standalone build?
- [ ] Settings page exposes all tunable thresholds

Fix anything broken. Propose and implement sensible improvements without over-engineering.

---

## Part 3 — Regular stocks mode (NEW — major feature)

**User's product vision (this makes sense — implement it):**

| Session | Time (US/Eastern) | What fires |
|---------|-------------------|------------|
| **Premarket** | ~4:00 AM – 9:30 AM | **Regular stock** callouts (underlying momentum — no options) |
| **Regular hours** | 9:30 AM – 4:00 PM | **0DTE options** callouts (existing system — BUY CALL/PUT) |
| **After hours** | 4:00 PM – ~8:00 PM | **Regular stock** callouts (underlying momentum — no options) |

Options should **not** be the primary callout outside RTH (spreads, no 0DTE liquidity, theta irrelevant). Stocks can move in premarket/after-hours on news and volume — that's when stock callouts matter.

**Implement:**

1. **`lib/trading-session.ts`** — extend with:
   - `marketSession(nowMs)` → `'premarket' | 'regular' | 'afterhours' | 'closed'`
   - Helpers: `isOptionsSession()`, `isStockSession()`

2. **Stock scanner loop** (new or extend `lib/scanner-loop.ts`):
   - Reuse 1s underlying tape, acceleration, volume surge, VWAP, HOD/LOD
   - **No option chain fetch** in premarket/after-hours
   - Stock verdict: `BUY LONG` / `BUY SHORT` (or `BUY` / `SELL`) based on direction + speed + setup score
   - Persist alerts with new fields: `asset_class: 'stock' | 'options'`, `session: 'premarket' | 'regular' | 'afterhours'`
   - DB migration in `lib/db.ts`

3. **Session router** in capture logic:
   - If `isStockSession()` → run stock capture only (skip 0DTE chain)
   - If `isOptionsSession()` → run existing 0DTE capture (skip stock-only path)
   - If `closed` → no new callouts (tracker still runs for open alerts)

4. **Nav restructure** — top-level sections at top of nav:

   ```
   [ Options ▾ ]  [ Stocks ▾ ]  [ Alerts ]  [ Settings ]
   ```

   Or grouped tabs:
   - **Options** → Dashboard (options tape), Scanner (momentum + unusual), Options Alerts
   - **Stocks** → Stock Dashboard, Stock Scanner, Stock Alerts (premarket/after-hours)
   - Shared: Alerts accuracy (filter by asset class), Settings, Guide

   Update `components/AppNav.tsx` with a clear two-mode structure. User should instantly see whether they're in Options or Stocks mode.

5. **Alerts UI** (`app/alert-lab/page.tsx`):
   - Filter/tabs: **Options** | **Stocks** | **All**
   - Stock callouts show: ticker, direction (LONG/SHORT), move @ 1m/5m, no strike/DTE
   - Separate accuracy KPIs per asset class if data allows

6. **Discord notifications:**
   - Stock alerts in premarket/after-hours (clear wording, no option contract line)
   - Options alerts during RTH only (existing behavior)

7. **Tests:**
   - Session detection (premarket, regular, afterhours, closed — use fixed ET timestamps)
   - Stock capture does not fetch chains
   - Options capture suppressed outside RTH

---

## Part 4 — Constraints (do not break)

- **Signals only** — never place orders; research/decision-support language
- **Single VPS instance** — no multi-instance/serverless (README warns about cache + SQLite)
- **Deterministic scoring** — no AI in signal path
- **Catalysts never block** alerts (attach async after capture)
- **Existing options accuracy** must keep working
- Match existing code style; minimal focused diffs
- Run `npm test`, `tsc`, `npm run build` before committing
- Commit with clear messages; push to `main` on https://github.com/bexgonz37/optiscan

---

## Part 5 — Deliverables

When done, provide:

1. **VPS URL / SSH instructions** (or confirm deployment status)
2. **Summary of audit fixes**
3. **Nav map** (before → after)
4. **Session schedule table** (what fires when)
5. **How to test** premarket vs RTH behavior (including how to simulate sessions in dev)
6. **Git commit SHAs** pushed to main

Start by reading the repo README, `lib/trading-session.ts`, `components/AppNav.tsx`, and `lib/scanner-loop.ts`. Ask the user for their VPS IP and Polygon key only if you cannot proceed without them.

---

**End of full prompt**
