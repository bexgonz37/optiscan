# Brokerage V2 Operational Validation (Soak)

Status: **ACTIVE after B6**  
Cutover: **NOT authorized** until human approval after `READY_FOR_CONTROLLED_CUTOVER`

## Goals

1. Collect readiness evidence over real trading days.
2. Auto-generate one daily readiness report (America/New_York calendar day).
3. Fix parity/reconciliation defects when found; extend soak after fixes.
4. Never enable V2 as authoritative without explicit approval.

## Feature flags (code defaults remain OFF)

| Flag | Soak guidance |
|---|---|
| `PAPER_BROKER_V2_ENABLED` | Default `0` in repo. **Optional ops enable = `1`** only to dual-write mirrors for soak evidence. Does not change user-visible authority. |
| `PAPER_BROKER_V2_SHADOW_READ_ENABLED` | Keep `0` until readiness ≥ `READY_FOR_SHADOW_READS`, then optional. |
| `PAPER_BROKER_V2_READS_ENABLED` | **Must stay `0`** until explicit cutover approval. |

Invalid combinations remain blocked by `validateBrokerV2FlagCombination`.

## Daily report contents

Stored in `broker_readiness_daily_reports` (idempotent on `report_day`):

- Readiness status
- Mirrored trade / round-trip counts
- Parity success rates (trade, fill, realized P&L, return, lifecycle, audit, equity)
- Unresolved reconciliation failures
- Orphan / duplicate counts
- Missing / stale marks + incomplete equity snapshots
- Shadow-read event/mismatch counts
- Warnings + day-over-day regressions
- Flag snapshot + recommended next action

Scheduler job: `brokerReadiness` (default check every 60m; one report per ET day).

Dashboards:

- Live evaluator: `/brokerage-readiness`
- API: `GET /api/research/brokerage-readiness` (includes `soak` history)

## When gate is met

If status becomes `READY_FOR_CONTROLLED_CUTOVER`:

1. System logs + audit event `READINESS_CUTOVER_GATE_MET`
2. **No automatic cutover**
3. Present evidence package to the owner for approval

## Rollback

V2 reads were never enabled in soak. If dual-write was enabled for observation, set `PAPER_BROKER_V2_ENABLED=0` to stop new mirrors. Legacy history untouched.
