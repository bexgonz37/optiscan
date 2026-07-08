# OptiScan — Live 0DTE Options & Share Momentum Scanner

OptiScan is a self-hosted, chrome-noir **live trading terminal** that watches the market in real time, ranks what's moving, and fires **research signals** when strict gates pass. It **never places orders** — signals only.

Two products run in parallel:

| Product | Tab | Session (ET) | Callout type | Discord channel |
|---------|-----|--------------|--------------|-----------------|
| **Options** | Options | 9:30 AM–4:00 PM (RTH) | **BUY CALL / BUY PUT** on 0DTE contracts | `#options-callouts` |
| **Market** | Market | 4:00 AM–9:30 AM + 4:00 PM–8:00 PM | **LONG / SHORT** share momentum | `#stock-callouts` |

Data comes from [Polygon / Massive](https://polygon.io/) (one API key covers stocks + options). Alerts persist to local SQLite, track outcomes automatically, and can ping Discord with separate webhooks per product.

## The core contract

Three rules define this product (full spec: [docs/PRD.md](docs/PRD.md)):

1. **Speed** — watch how fast every name is moving in **% per minute**; past the tunable threshold (`SCANNER_MIN_RATE_PCT_MIN`, or Settings → Capture thresholds), it triggers.
2. **Discord** — a passing TRADE-tier trigger is sent to the product's Discord webhook. Always.
3. **Spread** — an options callout must have a fillable spread (`TRADE_MAX_SPREAD_PCT`, default 5%). Spread too wide → it is never posted as a BUY, no matter how fast the tape is.

Nothing in the codebase may bypass these three gates.

---

## Table of contents

- [Quick start](#quick-start)
- [Pages & UI](#pages--ui)
- [Market sessions](#market-sessions)
- [How the scanner works](#how-the-scanner-works)
- [Discord setup](#discord-setup)
- [Environment variables](#environment-variables)
- [Settings you control in the UI](#settings-you-control-in-the-ui)
- [API reference](#api-reference)
- [Alerts, tracking & accuracy](#alerts-tracking--accuracy)
- [Run 24/7 (VPS)](#run-247-vps)
- [Local development](#local-development)
- [Tests](#tests)
- [Deployment notes](#deployment-notes)
- [Project structure](#project-structure)
- [Disclaimer](#disclaimer)

---

## Quick start

### Requirements

- **Node.js 22+** (uses the built-in test runner)
- **Polygon / Massive API key** — free tier works for UI dev (15-min delayed); **real-time Stocks + Options** plan required for live 0DTE scanning
- Windows, macOS, or Linux

### Install & run

```bash
git clone https://github.com/bexgonz37/optiscan.git
cd optiscan
npm install

# Copy env template and add your key (no space after =)
cp .env.local.example .env.local   # macOS/Linux
copy .env.local.example .env.local # Windows
```

Edit `.env.local`:

```bash
POLYGON_API_KEY=your_key_here
STOCK_CALLOUTS=1
DISCORD_WEBHOOK_OPTIONS=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_STOCKS=https://discord.com/api/webhooks/...
```

```bash
npm run dev
```

Open **http://localhost:8780**.

Without a Polygon key the UI loads and explains what's missing. With a key the live tape fills; with a **paid real-time** key the 1-second scanner loop runs.

### First-time checklist

1. Open **Settings** → turn **Discord alerts** **On**
2. Turn **Extended-hours Discord** **On** if you want premarket/after-hours stock pings
3. Hit **Test options webhook** and **Test stocks webhook** — each should land in its own channel
4. On the **Live** page, use the **Options / Market** toggle to switch products
5. Click any symbol to open the chart drawer (lazy-loaded for speed)

---

## Pages & UI

| Route | Purpose |
|-------|---------|
| `/` | **Live** — hero callout, 3-column scanner, recent callouts, Options/Market toggle |
| `/alerts` | **Alerts dashboard** — KPIs, scoreline, donut chart, ledger, filters |
| `/settings` | Language mode, capture thresholds, Discord toggles, webhook tests |
| `/alert-lab` | Deep alert lab (history, journal, weekly report) |
| `/scanner` | Legacy scanner dashboard |
| `/review` | How the system works + honest limits |
| `/guide` | Beginner guide |

### Live page features

- **Options / Market tabs** — separate products, separate Discord routing, separate recent-callout lists
- **Scanners** — three ranked columns (speed, volume, level breaks) with stable row order (20s refresh; **Hold** freezes layout)
- **Sort** — speed, volume surge, % move, level break, symbol
- **Chart drawer** — click any row; candles load first, verdict/options chain deferred for responsiveness
- **Closed market** — when the session is `closed`, shows Polygon snapshot gainers/losers (refreshed every 60s) with normalized day-change math
- **SSE stream** — `/api/scanner/stream` with poll fallback; UI debounces tape updates (~1.2s) so rows don't jump every tick

### Chrome-noir design

Dark terminal aesthetic, green Robinhood-style shine on display type, mobile bottom nav, theme toggle (light/dark in localStorage).

---

## Market sessions

All times are **US/Eastern** (DST-safe). Weekends = `closed`. Exchange holidays are not modeled (flat tape → nothing triggers — safe default).

| Session | Time (ET) | Options tab | Market tab | New callouts |
|---------|-----------|-------------|------------|--------------|
| **Premarket** | 4:00–9:30 AM | Opening watch (underlying momentum only; no executable contracts yet) | Share momentum **LIVE** | Stocks only (if `STOCK_CALLOUTS=1`) |
| **Regular** | 9:30 AM–4:00 PM | 0DTE options **LIVE** — BUY CALL/PUT | Share momentum **LIVE** | Options + stocks |
| **After hours** | 4:00–8:00 PM | Closed (last RTH callout shown as historical) | Share momentum **LIVE** | Stocks only |
| **Closed** | Otherwise | Snapshot recap movers | Snapshot recap movers | None (tracker finishes open alerts) |

---

## How the scanner works

### Architecture

```
Browser (Live UI, SSE/poll ~1s)
  └─ /api/scanner/stream  ─┐
  └─ /api/scanner/live    ─┤ scanner-loop.ts (1s heartbeat)
                           │
                           ├─ Regular session:
                           │    bulk snapshot → per-symbol ring buffer
                           │    → acceleration, volume surge, path efficiency
                           │    → shouldTrigger() → 0DTE chain fetch (gated)
                           │    → alert-capture.ts → SQLite + Discord
                           │
                           ├─ Extended hours (STOCK_CALLOUTS=1):
                           │    parallel stock-signals path → stock-capture.ts
                           │
                           └─ Closed session:
                                fetchTopMovers(gainers/losers) → recap tape
                                normalizeDayChangePercent() for accurate %
```

### 0DTE options engine (`lib/scanner-loop.ts`, `lib/zero-dte.js`)

- **Every-second loop** (`SCANNER_LOOP_MS`, default 1000ms) over a liquid 0DTE universe (~35 core symbols + discovery promotions)
- **One bulk snapshot** per tick — per-symbol ring buffer (~6 min of ticks) computes speed, acceleration, volume surge, HOD/LOD/VWAP
- **Chains fetched only on trigger** — never wholesale; prefetched when near-trigger
- **Active alerts** re-quote every ~7s (`SCANNER_ACTIVE_REFRESH_MS`)
- **429 backoff** — doubles interval up to 60s, then decays
- **Discovery lane** — every 30s snapshots ~243 symbols, promotes top movers into the fast loop for 5 min

### Share momentum engine (`lib/stock-signals.ts`, `lib/stock-capture.ts`)

- Runs in **premarket + after-hours** (and RTH when `STOCK_CALLOUTS=1`)
- LONG/SHORT share callouts — no option chains
- Separate cooldowns, scoring, and Discord routing from options
- Requires `STOCK_CALLOUTS=1` in env **and** `DISCORD_WEBHOOK_STOCKS` for Discord (no fallback to options webhook)

### Day-change accuracy (`lib/polygon-provider.js`)

Polygon's raw `todaysChangePerc` can be wrong when:

- **Spin-offs / listing days** — prev close is an accounting stub (e.g. MFP spin-off: prev $6.59, open $35.50 → real session move ~+3%, not +455%)
- **After-hours prints** — last trade above official session close inflates the %

OptiScan normalizes using:

1. **Session close** (`day.c`) vs **prev close** when available
2. **Open-to-close** when open and prev close aren't comparable (ratio ≥2.5× or ≤0.4×)
3. **Warrant filter** — class shares (`.WS`, `.W` suffix, sub-$0.50) removed from closed recap

### Signal gates (defaults — tunable in Settings)

| Gate | Default | Meaning |
|------|---------|---------|
| `scannerMinRatePctMin` | 0.2 | Min \|%/min\| 15s velocity |
| `scannerMinVolSurge` | 1.4 | Min volume-surge ratio (30s window) |
| `scannerMinEfficiency` | 0.35 | Path efficiency (trend vs chop) |
| `scannerMinLevelSurge` | 1.2 | Level-break confirmation |
| `tradeMaxSpreadPct` | 5 | BUY requires contract spread ≤ this |
| `stockMinScore` | 66 | Min score for share callouts |

**Hard rule:** signal/gate math in `trade-verdict.ts`, `alert-capture.ts`, `zero-dte.js`, and scanner trigger thresholds should not be changed casually — they're audited and unit-tested.

---

## Discord setup

Discord is **built but disabled by default**. Enable in Settings after setting webhooks in `.env.local`.

### Webhook env vars

| Variable | Channel | Used for |
|----------|---------|----------|
| `DISCORD_WEBHOOK_OPTIONS` | `#options-callouts` | 0DTE BUY CALL/PUT during RTH |
| `DISCORD_WEBHOOK_STOCKS` | `#stock-callouts` | Share LONG/SHORT (extended hours + RTH) |
| `DISCORD_WEBHOOK_RECAP` | `#track-record` | Optional daily scoreboard |
| `DISCORD_WEBHOOK_URL` | Legacy fallback | Options only if `DISCORD_WEBHOOK_OPTIONS` unset |

**Stocks never fall back to the options webhook** — if `DISCORD_WEBHOOK_STOCKS` is missing, stock alerts are skipped and logged.

### Settings toggles

| Toggle | Effect |
|--------|--------|
| Discord alerts | Master on/off |
| Extended-hours Discord | Premarket/AH stock pings (default off) |
| Manual confirm | Queue payloads for approval before send (default off) |
| Public mode | Education-safe wording enforced at runtime |

### Message behavior

- **BUY embeds** — options and stocks use separate embed builders (`lib/alert-format.ts`)
- **WATCH posts** — quiet, no role mention, deduped per ticker per 30 min
- **Checkpoint PATCH** — same Discord message updated at 5m/10m milestones
- **Banned-phrase checker** — public payloads with directive trading language are refused (`lib/language-modes.js`)

### Test from Settings or API

```bash
curl -X POST http://localhost:8780/api/notifications/discord/test?kind=options
curl -X POST http://localhost:8780/api/notifications/discord/test?kind=stocks
```

---

## Environment variables

Copy `.env.local.example` → `.env.local`. Full list:

### Required for live scanning

```bash
POLYGON_API_KEY=           # No space after =
```

### Discord (server-side only — never exposed to browser)

```bash
DISCORD_WEBHOOK_OPTIONS=
DISCORD_WEBHOOK_STOCKS=
DISCORD_WEBHOOK_RECAP=     # optional
DISCORD_WEBHOOK_URL=       # legacy options fallback
DISCORD_ROLE_0DTE=         # optional @role on BUY pings
DISCORD_ROLE_STOCKS=
PUBLIC_APP_URL=            # embed footer links
STOCK_CALLOUTS=1           # enable share-momentum engine
```

### Scanner loop (0DTE real-time)

```bash
SCANNER_LOOP_MS=1000
SCANNER_ACTIVE_REFRESH_MS=7000
SCANNER_TRIGGER_COOLDOWN_MS=600000
SCANNER_DISCOVERY_MS=30000
SCANNER_DISCOVERY_TOP_N=20
SCANNER_0DTE_UNIVERSE=SPY,QQQ,IWM,TSLA,NVDA
SCANNER_0DTE_UNIVERSE_EXTRA=SPCX
SCANNER_MIN_RATE_PCT_MIN=0.2
SCANNER_MIN_VOL_SURGE=1.4
TRADE_MAX_SPREAD_PCT=5
```

### Legacy scan API (momentum + unusual activity tabs)

```bash
RADAR_SHORTLIST=12
SCAN_CONCURRENCY=4
SCAN_CACHE_MS=15000
SCAN_INCLUDE_MOVERS=1
OPTIONS_CHAIN_MAX_PAGES=4
```

### Security

```bash
SCAN_API_TOKEN=            # Optional quota lock on /api/scan/* and related routes
```

Browser: `localStorage.setItem("optiscan:token", "<same value>")` once in the console.

### Alert Lab

```bash
ALERT_LAB_ENABLED=1
ALERT_MIN_MOMENTUM_SCORE=65
ALERT_MIN_UNUSUAL_SCORE=80
ALERT_TRACK_INTERVAL_MS=60000
ALERT_FP_MIN_FAVORABLE_PCT=1.5
ALERT_DB_DIR=              # default ./data
```

---

## Settings you control in the UI

`/settings` persists to SQLite (`notification_settings`, `app_settings`):

- **Language mode** — Private (trader labels) vs Public (education-safe)
- **Capture thresholds** — min speed, volume surge, acceleration, efficiency, level surge, max spread, stock min score
- **Discord** — master toggle, extended-hours stocks, manual confirm, test buttons per webhook
- **Desktop alerts** — browser notification permission (stored in localStorage prefs)

---

## API reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Provider status, key present |
| `/api/scanner/live` | GET | Full loop state + tape |
| `/api/scanner/stream` | GET | SSE live tape stream |
| `/api/scan/momentum` | GET | Ranked momentum signals (cached) |
| `/api/scan/unusual` | GET | Unusual activity hits (cached) |
| `/api/scan/[symbol]` | GET | Single-symbol detail + verdict preview |
| `/api/options/[ticker]` | GET | 0DTE chain reality check |
| `/api/candles/[symbol]` | GET | OHLCV bars for chart drawer |
| `/api/alerts` | GET/POST | List / manual alert |
| `/api/alerts/[id]` | GET | Single alert detail |
| `/api/alerts/stats` | GET | Dashboard KPIs |
| `/api/alerts/performance` | GET | Hit-rate analytics |
| `/api/alerts/track` | GET | Run checkpoint sweep (cron fallback) |
| `/api/notifications/settings` | GET/PATCH | Discord + threshold settings |
| `/api/notifications/discord/test` | POST | `?kind=options\|stocks` |
| `/api/trade-journal` | GET/POST | Personal trade log |

Most routes require `SCAN_API_TOKEN` (when set) via the `x-scan-token` header or `Authorization: Bearer`. Query-string `?token=` is **not** accepted — URL tokens leak into access logs and Referer headers. Generate a token with `openssl rand -hex 24` and set it in both `.env.local` (dev) and `.env.production` (VPS).

---

## Alerts, tracking & accuracy

Every TRADE callout is persisted to **`data/optiscan.db`** (better-sqlite3, zero-config).

### Automatic tracking

- Sweeper runs every 60s (`instrumentation.ts` in production, `server-boot.ts` on first API hit in dev)
- Checkpoints at **5m / 15m / 30m / 1h / EOD** from Polygon minute candles
- Stores favorable move, max move, drawdown, option return %
- **False positive** at EOD if never moved ≥1.5% favorably and closed against signal

### Catalysts

- Classified from real Polygon news headlines (same API key)
- Quality: strong / medium / weak / unknown
- **Context only** — never gates or suppresses a signal

### Accuracy audits

```bash
node scripts/audit-accuracy.mjs
node scripts/calibrate-accuracy.mjs   # suggests threshold tweaks toward ≥70% early hit-rate
```

### Scores & explanations

- Setup / Risk / Liquidity formulas: `lib/alert-scoring.js`
- Full component breakdown stored as `score_breakdown_json`
- Deterministic explanations: `lib/explain.js` (rules-based, no model calls)
- Option outcome grading: `computeOptionOutcome` on order accuracy

---

## Run 24/7 (VPS)

Your PC cannot scan when it's off. Run OptiScan on a **$6/mo Linux VPS** so callouts fire from 4 AM–8 PM ET even when you're away.

**Full walkthrough:** [`docs/VPS.md`](docs/VPS.md)

### TL;DR

```bash
# On the VPS
git clone https://github.com/bexgonz37/optiscan.git /opt/optiscan
bash /opt/optiscan/scripts/vps-setup.sh
nano /opt/optiscan/.env.production   # keys + both Discord webhooks + STOCK_CALLOUTS=1
docker compose up -d --build
```

Access via SSH tunnel:

```powershell
ssh -L 8780:localhost:8780 root@YOUR_DROPLET_IP
```

Scanner + alert tracker start at **process boot** — no browser visit needed.

---

## Local development

```bash
npm run dev      # http://localhost:8780, hot reload
npm run build    # production build
npm run start    # production server on :8780
npm test         # 214 unit tests (Node 22+)
npx tsc --noEmit # typecheck
```

### Verify everything works

```bash
curl http://localhost:8780/api/health
curl http://localhost:8780/api/scanner/live?realtimeOnly=1
curl http://localhost:8780/api/notifications/settings
```

### Rate limits (Polygon free tier)

~5 calls/min, 15-min delayed data. The 1s scanner loop will back off on 429s. For real 0DTE:

- Upgrade to **Stocks + Options Advanced** (real-time)
- Keep `RADAR_SHORTLIST` small on free tier (4–6)
- Poll at 120s if using legacy scan endpoints

Each shortlisted symbol in a full scan ≈ 2 provider calls (candles + chain). Default shortlist 12 ≈ 27+ calls per scan.

### Dev server tips

- If port 8780 hangs or returns 500: kill the process, delete `.next`, restart `npm run dev`
- Run dev in your own terminal if background restarts corrupt the build cache
- `POLYGON_API_KEY` must have **no space** after `=`

---

## Tests

```bash
npm test
```

**214 tests** covering:

- Polygon response parsers + day-change normalization (spin-off guard, session close)
- Momentum / options scoring and contract ranking
- Zero-DTE trigger math and speed persistence
- Unusual-activity detector
- Language-mode banned-phrase enforcement
- Cache promise dedup
- Option chain pagination

No extra test dependencies — Node's built-in runner only.

---

## Deployment notes

- **Single instance only** — cache and SQLite are process-local
- Do **not** deploy multi-instance serverless (each lambda runs its own scan → N× Polygon quota)
- Do **not** add Redis — run one `next start` or one Docker container
- Production boot starts scanner via `instrumentation.ts` → `lib/server-boot.ts`
- SQLite volume in Docker: `/opt/optiscan/data` survives rebuilds

### Docker

```bash
docker compose up -d --build
docker compose logs -f --tail 50
```

---

## Project structure

```
optiscan/
├── app/                    # Next.js App Router pages + API routes
│   ├── page.tsx            # Live (home)
│   ├── alerts/             # Alerts dashboard
│   ├── settings/           # Settings + Discord tests
│   └── api/                # REST + SSE endpoints
├── components/             # React UI (OptiscanLiveView, ChartPanel, …)
├── lib/
│   ├── scanner-loop.ts     # 1s 0DTE heartbeat + closed recap
│   ├── stock-capture.ts    # Share momentum callouts
│   ├── alert-capture.ts    # Options callout persistence
│   ├── polygon-provider.js # Polygon client + day-change normalization
│   ├── notifications.ts    # Discord multi-webhook routing
│   ├── zero-dte.js         # Trigger math + contract ranking
│   └── trading-session.ts  # ET session engine
├── data/                   # SQLite (gitignored)
├── docs/VPS.md             # 24/7 deployment guide
├── scripts/                # VPS setup, accuracy audits
└── tests/                  # Unit tests (*.test.mjs)
```

---

## Health & monitoring

`/api/health` returns deep liveness info and **HTTP 503** when the scanner
loop is stalled (no tick within 3× its interval) during a non-closed session —
point uptime monitors and the Docker healthcheck at it.

Disclosure choice (documented per audit): when `SCAN_API_TOKEN` is set,
unauthenticated callers get a **shallow** body (ok, provider, keyPresent,
loopRunning, lastTickAgeMs, session, quotaExceeded — no error strings or
counters). Requests with the token (or any request when no token is
configured) get full stats: `ticks/triggers/alerts/errors/intervalMs/note`,
`callsToday`/`callsThisMinute` vs `dailyCap`/`minuteCap`, and `dbWritable`.

Polygon spend is hard-capped by a central call meter
(`POLYGON_DAILY_CALL_CAP`, `POLYGON_MINUTE_CALL_CAP`); at the cap requests
short-circuit with a typed `quota_exceeded` and the loop backs off like a 429.
Near the minute cap, non-critical calls (news enrichment, warm chain prefetch)
defer automatically — trigger-path fetches never defer.

"Why didn't it alert?" — near-trigger symbols that fail a gate leave a trace
(which gate, values vs. thresholds) in `nearMisses` on `/api/scanner/live`.

## Disclaimer

- **Signals only.** OptiScan never places orders. Always verify quotes in your broker.
- **Not financial advice.** Grades and scores are heuristics — not backtested edge.
- **Entry = quote midpoint.** Real fills can be worse, especially on wide spreads.
- **Delayed data** on free Polygon tiers makes 0DTE practice/logging only.
- **Webhook URLs are secrets.** Never commit `.env.local`. Rotate if leaked.

---

## License

Private project. All rights reserved.
