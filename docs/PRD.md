# OptiScan — Product Requirements Document

**Version:** 1.0 (reverse-engineered from the shipped product, 2026-07)
**Owner:** Rebecca (Bex)
**Status:** Describes the system as built, plus accepted near-term requirements. Hand this to any developer joining the project — it is the source of truth for *what* OptiScan must do and *why*; the code is the source of truth for *how*.

---

## 1. Overview

OptiScan is a self-hosted, single-operator momentum scanner for US equities and same-day (0DTE) options. It watches the live tape every second, fires a small number of high-conviction callouts when a stock starts moving fast with volume confirmation, attaches a specific tradable option contract to each options callout, tracks every callout's outcome honestly, and distributes callouts to Discord and the web UI.

The product's core identity: **few, strict, verifiable callouts — never a noisy firehose.** Every alert is graded against real market data after the fact, and the track record is the product.

### The core contract (operator's own words)

> "I want it to see what's moving fast in the market, by how fast it's moving
> percentage-wise per minute. If it's moving faster than the number — and the
> number is tunable, I set it — it triggers and gets sent to the Discord. And
> for options, look at the actual option spread: if the spread is good it
> triggers; if the spread is too big, I don't want it."

Every requirement in this document serves those three sentences. Concretely:

| Operator's rule | Where it lives | The tunable number |
|---|---|---|
| **"Moving fast, percentage per minute"** | Ring-buffer velocity in `lib/scanner-loop.ts` → `shouldTrigger()` in `lib/zero-dte.js` | `SCANNER_MIN_RATE_PCT_MIN` env (default **0.17 %/min**, core names get 0.9×) or live in **Settings → Capture thresholds** — DB setting wins over env |
| **"Triggers → sent to Discord"** | Capture pipeline → `lib/notifications.ts` → per-product webhooks | `DISCORD_WEBHOOK_OPTIONS` / `_STOCKS`; toggle in Settings → Discord |
| **"Spread too big → don't want it"** | `contractEntryGate` in `lib/zero-dte.js` (BUY tier) + spread hard-gate in `lib/callout-quality.ts` | `TRADE_MAX_SPREAD_PCT` (default **5%**) and `GOLD_MAX_SPREAD_PCT` (default **5%**) |

Rule for developers: these three behaviors are the product. Nothing may bypass
the velocity threshold, skip the Discord send for a passing TRADE-tier
callout, or post an options callout whose contract fails the spread gate.

### Problem statement

Fast intraday movers are only tradable in a narrow window. Retail scanners either spam dozens of untradeable alerts, ignore option-contract economics (a "+15% winner" is a real-fill loser after a 9% spread round trip), or report cherry-picked results. The operator needs one system that (a) catches moves early enough to act, (b) refuses setups that can't actually be filled, and (c) keeps an audit-grade record of how every callout performed.

### Business context

- Operated by one person on one VPS. The operator trades the callouts personally, sells access to a Discord channel where callouts are posted, and produces social content from the results.
- Market data comes from a paid Polygon.io/Massive plan (~$400/mo) with hard rate limits — **data spend is a first-class product constraint**, not an ops afterthought.
- Because callouts are sold and publicized, **compliance wording and honest performance stats are product requirements**, not nice-to-haves.

## 2. Goals and non-goals

### Goals

1. Detect momentum in a curated universe within ~10 seconds of a move starting, during premarket (4:00 ET), regular hours, and after-hours (to 20:00 ET).
2. During regular hours, attach a specific 0DTE option contract that passes entry-economics gates (spread, delta, breakeven vs. expected remaining move).
3. Route callouts to the right product: options callouts (RTH only) and share callouts (extended hours + RTH), to separate Discord webhooks.
4. Grade every callout at fixed checkpoints with favorable move, max adverse excursion, and a false-positive rule; never lose gradeability silently.
5. Never exceed the data plan: hard daily/minute call ceilings enforced in code.
6. Be observable: the operator can always answer "is it alive?", "what did it spend?", and "why didn't X alert?"
7. Enforce compliance wording per audience mode on every surface (web UI, Discord, generated social copy).

### Non-goals

- No trade execution or brokerage connectivity. OptiScan never places orders.
- No multi-user accounts, per-user isolation, or horizontal scaling. Single instance, single operator, by design (in-memory cooldowns and budgets assume one process).
- No AI/news-driven signals. The trigger engine is deterministic price/volume math; news is used only for context badges and catalyst classification.
- No half-day (early close) session modeling — a quiet afternoon is the accepted failure mode.

## 3. Users and audience modes

| Mode | Who sees it | Wording | Enforcement |
|---|---|---|---|
| **Private** (default) | The operator | Directive: `BUY CALL`, `BUY PUT`, `LONG`, `SHORT`, literal order tickets | none needed |
| **Public / education** | Screenshots, streams, screen-shares | Non-directive: "Call Momentum Watch", "Bullish Share Momentum Watch", "High-conviction watch"; order-ticket UI hidden; standing disclaimer footer | `language_mode` setting threads through UI components AND a runtime banned-language guard blocks any Discord payload containing directive phrases |
| **Paid subscriber** (future) | Discord members | Education-framed signal language + disclaimers | same guard; see §10 compliance |

Requirement: switching the mode in Settings must take effect on open views without a reload.

## 4. Product surfaces

| Route | Purpose |
|---|---|
| `/` (Live) | Main terminal: session status, hero callout (single strongest signal), ranked scanner columns, runners board, recent-callouts ledger, Options vs Market tabs |
| `/alerts` | Alert history + accuracy dashboard: live callouts, full ledger, signal-accuracy stats, trade journal (manual + Robinhood CSV import) |
| `/copilot` | Operator's posting desk: current TRADE-tier callouts formatted for Discord |
| `/data` | Data Core: provider/quota/health visibility |
| `/scanner` | Legacy on-demand momentum/unusual-activity scan (poll-driven, cache-protected) |
| `/stocks`, `/now`, `/review`, `/guide`, `/settings` | Shares view, quick view, daily review, user guide, configuration |
| `/alert-lab` | Redirects to `/alerts` (canonical) |

Global chrome: alert popup system (options-session only, TRADE-tier only), mobile bottom nav, compliance footer (public mode).

## 5. Functional requirements

### FR-1 Realtime scanner loop
- A single background loop ticks every `SCANNER_LOOP_MS` (default 1000 ms), started at process boot (`instrumentation.ts` → `server-boot.ts`), no browser visit required.
- Each tick makes **exactly one** bulk snapshot call covering the whole active universe (core 0DTE names + promoted discovery names). Per-symbol chains are *never* fetched for the discovery pool.
- Per symbol, an in-memory ring buffer (~6 min of 1s ticks) drives: short-window velocity (%/min), acceleration, volume surge vs. baseline, path efficiency, VWAP side, HOD/LOD breaks.
- Discovery: every 30 s, a broad-universe snapshot promotes the top movers (volume floor applied) into the fast loop for 5 minutes.
- Any 429 or quota error doubles the loop interval (cap 60 s) and decays back — degraded keys must degrade gracefully, never melt.
- Warmup: no triggers until a symbol has enough ring samples (6–10 ticks depending on core status).

### FR-2 Trigger engine (callout decision)
A callout fires only when ALL of the following pass (four independent confirmations — this bar is the product's identity; loosening it requires calibration data per §12):
1. **Persistence** — velocity sustained across sub-windows, not a 1-tick flicker.
2. **Acceleration** — move is speeding up (when a floor is configured).
3. **Tape moving** — level break (HOD/LOD), or sustained+instant velocity aligned, or velocity+surge combo.
4. **`shouldTrigger`** — rate/surge/efficiency/level thresholds with per-symbol cooldown.

Cooldowns: per symbol, options and shares tracked separately (core ~3 min, others 10 min). A trigger whose capture is rejected (SKIP tier / dedup) consumes only a short retry window (45 s default) — never zero (a zero cooldown lets one hot symbol fetch chains every second) and never the full window (an improving setup must still be able to fire).

### FR-3 0DTE contract selection and entry economics
- On an options trigger: fetch the 0–1 DTE chain (fallback 0–5 DTE), max 2 pages; chains are pre-warmed while a symbol is near-trigger so callout latency isn't paying for a cold fetch.
- Rank contracts by delta zone and strike distance; lotto wings score zero.
- **TRADE tier requires the exact contract to be fillable:** spread ≤ `TRADE_MAX_SPREAD_PCT` (default 5%), |delta| 0.35–0.65, breakeven within the expected remaining move; plus trend alignment (no counter-trend calls/puts, no extended chases).
- Anything failing entry economics can still be a WATCH; it must never be labeled a buy.

### FR-4 Dual-product routing
- **Options product:** RTH only (9:30–16:00 ET). **Shares product:** premarket + after-hours (+ RTH when `STOCK_CALLOUTS=1`); never fetches option chains.
- Separate Discord webhooks per product (`DISCORD_WEBHOOK_OPTIONS`, `DISCORD_WEBHOOK_STOCKS`, recap channel); stocks never fall back to the options webhook.
- Weekends and full-day US market holidays (built-in table 2025–2027 + `MARKET_HOLIDAYS` env) are `closed`: no callouts, recap-only tape.

### FR-5 Callout quality tiers
- Tiers: **TRADE** (post + popup + Discord), **WATCH** (visible, deduped 30 min/ticker on Discord), **SKIP** (never persisted).
- The TRADE bar ("gold" profile, modeled on a verified winning callout) checks setup score, speed, surge, move status (early/tradable — not a chase), worth/contract/liquidity scores, side-conviction gap, spread hard-gate. All thresholds env-tunable (`GOLD_*`), with documented defaults.
- Discord-postable set = TRADE-tier AND fillable; the desk view shows only that set.

### FR-6 Accuracy tracking (the track record is the product)
- Every persisted alert is swept every 60 s and graded at checkpoints: 1m/3m/5m/10m/15m/30m/1h/EOD.
- Per checkpoint: % move from alert (favorable-signed), max favorable move, max adverse excursion (drawdown), price. Options alerts also get live contract re-quotes (bounded: ≤3 symbols per 7 s window, 30-min tracking) into `options_snapshots`.
- **No lookahead:** checkpoints computed only from bars inside `[alert, checkpoint]`. **No stale-price grading:** missed sweeps backfill from candle history.
- False positive: favorable move < `ALERT_FP_MIN_FAVORABLE_PCT` (1.5%) by EOD.
- Every TRADE alert must be gradeable: a nightly integrity job flags TRADE alerts with zero contract snapshots, alerts stuck `tracking` > 2 days (survivorship guard), and a stale scanner lock. Exit code 1 = page the operator.
- Scoreboards: daily 16:05 ET and weekly Sunday posts to the recap webhook.

### FR-7 Publishing & social copy (honest-stats rule)
- Generated tweets/recaps/Discord pitches must: use **realized mid-to-mid returns only** for win rates and averages; label peak favorable moves explicitly as peaks, never blended into "returns"; carry a results/advice disclaimer on every generated post.
- The Discord sender runs a banned-language check on **every** payload; a payload containing directive phrases in public mode is refused, not softened.

### FR-8 Observability
- `GET /api/health`: HTTP **503** when the loop is stalled (no tick within 3× interval) during any non-closed session. Unauthenticated → shallow liveness body; with token → full stats (tick/trigger/alert/error counters, interval, note, `callsToday`/`callsThisMinute` vs caps, `dbWritable`).
- `GET /api/scanner/live` (in-memory, zero provider cost): loop state, ranked tape, and `nearMisses` — a ring buffer answering "why didn't X alert?" (first failed gate + values vs. thresholds, per-symbol throttled).
- SSE stream (`/api/scanner/stream`) pushes loop state every 1 s; the client falls back to 1 s polling on stream failure. UI shows freshness (fresh/aging/stale).

### FR-9 Settings
- Runtime-tunable via UI (persisted in SQLite `scanner_settings`): trigger thresholds, capture thresholds, Discord toggles, language mode, popup/sound. Env vars are boot defaults; DB settings win. No boot-time code may silently overwrite user-saved thresholds.

## 6. Non-functional requirements

### NFR-1 Data spend (hard requirement)
- Central call meter: every provider request counted, bucketed by ET trading day and wall-clock minute.
- Hard ceilings `POLYGON_DAILY_CALL_CAP` (default 200,000) and `POLYGON_MINUTE_CALL_CAP` (default 280). At a cap the request is refused **before the network** with a typed `quota_exceeded`; loop treats it like a 429. Cap 0 disables.
- Near 90% of the minute cap, non-critical calls (news enrichment, warm prefetch) defer; trigger-path fetches never defer.
- Budget invariants: 1 bulk snapshot/tick regardless of universe size; chains only on trigger/prefetch/active-refresh, all bounded.

### NFR-2 Reliability
- Single instance enforced by a DB advisory lock (`scanner_lock` row, 15 s heartbeat, ~2 min staleness takeover). A second process must refuse to start its loop and say so in logs + health note.
- SQLite (better-sqlite3, WAL) with `busy_timeout=5000`, `synchronous=NORMAL`, `wal_autocheckpoint=1000`, `foreign_keys=ON`. Nightly WAL-safe online backups, 14-day retention, quarterly restore test.
- Docker: standalone build, non-root, named data volume, healthcheck on `/api/health`, `restart: unless-stopped`.

### NFR-3 Security
- `SCAN_API_TOKEN` gates every data-spending route; accepted **only** via `x-scan-token` header or `Authorization: Bearer` — query-string tokens are rejected (log/referrer leakage). Timing-safe compare. Unset = open (documented local-dev default; must be set in prod).
- Port 8780 never exposed directly; real auth (Cloudflare Access / reverse-proxy) at the edge in production. Webhooks/keys are server-side only; `.env.local` and `data/` are never committed.

### NFR-4 Quality gates
- `npm test` (node test runner, ~276 tests incl. quota, auth, health, gates, language modes, near-miss, lock, session, accuracy) and `npm run build` must pass before every commit.
- A build smoke test fails the suite if a core file is truncated/corrupted or key exports disappear (this has happened; the guard is required).
- Signal-math files (`lib/zero-dte.js`, `lib/trade-verdict.ts`, `lib/alert-capture.ts` gates) may not be changed casually — threshold changes require checkpoint-data calibration and a note in the changelog.

## 7. System architecture (technical summary)

- **Stack:** Next.js 15 (App Router, TypeScript), better-sqlite3, Polygon/Massive REST. Dev at `localhost:8780`.
- **Process model:** one Node process runs the web app + scanner loop + tracker sweep. State that must survive dev hot-reloads lives on `globalThis` (loop state, DB handle, call meter).
- **Key modules:**
  - `lib/scanner-loop.ts` — the 1 s loop, discovery, triggers, near-miss capture, active-alert refresh.
  - `lib/zero-dte.js` — pure signal math (velocity, surge, efficiency, levels, direction, `shouldTrigger`, contract ranking). Deterministic, unit-tested, no I/O.
  - `lib/polygon-provider.js` — all provider I/O + call meter/quota guard. Dependency-free for direct test imports.
  - `lib/alert-capture.ts`, `lib/stock-capture.ts`, `lib/callout-quality.ts` — capture pipeline + TRADE/WATCH/SKIP tiers.
  - `lib/alert-tracker.ts` — checkpoint sweeps, backfill, scoreboards.
  - `lib/trade-verdict.ts` — display verdict (TRADE/WAIT/SKIP + headline) from alert + live tape.
  - `lib/language-modes.js` — label maps, banned-language guard, publicizer, disclaimer.
  - `lib/health.ts`, `lib/near-miss.ts`, `lib/instance-lock.ts` — pure, testable ops logic.
  - `lib/trading-session.ts` — ET sessions, holidays; safe for instrumentation import (no sqlite).
- **Data model (SQLite `data/optiscan.db`):** `alerts` (one row per callout: ticker, source, direction, contract, scores, session, capture_action, status, FP flag), `alert_performance` (checkpoint rows), `options_snapshots` (live contract marks per alert), `trade_journal`, `scanner_settings` (key/value), `scanner_lock` (single row).
- **API surface:** see §4 pages plus `/api/alerts*` (CRUD/stats/accuracy/track/weekly), `/api/scan/*` + `/api/scanner/*` (scans, live state, SSE), `/api/candles/*`, `/api/options/[ticker]`, `/api/catalysts/[ticker]`, `/api/notifications/*` (settings, tests, pending), `/api/trade-journal*`, `/api/health` (+ `/data-access`). All data-spending routes call `checkApiToken`.

## 8. Configuration reference (operator-facing)

Boot defaults via env; `.env.local.example` / `env.production.example` are the canonical documented lists. Highlights a developer must not break:

```
POLYGON_API_KEY                  # required
SCAN_API_TOKEN                   # required in prod (openssl rand -hex 24)
POLYGON_DAILY_CALL_CAP=200000    # hard spend ceilings
POLYGON_MINUTE_CALL_CAP=280
SCANNER_LOOP_MS=1000             # loop cadence
SCANNER_DISCOVERY_MS=30000 / SCANNER_DISCOVERY_TOP_N
SCANNER_MIN_RATE_PCT_MIN / _VOL_SURGE / _EFFICIENCY / _ACCEL   # trigger gates
SCANNER_TRIGGER_COOLDOWN_MS / SCANNER_CORE_TRIGGER_COOLDOWN_MS
SCANNER_SKIP_RETRY_COOLDOWN_MS=45000
TRADE_MAX_SPREAD_PCT=5           # BUY fillability
GOLD_TRADE_* / GOLD_WATCH_*      # quality-tier thresholds
STOCK_CALLOUTS=1                 # enables shares engine
DISCORD_WEBHOOK_OPTIONS / _STOCKS / _RECAP / DISCORD_ROLE_*
MARKET_HOLIDAYS=YYYY-MM-DD,...   # extend holiday table without deploy
SCANNER_REALTIME=0               # kill switch for the loop
```

## 9. Acceptance criteria (definition of "working")

1. Boot with a valid key during RTH → within 60 s, `/api/health` returns 200 with `loopRunning:true`, `lastTickAgeMs` < 3000, rising `ticks`.
2. Kill the loop during RTH → `/api/health` returns 503; Docker healthcheck flips unhealthy.
3. Set `POLYGON_MINUTE_CALL_CAP=4` → loop backs off with `quota_exceeded` note; zero requests hit the network past the cap.
4. A fast mover breaking HOD with 2×+ surge during RTH → callout within ~10 s carrying a contract with spread ≤5% and delta in zone, or it is a WATCH, never a TRADE.
5. Same symbol cannot produce a second options callout inside its cooldown; a SKIP-rejected trigger retries no sooner than 45 s.
6. Every TRADE alert has ≥1 options snapshot by EOD (integrity job exits 0).
7. Public mode: no surface renders BUY/LONG/SHORT/order tickets; disclaimer footer visible; Discord refuses a directive payload; generated social copy contains realized-only stats + disclaimer.
8. Second process against the same data dir refuses to start its loop and says why.
9. `npm test` and `npm run build` green on a clean checkout (Windows dev + Linux Docker).

## 10. Compliance requirements (non-negotiable before paid access)

- Public/education mode enforced end-to-end (UI + Discord + social copy) — shipped; regression-tested.
- Performance claims in any public/paid channel: realized returns only, peaks labeled, no cherry-picking (full ledger visible, not just winners), standing disclaimer.
- Before charging subscribers: operator obtains securities-law review (adviser registration / publisher-exclusion analysis is jurisdiction-specific and outside engineering scope).

## 11. Out of scope for v1 / accepted roadmap

- **v1.1 (ops):** Discord ops-webhook push alerts on loop stall / quota cap / DB failure (health 503 exists; nothing pages yet). Structured JSON logging + rotation.
- **v1.2 (UI consolidation):** merge overlapping status surfaces into one status bar; single ranked table; details drawer; design-system pass; `/alerts` KPI charts (hit rate by score bucket, favorable-vs-drawdown scatter, session heatmap).
- **v1.3 (signal calibration):** calibrate `expectedRemainingMovePct` and volume-surge fidelity against accumulated checkpoint data; ATR-normalize discovery thresholds; premarket/AH-specific stock gates.
- **Future:** paid-user mode wording tier, per-user auth if ever multi-tenant (explicitly out of scope today).

## 12. Risks and constraints for any developer touching this

1. **Data spend is the money.** Any new provider call must go through `polyFetch` (metered) and respect the budget helpers. Never add an unmetered fetch path.
2. **Don't loosen gates without data.** The strict trigger bar is deliberate (a prior noisy configuration measured a 7% hit rate). Threshold changes ship behind env vars with defaults unchanged, then get calibrated from the tracker.
3. **Single process assumptions everywhere.** Cooldowns, budgets, and loop state are in-memory. Anything multi-replica breaks correctness silently.
4. **Cooldown ≠ optional.** Every trigger path must set *some* cooldown on every outcome (success = full, rejection = retry window). A missing cooldown is a 1 req/s quota leak per hot symbol.
5. **Grading integrity.** Never compute a checkpoint from data outside its window; never present peak moves as returns; never let a TRADE alert become ungradeable silently.
6. **Compliance strings.** New user-facing surfaces must consume `useLanguageMode` and the label maps; add new directive strings to the language-mode tests.
7. **Run `npm test` + `npm run build` before every commit.** The smoke test exists because file corruption has reached the working tree before.
