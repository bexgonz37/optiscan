# OptiScan — Options Scanner

A standalone, dark "trading terminal" web app that scans the options market for two
kinds of setups and alerts you when strong ones appear. **Signals only — it never
places orders.**

- **Momentum tab** — the best call/put on the stocks with the strongest intraday
  momentum (score, grade, target-delta contract, entry, breakeven, greeks).
- **Unusual Activity tab** — option contracts trading far above their open interest
  (volume/OI ratio), a tell for fresh, aggressive positioning.

Data comes from [Polygon / Massive](https://polygon.io/) (stocks + options from one
key). The heavy signal math is reused from the momentum-radar project; everything
here (UI, API, unusual-activity detector, caching) is new.

## Quick start

```bash
# 1. install deps
npm install

# 2. add your key
copy .env.local.example .env.local   # Windows (use cp on macOS/Linux)
#   then edit .env.local and set POLYGON_API_KEY=your_key

# 3. run
npm run dev
```

Open http://localhost:8780.

Without a key the UI loads and explains what to add; with a key both scanners fill
with live signals.

## How it works

```
Browser (dark UI, polls every 15/30/60/120s — pick in the top bar, default 30s)
  └─ /api/scan/momentum  ┐
  └─ /api/scan/unusual   ├─ runScan()  (deduped + cached)
  └─ /api/scan/[symbol]  ┘     │
                               ├─ Polygon: bulk quotes + top movers -> shortlist
                               ├─ per symbol (bounded concurrency):
                               │     candles -> buildMomentumSignal
                               │     option chain (paginated) -> buildOptionSignal + unusual detector
                               └─ ranked momentum[] + unusual[]
```

One underlying scan feeds both tabs: when the momentum and unusual endpoints hit a
cold cache at the same instant they share a single in-flight scan (promise-level
dedup), results are cached for `SCAN_CACHE_MS`, and per-symbol fan-out is capped by
`SCAN_CONCURRENCY`.

Each scan costs roughly `2 × RADAR_SHORTLIST + 3` provider calls (candles + chain
per symbol, plus bulk quotes and two movers snapshots; wide chains like SPY may add
1-3 pagination calls). With the default shortlist of 12 that's ~27+ calls per scan —
which is why sub-15s polling is pointless on anything but a high-tier plan.

## Alerts

Click **Alerts on** in the top bar to enable browser desktop notifications + a sound
whenever a new **STRONG** (score ≥ 80) signal appears in either tab. Alerts are
de-duplicated per contract so you're only pinged once.

## Configuration

All tuning is via `.env.local` — see `.env.local.example` for the full list:
scan sizing / rate-limit controls, momentum thresholds, options contract selection,
and unusual-activity thresholds.

### Rate limits

The Polygon free tier allows ~5 calls/min and returns 15-minute delayed data. Each
shortlisted symbol costs ~2 calls (candles + chain), so keep `RADAR_SHORTLIST` small
(e.g. 4-6) on the free tier, use the 120s poll setting, and raise both once you're
on a paid Stocks + Options plan for real-time data and higher throughput.

### API token (optional)

Set `SCAN_API_TOKEN` in `.env.local` and every `/api/scan/*` request must include it
(header `x-scan-token`, `Authorization: Bearer`, or `?token=`). In the browser, run
`localStorage.setItem("optiscan:token", "<your token>")` once in the console and the
UI sends it automatically. This is a quota lock, not user auth — anyone with the
token has full access. For a real public deploy put proper auth (Vercel protection,
Cloudflare Access, reverse-proxy basic auth) in front instead.

## Tests

```bash
npm test   # Node's built-in test runner, no extra dependencies (Node 22+)
```

Covers the scoring cores (momentum score, contract selection/ranking, unusual-
activity score), the Polygon response parsers, chain pagination, and the cache's
promise dedup.

## Deployment notes

The cache (and its dedup) is **process-local, in-memory**. That's exactly right for
the intended single-instance `next start`. If you deploy multi-instance or
serverless (e.g. Vercel lambdas), every instance keeps its own cache: concurrent
lambdas will each run their own full scan (N× Polygon quota), alerts' "seen" state
still lives in each browser (fine), and two users can see different scan timestamps.
Don't add Redis for this — just run it as one instance.

## Notes

- Signals only. Always verify quotes in your broker before trading.
- Grades/scores are heuristics — none of this is backtested edge.
- "Entry" is the quote midpoint; real fills can be worse, especially on wide spreads.
- Not financial advice.

## Alert Lab (/alert-lab)

Every GOOD+ momentum signal and STRONG unusual-flow hit is persisted to a local
SQLite file (`data/optiscan.db`, zero-config via better-sqlite3) and then
tracked automatically at 5min / 15min / 30min / 1hr / end-of-day. Each
checkpoint stores price, favorable-direction move, best print since the alert,
and drawdown; at EOD an alert is marked a false positive if it never moved
≥1.5% favorably AND closed against the signal (`ALERT_FP_MIN_FAVORABLE_PCT`).

- Scheduling: an in-process sweeper (started by `instrumentation.ts`) runs
  every 60s inside the normal `next dev`/`next start` process. Checkpoints are
  computed from Polygon minute candles, so downtime is backfilled on the next
  launch. On serverless (no resident process) point a cron at
  `GET /api/alerts/track` instead.
- Catalysts: classified from real Polygon news headlines (same API key);
  quality strong/medium/weak/unknown. No news + big relative volume is labeled
  an *inferred* social-momentum catalyst — nothing is fabricated.
- Scores: signal quality, risk, and options liquidity formulas are documented
  in `lib/alert-scoring.js` and unit-tested.
- API: `GET /api/alerts`, `/api/alerts/:id`, `/api/alerts/performance`,
  `/api/alerts/stats`, `/api/alerts/weekly-report`, `/api/alerts/track`,
  `POST /api/trade-journal`, `PATCH /api/trade-journal/:id` — all behind the
  same optional `SCAN_API_TOKEN` gate.
- Everything is research/logging of scanner output — no order placement and no
  recommendations, and the journal is a personal record only.

## Language modes, popups & notifications

- **Private Trading Mode / Public Education Mode** — toggled in `/settings`.
  Private shows my labels (A+ Setup, Possible Call/Put Setup); Public uses
  education-safe wording only. A banned-phrase checker
  (`lib/language-modes.js`) is enforced by tests AND at runtime: any public
  payload containing directive trading language is refused.
- **Popups** — real-time popup cards (browser popup + optional desktop
  notification + sound, all toggleable) with Watch / Journal / Mark Trade
  Taken / Snooze / Ignore / Open Chain / Details actions. Every interaction is
  logged to `popup_events` for the feedback loop.
- **Discord** — built but **disabled by default**. Webhook URL lives only in
  `DISCORD_WEBHOOK_URL` (env; never sent to the frontend). Messages are always
  Public/Education wording, re-checked for banned language at send time, and
  by default queue for **manual confirmation** in `/settings` before sending.
- **Setup / Risk / Liquidity scores** — formulas and weights are documented in
  `lib/alert-scoring.js`; every alert stores its full component breakdown
  (`score_breakdown_json`) plus deterministic private + public explanations
  (`lib/explain.js` — rules-based from real values, no model calls).
- **Pages** — `/scanner` = the home scanner, `/alerts` data lives in
  `/alert-lab` (list + filters + analytics), `/trade-journal` section inside
  Alert Lab, `/settings`, `/review` (how the system works + honest limits).

Everything remains research/decision-support: no order placement, no
recommendations, no profit claims. Not financial advice.
