# OPTIONS_AUTONOMOUS_RUNTIME

How the independent Options Opportunity Scanner runs **autonomously on Railway** with no daily manual
PowerShell. The diagnostic and `GET` endpoints are **operator inspection tools only** — they are never
required for scanning, candidate creation, paper trading, Discord delivery, grading, recovery, or daily
operation.

> Paper/research only. No real-money execution. All logic is flag-gated and defaults OFF. This task did
> not loosen any strategy entry gate.

## Boot lifecycle (once per Node process)

`ensureServerBoot()` (`lib/server-boot.ts`) is called by every server route and starts the runtime once
(idempotent). A `GET` request only *triggers* this one-time boot; it never triggers a scan or grade.

| Step | Module | Gate | Behavior |
|---|---|---|---|
| Monitor | `startOptionsMonitor` (`monitor.ts`) | `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1` | Singleton in-process interval loop; second start is a no-op. |
| Self-check | `runOptionsSelfCheck` (`runtime.ts`) | always runs, fails closed | Verifies deps without exposing secrets; persists blockers. |
| Grader | `startOptionsGrader` (`grade.ts`) | `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1` **and** `REAL_OPTION_PAPER_ENABLED=1` | Singleton loop; closes/grades open paper positions; runs the daily summary each tick. |

**Single instance.** Monitor and grader are `globalThis` singletons guarded by a `running` flag. Timers
are `unref()`'d so they never keep the process alive artificially, and `SIGTERM`/`SIGINT` stop them
cleanly.

**State restored from persistence.** Dedup and idempotency are **DB-based**, so a restart/deploy cannot
produce a duplicate alert or a duplicate paper trade:
- Discord alerts: `options_alerts.alert_id` (`symbol|strategy|contract|5-min bucket`) — an existing
  `SENT`/`SEND_ATTEMPTED` row suppresses any resend, including after a restart.
- Paper trades: `canOpenRealOptionPaper` dedups by `contract+strategy+time-bucket` against the DB.
- Open positions: `options_paper_trades.status='ENTERED'` rows persist; the grader resumes them after a
  restart with no in-memory dependency.

**Heartbeat.** Every monitor cycle upserts `options_runtime.heartbeat` (`persistHeartbeatOnDb`). Runtime
status therefore survives a restart and needs no manual endpoint call.

## Candidate lifecycle (automatic)

Tier-1 + Tier-2 are scanned on session cadences → Stage-1 cheap snapshot → Stage-1.5 decision-time
features (stale bars reject safely) → Stage-2 chain only when a strategy is plausible (or options-activity
escalates) → real OCC contract selection → freshness/spread/liquidity/chase/duplicate/cooldown gates →
`REAL_OPTION_PAPER` entry (when enabled) → one gated private-beta Discord callout (when enabled/eligible;
research-only puts suppressed). Every decision + rejection reason is written to `options_candidates`.

## Outcome grading (automatic — the piece this task added)

The grader (`grade.ts`) polls open `REAL_OPTION_PAPER` positions every `OPTIONS_GRADE_INTERVAL_MS`
(default 30 s):

1. Refresh the contract's quote (`buildLiveGradeDeps().getQuote` → underlying chain → match OCC symbol).
2. `decideOptionExit()` applies, in priority: **target** (`+OPTIONS_PAPER_TAKE_PROFIT_PCT`, default 60%),
   **stop** (`-OPTIONS_PAPER_STOP_LOSS_PCT`, default 40%), **expiration**, **time-stop**
   (`OPTIONS_PAPER_MAX_HOLD_MS`, default 2 days).
3. P&L is computed from the **option** price ×100 (`realOptionExit`), never the underlying.
4. Positions that expire with no usable quote are closed **unpriced** (`pnl=null`) — never fabricated.

`REAL_OPTION_PAPER`, `EQUITY_PAPER`, `MODELED_OPTION_RESEARCH`, and `UNDERLYING_PROXY_INVALID` stay in
separate lanes and are never combined. No manual grading command exists or is required.

## Observability (persisted, read-only)

`GET /api/research/options` reads (never writes): monitor metrics + health, `grading` backlog
(open positions, graded total, last grade cycle, live grader state), `runtime` (persisted heartbeat +
freshness + last self-check + last summary day), delivery metrics, and the split performance report.

## Environment flags

- Enable scanning: `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1`
- Enable paper + grading: `REAL_OPTION_PAPER_ENABLED=1`
- Enable private callouts: `EARLY_OPTIONS_CALLOUTS_ENABLED=1` (+ `DISCORD_WEBHOOK_OPTIONS`)
- Kill switch: `OPTIONS_CALLOUTS_KILL=1`
- Summaries: `DISCORD_WEBHOOK_RECAP` (falls back to options webhook), `OPTIONS_SUMMARY_HOUR_ET` (default 16)

See `OPTIONS_SESSION_AUTOMATION.md`, `OPTIONS_RECOVERY_RUNBOOK.md`, `OPTIONS_DAILY_SUMMARY.md`.
