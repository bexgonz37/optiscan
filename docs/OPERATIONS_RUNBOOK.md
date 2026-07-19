# Operations Runbook — Research Platform

## Read-only diagnostics
- `GET /api/research/overview` (token-gated by `x-scan-token`) — the consolidated, secret-scrubbed
  operational view: capabilities, candidate funnel, lane routing, portfolios, experiments,
  counterfactuals, gate-effectiveness, strategy agents, AI research, replay, session/provider.
- `GET /api/runtime/status` — deployed SHA + effective flags + Discord readiness + delivery ledger.
- `GET /api/system/provider-health` — provider connect/latency/rate-limit (authoritative for
  PROVIDER_ERROR / RATE_LIMITED — the research overview does NOT re-fetch this).
- UI: `/research` (read-only summary cards + drill-down).

## Monitoring expectations
- **Production Discord** volume/selectivity unchanged from baseline. Any change after enabling a
  research flag is an incident (research must never affect Discord).
- **Capture/router** rows accrue only during RTH for options; off-hours DATA_STALE is expected.
- **Fills**: RESEARCH/CHALLENGE fills only with a defensible quote; REJECTED_INVALID never fills.
- **AI**: proposals stay PENDING_REVIEW; nothing auto-applies.
- **Replay**: options always INACTIVE_MISSING_PROVIDER; stock replay bounded by provider budget.

## Failure modes & responses
| Symptom | Likely cause | Response |
|---|---|---|
| All options candidates DATA_STALE | outside options RTH (expected) or provider stale | check session; `/api/system/provider-health` |
| A research/AI/replay section shows `{error}` | one aggregation failed (isolated) | other sections still valid; check logs; non-fatal |
| Discord counts change after a research flag | leakage regression | **abort**: unset the flag; investigate |
| Fill created without a defensible quote | fill-honesty regression | **abort**: unset `RESEARCH_LANE_ENABLED`; investigate |
| Proposal APPROVED with no reviewer | review-boundary regression | investigate `reviewProposalOnDb` usage |

## Safe operations
- Never enable a flag in Railway without following the staged activation doc.
- Never relax `callouts/eligibility.ts`, `bearish-gate.ts`, or freshness to raise volume.
- Diagnostics are read-only — never trigger replay/grading/AI from a GET.
- Secrets: the overview response is secret-scrubbed; verify no key/token/webhook ever appears.

## Restart / idempotency
All writes use UNIQUE keys / `INSERT OR IGNORE`: candidates (setup_id), routes (setup_id,lane),
enrollments (experiment,version,setup), counterfactuals (setup,kind), training rows (setup,source_kind),
replay outcomes (run,symbol,entry), findings (run,stage,subject). Restarts/retries never duplicate.
