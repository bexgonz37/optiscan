# High-Asymmetry Radar

Status: PHASE 1 RESEARCH FOUNDATION — SHADOW ONLY, NOT WIRED, NOT DEPLOYED

Branch: `feature/high-asymmetry-radar` (separate worktree). Nothing in this note
describes production behaviour on `main`.

## Purpose

OptiScan already catches ordinary technical setups that other traders also see.
The research question this component exists to answer is narrower:

> What distinguishes an ordinary setup from an unusually early options
> opportunity — one detected **before** the premium has already expanded?

Phase 1 does not answer that question. It builds the apparatus that could
answer it honestly: a canonical evidence model, deterministic outcome labels, a
replay/aggregation foundation, and read-only diagnostics. Thresholds were
deliberately NOT tuned, because there is no measured cohort to tune them
against yet.

## What exists

| File | Role |
| --- | --- |
| `lib/research/asymmetry/evidence.ts` | Canonical evidence model, OCC identity verification, executable-quote validation |
| `lib/research/asymmetry/premium-chase.ts` | Premium expansion from the earliest valid executable quote; reporting buckets |
| `lib/research/asymmetry/outcomes.ts` | Deterministic outcome labels, horizons, MFE/MAE, time-to-milestone |
| `lib/research/asymmetry/states.ts` | Shadow research states and the frozen no-SEND authority table |
| `lib/research/asymmetry/cohorts.ts` | Descriptive cohort comparison across features |
| `lib/research/asymmetry/report.ts` | Pure replay/aggregation assembler |
| `lib/research/asymmetry/loader.ts` | Read-only persisted-cohort loader (SELECTs only) |
| `app/api/research/asymmetry/route.ts` | Token-gated, GET-only diagnostics |

## Evidence model

Every field is timestamped and had to be genuinely available at the candidate
timestamp. Three rules are enforced structurally, not by convention:

1. **Missing stays missing.** Every optional field is `T | null` and every null
   carries a `MissingReason` in `evidence.missing`. Nothing is defaulted to 0,
   and 0 is never a stand-in for "unsourced". An observed open interest of 0 is
   preserved as a real 0 — but it makes the volume/OI ratio undefined, not zero
   and not infinite.
2. **Nothing is fabricated.** A catalyst named without a source is
   `REJECTED_UNSOURCED`, not downgraded to a guess. Greeks require a provider
   source. Relative volume requires a named same-time-of-day baseline. Volume
   acceleration requires an explicit bounded window. Levels require a level
   source.
3. **No future evidence.** Anything stamped after the candidate timestamp is
   refused with `EVIDENCE_FROM_FUTURE` and cannot reach the candidate.

An OCC symbol is accepted only when it parses AND agrees with the separately
supplied underlying, expiration, strike, and right. A disagreement refuses the
identity outright, which in turn refuses the quote — a candidate we cannot
identify carries no executable evidence at all.

A quote is executable only when bid > 0, ask ≥ bid, the provider event time
exists, is not in the future, sits inside the options session, belongs to the
same trading day, and is within `maxQuoteAgeMs` (default 60s).

## Outcome labels

Graded from verified exact-OCC marks. **Ask entry, bid marks** — no mid or
theoretical fill is ever assumed.

`OUTSIZED_500` · `OUTSIZED_200` · `OUTSIZED_100` · `OUTSIZED_50` ·
`ORDINARY_WIN` · `FLAT` · `FAILED` · `INSUFFICIENT_EVIDENCE`

- The `OUTSIZED_*` label comes from **MFE**: the move demonstrably happened.
- Otherwise the **final verified mark** decides: ≥ +10% `ORDINARY_WIN`,
  within ±10% `FLAT`, ≤ −10% `FAILED`.
- A candidate that peaked at +30% and closed at +18% is an `ORDINARY_WIN`. It is
  never promoted to outsized.

Tracked per candidate: returns at 1/3/5/10/15/30/60 minutes (null where no
qualifying mark exists — never 0), MFE, MAE, final verified result and its
timestamp, time to +25/+50/+100/+200/+500, whether a fresh executable exit quote
existed, and `outsizedMoveTiming`.

`outsizedMoveTiming` answers "before or after the chase": the same verified peak
bid is re-measured against the earliest valid executable ask. A move that clears
a threshold from the pre-chase baseline but not from the candidate's own ask is
`CONSUMED_BY_PREMIUM_CHASE` — it existed, but not for anyone entering there.

## Candidate states

`EARLY_ASYMMETRY` · `CONFIRMING` · `HIGH_ASYMMETRY` · `TRIGGERED` ·
`PREMIUM_CHASE` · `LIQUIDITY_FAILURE` · `INVALIDATED` · `INSUFFICIENT_EVIDENCE`

These are **evidence-coverage classifications, not predictions and not
subscriber readiness**. `HIGH_ASYMMETRY` means "fully described, sourced
confirmation, premium chase under 10%" — it does not mean the contract will
move. Precedence is fixed: evidence → liquidity → invalidation → premium chase
→ trigger → confirmation → early.

Unsourced confirmations, triggers, and invalidations are ignored. A confirmation
timestamped after the candidate cannot confirm it.

`RESEARCH_STATE_CAN_SEND` is a frozen table mapping **every** state to `false`,
and `canResearchStateSend()` returns `false` unconditionally. There is no
argument, flag, or state that flips it.

## Premium-chase analysis

Measured from the **earliest valid executable quote** for the exact same OCC
contract in the same session, to the ask at the candidate timestamp. A stale,
undated, future, after-hours, wrong-session, or wrong-OCC observation cannot
become the baseline, so the figure can never be inflated by a quote nobody could
have traded. Every refused observation is reported with its reason.

Buckets: `UNDER_10` · `PCT_10_15` · `PCT_15_20` · `PCT_20_25` · `OVER_25` ·
`UNKNOWN`. **Diagnostics only** — in this phase nothing is blocked, ranked, or
altered because of them. An unmeasurable chase is `UNKNOWN`, never 0.

## Cohort comparison

Compares `OUTSIZED` / `ORDINARY` / `FAILED` (with `UNGRADED` reported for
coverage) across relative volume, volume acceleration, volume/OI, option volume,
open interest, spread, distance to level, room beyond level, DTE, moneyness, IV
and IV change, prior underlying move, premium chase — plus categorical setup
family, time of day, session phase, catalyst state, market/sector alignment,
compression, liquidity, spread quality, and chase bucket.

Reports sample size, median, average, p25/p75 (only with ≥ 4 points), missing
count, and outcome rates. By construction it will not:

- assert causation — every output is a distribution summary;
- name a best or discriminating feature — `topFeature` is **always null** in
  Phase 1, and `sufficientEvidence` is false unless every compared cohort
  reaches the minimum sample (default 30);
- treat a missing value as a low value — missing values are excluded from every
  statistic and counted separately;
- describe a negative or empty cohort as profitable — there is no profitability
  verdict in this module at all.

A share of an empty cohort is `null`, not 0%.

## Data coverage — what is honestly unavailable today

The loader reads `options_research_observations` (candidate evidence and the
premium-chase baseline) and `options_paper_marks` (exact-OCC outcome marks,
matched by `option_symbol` so a mark can never be attributed to the wrong
contract). An absent table degrades to a warning and an empty cohort.

`KNOWN_UNSOURCED_FIELDS` — modelled but with **no persisted source yet**, left
null with a recorded reason and declared by the endpoint:

stock volume · relative stock volume · volume acceleration · implied volatility
and its change · gamma · relative strength vs SPY/QQQ/sector · sector alignment
· market alignment · confirmed catalysts · compression state · prior underlying
move.

Until each has a real source it contributes nothing rather than a fabricated
value. This is the single largest gap in the radar and the honest reason no
Phase 2 threshold can be set yet.

## Diagnostics

`GET /api/research/asymmetry?date=YYYY-MM-DD&limit=N` — token-gated, GET only,
SELECTs only. Exposes cohort sizes, outcome counts, outsized counts, research
state counts, premium-chase distribution, data coverage and missing-evidence
reasons, known-unsourced fields, feature comparison, and recent candidates.

Carries no webhook, token, URL, or Discord configuration, and no authority to
change live behaviour. `safety` renders `advisoryOnly: true`,
`productionBehaviorChanged: false`, `canSend: false`,
`isSubscriberPerformance: false`.

## Tests

- `tests/high-asymmetry-evidence.test.mjs` — future/stale/undated/after-hours/
  wrong-session/wrong-OCC refusal, unsourced catalyst rejection, source
  requirements, missing-never-zero, determinism, no input mutation.
- `tests/high-asymmetry-outcomes.test.mjs` — ask entry vs bid marks, threshold
  determinism at every boundary, ordinary win never promoted, wrong-OCC and
  stale marks cannot grade, evaluation-time bound, null horizons, MFE/MAE/
  time-to-milestone, premium-chase baseline selection and buckets,
  chase-consumed move timing.
- `tests/high-asymmetry-boundaries.test.mjs` — no state can SEND, frozen
  authority table, state precedence, unsourced signals ignored, **static import
  scan** proving no delivery/notification/paper/scanner/broker/AI/social import
  and no network or delivery call in any module, GET-only and secret-free route,
  empty and failing cohorts never described as profitable, missing values
  excluded from statistics.
- `tests/high-asymmetry-loader.test.mjs` — invalid date, absent tables,
  exact-OCC mark matching, undated observation refusal, chase anchoring,
  unsourced fields declared, evaluation-time bound, and a no-writes assertion.

52 focused tests. Full suite 2549 pass / 0 fail / 1 pre-existing skip;
`npx tsc --noEmit` clean; `npm run build` compiled.

## Safety boundaries

- Research only. Cannot send, rank, gate, or alter any live alert, contract,
  entry, stop, target, or paper position.
- Not imported by any live path. The scheduler, scanner, delivery, callout,
  paper, and notification code are unchanged and do not reference this module.
- No Discord publication, no Twitter generation, no subscriber messaging, no
  automatic contract buying, no strategy-weight changes.
- No new environment variable, no feature flag, no Railway change.
- No ML training and no opaque scoring — every classification is a readable
  deterministic rule.
- AI is not referenced anywhere in the module; it remains explanatory only.
- Outcome labels describe verified past exact-OCC option marks. They are **not
  predictions**, not subscriber performance, and imply no future gain for any
  candidate.

## Related notes

- [[safety]]
- [[Market Data]]
- [[Options Scanner]]
- [[Opportunity Lifecycle]]
- [[watchlist]]
- [[earlier-entry]]
- [[loss-protection]]
- [[AI Learning System]]
