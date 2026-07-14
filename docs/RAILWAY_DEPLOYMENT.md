# OptiScan — Railway deployment guide

Deploy OptiScan as **one persistent Railway service, one replica**, that owns both
the Next.js web app and the background runtime (scanner, Supervisor, paper engine,
learning/drift scheduler). SQLite is the authoritative database on a Railway
persistent volume.

> **Do not** split into separate web/worker services or scale past one replica while
> SQLite is the shared database — the scanner lock and scheduler lease guarantee a
> single owner only within a shared volume. Multiple replicas require migrating to a
> genuinely shared database (PostgreSQL) first. See `docs/OPERATIONS.md` → "When to
> migrate to PostgreSQL".

This document gives the exact user-facing steps. Claude cannot click in your Railway
account — you perform these; the repository ships the configuration.

## What the repo already provides

- `Dockerfile` — production image: builds Next.js **standalone** output and runs
  `node server.js`, which triggers Next instrumentation → `ensureServerBoot()` →
  scanner + paper engine + scheduler. (Plain `next start` does **not** boot the
  runtime, so the image uses the standalone server.)
- `docker-entrypoint.sh` — starts as root only to make the `/app/data` volume
  writable by the unprivileged `nodejs` user, then drops privileges via `gosu`.
- `railway.json` — Dockerfile builder, healthcheck `/api/healthz`, 1 replica,
  restart on failure.
- `/api/healthz` — lightweight probe (200 when the DB opens; never 503 for a closed
  market, inactive model, or unconfigured Discord).
- `.env.railway.example` — the full variable inventory with placeholders.

## Exact settings

- **Build:** Docker (from `Dockerfile`). No custom build command needed.
- **Start:** the image entrypoint (`docker-entrypoint.sh` → `node server.js`). No
  custom start command needed; the server reads Railway's injected `PORT`.
- **Healthcheck path:** `/api/healthz`
- **Volume mount path:** `/app/data`
- **Database path:** `${ALERT_DB_DIR}/optiscan.db` → set `ALERT_DB_DIR=/app/data`,
  so the DB file is `/app/data/optiscan.db` (plus `-wal`/`-shm`) on the volume.

## Step-by-step (Railway UI)

1. **Create a project** — Railway → *New Project* → *Deploy from GitHub repo*.
2. **Select the repo + branch** — choose the OptiScan repository and the `main`
   branch. Railway detects `railway.json` and builds from the `Dockerfile`.
3. **Confirm build/start** — Settings → *Build*: builder = Dockerfile. *Deploy*:
   healthcheck path `/api/healthz`, replicas = 1 (from `railway.json`). Leave the
   start command empty (the image entrypoint runs).
4. **Add a persistent volume** — service → *Settings* → *Volumes* → *New Volume*.
5. **Mount it at `/app/data`** — set the mount path exactly to `/app/data`.
6. **Add Stage A variables** — *Variables* tab. Minimum:
   ```
   NODE_ENV=production
   ALERT_DB_DIR=/app/data
   POLYGON_API_KEY=<your key>        # or MASSIVE_API_KEY
   SCAN_API_TOKEN=<random hex>       # recommended
   SUPERVISOR_RUNTIME=0
   CALLOUT_CANONICAL_PATH=legacy
   AGENT_CALLOUT_DISCORD=0
   IMPROVEMENT_AUDIT=0
   ```
   (Do **not** set `PORT` — Railway injects it. Do **not** set `BEARISH_ACTIONABLE`.)
7. **Confirm the healthcheck path** is `/api/healthz` (Settings → Deploy).
8. **Generate a public domain** — Settings → *Networking* → *Generate Domain*. Put
   that URL in `PUBLIC_APP_URL` if you want dashboard links in Discord.
9. **Deploy** — trigger the first deploy (push to `main` or *Deploy* button).
10. **Inspect build logs** — confirm `npm ci`, `npm run build`, and the standalone
    copy succeed.
11. **Inspect runtime logs** — expect `[optiscan] scanner + alert tracker started at
    process boot` and `[scheduler] started`.
12. **Open the health endpoint** — `https://<domain>/api/healthz` → `{"ok":true,...}`.
13. **Open runtime status** — `https://<domain>/api/runtime/status` with header
    `x-scan-token: <SCAN_API_TOKEN>`. Confirm scanner/scheduler/model/improvement
    sections render.
14. **Confirm the worker lease owner** — in `/api/runtime/status`, `worker.scheduler`
    should show `isOwner: true` with a recent heartbeat, and `worker.scanner` a fresh
    heartbeat.
15. **Confirm DB path + migration** — logs show no migration error; `/api/healthz`
    returns `db:true`. The DB lives at `/app/data/optiscan.db`.
16. **Redeploy and confirm persistence** — trigger a redeploy; after it comes back,
    confirm prior data survived (e.g. settings, any paper history) — the volume
    persists across deploys, the container filesystem does not.
17. **Run the Discord smoke test** — see `docs/RUNTIME.md` → smoke test, or:
    set `DISCORD_SMOKE_TEST=1` + webhooks, then
    `curl -H "x-scan-token: $SCAN_API_TOKEN" "https://<domain>/api/dev/discord-smoke?send=1"`.
    Disable it afterward (remove `DISCORD_SMOKE_TEST`).
18. **Enable Stage B** — set `SUPERVISOR_RUNTIME=1` (keep `CALLOUT_CANONICAL_PATH=legacy`
    and `AGENT_CALLOUT_DISCORD=0`). Redeploy.
19. **Observe Supervisor callouts without sending** — check `/api/callouts` and the
    `supervisor` + `callouts` sections of `/api/runtime/status`. Verify horizons,
    freshness, risk blocks, and selected contracts. No Discord sends occur.
20. **Enable Stage C only after observation** — set `CALLOUT_CANONICAL_PATH=supervisor`
    and `AGENT_CALLOUT_DISCORD=1`, ensure `DISCORD_WEBHOOK_OPTIONS` (and
    `DISCORD_WEBHOOK_STOCKS`) are set. Redeploy.
21. **Confirm exactly one options callout path is active** — with
    `CALLOUT_CANONICAL_PATH=supervisor`, the legacy options sender stands down
    (delivery ledger shows callout `payload_type` sends, and `notifyNewAlert` records
    `skipped: superseded by supervisor canonical callout path`). Puts remain
    RESEARCH_ONLY.
22. **Confirm exactly one PAPER-entry path is active** — with
    `CALLOUT_CANONICAL_PATH=supervisor`, the legacy `autoEnterFromAlerts` path stands
    down and the Supervisor→paper bridge is the single authoritative paper source, so
    a strong setup cannot be papered twice. Verify paper trades trace to
    `paper_candidates` (source `SUPERVISOR`), not to bare alert auto-entry.
23. **`AGENT_CALLOUT_DISCORD=1` is MANDATORY for options Discord under the supervisor
    path.** Because the supervisor path suppresses the legacy options sender, leaving
    this at `0` silences options Discord entirely. `/api/runtime/status` `config`
    flags `AGENT_CALLOUT_DISCORD` as blocking `options_alerts` when it is off.
24. **Premarket/after-hours stock (optional)** — regular-hours stock needs only
    `STOCK_CALLOUTS=1` + `DISCORD_WEBHOOK_STOCKS`. Extended sessions ALSO require
    `STOCK_EXTENDED_HOURS=1` (or `PAPER_STOCK_EXTENDED_HOURS=1`) **and** the
    `extended_stock_notify` DB setting = `1` (Settings page). The `config` section of
    `/api/runtime/status` shows each gate so a silent premarket does not read as
    "stale/no data".
25. **Fast-moving stock capture** — keep `STOCK_MOMENTUM_LATCH=1` (default) and
    the default `SCANNER_DISCOVERY_MS=15000` unless provider quota requires a
    rollback. The latch does not send WAIT/WATCH; it only allows a stock-only
    capture after a recent speed crossing gets real volume confirmation and the
    normal now-only Discord gate still passes.

## Stage variable profiles

| Variable | Stage A | Stage B | Stage C |
|---|---|---|---|
| `SUPERVISOR_RUNTIME` | `0` | `1` | `1` |
| `CALLOUT_CANONICAL_PATH` | `legacy` | `legacy` | `supervisor` |
| `AGENT_CALLOUT_DISCORD` | `0` | `0` | `1` (required — else options Discord silent) |
| `STOCK_CALLOUTS` | `0` | `0`/`1` | `1` |
| `STOCK_MOMENTUM_LATCH` | `1` | `1` | `1` |
| `SCANNER_DISCOVERY_MS` | `15000` | `15000` | `15000` |
| `STOCK_EXTENDED_HOURS` | `0` | `0` | `1` for premarket/after-hours stock |
| `extended_stock_notify` (DB setting) | `0` | `0` | `1` for premarket/after-hours stock |
| `DISCORD_WATCH_ALERTS` | unset | unset | unset (WATCH is dashboard-only) |
| `IMPROVEMENT_AUDIT` | `0` | `0` | `0` (enable later, proposal-only) |
| `AI_ENABLED` | `0` | `0` | `0` (enable later; advisory AI is off by default) |
| Discord webhooks | optional | optional | required for sends |

## Advisory AI layer (nightly diagnosis + weekly proposals)

Off by default; enable only after the deterministic runtime is validated. The AI
jobs run **in-process, detached** from the scheduler beat (no new service) and never
block scanning, Discord, paper trading, or health checks. Full reference:
`docs/AI_OPERATIONS.md`.

Minimum to turn on:

```
AI_ENABLED=1
ANTHROPIC_API_KEY=sk-ant-...            # secret; set in Railway variables, never commit
AI_NIGHTLY_DIAGNOSIS_ENABLED=1
AI_WEEKLY_PROPOSALS_ENABLED=1           # optional
# AI_RECAP_ENABLED=1                    # optional; requires DISCORD_WEBHOOK_RECAP
```

Model routing + cost guards (safe defaults shown):

```
AI_NIGHTLY_MODEL=claude-haiku-4-5       # lower-cost narration
AI_WEEKLY_MODEL=claude-sonnet-5         # stronger reasoning for proposals
AI_MONTHLY_SOFT_LIMIT_USD=5             # warn threshold
AI_MONTHLY_HARD_LIMIT_USD=20            # optional AI jobs stop here; deterministic paths continue
AI_MAX_OUTPUT_TOKENS_PER_JOB=4000
AI_JOB_TIMEOUT_MS=60000
AI_MAX_RETRIES=2
```

Nightly runs after 20:15 ET on trading weekdays; weekly runs Friday ≥21:00 ET /
Saturday (America/New_York, holiday-aware). Reports/lessons/proposals are visible at
`/ai` (auth-gated). Nothing auto-applies, auto-merges, or auto-deploys; a human
approves every proposal. **No Railway service/cron changes are required** — the jobs
use the existing scheduler + worker lease.

## Improvement agent (initial hosted mode)

Keep `IMPROVEMENT_AUDIT` unset/`0` until basic runtime is validated. To later enable
**proposal-only** auditing: `IMPROVEMENT_AUDIT=1`. Never set `IMPROVEMENT_AUTOMATION`
or `IMPROVEMENT_AUTO_MERGE` in production — the agent records immutable proposals
only; it never edits code, merges, or pushes.

## Volume permissions note

The image runs as the unprivileged `nodejs` user, but `docker-entrypoint.sh` fixes
`/app/data` ownership as root before dropping privileges, so the SQLite volume is
writable regardless of how Railway mounts it. If logs ever show a SQLite write error
on `/app/data`, confirm the volume is mounted at exactly `/app/data` and that
`ALERT_DB_DIR=/app/data`.

See `docs/OPERATIONS.md` for backups, rollback, and the operations runbook.
