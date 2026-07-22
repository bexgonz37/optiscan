# OPTIONS_RECOVERY_RUNBOOK

Reliability + recovery behavior for the autonomous options runtime, and how to inspect it read-only.

## Automatic recovery guarantees

| Concern | Mechanism | Where |
|---|---|---|
| Restart after recoverable failure | In-process interval loops resume every tick; a thrown cycle is caught and the next tick retries. | `monitor.ts`, `grade.ts` |
| No crash-loop | In-process (no child process to respawn). Circuit breaker opens after `OPTIONS_BREAKER_FAILS` (5) failures for `OPTIONS_BREAKER_COOLDOWN_MS` (30 s), then half-opens. | `monitor.ts` breaker |
| Bounded backoff | Delivery retry backoff is bounded (`min(15s, 2^n·1s)`); an ambiguous timeout is **never** retried. | `delivery.ts` |
| Web app stays responsive | All loop work is async + `unref()`'d; a missing dep fails the *feature* closed, never the web server. | boot + self-check |
| Never silently stop on provider/DB error | Every cycle/pass wraps work in try/catch and continues; failures increment counters, not termination. | `monitor.ts`, `grade.ts` |
| Provider budget | `OPTIONS_PROVIDER_BUDGET_PER_MINUTE` (200) throttles calls per rolling minute. | `monitor.ts` `tryConsume` |
| No duplicate Discord after restart | DB-based `alert_id`; existing `SENT`/`SEND_ATTEMPTED` suppresses resend. | `delivery.ts` |
| Idempotent paper IDs | `canOpenRealOptionPaper` dedups by contract+strategy+bucket against the DB. | `paper.ts` |
| Grading resumes after restart | Open `status='ENTERED'` rows persist; grader re-reads them — no in-memory state needed. | `grade.ts` |

Tests `5–8` prove: restart preserves alert/trade dedup, grading resumes from the DB after a grader
restart, a temporary provider failure (batch or per-contract) is isolated and recovers, and a Discord
failure never throws into the monitor.

## Stale locks / leases

The options monitor/grader are single-process `globalThis` singletons — there is no cross-process lease to
recover. (The separate historical-replay worker and scheduler own DB-backed leases reclaimed at boot; see
`server-boot.ts` reconciliation.) On boot, `runOptionsSelfCheck` records the current singleton/dep state.

## Startup self-check (fail-closed)

`runOptionsSelfCheck` verifies, without exposing any secret value (presence booleans only):
required flags, `POLYGON_API_KEY`, `DISCORD_WEBHOOK_OPTIONS` (only when delivery is enabled), Node ≥ 18,
DB readiness. A missing **required** dependency becomes a `blocker`, the feature is treated as inactive
(fails closed), and the result is persisted to `options_runtime.self_check`. The web app is never blocked.

## Read-only inspection (no work triggered)

```
GET /api/research/options            # runtime heartbeat, self-check, grading backlog, delivery, report
GET /api/research/options/diagnostic # per-symbol Tier-1 evidence (why each did/didn't reach Stage 2)
```

Both require the API token and only read state. If `runtime.heartbeatFresh=false` while the market is
open and the flag is on, check `selfCheck.blockers` first, then provider health. A closed-market
`heartbeat` with `stage15Stale ≈ scanned` and empty distributions is **expected** — re-check during
regular hours.

## Common signals

- **0 candidates + all distributions n=0 + `stage15Stale` high** → market closed / stale bars. Expected.
- **`grading.openPositions` climbing, `lastGradeCycleMs` stale** → grader not running: confirm
  `REAL_OPTION_PAPER_ENABLED=1` and check `grader.errors`.
- **`delivery.sendFailed` rising** → Discord/webhook issue; monitoring continues regardless.
