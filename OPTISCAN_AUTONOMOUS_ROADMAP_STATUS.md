# OptiScan Autonomous Roadmap — Status

**Updated:** 2026-08-03 · **Deployed:** `1e70aaf` · **Started from:** `0eea887`

Durable status for the Gate B–G roadmap. Updated after every gate.

---

## Current stage

**Gate B — IN PROGRESS.** B1/B2/B3 shipped. B4–B8 not started.

## Gate ledger

| Gate | Scope | Status | Evidence |
|---|---|---|---|
| **A** | FUTURE_QUOTE root cause + fix | **PASSED** | 8-min live sample: 135 marks, **0 FUTURE_QUOTE**, 69.6% usable (from 24.4%) |
| **B1** | Persist per-attempt mark evidence | **DEPLOYED_UNPROVEN** | `asymmetry_mark_evidence` table live; no session has populated it yet |
| **B2** | Define/enforce mark independence | **DEPLOYED_UNPROVEN** | Enforced in the runner; rate not yet measured |
| **B3** | Horizon windows | **DEPLOYED** | Non-overlap asserted by test across all 7 horizons |
| **B4** | Scheduler fairness / long horizons | **NOT STARTED** | 30m 15/173, 60m 12/133 remain weak |
| **B5** | Massive consumer audit | **NOT STARTED** | 280/min saturated; consumer unidentified |
| **B6** | Durable provider accounting | **NOT STARTED** | `callsToday` still process-local, resets on deploy |
| **B7** | Per-consumer provider budgets | **NOT STARTED** | — |
| **B8** | Live Gate B validation | **BLOCKED** | Needs one full session of evidence |
| **C** | Verified performance | **BLOCKED** | Requires `independentMarkPct >= 50%` |
| **D** | Historical learning | **NOT STARTED** | Independent of C; can start once budget is understood |
| **E** | Experiment registry | **NOT STARTED** | — |
| **F** | High-Asymmetry lifecycle | **NOT STARTED** | Owner-private parts could start early |
| **G** | Subscriber readiness | **BLOCKED** | Paid launch blocked |

## What shipped this session

- `lib/research/asymmetry/horizon-windows.ts` — deterministic non-overlapping
  windows, independence rule, `claimableHorizons`, `missedHorizons`.
- `lib/research/asymmetry/mark-evidence-store.ts` — per-attempt evidence log +
  `buildIndependenceReportOnDb` (read-only, zero provider calls).
- `asymmetry_mark_evidence` table — additive, repeat-safe, no destructive DDL.
- Mark runner records evidence and enforces one-observation-per-horizon.

## Validation

3228/3228 green **both runs** · `tsc` clean · `build` clean · `git diff --check`
clean · migration additive/repeat-safe · graphify updated.

## The measurement that unblocks everything

`independentMarkPct >= 50%`, from `buildIndependenceReportOnDb`. It reads only
persisted evidence, so it produces a number after one live RTH session with the
deployed code. **Gate C cannot honestly start before that.**

## Known blockers

1. **Provider minute cap saturated (280/280).** `quotaExceededCount` climbing
   ~440/min. The consumer is unidentified — B5 is the next highest-value work.
   **Do not raise the cap.**
2. **Long-horizon coverage weak** — 30m 15/173, 60m 12/133. Windows should help
   (a 60m quote can no longer be consumed by the 1m row) but this is unmeasured.
3. **`callsToday` is process-local** and resets on deploy, so no durable daily
   usage total exists yet (B6).

## Next automatic action

**Gate B5 — map the Massive consumers.** Diagnostic-only, needs no new
performance evidence, and directly addresses the binding constraint. Then B6
(durable accounting), then B4 (fairness/long horizons), then B8 live validation.

## Safety posture (unchanged)

`canSendSubscriber: false` · `automaticRealTrading: false` · no broker path ·
AI advisory only · no bracket promoted · no strategy quarantined · **paid launch
blocked**. No Stripe/billing/roles work touched.
