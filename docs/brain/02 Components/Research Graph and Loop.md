# Research Graph and Loop

Graph Engineering and Loop Engineering memory for the OptiScan research arm.
Updated 2026-08-21 (4). Companion to the AST graph in `graphify-out/` — that one is
generated, this one records the parts a parser cannot see: which identity a consumer
joins on, and which of them fail SILENTLY when the join is wrong.

---

## GRAPH — the live dependency chain

Read the identity column first. Every defect this repository has recorded in the last
month was a consumer joining on an identifier the object does not carry, returning the
empty set, and reporting it as a quiet day.

| # | Stage | Owns | Joined by | Silent-failure risk |
|---|---|---|---|---|
| 0a | **WHOLE-MARKET SOURCE** | `fetchMarketSnapshot()` — 13,132 rows, ONE call, 5s TTL, shared | endpoint TTL | Every lane below reads this same response; a second fetcher would double the cost invisibly |
| 0b | **MARKET DISCOVERY ELIGIBILITY** | `marketDiscoveryEligible()` — >= $1, >= $10M, >= 10% move, **NO ceiling** | symbol | Was the SAME function as trading eligibility; the $50 ceiling silently decided what could be LOOKED at |
| 0c | **MARKET MOVER OBSERVATION** | `market_mover_observations` (first observation IMMUTABLE, peak advances) | `(session_date, symbol)` | Zero live authority. If this is empty the coverage loop reads as "nothing was missed" |
| 0d | BROAD STOCK MOMENTUM | `broadStockEligibility()` — $0.50-$50 TRADING gate | symbol | Unchanged and still ceilinged. This is the gate that MAY refuse a $120 stock |
| 0e | **TIER-2 PRIORITISATION** | `selectTier2Cycle()` — 15 exceptional + rotation, 25 slots | rank, then rotation cursor | Was `.slice(0,25)` of provider order: 1.9% of a 1,347 universe, the same 25 forever |
| 0f | **WATCHLIST ADMISSION** | `allocateAdmissionSlots()` — banded, guaranteed CORE+SECTOR, bounded momentum, rotated fill | tier band, then rotation cursor | Was `.sort().slice(0,60)` of a 78-symbol curated list: the whole XL* family cut on every run, and a slice never fails |
| 0g | **WATCHLIST MOMENTUM FEED** | `momentumCandidatesFromMoversOnDb()` — reads 0c, costs ZERO provider requests | `(session_date, symbol)` | If 0c is empty this silently contributes nothing and the watchlist looks merely curated |
| 1 | LIVE OPPORTUNITY | `options_candidates`, the pending audit case | `opportunity_fingerprint` | — |
| 2 | STRATEGY EVALUATION | `case_json.strategyEvaluations[]` (~27 per case) | **`strategyId` of the SELECTED strategy** | Reading `[0]` or the strongest reports a strategy that was never traded |
| 3 | CALLOUT | `discord_deliveries` (`owner_intraday_actionable`, `OPENING`, `SENT`) | `opportunity_case_id` | The only proof an owner was *told*; a mirror proves only that a trade was tracked |
| 4 | OWNER CASE | the CLAIM `opportunity_cases` row minted at delivery | `opportunity_id` | **Two case rows per callout.** The pending audit case owns the observation; the claim case owns the mirror |
| 5 | EXACT OCC MIRROR | `options_paper_trades` where `paper_kind='OWNER_VALIDATION_PAPER'` | `feature_snapshot_json.opportunityCaseId` | **`alert_id` is NULL on every owner row** — 0 of 74. Six consumers joined on it and all returned the empty set |
| 6 | MARKS | `options_paper_marks` | `trade_id` **AND** `option_symbol` | A mark on a re-selected strike is a different instrument; it must never enter this decision's excursion |
| 7 | GRADING | realized return, MFE/MAE recomputed from same-contract marks | mirror id | Stored `mfe_pct` is wrong on 36 of 78 delivered cases — never read it |
| 8 | PRE_MOVE V1 | `opportunity_pre_move_discovery` (V1 columns) | the PENDING case id, claim id as fallback | Promotion keyed on the claim id alone matched ZERO rows for its entire life |
| 8b | **PRE_MOVE V2** | same row, `v2_*` columns | same two ids | `v2_captured=0` means NOT a V2 row — excluded, never counted UNGRADABLE |
| 9 | OWNER LEARNING | `buildOwnerLearningReportOnDb` | `owner-mirror-identity.ts` | The single resolver; a seventh consumer must not reinvent the broken one |
| 10 | NIGHTLY RESEARCH | `buildAiResearchContextOnDb` | the report above | An absent section reads exactly like a quiet one |
| 11 | WEEKLY RESEARCH | `runWeeklyResearchOnDb` + the same context | week key | Same |
| 12 | HISTORICAL PROBABILITY | `HISTORICAL_COHORT_V1:paperKind=OWNER_VALIDATION_PAPER` | case ids via the mirror | A null `session_date` is an independence count of ZERO, not a missing label |
| 13 | SHADOW EXPERIMENT | `OWNER_SELECTION_STRENGTH_GATE_V1` scoreboard | owner learning rows | Both arms must share ONE population; 41 vs 67 is two populations |
| 14 | PRIVATE APP | `/api/research/command-center` | the builders above | — |
| 15 | ASK OPTISCAN | `advisory-chat` + `explain-target` | **stable IDs only** | A trade resolved from ticker text has more than one answer |
| 16 | OWNER DISCORD | `DISCORD_WEBHOOK_RECAP` / owner opening | — | — |
| 17 | SUBSCRIBER DISCORD | `options_alerts` + `DELIVERED_ALERT_PAPER` | `alert_id` | **Structurally cannot see an owner callout** — that is the safety property |
| 17b | **EXECUTABLE MEASUREMENT** | `measureExecutableOpportunityOnDb()` — joins 0c + `options_research_observations` + `asymmetry_outcomes` + `contract_funnel_evidence` | `(session_date, symbol)`, then exact OCC | ZERO provider requests. A mover with no NBBO gets a NULL ladder; a zero there would be a claim nobody could have had |
| 18 | CONTENT EVENT | `opportunity_content_events` | `contentEventId(caseId, type, materialDiscriminator)` | The discriminator carried `nowMs`, so `INSERT OR IGNORE` could never collide and one case emitted events forever |
| 18a | **CONTENT GATE** | `gateContentBundle()` — dedupe → worthiness → coherence → rank | `semanticContentFingerprint` (symbol, side, category, session, thesis digest, milestone, evidence state) | The old fingerprint included the event id, so the UNIQUE constraint on `content_drafts.fingerprint` deduplicated nothing — 200 rows, 62 distinct texts |
| 18b | CONTENT / TWITTER | `content_drafts` → `DISCORD_WEBHOOK_CONTENT` (a NOTICE, not the copy) | `verifyContentClaimForCase` | Requires a SENT alert with a delivered mirror; an owner callout has neither |
| 18c | **CONTENT FEEDBACK** | `contentFeedbackReportOnDb()` — approval/rejection aggregates | `content_drafts.approved_at_ms` / `rejected_at_ms` | These columns were written since the table existed and had NO reader. `scoreContentWorthiness` cannot import this module, so preference can never promote something the verdict refused |

### Shared fields and every downstream consumer

Before changing one of these, this is the list to walk.

- **`opportunity_case_id`** — the pending/claim pair. Consumers: pre-move V1 + V2,
  owner mirror identity, owner learning, cohort membership, content claim integrity,
  explain-target. `preMoveCaseIdForFingerprint` derives the pending id as a pure
  function of the fingerprint; it is never stored.
- **`option_symbol` (exact OCC)** — mirror, marks, excursion, cohort, content, explain.
  An OCC mismatch is CENSORED, never priced.
- **`paper_kind`** — the ONLY thing separating owner from subscriber in one table.
- **`session_date`** — independence counting everywhere. Validated: a weekend never
  counts toward a floor.
- **`v2_captured`** — divides the V2 population from everything that predates it.
- **`content_drafts.fingerprint`** — SEMANTIC now, and the only thing preventing a repeated unchanged event from regenerating the same draft. It must never again include the content-event id, the draft id, a template variant or a timestamp: every one of those is unique per generation, which is how idempotency-for-retries got mistaken for deduplication.
- **`contract_funnel_evidence.terminal_reason`** — records how the funnel ENDED, and `CONTRACT_SELECTED` is the SUCCESS value. Reading any non-null value as a refusal does not produce a slightly wrong number; it inverts the finding. Consumers: the executable measurement, the missed-opportunity panel.
- **the 280/minute provider partition** — the one quota every lane competes in, and the
  dependency most easily changed by accident. Consumers and their 2026-08-19 spend:

  | Consumer | Reserve/min | Requests | Refusals | Note |
  |---|---|---|---|---|
  | `scanner` | 58 | 31,804 | 1,904 | live safety, highest priority |
  | `options_paper_mark` | 44 | 32,934 | 108 | exact open positions — NOT starved |
  | `asymmetry_mark` | 44 | 748 | **17,483** | fired its whole backlog at a 44/min reserve |
  | `options_discovery` | 28 | 11,740 | 1,097 | |
  | `asymmetry_discovery` | **none** | 393 | 1,647 | shared pool only; asked for a flat 120/sweep |
  | `alert_capture` | 5 | 127 | 0 | |
  | everything else | none | < 600 | ~21 | |

  **The reserve architecture was working.** No live or execution lane was starved: one
  research lane generated 79% of the session's 22,260 refusals by itself. Before changing
  a reserve, check whether the lane is being refused or refusing itself.
- **`remainingMinuteAllowance(consumer, stats)`** — the answer to "may *I* spend", read
  from a lane's OWN partition. NOT the same question as `nearMinuteBudget(getCallStats())`,
  which asks "is the MINUTE nearly full". Answering the second with the first surrenders a
  reserve that exists precisely to be spent when the minute is busy. Consumers:
  `mark-runner`, `transition-runner`. `nearMinuteBudget` callers (`paper-engine`,
  `scanner-loop`, `position-callout`, `options/monitor`) still ask the global question —
  **unreviewed, and worth reviewing**: with the partition in place, other lanes alone can
  reach at most 236/280 (84.3%), so a 0.9 deferral fraction can only trip once the lane
  asking has itself spent some reserve.

---

## LOOP — what runs without the owner

```
OBSERVE      scanner tick → pre-move V1 observation (write-once detection)
   ↓
CALLOUT      delivery-decision → Discord opening → exact-OCC mirror
             → pre-move V1 alert promotion
             → PRE_MOVE V2 alert-instant snapshot        ← NEW, write-once at the send
   ↓
TRACK        marks on the frozen contract only
   ↓
GRADE        realized return, MFE/MAE recomputed, path label, stop/gap evidence
   ↓
LEARN        owner learning report → findings store
   ↓
COMPARE      historical cohort probabilities (20 trades / 5 independent sessions)
   ↓
SHADOW TEST  OWNER_SELECTION_STRENGTH_GATE_V1 scoreboard, prospective only
   ↓
PROSPECTIVE  nightly (after 20:15 ET, trading weekdays) — deterministic first,
VALIDATION   AI narration second and optional
             weekly (Fri ≥21:00 ET or Sat) — the ONLY place an experiment status moves
   ↓
HUMAN REVIEW /research/command-center · Explain This · READY_FOR_HUMAN_REVIEW at most
   ↓
OBSERVE AGAIN
```

### What is automatic

- The scanner loop, the callout, the mirror, the marks and the grading.
- **Both** pre-move captures. V2 needs no separate job: it writes at the send.
- The nightly and weekly schedules, both gated on the combined `$20/month` AI cap and
  both structured so the deterministic half survives any model failure.
- The experiment scoreboard, recomputed on every read from persisted outcomes.

### What is NOT automatic, by construction

- Promotion of any experiment. The best reachable status is `READY_FOR_HUMAN_REVIEW`.
- Subscriber enablement. A named human act, taken elsewhere.
- Posting to X/Twitter. Drafts are generated, held and copied by hand.
- Any change to a threshold, target, stop, exit or ranking weight.

### The COVERAGE loop — added 2026-08-19

The loop above can only learn from symbols OptiScan already observed. MRNA proved that is
not enough: it moved +133%, was never admitted to any universe, and therefore was never
strategy-rejected. The missed-opportunity forensic returned `evidenceQuality: NONE` —
"the system never quoted one" — because reaching the verdict that names this failure
(`OUTSIDE_DISCOVERY_UNIVERSE`, classifier step 2) requires passing `hadQuoteEvidence`
(step 1). **The loop that exists to notice a giant miss could not notice it, because
noticing required having already looked.**

```
MARKET               whole-market snapshot (already paid for by discovery)
   |
INDEPENDENT          marketDiscoveryEligible + rankMarketMovers
DISCOVERY            no price ceiling; observation eligibility only
   |
OBSERVED / MISSED    market_mover_observations   ← first observation IMMUTABLE
   |
RECONSTRUCT          reconstructSymbol() over OptiScan's own tables
   |
CLASSIFY             NOT_ADMITTED_TO_UNIVERSE | ADMITTED_NOT_QUOTED | OBSERVED_BY_OPTISCAN
   |
QUANTIFY             COVERAGE scope — move, phase, lag, peak
                     EXECUTABLE_FROM_SHARED_EVIDENCE — the QUOTED subset, joined from
                     rows already paid for, ZERO provider requests
                     EXECUTABLE (prospective, every discovered mover) STILL NOT STARTED
   |
SHADOW TEST          EXTREME_PREMARKET_DISCOVERY_V1, prospective from 2026-08-19
```

**The rule that keeps it honest.** A coverage case NEVER quotes an executable return. Two
different claims were being conflated:

- *"OptiScan missed a verified +293% executable winner"* — a claim about a FILL. Needs
  NBBO. Gated exactly as before; nothing on the coverage path can produce it.
- *"OptiScan never observed the 5th largest mover in the market"* — a claim about
  COVERAGE. Needs only market state.

Placing the second beside the first is not a weaker version of it. Merging them would be.

**The half that did not need the budget — added 2026-08-19 (3).** The EXECUTABLE scope was blocked on provider budget, and that reasoning stands for the question it answers: going out and quoting movers we have NOT quoted needs a lane holding no minute reserve. It does not describe the movers we DID quote. For those, every field already has a durable source on disk, so `measureExecutableOpportunityOnDb` joins them at zero cost and stays runnable while the minute cap is saturated — which is exactly when a budget-caused miss needs investigating.

It is a THIRD scope, `EXECUTABLE_FROM_SHARED_EVIDENCE`, not a flip of the second. The two answer different questions and one is strictly narrower; every field it claims is prefixed `quoted`, and `unmeasuredFraction` states on every response how much of the discovered population it excludes. First production run: 40 movers, 3 measurable, 92.5% unmeasured. A partial answer read as the whole one is the failure the scope split exists to prevent.

### The CONTENT loop — rebuilt 2026-08-19 (3)

The old path had no step between "we rendered some copy" and "it is in the owner's
queue", so the answer to "should this exist" was always yes. 9,309 drafts, 92% of one
routine category, one sentence persisted 22 times.

```
INTERNAL EVENT       emitContentEventForCase — discriminator from WHAT CHANGED,
                     never from the clock
   |
WORTHINESS           deterministic score: novelty, significance, evidence quality,
                     audience value, timeliness, non-duplication. NO model.
   |
CLAIM VERIFICATION   unchanged — a performance category still needs a verified packet
   |
COHERENCE            does the copy agree with the position it describes
   |
DEDUPE               semantic fingerprint; a batch collapses to one idea
   |
RANK / BEST FEW      at most 3 rows per idea
   |
PRIVATE REVIEW QUEUE the app is the content inbox
   |
DISCORD NOTICE       one line, only above a floor ABOVE the queue threshold
   |
MANUAL POST          by hand, always
   |
FEEDBACK             approval / rejection / manual post aggregated back into ranking
```

**The rule that keeps it honest.** On a routine day the correct output is ZERO drafts.
That is why the design must be able to return zero, and why a ranked top-N cannot be
the mechanism — a top-N always returns N, which is how "the best of today" quietly
becomes "today". Feedback tunes the ORDER of things already worth reading; it can never
promote something the verdict refused, and the separation is structural rather than
numeric: `content-worthiness.ts` cannot import `content-feedback.ts`.

### Where the loop can go quiet without erroring

1. A consumer joining on `alert_id` for an owner row → empty set, reads as a quiet day.
   Guarded by `tests/cross-output-consistency.test.mjs`, which requires six surfaces to
   agree about one callout that definitely exists.
2. A research context section that fails to build → `null`, reads as nothing to report.
   Guarded by the no-empty-object assertion in
   `tests/weekly-wiring-and-lane-separation.test.mjs`.
3. A webhook variable holding a copy of another lane's URL → every diagnostic reads
   CONFIGURED. Guarded by `lib/notifications/lane-separation.ts`.
4. **A symbol never admitted to any universe** → no row anywhere, which reads identically
   to "nothing happened". This is the failure MRNA exposed, and the coverage loop above is
   the guard. `market_mover_observations` going empty restores the blindness silently, so
   `moverRecorderState()` is the thing to check first.
5. **A semantic fingerprint that includes anything unique per generation** → every
   comparison misses, nothing is ever a duplicate, and the queue fills with the same
   sentence. It never errors; it looks like a productive day. Guarded by
   `tests/content-worthiness-and-dedupe.test.mjs`, which asserts the fingerprint carries
   no event id, draft id or clock.
6. **A cap that sits below the curated universe it bounds** → the overflow rule becomes
   whatever the sort order was, and a slice always succeeds. Guarded by
   `tests/watchlist-admission-priority.test.mjs`, which asserts the property (nothing is
   cut for sorting late) rather than the current symbol list.
7. **A research sweep firing more work than its partition allows** → thousands of refusals
   a minute, a transient row for each, and the identical backlog re-fired next sweep. It
   never errors; it looks like a busy provider. Guarded by
   `tests/asymmetry-mark-admission.test.mjs`.

---

## Frozen definitions

Do not update a recorded hash to make a check pass. Register the next version.

| Definition | Hash | Prospective from |
|---|---|---|
| `LHC_SELECT_V1` | `80e5c5d878f5f9e185661981c87afc63` | — |
| `OWNER_SELECTION_STRENGTH_GATE_V1` | `9b4f77b3c6268bf9e94781dc849ad2ef` | 2026-08-19 |
| `PRE_MOVE_DISCOVERY_V2` | `e6eb1148e3bbd29fc4b71c657afbcafc` | at first capture |
| `EXTREME_PREMARKET_DISCOVERY_V1` | `d173a8c4d28c479e71000482f0a39e30` | 2026-08-19 |

`EXTREME_PREMARKET_DISCOVERY_V1` is the first definition frozen with NO evidence behind it
at all — empty `historicalResult`, empty `developmentSessions`, `sourceCohortId:
NONE_NO_HISTORICAL_COHORT`. That is deliberate: it was motivated by ONE example, and a rule
motivated by one vivid example is the likeliest of all to be widened until it fits. Its
hash covers BOTH the eligibility floors AND the ranking's output ORDER, because probing
eligibility alone would let the ranking be retuned silently, and the ranking is what
decides whether a mover is reached. It declares THREE measurement scopes. COVERAGE and
`EXECUTABLE_FROM_SHARED_EVIDENCE` are started — both answerable from rows already paid for.
The prospective `EXECUTABLE` scope still names provider budget as its prerequisite rather
than reporting a number it cannot honestly obtain. **The hash did not move**, because it
covers the eligibility floors and the ranking order and neither changed: adding a scope
declares what is being measured, not what the rule does.

Each hash is content-addressed by BEHAVIOUR, not source text: the definition is probed
across a sweep of inputs, so a moved threshold or a reordered branch changes the hash
even when the constants still read the same. Reordering the branches is exactly what
went wrong in PRE_MOVE V1.

---

## Phase 1 convergence graph — added 2026-08-19

Phase 1 establishes one canonical point-in-time memory substrate without changing a
live strategy, delivery bar, target, stop, exit, provider cap, or subscriber authority.

```
MARKET OBSERVATION (T0)
   |
   +--> shared underlying/chain evidence
   |       |
   |       +--> truthful contract-funnel terminal stage
   |       +--> exact fresh quote eligibility
   |       +--> deterministic strategy evaluation
   |
   +--> SetupEpisodeV2 / Zone A (immutable, as-of <= T0)
           |
           +--> OBSERVATION          every evaluated candidate
           +--> COUNTERFACTUAL       only exact OCC + defensible ask entry
           +--> PAPER_TRADE          only an actual paper position
           +--> DELIVERED_SUBSCRIBER only an accepted subscriber delivery
           |
           +--> outcome labels       append-only schema is READY
                                      production label worker is NOT YET LIVE
```

The canonical join is `episode_key`, a deterministic SHA-256-derived identifier. Zone A
contains only information knowable at T0 with field-level value, source, as-of time,
quality, missing reason, and version. Zone B is physically separate and append-only.
Underlying outcomes and exact-option outcomes cannot share a label identity. Exact-option
labels require OCC and `BUY_AT_ASK_EXIT_AT_FUTURE_BID`; insufficient coverage remains
explicitly censored rather than becoming a zero return.

### Phase 1 runtime failure boundaries

1. A bounded strike request may retry once without strike bounds only after a successful,
   non-truncated raw-zero provider response. Provider failures are not negative-cached.
2. Contract funnel stages are mutually exclusive and reconcile to the evaluation count.
   A schema/write/read fault is an ERROR in health and logs, never a zero-row day.
3. Executable evidence requires an exact session/OCC fingerprint, positive two-sided quote,
   fresh quote timestamp, and ask-entry agreement. Paper marks from another contract or a
   midpoint entry cannot be promoted to executable evidence.
4. Latency timestamps are captured at the actual observation, candidate, chain, decision,
   and Discord boundaries. Their distributions are descriptive telemetry, not inferred SLO
   compliance.
5. Storage sampling and backup verification run off the live decision path. Backup uses the
   SQLite online backup API, verifies checksum plus `quick_check` in an OS temporary copy,
   and refuses to restore over the live production database.

### Phase 1 learning loop status

```
OBSERVE -> FREEZE -> EVALUATE -> RECORD DISTINCT ACTION -> LABEL -> AGGREGATE -> RESEARCH
   live      live       live              live              ^
                                                        schema ready;
                                                        worker Phase 2
```

The loop is therefore structurally converged but not yet empirically closed. Phase 1 may
truthfully claim broad non-alert episode capture and action separation. It must not claim
automatic multi-horizon option labels, calibrated probabilities, analog lookup, or proven
alpha until the Phase 2 labeler and subsequent research gates exist.

Canonical terminology lives in `lib/terminology.ts`. App tooltips and Ask OptiScan import
that source; `CANONICAL_TERMINOLOGY.md` is generated and checked, not hand-maintained.

---

## Phase 2A automatic forward-label graph — added 2026-08-19

Phase 2A closes the label edge with a bounded, restart-safe slow path. It does not add
historical analogs, probabilities, EV, live reweighting, or any delivery authority.

```
SetupEpisodeV2 / immutable Zone A
   |
   +--> horizon clock: 5m / 15m / 30m / 60m / regular-session close
   |
   +--> persisted underlying 1m OHLC ----------------> UNDERLYING_LABEL
   |
   +--> frozen exact OCC + contemporaneous ask
          + persisted exact-OCC future NBBO bid ----> EXACT_OPTION_EXECUTABLE_LABEL
   |
   +--> append-only FORWARD_LABEL_V1
          + path quality / gaps / censoring / missing reason
          + terminal return / MFE / MAE / threshold times
          + explicit competing-event order or ambiguity
          + config digest / production SHA / evidence version
          |
          +--> reconciled daily coverage snapshot
          +--> order-independent deterministic dataset version
          +--> private Forward Learning / evidence-breadth view
          +--> future Phase 2B research consumers (NO authority yet)
```

The exact-option denominator is the frozen contemporaneous ask and every forward mark is
the bid for the same normalized OCC. Midpoint, last trade, a nearby strike, another
expiration, or underlying movement cannot substitute. A zero bid is legitimate evidence
of a -100% executable mark; a missing or crossed book is unknown. Post-horizon marks do
not prove an in-horizon event. Underlying OHLC can establish that both competing levels
were inside one minute but cannot establish their sequence, so the canonical order is
`AMBIGUOUS_INTRABAR`.

### Phase 2A loop closure

```
OBSERVE -> FREEZE -> EVALUATE -> RECORD ACTION TYPE -> WAIT FOR HORIZON
   -> LABEL -> VERIFY COVERAGE -> VERSION DATASET -> RESEARCH-READY EVIDENCE
```

### Phase 2A OBSERVE -> FREEZE observability gate — added 2026-08-19

The OBSERVE -> FREEZE edge now exposes bounded, process-lifetime counters for EpisodeV2
build attempts, successes, classified rejections, persistence outcomes, and action-write
failures through the canonical system overview health surface. Zero persisted episodes is
therefore no longer interpreted as healthy capture by itself: the first production sample
after deployment reported `NEVER_ATTEMPTED` with zero build attempts. A separate read-only,
zero-provider aggregate over existing observations found 42,731 contract-selected rows:
2,935 quote timestamps newer than observation (6.87%), 3 equal, and 39,793 older. That
diagnostic establishes magnitude only. The timestamp semantics, Zone-A validation, episode
identity, strategy and contract logic, delivery behavior, and subscriber authority are
unchanged; the OBSERVE -> FREEZE loop is observable, not repaired.

### Phase 2A OBSERVE -> FREEZE four-clock semantics — added 2026-08-20

The first gate proved the magnitude. This one names the clocks. It changes what the
OBSERVE -> FREEZE edge can be OBSERVED to mean, and nothing else: the Zone-A rule, the
episode identity, contract selection, delivery, and subscriber authority are all
byte-identical to the prior build, and zero provider calls were added.

Live production on 2026-08-20 rejected 62 of 738 EpisodeV2 builds as
`ZONE_A_FUTURE_TIMESTAMP`. Of the 594 CONTRACT_SELECTED rows carrying a quote timestamp,
62 (10.44%) had `quote_timestamp_ms > observed_at_ms`, distributed continuously through
zero: p50 311ms, p95 2,059ms, max 3,564ms, and nothing at all beyond five seconds. That
is not the shape of a provider publishing future-dated prints. It is the shape of a
reference clock captured too early.

It was. The live path captures one local instant at the top of the per-symbol scan and
then spends real wall-clock on `getBars()`, feature computation, strategy scoring and
`getChain()` before it ever sees a quote. Comparing an exchange event time against that
earlier instant asks whether the quote existed before we STARTED LOOKING. The leakage
question is whether it existed before we DECIDED. Those are different instants on
different clocks, so the edge now carries four of them and never collapses one into
another:

```
observationStartedAtMs  LOCAL    scanner evaluation start (monitor n0)
        |                        ... getBars, features, strategy scoring ...
        |                        ... getChain ...
quoteReceivedAtMs       LOCAL    chain response carrying the selected quote completed
        |
decisionAtMs            LOCAL    disposition fixed; nothing later may enter Zone A
        v
quoteEventAtMs          FOREIGN  provider/exchange/SIP NBBO event time
```

`quoteEventAtMs` belongs to a foreign clock, so any difference involving it also carries
the unknown offset between that clock and ours. Those relations are labelled MIXED_CLOCK
and must never be read as network or transport latency. Only the local-to-local
differences are true elapsed durations.

Nothing is clamped. `signedQuoteAgeAt(referenceMs, quoteEventAtMs)` is the one canonical
calculation and it returns null only when an input is missing — never because the answer
came out negative. A negative age is the evidence; `Math.max(0, ...)` is what erased it.

Every build attempt is now classified as `BEFORE_OR_AT_OBSERVATION_START`,
`BETWEEN_OBSERVATION_AND_DECISION`, `AFTER_DECISION`, or
`INSUFFICIENT_TIMESTAMP_EVIDENCE`, with the same four-way split kept separately for the
attempts the CURRENT rule rejected. Those rejections still happen, deliberately, so the
old rule and the new evidence run against the same live traffic and can be compared. The
counters and the fixed-width signed histograms are process-lifetime and bounded; no
timestamp event writes a DB row.

Three legacy quote-age implementations still disagree with the canonical helper and are
listed, live, under `timestampSemantics.legacyQuoteAgeSemantics.stillDivergent`. They are
not unified here: each feeds a live gate, and changing one would move acceptance in the
same deployment that is supposed to prove acceptance did not move.

Status after this build: **TIMESTAMP VALIDATION REPAIR PENDING LIVE PROOF.** The loop is
now observable in the right units. It is still not repaired, and the validator must not
be touched until a full RTH session reports how many of its `ZONE_A_FUTURE_TIMESTAMP`
rejections were `BETWEEN_OBSERVATION_AND_DECISION`.

The scheduler checks once per minute. Each run examines at most ten episodes, has an
independent eight-second deadline, yields between episodes, and issues zero provider
requests. `INSERT OR IGNORE` plus deterministic label identity makes deploy/restart and
rerun safe. Dataset identity registers at most 1,000 previously unseen immutable labels
per beat and combines SHA-256 membership digests with an order-independent XOR, avoiding
a growing full-label scan. Historical breadth refreshes one dataset off-peak; large
tables use explicitly identified SQLite planner estimates rather than blocking the live
scheduler with a multi-million-row `DISTINCT` scan.

Actions remain separate populations: `OBSERVATION`, defensible `COUNTERFACTUAL`, actual
`PAPER_TRADE`, reconciled `OWNER_PAPER`, and genuinely delivered
`DELIVERED_SUBSCRIBER_TRADE`. `ACTIONABLE`, `WATCH`, and `REJECTED` episodes can receive
underlying labels without manufacturing a paper position. Exact-option coverage is
reported across population, side, DTE, strategy, discovery stage, selection strength,
liquidity/evidence tier, session, symbol, mover class, and action kind. This visibility
describes where evidence exists; it is not an alpha claim.

The evidence edge is deliberately reuse-first: historical normalized bars/quotes,
paper marks, and asymmetry marks are read from SQLite. No forward-capture provider lane
was added and provider caps are unchanged. Current exact-option coverage is expected to
remain selected and may be thin; a future capture proposal must first quantify calls per
minute/day, lane cost, cap share, and the populations whose selection bias would improve.

## Historical Analog graph — added 2026-08-21

Stored evidence → point-in-time reconstruction → feature-vector version → comparability →
corpus → similarity → baselines → OOS evaluation → research surface. Every stage below is
RESEARCH_ONLY: no edge from any row here reaches the scanner, a threshold, contract
selection, Discord or subscriber state.

| # | Stage | Owns | Joined by | Silent-failure risk |
|---|---|---|---|---|
| A0 | STORED BARS | `historical_underlying_bars` (60,164 rows, 15 symbols, 1m, 2026-08-03…07) | `(symbol, timeframe, ts_ms)` | **`timeframe` is load-bearing.** The seeder's warmup/velocity windows are BAR COUNTS; feeding it 1d bars silently reinterprets a 15-bar window as three trading weeks |
| A1 | LOCAL REPLAY | `ANALOG_LOCAL_REPLAY_V1` → `seedEpisodesPure` → `persistEpisodeOnDb` | deterministic `episodeKeyOf(source, symbol, t0Ms, schemaVersion)` | Zero provider calls. Re-running is a no-op by key + `INSERT OR IGNORE`. A horizon the bar span cannot reach yields 0 rows, which is why `plannedHorizons` is reported separately from `labelsByHorizon` |
| A2 | EPISODE ROW | `setup_episodes` | `episode_key`, **and `episode_version`** | `episode_version=2` rows have a structurally NULL `liquidity_tier` and carry features only in `zone_a_json`. Dispatching on the wrong version returns a vector that is well-formed and wrong |
| A3 | LABEL ROW | `episode_labels` (V1) / `episode_outcome_labels_v2` (V2) | `(episode_key, horizon)` | **One episode has one label PER HORIZON.** A load without `horizon` repeats every `episode_key` and pools a 5-minute outcome with a session one |
| A4 | FEATURE VECTOR | `ANALOG_FEATURE_VECTOR_V1` / `ANALOG_FEATURE_VECTOR_V2` | `vector.version` | Same seven dimension NAMES, different estimators. Blending versions returns a number and no error |
| A5 | COMPARABILITY | `ANALOG_COMPARABILITY_V1` registry, resolved FROM the version | `required` / `optional` key sets | An unregistered version THROWS rather than inheriting V1's requirements — a silent V1 fallback is what would reject a future V3 wholesale with nothing in the output to say so |
| A6 | CORPUS | `ANALOG_CORPUS_V1`, single-class AND single-version AND single-horizon | `(evidenceClass, vectorVersion, horizon)` | `droppedByVectorVersion` and `droppedIncomparable` are separate counters because "nothing matched" and "everything was the other version" mean opposite things |
| A7 | RETRIEVAL | `ANALOG_RETRIEVAL_V1` — fence on `labelEndMs <= t0`, self/dup/version/horizon exclusions | `AnalogQuery.{id, t0Ms, vector, horizon}` | An optional comparability key absent on one side is DROPPED and counted, never scored as agreement |
| A8 | BASELINES | `ANALOG_BASELINE_V1` — global / symbol / regime / direction | `eligibleTrainingSet()`, the SAME fence retrieval uses | A baseline built from a weaker fence inflates the opponent and makes the engine look modest; nobody audits the loser |
| A9 | INDEPENDENCE | `ANALOG_INDEPENDENCE_V1` — PREDICTION / SYMBOL_SESSION / SESSION / SYMBOL | cluster label per unit | `observations` is reported so the gap to the cluster count is visible, NEVER as a sample size |
| A10 | EVALUATION | `ANALOG_EVAL_V1` + clustered lift CIs | scoreable predictions | The Brier and every baseline Brier must be over the IDENTICAL rows, or the delta is a difference of denominators |
| A11 | SURFACE | `GET /api/research/analog`, `POST ?action=seed-from-store` | — | Writing is opt-in (`commit=1`); nothing schedules the seeder |

### Dynamic boundaries Graphify cannot resolve

The AST parser sees the imports; it cannot see any of these, and each one is a place a
correct-looking call returns a wrong answer:

- **`comparabilitySpecFor(version)`** is a runtime registry lookup keyed by a STRING that
  arrives on the data. No static edge exists from `retrieval.ts` to
  `feature-vector-v2.ts`; the spec is registered as a side effect of importing the module
  that defines it. A future vector that is never imported is never registered, and the
  lookup throws at query time rather than at build time — deliberately.
- **`vectorForEpisodeRow(row)`** dispatches on `row.episode_version`, a database value.
  Which vector builder runs is not decidable from the source.
- **`zone_a_json` traversal** is string-keyed into a JSON blob
  (`optiscan.sharedFeatureSnapshot.value.underlying.{price,hod,lod,…}`). The producer is
  `computeOptionsFeatures` in a different subsystem; nothing links the two but the key
  names, and a rename on the producer side would surface as silently-null dimensions.
- **`loadAnalogCorpusOnDb` branches on `evidenceClass`** to choose a table AND a default
  vector version. The class is a request parameter.
- **The route's dynamic `await import()`** of every analog module defers all of it past the
  static graph.

### Loop — the analog research loop, and where it deliberately stops

```
OBSERVE / FREEZE  →  LABEL  →  HISTORICAL MEMORY  →  ANALOG RETRIEVAL
                                                          ↓
RESEARCH CONCLUSION  ←  EVALUATION  ←  BASELINE COMPARISON
```

- **Automatic:** OBSERVE/FREEZE (live scanner → SetupEpisodeV2) and LABEL (the Phase 2A
  forward labeler on the scheduler).
- **Manual, by construction:** HISTORICAL MEMORY widening (`POST ?action=seed-from-store`,
  dry run by default) and EVALUATION (`GET ?evaluate=1`). Neither is scheduled, and
  neither should be: both are questions an owner asks, not work the system owes.
- **Closed at RESEARCH CONCLUSION.** There is no edge from the conclusion to any
  threshold, and there must not be one until the blockers in the current packet clear.

The loop can go quiet without erroring in exactly three places, all of which now report
rather than return zero: a corpus that is all one vector version (`droppedByVectorVersion`),
a corpus that spans horizons (`mixedHorizons` + `duplicateMemberIds`), and an evaluation
whose every query abstained (`coverage: 0` with the floor named in `abstainReason`).

---

## Broad historical universe graph — added 2026-08-21

The chain from "what may OptiScan look at" to "what does OptiScan remember". Every stage
below is RESEARCH_ONLY from H3 onward; nothing here reaches the scanner, a threshold,
contract selection, Discord or subscriber state.

| # | Stage | Owns | Joined by | Silent-failure risk |
|---|---|---|---|---|
| H0a | **CURATED SCAN LIST** | `DEFAULT_UNIVERSE` in `lib/universe.js` — 48 ETFs + 115 mega/large + 81 momentum, deduped to **244** | symbol | SUPPLEMENTAL and additive; the whole-market print wins on collision. It can raise the floor of the universe and can never restrict it — reading it as "the universe" understates coverage by orders of magnitude |
| H0b | **BROAD STOCK DISCOVERY** | `broadStockEligibility()` — $0.50–$50, ≥500k day volume, ≥+10% from prev close | symbol | The $50 ceiling is a TRADING gate applied to DISCOVERY, so no stock over $50 is promotable outside H0a |
| H0c | **OPTIONS TIER-2 ELIGIBILITY** | `tier2Eligible()` — price ≥ $3, day dollar volume ≥ $20M, not OTC/warrant/right/unit/preferred | symbol | Computed live off the shared snapshot and never persisted as a list. The only durable trace of who was eligible is who got EVALUATED — `options_candidates`, 3,131 distinct symbols over a month |
| H1 | **HISTORICAL UNIVERSE RESOLVER** | `classifyUniverse()` in `lib/research/episode/universe.ts` — `provider_pit` / `user_dated_file` / `current_symbols` | source tier | **`providerPitAvailable` is CALLER-SUPPLIED.** `app/api/research/seed/route.ts` forwards `body.providerPitAvailable === true` and the resolver trusts it, so a run can be stamped `survivorshipBias: false` with nothing verified |
| H2 | **DURABLE BAR STORE** | `historical_underlying_bars` — 60,164 rows, 15 symbols, 1m, 2026-08-03…07 | `(symbol, timeframe, ts_ms)` | The ONLY local source with a regular post-T0 grid. Everything else that looks like a price path is endogenously sampled |
| H3 | **INGESTION PROGRESS** | `historical_ingestion_progress` — per-job cursor, monotonic `completed_through_ms` | `job_key` | **`status` is the whole safety property.** `COMPLETE` and `EXHAUSTED` are both terminal and mean different things; a reader that collapses them re-buys settled data for ever (see below) |
| H4 | **PLANNER** | `buildBackfillPlan()` — anchors option windows on real cases, derives reference targets FROM those windows | `(subject, timeframe)` | Keeps no memory of what was fetched, by design. Dedup belongs to the runner that spends the request — a planner that "remembers" would silently narrow coverage |
| H5 | **RUNNERS** | `ingestUnderlyingBarsOnDb` / `ingestOptionQuotesOnDb` / `ingestContractReferenceOnDb` | `job_key` via `ingestJobKey()` | Each must skip a terminal job itself. `ingestContractReference` did not, and re-bought the same expiration range every pass for ever |
| H6 | **COVERAGE REPAIR** | `reopenUndercoveredOptionQuoteJobsOnDb` — one-way `COMPLETE → IN_PROGRESS` | `job_key`, evidence from `historical_option_quotes` rows | Reads ROWS. Rows cannot distinguish "truncated page" from "market had nothing", so the STATUS has to carry it |
| H7 | **LOCAL REPLAY** | `ANALOG_LOCAL_REPLAY_V1` → `seedEpisodesPure` | deterministic `episodeKeyOf` | Zero provider calls, idempotent by key. **A dry run reports INTENT, not delta** — it says "231 would be inserted" where a commit says "231 already present". Reading the dry run as a delta invents expansion that is not there |
| H8 | **CORPUS INVENTORY** | `analogCorpusInventoryOnDb` — 4 classes | evidence class | **`HISTORICAL_EXACT_OPTION` has no row.** 2,238,462 stored NBBO rows over 73 contracts are invisible to the surface even though the class is defined and the store is populated |

### The two spend loops, and why status had to become structural

Found 2026-08-21 by auditing what the lane had SPENT rather than what it had stored.

```
                 ┌──────────────────────────────────────────┐
                 │  runner: span examined, provider empty   │
                 │  → COMPLETE, completed_through_ms = toMs │
                 └───────────────────┬──────────────────────┘
                                     │
                 ┌───────────────────▼──────────────────────┐
                 │  repair: rows stop short of window end    │
   ONE REQUEST   │  → reopen as IN_PROGRESS                  │   FOREVER
   PER PASS      └───────────────────┬──────────────────────┘
                                     │
                                     └──── back to the runner ────┘
```

78 option-quote windows carried **14,239 runs and 7,363 provider requests** for 2,238,462
rows. 54 contract-reference jobs carried **6,944 runs and 6,944 requests** writing
6,013,016 rows that collapse to the **27,000** distinct contracts already stored — 222x
write amplification. `underlying_bars`, the lane that does check, sat at 15 runs for 15
jobs.

The repair could not be taught to read the difference out of the rows, because it is not in
the rows. So the runner's verdict became data: `IngestStatus` gains **`EXHAUSTED`**, and
every consumer that means "finished" now goes through `isTerminalIngestStatus()` — the
quote runner's skip, the contract-reference runner's new skip, `completedOptionWindows()`
in the planner, and `resumable` on both diagnostics. The repair still queries only
`COMPLETE`, so it can still fix a genuine legacy capped page exactly once, and can never
see an exhausted window again. Excluding it from the repair but not the planner would have
MOVED the loop rather than ended it; a test pins that.

### Dynamic boundaries Graphify cannot resolve here

- **`historicalMinerJob` require chain.** `lib/scheduler.ts` reaches
  `runHistoricalMinerOnDb` through a runtime `require("@/lib/research/historical/miner")`
  inside the beat, so no static edge exists from the scheduler to the entire ingestion
  subsystem. The whole lane looks unreachable to the parser and runs every 15 minutes.
- **`recordMarketMoverCycle` and `getDb`** are both `require`d inside `refreshDiscovery` in
  `lib/scanner-loop.ts`, deliberately, so the scanner's import graph never gains a database
  dependency. The observation lane is invisible to the AST from its only caller.
- **`isTerminalIngestStatus` reads a DATABASE STRING.** Which branch a runner takes is not
  decidable from source; an unrecognised status is treated as non-terminal, which is the
  safe direction (it retries) but is the direction that costs money.
- **The seed route's universe tier** arrives as a request-body string and decides whether a
  whole corpus is `validForVerdict`. No static caller can be inspected for it.
- **`fetchMarketSnapshot()` TTL/inflight dedupe** lives on `globalThis`, so scanner
  discovery, the options monitor and the mover recorder share one response through a
  side channel the parser cannot follow. A second fetcher would double provider cost with
  no new import edge.

### Loop — the broad historical learning loop, and where it is blocked

```
UNIVERSE ──────────────► HISTORICAL DATA ──────► POINT-IN-TIME REPLAY
   │                          ▲   ▲                      │
   │                          │   └── BLOCKED: storage    ▼
   │                          │                     SETUP EPISODES
   │                    (bars, 15 syms)                   │
   │                                                      ▼
   └──► FORWARD CAPTURE ──────────────────────────► OUTCOME LABELS
        (live, free, 2 days old)                          │
                                                          ▼
   FORWARD VALIDATION ◄── SHADOW HYPOTHESIS ◄── HISTORICAL MEMORY
        (NOT STARTED)         (NOT STARTED)      │
                                                 ▼
                                    FEATURE/STRATEGY RESEARCH
                                          (NOT STARTED)
```

| Stage | State | Why |
|---|---|---|
| UNIVERSE (live) | **LIVE** | `SCREENERS_FIRST`, 244 curated + whole-market broad discovery, verified in `loop-health` |
| UNIVERSE (historical) | **BLOCKED** | resolves to `current_symbols` → survivorship-biased → EXPLORATORY_ONLY, cannot issue GO |
| HISTORICAL DATA | **BLOCKED** | not by the provider — 2 years of ~200 symbols is ~4,900 requests and $0 incremental — but by volume: 6.28 GiB DB on a 45.53 GiB volume already 41% used, growing 172 MB/day, 167 days to exhaustion |
| POINT-IN-TIME REPLAY | **BUILT**, leakage-hardened | `seedEpisodesPure` shared by both lanes; T0 fence and Zone-A blocks enforced in `persistEpisodeOnDb`, not in callers |
| ZERO-COST WIDENING | **BUILT, EXHAUSTED** | `ANALOG_LOCAL_REPLAY_V1` has consumed all 15 stored symbols; a re-run is a proven no-op |
| FORWARD CAPTURE | **LIVE** | `SetupEpisodeV2` since 2026-08-19; 1,723 episodes and 33 symbols in one session at zero marginal cost, and it accrues without anyone asking |
| OUTCOME LABELS | **LIVE** (forward) / **BUILT** (historical) | Phase 2A labeler on the scheduler; historical labels only where bars reach the horizon |
| HISTORICAL MEMORY | **RESEARCH/SHADOW** | 17 symbols, 92.1% of it in five mega-caps |
| FEATURE/STRATEGY RESEARCH | **NOT STARTED** | deliberately — the corpus cannot yet separate a setup from a ticker |
| SHADOW HYPOTHESIS → FORWARD VALIDATION | **NOT STARTED** | and the loop must not close into live authority until the packet's blockers clear |

The loop can go quiet without erroring in one new place, now reported rather than assumed:
a `seed-from-store` DRY RUN prints what it WOULD write, so a corpus that is already fully
replayed and one that has never been replayed print the same number. Only the commit path
distinguishes them, via `episodesAlreadyPresent`.

---

## Options provider-efficiency graph — added 2026-08-21 (4)

Three nodes are new and all three sit BETWEEN promotion and spend, which is where the 802
zero-contract attempts were being generated. The previous phase built them and wired none of
them; this one made the path run through them.

```
FULL OPTIONS SNAPSHOT
  → CHEAP AWARENESS            (zero provider cost, whole eligible universe)
  → PRE-SCORE / RANK
  → DEEP PROMOTION             (bounded, ceiling 25 for the first rollout)
  → OPTIONABILITY              ← NEW. can remove a request before it is made
  → CHAIN ADMISSION            ← NEW. decides which surviving requests the budget serves
  → STAGE 1.5                  ← NEW, OBSERVER ONLY. no outbound edge
  → CHAIN → CONTRACT → EPISODE → ACTIONABILITY → DELIVERY → TRACK → LABEL
```

| Stage | Owns | Joined by | Silent-failure risk |
|---|---|---|---|
| P1 | **OPTIONABILITY** | in-memory tri-state registry in `MonitorState.optionability` | symbol, pruned to the live universe + Tier-0/1 | A wrongly-set NOT_OPTIONABLE makes a symbol invisible and NOTHING downstream recovers it — which is why only reference evidence or two SEPARATE sessions of clean wide empties can set it, and why verdicts expire |
| P2 | **ZERO-CONTRACT CAUSE** | `classifyChainAttempt()` — 9 causes, 4 origins | the fetch outcome FIRST, the funnel terminal reason only if contracts arrived | Reading the selector first lets a stale funnel field relabel a quota refusal as a band rejection — the exact masquerade the taxonomy exists to prevent |
| P3 | **CHAIN ADMISSION** | `MonitorState.chainQueue`, rebuilt each cycle from deferrals only | `chainTicketKey(symbol, side, strategyKey)` | A carried ticket whose symbol was not re-prepared has no candidate behind it; offering it lets it win a slot, do nothing, and defer a servable ticket |
| P4 | **MISSED / DEFERRED** | `options_missed_opportunities` | `(session_date, symbol)`; joined in-process by `missedPending` | The skip site knows the reason and not the rank; the sweep knows the rank and not the reason. A record written without the awareness row would carry a rank with no denominator |
| P5 | **LIVE SHADOW** | fixed-size rings in `live-shadow.ts` | none — it is a leaf | An empty shadow report and a shadow that never ran read identically; `observed` and `faults` distinguish them |

### The MISS loop, which previously had no edges at all

```
AWARE → DEFERRED / DROPPED / QUOTA BLOCKED → RECORD WHY → FORWARD UNDERLYING EVIDENCE
      → RESEARCH
```

It terminates in underlying evidence and stops there. There is no edge from this loop to a
contract, a paper trade or a return, and the SCHEMA is what enforces that — there is no
column for an OCC, a strike, an expiration, a premium or a return, so a later writer cannot
quietly start filling one in for a contract that was never selected.

### SHADOW branches — all leaves, none with an outbound edge into a decision

`FEATURE_SEMANTICS_V2` · `DIRECTION_AWARE_LATE_PHASE_V1` · `STAGE15_CHAIN_GATE_V1` ·
`BEARISH_SIGNAL_DEDUPE` · `RVOL` · `TIE_DIAGNOSTICS`

Two different guarantees hold here, and conflating them is how a shadow acquires authority:

- the MEASUREMENT modules have no production importer at all, type-only imports included;
- the OBSERVER has exactly one production-importable export, `observeLiveShadow`, and it
  returns `void`. A caller cannot branch on what it is not given.

Both are enforced by `options-shadow-isolation.test.mjs` — which, until this phase, could not
fail: its pattern required a closing quote immediately after the module stem and every import
here is written `from "./x.ts"`. It had never matched anything.

### Dynamic boundaries Graphify cannot resolve here

The graph is built from imports and the provider budget is a runtime resource, not a module.
These edges are real and no static analysis will find them:

- every lane in `provider-lane-audit.ts` competes for ONE 280/min meter, so `scanner`,
  `options_paper_mark` and `asymmetry_mark` are upstream of options chain capacity without
  importing anything under `lib/research/options/`;
- `tier2Headroom()` reads the global meter through a `require` inside a `try`, deliberately,
  so an unreadable meter degrades to the lane bucket rather than throwing — an import graph
  sees no dependency at all;
- promotion capacity is sized on MEASURED requests-per-promotion from this process's own
  counters, so the edge from "what happened last cycle" to "what is affordable next cycle"
  runs through mutable state;
- the chain queue carries tickets ACROSS cycles — an edge from a cycle to its successor.

### Loop — spend intelligently, and learn from what was not spent on

```
SEE EVERYTHING CHEAPLY → PROMOTE THE MOST INTERESTING → SPEND PROVIDER CAPACITY INTELLIGENTLY
  → SELECT EXACT OPTION → DELIVER → TRACK → LEARN
```

"Spend provider capacity intelligently" closed at two different strengths, and the difference
is deliberate:

| Half | State | Control |
|---|---|---|
| don't spend on a proven negative (OPTIONABILITY) | **LIVE**, on by default | UNKNOWN always eligible; 30-day TTL |
| spend the remainder in the right order (ADMISSION) | **BUILT, DEFAULT-INACTIVE** | `OPTIONS_CHAIN_ADMISSION_ENABLED=1` |

```
DID NOT PROMOTE / QUOTA BLOCKED / NO CHAIN → RECORD WHY → LEARN WITHOUT FABRICATING OPTIONS
```

This was the weakest link in the 2026-08-21 (3) packet — "the records exist and are bounded,
but nothing writes them from the live path yet". It now closes: `noteSkip()` fires from six
distinct points in the live path and the sweep writes them with the rank and the denominator
that make them readable later.

The LEARNING half remains deliberately open. Recording why COIN was skipped is not the same as
knowing whether skipping it was right; that needs forward outcomes on the underlying, which
these records now make possible and which nothing yet computes.

| Stage | State | Why |
|---|---|---|
| CHEAP AWARENESS | **LIVE** | full eligible universe every valid snapshot cycle, zero marginal cost |
| DEEP PROMOTION | **LIVE**, ceiling 25 | rollout ceiling holds until measured chain spend per promotion is known |
| OPTIONABILITY | **LIVE-WIRED** | the only new behaviour ON by default |
| ZERO-CONTRACT CAUSE | **LIVE-WIRED** | observability; changes no decision |
| CHAIN ADMISSION | **BUILT, DEFAULT-INACTIVE** | unproven change to the SHAPE of a live cycle |
| ACTIONABLE RESERVE | **BUILT** | active only with admission |
| MISS CAPTURE | **LIVE-WIRED** | new table, new write rate — watch row count on the first session |
| STAGE 1.5 / FEATURE V2 / LATE PHASE / DEDUPE / TIES | **SHADOW** | live subject at last; no production sample yet |
| RELATIVE VOLUME | **BLOCKED — INSUFFICIENT_HISTORY** locally | verdict computed at runtime, never declared in a document |
| PROMOTION OF ANY SHADOW | **NOT STARTED** | shadow evidence never closes into live authority automatically |
