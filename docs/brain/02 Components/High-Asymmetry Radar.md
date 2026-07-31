# High-Asymmetry Radar

Status: **DEPLOYED_UNPROVEN, ACTIVATED** — merged to `main`, live in production,
and all three flags are now SET by the owner. The runners are enabled and
executing, but the market has been closed since activation, so the radar has
still NEVER observed a live candidate. Zero cases exist.

Merged to `main` and deployed disabled. Everything below describes code that is
PRESENT in production but performing no work.

## Feature status

| Capability | Status |
| --- | --- |
| Evidence model, states, outcomes, cohorts, replay apparatus | RESEARCH_ONLY |
| Replay against real production data | LIVE_AND_VERIFIED (result: zero evidence, see below) |
| Owner-private notification path (`private-notify.ts`) | BUILT_DISABLED |
| Live intake admission core (`live-intake.ts`) | BUILT_DISABLED |
| Live call site in `options/loop.ts` | LOCAL_ONLY |
| Shadow-case persistence (5 tables) | LOCAL_ONLY |
| State-transition runner + notifier wiring | LOCAL_ONLY |
| Forward-mark scheduler + runner | LOCAL_ONLY |
| Outcome aggregation | LOCAL_ONLY |
| EOD Quant review (scheduled) | LOCAL_ONLY |
| AI advisory on measured results | LOCAL_ONLY |
| Private diagnostics endpoint | LOCAL_ONLY |
| Executed against a live candidate | MISSING |
| Merged / deployed / enabled | MISSING |

## The replay HAS now been run against real data (2026-07-30)

Superseding the earlier "could not be run" note. A consistent read-only
snapshot of the production database (1,357,881,344 bytes, `integrity_check: ok`,
130 tables) was taken via the SQLite online-backup API and replayed.

**Result: zero gradeable candidates, because `options_research_observations`
is EMPTY in production (0 rows).** Every coverage, cohort, exclusion, and
premium-chase count is 0 — not a measured zero, an absent one.

The cause is timing, verified rather than assumed: the writer
(`recordOptionsResearchObservation`, wired into `loop.ts` and `delivery.ts`)
arrived in commit `1bde178`, which is an ancestor of the deployed commit but
NOT of the prior production baseline `efaf2be`. It reached production at
16:41 ET on 2026-07-30 — 41 minutes after the 16:00 close, and 42 minutes after
the last candidate row was written at 15:59 ET. **No options session has yet
run with the capture writer live.**

The surrounding pipeline is healthy and full by comparison: 145,505 paper
marks, 632 paper trades, 868 options alerts, 2,212 alerts, 35,936 candidates.
Only the research-observation table is empty.

**Nothing here is evidence of strategy performance.** An empty research table
means evidence is absent.

What Phase 2 did instead was build the apparatus so a single command produces
them, and — by auditing the capture path in source — establish three structural
findings that do not need data to be true:

1. **Outcome marks only exist for contracts that became paper trades.**
   `options_paper_marks` is keyed by `trade_id`. A research candidate that never
   became an alert has no marks and can never be graded. So the OUTSIZED cohort
   can currently only contain contracts the system *already alerted on* — which
   is precisely the population the radar is supposed to be compared against.
   This, not any missing feature, is the binding constraint.
2. **Premium chase is structurally vacuous under the Phase 1 identity.** The
   candidate is the first observation of a contract, so the only quotes at or
   before it are its own; the earliest valid quote IS the candidate quote and
   `chasePct` can only ever be 0 or UNKNOWN. Counted explicitly as
   `candidatesWithVacuousPremiumChase`.
3. **A mark from a later session could pass the freshness check.** Marks are
   validated against their own observation time, so a next-day quote looked
   perfectly fresh. Found by a Phase 2 test and **fixed** in both
   `outcomes.ts` and `coverage-audit.ts`, which now require a mark to share the
   entry's trading day.

## Controlled activation (2026-07-31, market closed)

Owner set `HIGH_ASYMMETRY_CAPTURE_ENABLED=1`,
`HIGH_ASYMMETRY_PRIVATE_ENABLED=1`, and `HIGH_ASYMMETRY_PRIVATE_WEBHOOK`.
The webhook value has never been displayed, retrieved, or logged.

Verified live from `/api/research/asymmetry/live`:

- `privateNotification.enabled: true`
- `privateNotification.webhookConfigured: true`
- `refusedReason: null` — the **collision guard PASSES**, so the configured
  webhook is not equal to the alerts, watchlist, recap, or generic webhook
- `canSendSubscriber: false`, `automaticTrading: false`, `advisoryOnly: true`
- Runners now report `ran: true` instead of the flag reason

**Existing Discord routing is untouched:** `{options:true, watchlist:true,
recap:false}`; Recaps still `BLOCKED / never`; `sent24h 2`,
`lastSentAt 2026-07-30T22:01:11.886Z` — unchanged from before activation, so
**nothing has been sent**. `DISCORD_WEBHOOK_RECAP` was not modified.

### A real defect was found BY activating, and fixed

The first enabled EOD run reported:

    persisted:false  aiStatus:"OK"
    errors:["persist: no such table: asymmetry_daily_reviews"]

Two defects. The review wrote without calling `ensureAsymmetrySchema` (the case
and transition writers do), so on a zero-case session nothing had created the
tables and the measured review was silently lost — it would have started working
by accident after the first captured case, which is worse than failing outright
because the failure would look intermittent. And **AI ran anyway**: the ordering
was right but the model call was never made conditional on persistence
succeeding, so it explained a review that does not exist.

Fixed in `6c15d3b`: the review ensures its own schema, and AI is skipped with an
explicit reason when the review was not stored. Two regression tests written
against the exact production symptom.

## Production disabled-state proof (2026-07-31, commit `cdfcfc7`, pre-activation)

Deployment `5686432103` reached `success`. `/api/healthz` serves `cdfcfc7` with
`schemaOk: true`, `schemaMissing: []`, `missingLegacyColumns: []`,
`lifecycle.active: true`.

**All three scheduler jobs are registered and DID run**, each declining
correctly — this is the strongest available proof, because a job that never ran
would prove nothing:

    asymmetryTransitions  runs=1
    asymmetryMarks        runs=1   ran:false
                                   reason:"HIGH_ASYMMETRY_CAPTURE_ENABLED is not set"
                                   errors:[]
    asymmetryEod          runs=1   persisted:false  aiStatus:SKIPPED  errors:[]

`GET /api/research/asymmetry/live` → 200: `activeCases 0`, `stateCounts {}`,
`recentTransitions 0`, `outcomes 0`, `eodQuantReview null`,
`privateNotification.enabled false`, `webhookConfigured false`,
`canSendSubscriber false`, `automaticTrading false`. No webhook value is
returned anywhere — configuration is reported by presence only.

**The five asymmetry tables do NOT exist on the production volume, and that is
correct.** `ensureAsymmetrySchema` is called only from inside the write
functions, which never execute while the flag is unset — so "zero work" means
zero, including zero DDL. They are created lazily and idempotently on the first
enabled write. The diagnostics route returned 200 with zeros rather than an
error, proving it degrades gracefully against absent tables.

**Nothing was sent.** Discord is byte-identical to the pre-deploy baseline:
`sent24h 2`, `failed24h 0`, `lastSentAt 2026-07-30T22:01:11.886Z`, webhooks
`{options:true, watchlist:true, recap:false}`. No recap variable was touched.

**Existing behaviour unchanged.** Scanner `running: true`; `/`, `/watchlist`,
`/callouts`, `/quant`, `/discord`, `/paper`, `/ai` all 200.

## The connected runtime graph

Every node now has a real caller or scheduler. Verified by Graphify as 1-hop
`calls` edges, not by documentation:

    runOptionsCandidate -> captureAsymmetryCandidate -> openAsymmetryCaseOnDb
    asymmetryTransitionsJob -> runAsymmetryTransitions -> recordTransitionOnDb
                                                       -> notifyPrivateAsymmetry
    asymmetryMarksJob -> runDueAsymmetryMarks -> writeMarkOnDb
                                              -> aggregateOutcomesOnDb
    asymmetryEodJob -> runAsymmetryEodReview -> buildDeterministicReview -> (injected AI)
    observeAsymmetryCase -> liveAsymmetryQuote -> buildLiveGradeDeps().getQuote

Callers: the live options loop calls capture; the scheduler beat runs
`asymmetryTransitions` (60s), `asymmetryMarks` (60s due-work), and
`asymmetryEod` (hourly, idempotent per trading day). All five tables have both
a writer and a reader.

**Graphify caveat, stated honestly.** Graphify confirms 7 of the 10 edges as
direct 1-hop `calls`. The three scheduler -> runner edges are NOT provable by
Graphify: the scheduler uses dynamic `require()` (26 of them, the established
convention for every job in this file), which the AST extractor cannot resolve.
Querying those pairs returns an incidental multi-hop path through `tradingDay`,
which is NOT proof. The pre-existing `watchlistPlanningJob` shows the identical
artefact, so this is a tool limitation across all scheduler jobs rather than a
weakness in this wiring. Those three edges are proven instead by source
(`scheduler.ts:457/462`, `477/482`, `497/502`) and by assertions in
`tests/high-asymmetry-quote-provider.test.mjs` and the graph-acceptance suite.

**An architectural boundary was violated and fixed properly.** The AI explainer
was first written inside `lib/research/asymmetry/`, which broke two existing
spec tests: model calls are forbidden outside `lib/ai/`, and no asymmetry module
may import an AI path. Rather than weaken either test, the call moved to
`lib/ai/asymmetry-explain.ts` and the scheduler injects it into the EOD review's
`explain` hook. The dependency now points AI -> research, never the reverse, and
the radar still imports no AI.

**AI cannot affect a measured result.** The deterministic review is persisted
BEFORE `explain` is invoked — asserted by a test comparing source offsets. An AI
failure yields `aiStatus: FAILED` and leaves the review row intact.

**The quote provider was wrong and is now verified.** The adapter was first
written against `getOptionQuoteSnapshot` — a function that DOES NOT EXIST
anywhere in the repo. Every fetch would have thrown, been swallowed, and
recorded as NO_QUOTE, so marking would have degraded to "no data" forever while
appearing healthy. Nothing caught it because every test injected a fabricated
quote function. It now uses `buildLiveGradeDeps().getQuote(occ, underlying)` —
the same path live grading uses, so metered data-access boundaries are
respected. Three real differences from the guess: it is ASYNC, it needs the
UNDERLYING symbol as well as the OCC, and the timestamp field is
`providerTimestamp`. A dedicated suite now binds adapter to provider and fails
if they drift.

**A provider outage is not a missing quote.** `PROVIDER_ERROR` is recorded
distinctly from `NO_QUOTE`, so an outage can never be misread as a contract
that genuinely had no market.

**Marks are due-work, not timers.** Each sweep computes which of the seven
horizons have elapsed and are unrecorded, so a redeploy loses no horizon and a
replayed sweep writes nothing (PRIMARY KEY on session+fingerprint+horizon).
Entry is the ASK and marks are the BID — conservative on both sides, asserted.

## The first real runtime edge (previous checkpoint)

`options/loop.ts` now imports and calls `captureAsymmetryCandidate`, placed
immediately after the existing `recordOptionsResearchObservation` call for
`CONTRACT_SELECTED` — where the exact OCC is legitimately known and subscriber
qualification has NOT finished. The radar therefore sees contracts the
subscriber pipeline may go on to reject.

    options loop -> captureAsymmetryCandidate -> decideLiveIntake -> openAsymmetryCaseOnDb

This is the first time any asymmetry module has a production caller. Verified
by test, not assumption: one assertion fails if the import is removed, another
if the call is removed, another if the result is ever assigned or branched on.

**Isolation.** `captureAsymmetryCandidate` never throws — every path sits in one
try/catch returning a result. The call site discards that result, so it cannot
alter the callout, the delivery decision, paper linkage, or any SEND. Tested
against an exploding database and malformed input.

**Off by default.** Without `HIGH_ASYMMETRY_CAPTURE_ENABLED=1` it returns
DISABLED having touched no database — asserted with a spy that fails if any
statement is prepared. This flag is SEPARATE from the notification flag: capture
is silent research and can run alone.

**Persistence.** Five additive tables, all `CREATE TABLE IF NOT EXISTS`, no
destructive DDL (asserted). One active case per fingerprint is enforced by the
PRIMARY KEY `(session_date, fingerprint)`, not by a read-then-write race, so a
duplicate tick cannot create a second case. The FIRST detection wins — a later
observation never overwrites the early ask, because the early price is the whole
measurement.

**Lead time is unknown until proven.** Before the subscriber pipeline qualifies
the same contract, `leadMs` and `premiumAvoidedPct` are NULL, not 0. Reporting
zero there would invent an edge that was never measured.

## Live intake admission core — BUILT_DISABLED

`lib/research/asymmetry/live-intake.ts`. PURE decision function, now reached
from the live loop via `capture.ts`. It is NOT deployed, so the radar still
observes nothing in production.

Its purpose is to admit candidates EARLIER and with FEWER hard gates than the
subscriber pipeline. The subscriber path is conservative because a bad SEND
costs money; the radar's job is the opposite — observe before premium expands
and record what was knowable at that moment. Applying subscriber gates here
would reject exactly the early, incomplete candidates worth studying.

**Hard blockers** (observation untrustworthy or duplicate): no exact OCC,
contract identity mismatch, no executable quote, unusable spread (>35% of mid),
zero open interest, future/stale/wrong-session evidence, duplicate active case,
explicit invalidation.

**Labelled and admitted anyway**: missing catalyst, market/sector alignment,
IV, Greeks, relative volume, volume acceleration, compression state, level
distances, prior move, VWAP relationship, OI, option volume.

Two properties worth keeping: an *observed* open interest of 0 is data and is
NOT labelled absent, whereas a null is; and `computeLeadTime` returns null —
not zero — when the subscriber alert never fired, because "never happened" and
"zero lead" are different facts.

## Owner-private notification path — BUILT_DISABLED

`lib/research/asymmetry/private-notify.ts`. Code-complete, inert by default,
and safe to merge while disabled. It is a message formatter with gates; it is
**not** an active radar and it surfaces nothing today.

Five gates, each enforced in code and asserted by test:

1. **Off by default.** Requires `HIGH_ASYMMETRY_PRIVATE_ENABLED=1` AND a
   non-empty `HIGH_ASYMMETRY_PRIVATE_WEBHOOK`. Only the literal `"1"` enables.
2. **No subscriber fallback.** The webhook comes from ONE dedicated variable.
   There is no `?? DISCORD_WEBHOOK_*` anywhere, a test strips comments and
   asserts the module reads no subscriber variable, and a configured value that
   EQUALS any of `DISCORD_WEBHOOK_URL/OPTIONS/STOCKS/WATCHLIST/RECAP` is
   refused outright — a copy-paste mistake cannot route research to subscribers.
3. **No send authority.** Imports only `./states.ts`. `subscriberSendCreated` is
   typed `false`, and every one of the 8 states returns false from
   `canResearchStateSend`.
4. **Only early states surface.** `EARLY_ASYMMETRY`, `CONFIRMING`,
   `HIGH_ASYMMETRY`, `TRIGGERED`. `PREMIUM_CHASE`, `LIQUIDITY_FAILURE`,
   `INVALIDATED`, `INSUFFICIENT_EVIDENCE` are suppressed — surfacing a chased
   candidate as early is exactly the failure the radar exists to avoid.
5. **Noise controlled.** One case per fingerprint, state-change only, and a
   per-symbol-per-session ceiling (default 4).

Failure is contained: a rejecting or throwing sender returns `SEND_FAILED`
rather than propagating, and a failed send does not consume the dedupe slot.
Missing evidence renders as `unavailable`, never as `0`.

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

Added in Phase 2:

| File | Role |
| --- | --- |
| `lib/research/asymmetry/db-read.ts` | The one SELECT-only read primitive per source; tolerates legacy schemas |
| `lib/research/asymmetry/coverage-audit.ts` | Data-availability audit and single-attribution exclusion taxonomy |
| `lib/research/asymmetry/identity.ts` | Candidate identity strategies and the duplicate-detection audit |
| `lib/research/asymmetry/historical-examples.ts` | Import contract where a screenshot cannot carry a price |
| `lib/research/asymmetry/source-priority.ts` | Missing-source ranking by cost to obtain, never by assumed power |
| `lib/research/asymmetry/replay.ts` | Read-only, idempotent replay orchestrator |
| `app/api/research/asymmetry/replay/route.ts` | Token-gated, GET-only replay diagnostics |
| `scripts/asymmetry-replay.mjs` | Offline CLI; opens the database `readonly: true` |

### How to actually get the numbers

```
node --experimental-strip-types scripts/asymmetry-replay.mjs --db <path-to-optiscan.db>
```

The file is opened `readonly: true, fileMustExist: true`, so the script cannot
write to it even if a future edit tried. Point it at a **copy** of the
production database. `--dates`, `--sessions`, `--identity`, `--at`, and `--json`
are supported; `--at` pins the evidence horizon so a run is reproducible.

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
value.

What the capture path *can* persist today, verified in source: `loop.ts` writes
symbol, direction, strategy family, underlying price, exact OCC, option type,
strike, expiration, DTE, bid, ask, spread, provider quote timestamp, quote age,
option volume, open interest, delta, freshness, candidate state and blockers.
It never writes VWAP, structure, momentum, relative state, IV, gamma, or a
thesis fingerprint — those columns exist and stay NULL.

The read tolerates a legacy schema: `db-read.ts` probes `PRAGMA table_info`
first and selects only columns that exist, so a database predating a migration
degrades to nulls instead of failing the whole read and looking like "no
evidence".

## Duplicate detection and candidate identity

The scanner re-observes a contract on every tick while it stays a candidate, and
`loop.ts` writes three to four observations per detection at the *same*
millisecond (`CONTRACT_SELECTED`, `QUOTE_VALIDATED`, `READY`). One OCC therefore
routinely carries many observations per session.

`auditDetectionClusters` reports, per contract: observation count, cluster count
at **four** probed quiet-gap widths (5 / 15 / 30 / 60 minutes), the largest
gaps, distinct candidate states, and distinct thesis fingerprints. Reporting a
curve rather than one number keeps this an audit and not a tuned threshold.

Three identity strategies exist:

- `OCC_SESSION_FIRST_OBSERVATION` — **the active default, unchanged.**
- `OCC_SESSION_CLUSTER` — splits on a bounded quiet gap.
- `OCC_SESSION_FINGERPRINT` — splits on the persisted `thesis_fingerprint`.

`recommendIdentity` prefers fingerprint evidence when it exists, falls back to
cluster evidence, and returns `INSUFFICIENT_EVIDENCE` with no data. **The
default did not change**, because changing it requires real evidence and there
is none yet.

A relevant capture fact: `thesis_fingerprint` is written by `delivery.ts` only
(`DEDUPED` / `PAPER_LINKED` / `SENT`). Candidate-lifecycle observations from
`loop.ts` persist it as NULL, so the fingerprint identity is currently
available only for contracts that reached delivery.

## Historical example import contract

A known "this went up 800%" example is a valuable lead and worthless evidence.
The separation is structural, not a rule to remember:

- `HistoricalExampleReference` (screenshot, article, post, chart, broker
  statement) declares **no numeric price, return, or quote field at all**, so no
  code path can read a return off one. A test asserts the interface stays that
  way.
- `quoteEvidence` is the only channel carrying prices, and every quote is
  revalidated by the same `validateExecutableQuote` used everywhere else.
- Missing exact OCC → `PENDING_EXACT_OCC`. Missing timestamp →
  `PENDING_CANDIDATE_TIMESTAMP`. Missing independently sourced quotes →
  `PENDING_QUOTE_EVIDENCE`. Each is retained as a lead, never as an outcome.
- An accepted example is graded by the standard engine with no relaxed rule; a
  stale mark is refused exactly as it would be for a persisted candidate.
- A claimed return in a submission note is never read, parsed, or reported.

## Data-source priority

`source-priority.ts` ranks missing fields by **cost to obtain and reach** —
provider support, implementation effort, ongoing API cost, and backfillability.
It explicitly does **not** rank by predictive power: every field carries
`discriminationEvidence: "UNMEASURED_HYPOTHESIS"`, because no outsized cohort
exists to measure against. Each provider claim cites the repo file that proves
it, so the table can be re-verified rather than trusted.

The two recommendations, in order:

1. **Forward outcome marks for non-alerted research candidates.** Without this
   nothing else matters — the graded population stays limited to contracts
   already alerted on, and the ordinary-versus-outsized comparison is
   impossible in principle. Uses the present-time snapshot call that already
   exists. Forward-only; cannot be backfilled.
2. **Implied volatility (and gamma).** `fetchOptionChain` already records a
   `greeks` sample and `live-deps.ts` already maps
   `iv: c.iv ?? c.implied_volatility`. The value is in hand at scan time and is
   simply dropped before persistence — this is a column plus a writer argument
   at **zero additional API cost**. Gamma is one mapping line further.

Relative volume, volume acceleration, prior underlying move, and relative
strength are all computable from `/v2/aggs`, which is already entitled, and are
**backfillable** onto candidates already captured — making them the natural
third step. Historical option quotes are `NOT_AVAILABLE`: the integration
provides only a present-time `/v3/snapshot/options`, so past candidates can
never be graded retroactively and only forward capture will ever work.

## Diagnostics

`GET /api/research/asymmetry?date=YYYY-MM-DD&limit=N` — token-gated, GET only,
SELECTs only. Exposes cohort sizes, outcome counts, outsized counts, research
state counts, premium-chase distribution, data coverage and missing-evidence
reasons, known-unsourced fields, feature comparison, and recent candidates.

`GET /api/research/asymmetry/replay?dates=&sessions=&limit=&identity=&at=` —
token-gated, GET only, SELECTs only, `writesPerformed: 0`. Exposes the data
availability audit, the exclusion taxonomy, gradeable counts per horizon, real
cohort counts, the duplicate-cluster audit with its recommendation, the source
priority ranking, and recent replay rows.

No manual replay action writes anything. A dedicated research table was
considered and **not** added: every output is deterministic from persisted
evidence, so persistence would add a migration and a staleness risk to buy
nothing. That keeps the additive/repeat-safe migration review trivially empty.

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
- `tests/high-asymmetry-replay.test.mjs` — empty database reports absent
  evidence rather than a zero result, evidence-horizon bound, **cross-session
  marks refused**, exact OCC mandatory, stale and after-hours excluded with
  distinct reasons, exclusion counts sum exactly to the ungradeable population,
  horizon absence is false rather than 0%, replay is idempotent, and it runs
  against a genuinely `readonly: true` sqlite handle.
- `tests/high-asymmetry-identity.test.mjs` — repeated observations are not
  double-counted, cluster sensitivity across gap widths, boundary-exact
  splitting, fingerprint separation, vacuous chase surfaced, the default
  identity does not change itself, no recommendation without evidence, and the
  source ranking never claims measured predictive power.
- `tests/high-asymmetry-historical-examples.test.mjs` — a screenshot is a lead
  and never an outcome, a claimed return never reaches the report, the
  reference interface carries no price field, wrong-contract quote evidence is
  refused, and accepted examples get no relaxed rule.

87 focused tests. Full suite 2587 pass / 0 fail / 0 skipped;
`npx tsc --noEmit --incremental false` clean; `npm run build` compiled with both
research routes present; `git diff --check` clean; no migration added.

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
- The replay writes nothing: `writesPerformed: 0`, SELECT-only, no migration.
  The CLI opens the database `readonly: true` so it cannot write even by
  mistake.
- Zero gradeable candidates means the **evidence is absent**, never that a
  strategy performed at zero. Asserted by test.
- No screenshot, article, or social post can supply a price to the radar.

## Paper-trading lane (added 2026-07-30) — BUILT_DISABLED

Every qualifying shadow case automatically creates and manages an owner-private
SIMULATED position. Nothing here can place a real order, create a subscriber
SEND, or touch a subscriber paper trade.

### Why a separate TABLE, not a separate column value

The existing paper population lives in `options_paper_trades`, separated by
`paper_kind` (DELIVERED_ALERT_PAPER / RESEARCH_ONLY_PAPER /
ZERO_DTE_RESEARCH_PAPER / BEARISH_RESEARCH_PAPER). Adding a fifth kind would
have put research P&L one forgotten `WHERE` clause away from a subscriber win
rate. `asymmetry_paper_positions` is a different table, so no existing query
can absorb it by accident. Asserted by test.

### Runtime graph

| Node | Caller | File | Trigger | Reads | Writes |
| --- | --- | --- | --- | --- | --- |
| capture | live options loop | `capture.ts` | CONTRACT_SELECTED | — | `asymmetry_cases` |
| state sweep | scheduler `asymmetryTransitions` | `transition-runner.ts` | 60s | cases | `asymmetry_transitions` |
| paper entry | scheduler `asymmetryPaper` | `paper/entry.ts` | 60s | cases | `asymmetry_paper_positions` / `_skips` |
| management | scheduler `asymmetryPaper` | `paper/runner.ts` | 60s | positions | `asymmetry_paper_marks`, positions |
| Quant | scheduler `asymmetryEod` | `paper/quant.ts` | hourly | positions, skips | `asymmetry_quant_reports` |
| report delivery | scheduler `asymmetryEod` | `paper/report-delivery.ts` | hourly, once/session | review | `asymmetry_paper_report_delivery` |
| AI advisory | scheduler `asymmetryEod` | `lib/ai/asymmetry-explain.ts` | after persistence | review | `asymmetry_ai_cache` / `_ledger` |

Graphify resolves every intra-lane edge as `calls [EXTRACTED]`. The three
scheduler -> runner edges remain unresolvable for the documented reason: the
scheduler uses dynamic `require()` for all 26 of its jobs. Those are proven by
source and by `tests/high-asymmetry-paper-graph.test.mjs` instead.

### Decisions worth remembering

- **Entry is the ask, marks and exits are the bid.** Conservative on both sides.
  A mid fill would flatter every result in this lane by roughly a full spread,
  and it would also disagree with `asymmetry_outcomes`, which already grades
  from `early_ask`.
- **An unobtainable exit is UNVERIFIED, not a loss.** When an exit rule fires
  and no valid bid exists, the position stays OPEN with the reason recorded and
  a bounded retry count. It is never closed at zero. Every return statistic uses
  only VERIFIED exits; the rest is reported as `missingDataRate`.
- **Sizing that cannot be computed is null, never zero contracts.** A zero-size
  position would enter the cohort having risked nothing and returned nothing —
  a fabricated data point.
- **One position per (session, symbol, direction, exact OCC, setup).** Enforced
  by the PRIMARY KEY, not by a read-then-write check, because the 60s sweep and
  the live loop run in the same process.
- **`listCasesOnDb` had to start returning `setup_family`.** It is part of the
  position identity; inferring it would have collapsed every fingerprint to
  `NO_SETUP` and silently merged distinct setups into one position.
- **TIME_STOP outranks SESSION_END.** A position still open at the bell after
  hours of going nowhere should say so; "closed at the close" would hide why it
  was still open.
- **Quant proposes, never activates.** Every proposal is emitted
  PROPOSED / NOT_IMPLEMENTED and nothing reads one back into a threshold.
  Cohorts are separated by `rules_version` and never pooled across versions.
- **Empty cohorts are null, never 0%.** A count of zero trades is a fact; a win
  rate over zero trades is not.

### AI cost controls

AI is OPTIONAL and strictly severable. The complete paper runtime — entry,
sizing, marks, exits, grading, cohort statistics, the EOD report — has zero
dependency on any AI module, asserted by a test that scans every file in the
lane and by one that runs a full cycle and checks no `lib/ai` module was loaded.

- ONE advisory call per trading session, after the deterministic review is
  persisted. Never per candidate, quote, mark, transition, or paper update.
- Cached by (trading date, review version); a duplicate run reuses the summary.
- Daily and monthly limits; at the limit the status is `AI_BUDGET_BLOCKED` and
  deterministic processing continues untouched.
- Only `CALLED` consumes budget — blocked, cached, and failed do not.
- Costs are ESTIMATED from character counts and labelled as such: the advisory
  layer does not return provider usage, and a precise-looking fabricated number
  would be worse than an open estimate.
- Nothing buys credits or enables auto-reload.

### Defect found and fixed while building this

`notifyPrivateAsymmetry` takes an OPTIONAL injected `send`, and the scheduler
never injected one. With capture enabled, private notifications enabled, and a
webhook configured — the exact production state as of 2026-07-30 — every
notification returned `NOT_CONFIGURED` ("no sender injected"). **No owner-private
message could ever have been delivered**, while diagnostics reported
`enabled: true, webhookConfigured: true` throughout.

Fixed by `lib/notifications/asymmetry-private-send.ts`, injected by the
scheduler. It lives outside `lib/research/asymmetry` on purpose so the radar's
boundary rule — no file under that directory may contain a network call — stays
absolute. That boundary test was also broadened to sweep `paper/`, which it had
not been covering.


## Related notes

- [[safety]]
- [[Market Data]]
- [[Options Scanner]]
- [[Opportunity Lifecycle]]
- [[watchlist]]
- [[earlier-entry]]
- [[loss-protection]]
- [[AI Learning System]]
