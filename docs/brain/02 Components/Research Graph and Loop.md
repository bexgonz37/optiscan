# Research Graph and Loop

Graph Engineering and Loop Engineering memory for the OptiScan research arm.
Updated 2026-08-19 (3). Companion to the AST graph in `graphify-out/` — that one is
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
