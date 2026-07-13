# Live Runtime Wiring — operations & deployment

This document covers the background runtime added in the "Live Runtime Wiring,
Discord Delivery, and Scheduler Activation" phase: how the Supervisor, canonical
callout delivery, and the learning/drift/improvement scheduler run, the environment
variables that gate them, and the remaining hosted-deployment steps.

Everything defaults to **safe** — an accidental deploy with no new env vars keeps
the legacy behavior and sends nothing new.

## What starts at boot

`ensureServerBoot()` (called from server routes) starts, once per process:

1. **alert tracker** (existing)
2. **scanner loop** (existing) — guarded by the `scanner_lock` advisory lock
3. **paper engine** (existing) — also runs authoritative outcome grading
4. **scheduler** (new) — guarded by the `scheduler` worker lease

The scheduler runs four jobs on independent cadences, but only on the process that
holds the `scheduler` lease (a DB row with a heartbeat; a crashed owner's lease
expires so another replica can take over — no permanent deadlock):

| Job | Default cadence | What it does | Gate |
|---|---|---|---|
| maintenance | 5 min | authoritative outcome sync + statistics refresh | always on |
| learning | 60 min | bounded learning cycle (gated retrain + drift snapshot) | always on |
| supervisor | 60 s | run relevant horizon agents → canonical callouts → deliver | `SUPERVISOR_RUNTIME=1` |
| improvement | 6 h | record proposal-only improvement audit | `IMPROVEMENT_AUDIT=1` |

### Supervisor cycle universe

Each supervisor cycle scans a bounded universe built as: every **valid** pinned
core ticker first (`SUPERVISOR_CORE_TICKERS`, default `NVDA,META,SPCX,SPY,AAPL,AMZN`),
then the strongest **dynamic movers** from the live scanner (falling back to the
static 0DTE watchlist when the scanner has no movers), filling the remaining slots
up to `SUPERVISOR_MAX_TICKERS`. The list is deduplicated (core vs. movers vs.
watchlist) and capped. With `SUPERVISOR_MAX_TICKERS=8` and the six default core
symbols, two slots remain for the strongest movers.

Core tickers are only *scanned first* — they are not forced actionable. A core
symbol with unavailable/stale data or no supported options chain fails honestly for
that symbol (downstream freshness/relevance/risk gates) while the rest of the cycle
continues. Invalid/garbage entries in `SUPERVISOR_CORE_TICKERS` are dropped and
never crash the cycle. Puts remain `RESEARCH_ONLY`; no contracts are fabricated and
no unsupported DTE coverage is widened.

The retrain policy is unchanged: ≥25 new graded outcomes, ≥24 h between trainings,
both classes present, sufficient coverage, moved watermark. With zero graded
outcomes the model stays honestly `INACTIVE_NO_TRAINABLE_DATA` — the scheduler never
fabricates readiness.

## Environment variables

All booleans use the repo convention `=== "1"`.

| Variable | Default | Meaning |
|---|---|---|
| `SCHEDULER_DISABLED` | unset | `1` = do not start the scheduler at all (kill switch) |
| `SUPERVISOR_RUNTIME` | off | `1` = run the automatic supervisor callout cycle |
| `SUPERVISOR_CORE_TICKERS` | `NVDA,META,SPCX,SPY,AAPL,AMZN` | comma/space-separated pinned core symbols always included first, before dynamic movers |
| `SUPERVISOR_MAX_TICKERS` | 8 | cap on tickers per supervisor cycle (1–50) |
| `CALLOUT_CANONICAL_PATH` | `legacy` | `supervisor` makes the new path canonical for OPTIONS callouts and stands the legacy options Discord sender down (no double-send) |
| `AGENT_CALLOUT_DISCORD` | off | `1` = master switch permitting supervisor Discord delivery (existing var) |
| `IMPROVEMENT_AUDIT` | off | `1` = run the low-frequency, proposal-only improvement audit |
| `DISCORD_SMOKE_TEST` | off | `1` = permit the manual smoke test to actually send |
| `SCHED_MAINTENANCE_MS` | 300000 | maintenance cadence (clamped 60 s–1 h) |
| `SCHED_LEARNING_MS` | 3600000 | learning cadence (clamped 10 min–24 h) |
| `SCHED_SUPERVISOR_MS` | 60000 | supervisor cadence (clamped 15 s–30 min) |
| `SCHED_IMPROVEMENT_MS` | 21600000 | improvement audit cadence (clamped 1 h–7 d) |

Discord webhooks (existing): `DISCORD_WEBHOOK_OPTIONS`, `DISCORD_WEBHOOK_STOCKS`,
`DISCORD_WEBHOOK_RECAP`, fallback `DISCORD_WEBHOOK_URL`. Option calls **and** put
research route to the options webhook (puts are labeled `RESEARCH ONLY`); momentum
stock routes to the stocks webhook.

### To turn the supervisor callout path fully live

```
SUPERVISOR_RUNTIME=1
CALLOUT_CANONICAL_PATH=supervisor
AGENT_CALLOUT_DISCORD=1
STOCK_CALLOUTS=1
PAPER_TRADING_ENABLED=1
PAPER_AUTO_ENTRY=1
PAPER_ALLOW_ZERO_DTE=1
PAPER_KILL_SWITCH=0
EARLY_ALERTS_ENABLED=0
ALERT_DB_DIR=/app/data
DISCORD_WEBHOOK_OPTIONS=...   # required for options Discord
DISCORD_WEBHOOK_STOCKS=...    # required for stock Discord
DISCORD_WEBHOOK_RECAP=...     # required for recaps
SCAN_API_TOKEN=...            # private owner-dashboard token
POLYGON_API_KEY=...           # required for market data
# Leave BEARISH_ACTIONABLE unset.
```

Setting `CALLOUT_CANONICAL_PATH=supervisor` automatically suppresses the legacy
options Discord sender so the same opportunity is never sent twice. Stock alerts
always use the legacy stock path (the supervisor does not own them).

## Discord smoke test

Preview formatting locally (no server, no webhook, nothing sent):

```
node --experimental-strip-types scripts/discord-smoke.mjs
```

Send the labeled `TEST / DRY RUN` messages through the tracked ledger on a running
server, after configuring the webhook vars:

```
# server env: DISCORD_SMOKE_TEST=1  (+ DISCORD_WEBHOOK_OPTIONS / DISCORD_WEBHOOK_STOCKS)
curl -H "x-scan-token: $SCAN_API_TOKEN" "http://localhost:8780/api/dev/discord-smoke?send=1"
```

The smoke test never creates a paper trade, fingerprint, outcome, or model-training
row, and its idempotency keys are namespaced (`smoke:*`) so repeated runs dedup.

## Runtime status

`GET /api/runtime/status` (auth-gated) returns worker/lease ownership + heartbeats,
scanner + supervisor cycle telemetry, Discord delivery ledger counts, learning/drift
state and next eligible learning cycle, model readiness (with the outcomes still
needed for experimental/validated activation), and the improvement-agent mode +
pending proposals. It never exposes secrets or webhook URLs.

## Remaining hosted-deployment requirements

- **Single data volume for replicas.** The scanner lock and scheduler lease live in
  SQLite, so all replicas must share the same database file for the single-owner
  guarantee to hold. If you run replicas against separate volumes, each will run its
  own scanner + scheduler.
- **Long-lived process.** The scheduler uses in-process timers; run under a process
  manager that keeps the Node server alive (the timers are `unref`'d so they never
  block shutdown).
- **Webhook secrets** are supplied via environment only; never commit them.
- **Improvement automation / branch protection.** The improvement agent remains
  proposal-only; branch protection and required reviews on `main` must be configured
  manually in GitHub. See `IMPLEMENTATION_STATUS.md` (Phase 9).
