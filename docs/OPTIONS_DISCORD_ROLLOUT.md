# OPTIONS_DISCORD_ROLLOUT

## Flags (all OFF in code; you set them in Railway)
| Flag | Effect | Sends Discord |
|---|---|---|
| INDEPENDENT_OPTIONS_DISCOVERY_ENABLED | monitor + records candidates | no |
| REAL_OPTION_PAPER_ENABLED | real-option paper (regular hours) | no |
| EARLY_OPTIONS_CALLOUTS_ENABLED | permits the private-beta delivery layer | **yes (gated)** |
| OPTIONS_CALLOUTS_KILL | kill switch — set to 1 to stop all sends instantly | — |

`EARLY_OPTIONS_CALLOUTS_ENABLED=0` ⇒ ZERO webhook sends (monitoring + paper may still run).

## Required env
`DISCORD_WEBHOOK_OPTIONS` = your private options webhook URL (kept secret; never logged/exposed).

## Observability (`GET /api/research/options` → `delivery`)
enabled, webhookConfigured, ready, sendAttempts, sent, sendFailed, tooLate, rejected, retries,
putsSuppressed, linkedPaper, latencyMs p50/p95, latestSentAtMs, latestFailureReason. Never includes
the webhook secret.

## Transport test (before any market callout)
`POST /api/research/options {"action":"transport_test"}` (token-gated) → sends ONE synthetic
"OptiScan options webhook transport test" message (no ticker/contract/entry), creates no paper trade or
performance record, returns `{ok, configured, status, latencyMs}`.

## Rollback / instant disable
Unset `EARLY_OPTIONS_CALLOUTS_ENABLED` (or set `OPTIONS_CALLOUTS_KILL=1`) → sends stop immediately.
Additive schema only; the stock radar is unaffected at all times.
