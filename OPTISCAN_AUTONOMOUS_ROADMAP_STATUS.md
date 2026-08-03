# OptiScan Autonomous Roadmap — Status

**Updated:** 2026-08-03 · **Deployed:** `7a0af62` · **Started from:** `7246304`

Durable status for the Gate B–G roadmap. Updated after every gate.

---

## Current stage

**Gate B — IN PROGRESS.** B1/B2/B3/B5/B6 shipped. B4, B7, B8 not started.

## Gate ledger

| Gate | Scope | Status | Evidence |
|---|---|---|---|
| **A** | FUTURE_QUOTE root cause + fix | **PASSED** | 8-min live sample: 135 marks, **0 FUTURE_QUOTE**, 69.6% usable (from 24.4%) |
| **B1** | Persist per-attempt mark evidence | **DEPLOYED_UNPROVEN** | `asymmetry_mark_evidence` table live; no session has populated it yet |
| **B2** | Define/enforce mark independence | **DEPLOYED_UNPROVEN** | Enforced in the runner; rate not yet measured |
| **B3** | Horizon windows | **DEPLOYED** | Non-overlap asserted by test across all 7 horizons |
| **B5** | Massive consumer audit | **DEPLOYED — COLLECTING** | Attribution shipped `7a0af62`; per-consumer numbers need one live RTH session |
| **B6** | Durable provider accounting | **DEPLOYED — COLLECTING** | `provider_request_minute` live; totals span deployments by construction |
| **B4** | Scheduler fairness / long horizons | **NOT STARTED** | 30m 15/173, 60m 12/133 remain weak |
| **B7** | Per-consumer provider budgets | **NOT STARTED** | Unblocked by B5/B6 — budgets now have something to measure against |
| **B8** | Live Gate B validation | **BLOCKED** | Needs one full session of evidence after B4/B7 |
| **C** | Verified performance | **BLOCKED** | Requires `independentMarkPct >= 50%` |
| **D** | Historical learning | **NOT STARTED** | Independent of C |
| **E** | Experiment registry | **NOT STARTED** | — |
| **F** | High-Asymmetry lifecycle | **NOT STARTED** | Owner-private parts could start early |
| **G** | Subscriber readiness | **BLOCKED** | Paid launch blocked |

## What shipped this session

### `93fcd63` — duplicate opening alerts (owner-reported, LIVE in production)

Closing an Opportunity Case deleted its `opportunity_thesis_active_index` row.
That row is also the guard on the outward opening path, so **a close silently
re-armed it**: the same symbol + direction could win a fresh claim and send a
second opening alert minutes after the subscriber was told the first hit T1.
Reported as "AAPL put alert" → "reached T1" → "AAPL put alert" again.

- `opportunity_thesis_reopen_cooldown` — durable post-close cooldown per thesis.
- `claimThesisIndexOnDb` refuses a re-open while it is active
  (`THESIS_REOPEN_COOLDOWN`); delivery logs `SUPPRESSED_REOPEN`.
- `OPPORTUNITY_THESIS_REOPEN_COOLDOWN_MS`, default **45m**, explicit `0` disables.
- Direction-scoped (a closed PUT never blocks a CALL); a later close extends the
  window, never shortens it; a pre-migration db keeps its old behaviour.

### `7a0af62` — Gate B5 + B6 (provider attribution and durable accounting)

B5 and B6 shipped together because attribution is impossible without
instrumentation — an audit of a system that records nothing produces a guess.

**Root finding.** Every provider call funnels through one `polyFetch`, which
incremented a single counter on `globalThis`. Two consequences:

1. **No attribution existed at all.** "280/min saturated" was true but
   unactionable — nothing recorded which consumer spent the minute.
2. **`recordPolygonCall()` was always called with the default purpose**, so the
   `discovery` / `grader` split in `quota-policy.ts` never fired. The grader
   reserve has been dead code.

- `lib/provider-context.ts` — AsyncLocalStorage consumer scope; 13 consumers
  mapped to 6 categories, in Gate B7 priority order.
- `lib/provider-accounting.ts` — per-minute rollups (a per-request table would be
  ~168k rows/day at cap); every ratio recoverable by summation.
- `lib/provider-accounting-sink.ts` — buffers in memory, flushes once per minute
  bucket, keeping fsync out of the scanner and mark hot paths.
- Scopes declared: scanner tick, options mark pass, asymmetry paper sweep,
  watchlist runner, premarket planning. Everything else lands in a **visible
  `unattributed` bucket** — a defect to close, not a category to grow.
- `GET /api/system/provider-usage` — persisted rows only, **zero provider calls**.

Semantics held: cache hits, deduplicated calls, and our own budget refusals are
**not** counted as provider requests, and a quota block is never conflated with
missing market data.

## Validation

3248/3248 green **both runs** · `tsc` clean · `build` clean · `git diff --check`
clean · migrations additive/repeat-safe · graphify updated. No cap raised, no
strategy demoted, no bracket promoted, no subscriber or Discord behaviour changed.

## The measurements that unblock everything

1. `independentMarkPct >= 50%`, from `buildIndependenceReportOnDb`.
2. Per-consumer request share, from `/api/system/provider-usage`. **This is now
   collectable and was not before.**

Both produce numbers after one live RTH session on the deployed code.

## Known blockers

1. **Provider minute cap saturated (280/280).** The consumer is now *measurable*
   but not yet *measured* — B5's numbers need a live session. **Do not raise the cap.**
2. **Long-horizon coverage weak** — 30m 15/173, 60m 12/133 (B4, unmeasured since
   horizon windows shipped).
3. **The grader reserve has never worked** (purpose never threaded through
   `polyFetch`). B7 should fix this at the same time it adds budgets.
4. **`unattributed` will be non-zero** on the first session — API routes,
   `alert-capture`, `swing-scan`, `zero-dte-context` and the diagnostics route at
   `app/api/diagnostics/alert-decision` still make unscoped calls. That route in
   particular violates "diagnostics must make zero provider requests".

## Next automatic action — EXACT RESUME POINT

**Read `/api/system/provider-usage` after the next RTH session**, then:

1. Record the per-consumer table in this file and close **B5** as MEASURED.
2. Scope whatever lands in `unattributed` (start with the four sources above).
3. **Gate B7** — per-consumer budgets. Thread the consumer through
   `recordPolygonCall()` so the grader reserve finally functions, then partition
   the minute budget in the documented priority order.
4. **Gate B4** — scheduler fairness / long horizons.
5. **Gate B8** — live validation.

Gates C–G are unchanged and remain blocked behind B8.

## Safety posture (unchanged)

`canSendSubscriber: false` · `automaticRealTrading: false` · no broker path ·
AI advisory only · no bracket promoted · no strategy quarantined · **paid launch
blocked**. No Stripe/billing/roles work touched.
