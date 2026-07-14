# OptiScan — operations runbook

Operating the single-service Railway (or Docker/VPS) deployment. Pair this with
`docs/RUNTIME.md` (flags/cadences), `docs/RAILWAY_DEPLOYMENT.md` (deploy steps), and
`docs/BACKUP.md` (backup detail).

Primary observability surface: **`GET /api/runtime/status`** (auth-gated). Liveness:
**`GET /api/healthz`**. Detailed scanner health: `GET /api/health`.

## Normal startup

`node server.js` (standalone) → Next instrumentation `register()` (production only) →
`ensureServerBoot()` starts, once per process: alert tracker, scanner loop (holds the
`scanner_lock`), paper engine, and the scheduler (holds the `scheduler` worker lease).
Logs: `scanner + alert tracker started at process boot` and `[scheduler] started`.

## Worker heartbeat interpretation (`/api/runtime/status` → `worker`)

- `scheduler.isOwner: true` + fresh `heartbeatAt` → this process runs the jobs.
- `scheduler.isOwner: false` with a note `standby — scheduler lease held by pid N` →
  another process owns it (expected only if two processes share the volume; with one
  replica you should always be owner).
- `scanner.fresh: true` → the scanner loop is heartbeating. `fresh: false` during an
  open session means the loop stalled — check logs.
- A crashed owner stops heartbeating; after ~120 s its lease is stale and another
  process can take over. No manual unlock needed.

## Scanner session behavior

The scanner runs on a market-session cadence. When the session is `closed`,
`/api/health` reports healthy (it does **not** require ticks while closed), and
`/api/healthz` stays 200. 0DTE options callouts fire only 9:30–16:00 ET.

## Degradation behaviors (all normal, none fail the healthcheck)

- **Provider outage / rate-limit:** scans return "provider unavailable"; freshness
  gates block actionable output; no fabricated data. Recovers automatically.
- **Discord outage:** the tracked delivery ledger records FAILED/RETRYING and retries
  with backoff; nothing else is affected.
- **Stale data:** actionable alerts/callouts are suppressed (freshness gate);
  desktop still shows the setup with a stale marker.
- **No NBBO:** no fabricated quote; the contract shows unavailable and the callout is
  non-actionable.
- **No valid contract:** status `NO_VALID_CONTRACT`; no fabricated contract.
- **Paper order:** simulated only; slippage embedded in fills; never a real order.
- **Fast stock move missed or rejected:** inspect `momentum_diagnostics` on the
  Railway volume for the ticker/day. It records near-miss, rejected, sent, and
  latch-rescued stock decisions with speed, volume, VWAP distance, quote age,
  latch state, first-detected/actionable timestamps, and strategy version.
- **Model inactive (`INACTIVE_NO_TRAINABLE_DATA`):** no probability shown; the setup
  score is labeled "SETUP SCORE — NOT A PROBABILITY". Normal until graded outcomes
  accumulate.
- **Experimental model:** activates only at its real thresholds (default ≥30 graded,
  ≥8 W/≥8 L, ≥10 holdout, both classes, beats base rate). Every experimental
  probability is labeled "EXPERIMENTAL — LIMITED DATA — RESEARCH ONLY".
- **Validated model:** activates only at the strict gates (default ≥200 graded,
  ≥40 W/≥40 L, ≥50 holdout, ≥95% coverage, calibrated).

## Scheduler / learning / drift / improvement state

- Scheduler jobs + cadences: `runtime-status.scheduler` and `docs/RUNTIME.md`.
- `runtime-status.learning`: last cycle note, next eligible learning cycle, drift
  state. Retrain is gated (≥25 new graded, ≥24 h between, both classes, coverage,
  moved watermark) — the scheduler never fabricates readiness.
- `runtime-status.improvement`: mode + pending proposals. `INACTIVE_NO_AUTOMATION`
  until `IMPROVEMENT_AUDIT=1`; even then it is proposal-only.

## Database backup (Railway volume)

The DB is `/app/data/optiscan.db` (+ `-wal`, `-shm`). See `docs/BACKUP.md` for the
full procedure. Quick options:

- **Railway volume backup:** use Railway's volume backup/snapshot feature on the
  service's volume. Recommended **daily**, plus before any risky change.
- **Manual copy:** from a shell on the service, copy `/app/data/optiscan.db*` to an
  external store. Prefer copying while writes are quiesced (or use the SQLite backup
  API) so the `-wal` is consistent.

**Recommended frequency:** daily snapshots; retain 7–14 days.

## Restart / redeploy

A redeploy replaces the container; the **volume persists**, so the DB survives. On
restart the scheduler/scanner re-acquire their lease/lock (same-pid or after the old
lease goes stale). Callout dedup/lifecycle is persistent (`callout_state`), so a
restart does not resend unchanged callouts.

## Rollback

- **Config rollback:** flip the environment switches below and redeploy.
- **Code rollback:** redeploy a previous Railway deployment (Deployments → Redeploy),
  or `git revert` and push. Migrations are additive/repeat-safe, so older code reads
  the same DB (it simply ignores newer columns/tables).
- **Data restore:** stop the service, restore the volume snapshot (or copy the backed
  up `optiscan.db*` into `/app/data`), restart.

## Environment rollback switches (fastest levers)

| Goal | Set | Effect |
|---|---|---|
| Disable Supervisor callouts | `SUPERVISOR_RUNTIME=0` | no supervisor cycle |
| Disable new Discord delivery | `AGENT_CALLOUT_DISCORD=0` | supervisor sends nothing |
| Revert to legacy options path | `CALLOUT_CANONICAL_PATH=legacy` | legacy sender resumes; supervisor stops owning options |
| Stop the scheduler | `SCHEDULER_DISABLED=1` | no maintenance/learning/supervisor/improvement jobs |
| Emergency scanner shutdown | `SCANNER_REALTIME=0` | scanner loop does not start |
| Emergency paper shutdown | `PAPER_TRADING_ENABLED=0` | paper engine does not start |
| Disable stock crossing latch | `STOCK_MOMENTUM_LATCH=0` | stock path returns to single-snapshot firing |
| Revert stock discovery cadence | `SCANNER_DISCOVERY_MS=30000` | restores prior broad discovery rate |
| Disable improvement audit | remove `IMPROVEMENT_AUDIT` (or `=0`) | no proposal generation |

After changing a variable, **redeploy/restart** for it to take effect.

## Safety confirmations (verify anytime)

- **Bearish actionability disabled:** `BEARISH_ACTIONABLE` must be unset/`0`. Puts and
  all bearish agents are RESEARCH_ONLY; `lib/bearish-gate.ts` is the final authority.
  Confirm via `/api/callouts` — put callouts show RESEARCH ONLY and are never
  actionable.
- **No live execution:** there is no brokerage integration in the codebase; the paper
  engine simulates fills only. No environment variable enables real-money trading.

## When to migrate to PostgreSQL

Migrate the authoritative database to PostgreSQL **before**: running more than one
replica, splitting into separate web/worker services, or needing cross-region
scaling. SQLite + one shared volume is correct for a single service/replica; it is
not a genuinely shared database across processes on different volumes. (Do not
migrate now — this is a future trigger, not a current task.)
