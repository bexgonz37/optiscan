# Current Task Packet

## Packet update — 2026-08-18 OptiScan was capturing the owner callouts and the learning pipeline could not see them

### Verified state (checked, not assumed)

- Baseline verified from git AND production BEFORE any change:
  local = `origin/main` = production = `801b7d0d`. Tracked tree clean (the four modified
  `docs/brain/02 Components` files are line-ending only — `git diff --numstat` is empty),
  19 untracked scratch files untouched and still 19 at the end.
- Production healthy throughout. Session `AFTERHOURS` for the whole engineering window.
- **No trading logic changed.** No scanner setup rule, strategy threshold, selection,
  ranking, CALL/PUT decision, contract/strike/expiration choice, DTE rule, Target 1,
  Target 2, stop, exit, overnight handling, provider cap, subscriber-readiness threshold,
  Discord message or delivery authority was touched. `OWNER_SELECTION_STRENGTH_GATE_V1`
  was not created. No Profit Protection was added. `LHC_SELECT_V1` untouched.
- Final production SHA `06e3ca0`, verified local = `origin/main` = production.

### THE DEFECT — an owner callout has no `alert_id`, and six consumers joined on one

`sendOwnerPrivateOpening` claims an Opportunity Case, sends the Discord opening, and
mirrors the trade into `options_paper_trades` as `OWNER_VALIDATION_PAPER`. Nothing on that
path writes an `options_alerts` row. So `opportunity_cases.alert_id` and
`options_paper_trades.alert_id` are null for every owner callout ever made:

```
owner mirrors 74   with alert_id 0
owner cases   74   with alert_id 0
owner mirrors with a case id on their own feature snapshot   74
```

Six learning consumers resolved owner evidence through `alert_id` anyway. **None of them
errored.** They returned the empty set, and an empty set is indistinguishable from a quiet
day. That is the whole shape of this defect: it could only be found by asking a question
the system had no way to answer wrongly.

The link that does exist is the opportunity case the mirror records on its own feature
snapshot. `owner-mirror-audit.ts` already used it — which is why the mirror RATE was
measurable while nothing else about the lane was — and it is now extracted into
`lib/opportunity-case/owner-mirror-identity.ts` so a seventh consumer cannot reinvent the
broken one.

**There are also TWO Opportunity Case rows behind one callout**, which is why no PRE_MOVE
row has ever been promoted to the OWNER lane. The scanner writes a PENDING audit case that
owns the observation; delivery mints a CLAIM case that owns the mirror.
`recordPreMoveAlertOnDb` was keyed on the claim id and matched zero rows for its entire
life. The pending id is not missing, it is computable — a pure function of the opportunity
fingerprint both rows carry. Verified against production before any code was written:
owner case `oc_alfb24` (IWM `O:IWM260819P00301000`, `of_1d78kh2`) derives `oc_us70d7`,
which exists, carries the same fingerprint and the same frozen contract, and was detected
1.8 seconds BEFORE the alert went out.

The resolver fails closed. Two mirrors naming one case is AMBIGUOUS and resolves to
nothing rather than to whichever row sorted first. A mirror on a contract the case did not
freeze is OCC_MISMATCH and is never handed back as the callout's evidence, because a
different strike's return is not this decision's return. Nothing fabricates an alert id,
an `options_alerts` row, or a historical notification timestamp.

### BEFORE and AFTER, on the same production evidence

The clean comparison is session **2026-08-17**, which is closed and cannot move. The owner
summary used to read `DELIVERED_ALERT_PAPER`, whose last row is 2026-08-06:

| owner summary, 2026-08-17 | BEFORE | AFTER |
|---|---|---|
| openings | 0 | **13** |
| exact mirrors | 0 | **13** |
| mirror rate | n/a (`alert_id IS NOT NULL`) | **1.00** (exact OCC) |
| closed / open | 0 / 0 | **12 / 1** |
| wins / losses | 0 / 0 | **7 / 5** |
| profit factor | null | **1.4618** |
| PUT / CALL | 0 / 0 | **13 / 0** |

Over the whole forward record the lane is **74 openings, 74 exact mirrors, 67 closed, 27
wins, 40 losses, win rate 40.3%, mean −9.19%, median −40.29%, PF 0.6654, PF without the
best winner 0.6226, 66 puts and 8 calls across 7 sessions.** The nightly received the
equivalent of zeros for all of it.

`byStrategy` now separates them: `lower_high_continuation` 46 trades PF 0.8291,
`vwap_rejection` 13 PF 0.6281, `sr_reclaim` 4 and `breakout_forming` 3 with no winners
at all.

### Session accounting: 0 independent sessions became 7

`loadCohortMembersOnDb`'s `LEFT JOIN opportunity_cases c ON c.alert_id = t.alert_id` gave
every owner row a null case and therefore a null `session_date`. **A null session date is
not a missing label — it is an independence count of zero**, and the owner lane sat
permanently at INSUFFICIENT_EVIDENCE with 74 verified excursions and 67 verified realized
outcomes behind it. No sample size could have opened it.

Identity now falls back to the case the mirror names; a trade with no case at all still
gets the session it was ENTERED in, via the repository's Eastern trading-day helper rather
than a UTC split that moves every post-20:00 ET entry into the next day.

Independence is also no longer `new Set(sessionDate).size`. A calendar date is not a
trading session, and a weekend or a corrupt epoch produces a well-formed `YYYY-MM-DD` that
clears a floor unchallenged. `countIndependentSessions` validates each date and REPORTS
what it rejected.

**The floors were not lowered.** They are still 20 trades over 5 independent sessions, and
a regression test seeds 25 trades over four sessions and asserts the gate still refuses.

### The owner probability gate opened on its own evidence

| `HISTORICAL_COHORT_V1:paperKind=OWNER_VALIDATION_PAPER` | BEFORE | AFTER |
|---|---|---|
| verified excursions | 74 | 74 |
| verified realized outcomes | 67 | 67 |
| independent sessions | **0** | **7** |
| verdict | INSUFFICIENT_EVIDENCE | **SUPPORTED** |
| member case ids | 0 | 74 |

Nothing about the population changed. Only its identity did.

```
P(+10) 0.6622  (49/74)      win rate      0.4030
P(+25) 0.5405  (40/74)      profit factor 0.6654
P(+50) 0.0676  ( 5/74)      expectancy   -9.19%
P(+100) 0      ( 0/74)      PF ex-top     0.6226
                            E[MFE] +25.79%   E[MAE] -32.05%
```

Read the two columns as two different claims, because they are: a lane that touches +25%
on 54% of setups and still returns a profit factor of 0.67 is a lane whose exit policy
gives back more than its selection captures. That is the same shape the delivered lane
showed at PF 0.94, and it is the reason the next work is exit research and not selection
tuning.

### PRE_MOVE: 0 owner rows became 70

The OWNER lane cannot take its membership from the `lane` column. That column is stamped
at CAPTURE time, on a tick that cannot know whether an owner will later be notified, so it
reads SHADOW or RESEARCH; the promotion that was supposed to fix it never matched a row.
Production before: **0 rows with `lane='OWNER'`, 0 rows with a non-null
`owner_notified_at_ms`**, against 74 exact owner mirrors, and every standing pre-move
question answering INSUFFICIENT_EVIDENCE.

Membership is now proven by the MIRROR — the object that only exists if the Discord
opening was actually sent — and its PRE_MOVE row is fetched by both case identities. That
is evidence, not a label. Rows the owner lane claims are removed from the others so one
callout is never counted in two populations.

`recordPreMoveAlertOnDb` now tries the pending audit case FIRST and the claim case second.
Order matters: the claim-case row, where it exists at all, was written on a tick AFTER the
alert, and measuring lead time from its detection instant would report every callout as
later than it was.

**Historical rows are not backfilled and no notification timestamp is invented.** Where
none was recorded the mirror's own `entered_at_ms` is used and the row SAYS SO in
`ownerAlertInstantProvenance`. The mirror opens immediately after the send, in the same
block, so that instant is at or after the true one: every lead time derived from it is a
FLOOR. It can understate how early a callout was; it cannot overstate it. All 70 current
owner rows are `DERIVED_FROM_MIRROR_ENTRY` and say so.

### Two trades the nightly can now tell apart

The test of a research context is not whether it contains a winner and a loser. It is
whether they are visibly different WITHOUT a reader who already knows which is which.

```
IWM  O:IWM260819P00301000  PUT  lower_high_continuation
  entry 0.986  T1 1.42  T2 1.86  stop 0.59   realized +44.42%   206 marks
  MFE +44.42%  MAE -12.37%   +10% at 6.4min  +25% at 14.4min  +50% never
  EVENTUAL_T1_WINNER · TARGET_1_HIT · SAME_DAY_EXIT
  PRE_TRIGGER · LARGE_REMAINING · reward remaining 1.0 · delta -0.45 · OI 1342
  selection strength 100 · delivery quality 81 · signal SUPPORTIVE · 0 contradicting

NFLX O:NFLX260814P00074000 PUT  lower_high_continuation
  entry 0.726  T1 1.04  T2 1.36  stop 0.43   realized -85.67%   552 marks
  MFE +31.68%  MAE -85.67%   +10% at 7.2min  +25% at 16.2min  +50% never
  GOOD_MOVE_THEN_REVERSED · STOP_LEAKAGE · OVERNIGHT_GAP · HELD_OVERNIGHT · OPENING_BELL_EXIT
  stop 0.43, exit fill 0.104 = -75.81% slippage · overnight gap -61.98 points
  selection strength · delivery quality 81 · signal verdict — all carried per trade
```

Same strategy, same side, same delivery quality, nearly identical milestone timings — and
opposite outcomes. What separates them is entirely in the second half of the trade, which
is exactly the finding, and it is now stated in the payload rather than left for a model
to infer.

Across the lane: 42 of 74 crossed a session boundary, 36 carried a measured overnight gap,
13 filled materially below their frozen stop. **Nothing was changed about the stop.** The
evidence to study it is simply now visible.

### Path labels are measurements, not judgements

`NEVER_WORKED` 13 · `WORKED_SMALL_THEN_FAILED` 15 · `GOOD_MOVE_THEN_REVERSED` 12 ·
`EVENTUAL_T1_WINNER` 25 · `WORKED_AND_HELD` 2 · `PATH_UNKNOWN` 7 (all still open).

Every threshold is a named constant. `PATH_UNKNOWN` is what a trade gets when its marks
cannot support a verdict — never `NEVER_WORKED`, which is the flattering answer for a
scanner and the damning one for a trade. No stored `maxReturnPct`, `mfe_pct` or `mae_pct`
is read anywhere in the owner lane: one fallback to a field that is wrong on 36 of 78
delivered cases would put a phantom number into every label at once.

`GOOD_MOVE_THEN_REVERSED` and `EVENTUAL_T1_WINNER` are separate labels precisely so the
Profit Protection question can be asked later without being begged now.

### Two selection numbers that were being confused with each other

The field first shipped in this session as `selectionStrength` was the delivery QUALITY
score off the mirror's feature snapshot, which spans 0.70 to 0.86 across 67 closed owner
trades — never 1.0. The audit that motivated exposing it described a `selStrength` taking
values of exactly 100 and below 75, so the two could not be the same thing, and it was
renamed `deliveryQualityScore` rather than shipped under a name it did not earn.

**Then the real one turned up.** `selStrength` is
`case_json.strategyEvaluations[].strength` — a 0–100 score frozen per strategy at callout,
present on both case rows, 27 evaluations deep. Both fields are now carried under their own
names, together with `strategyVersion`, `signalVerdict`, `signalsMatched` and
`contradictingEvidence` from the same evaluation.

The load-bearing detail is WHICH evaluation. A case holds one per strategy the scanner
considered, and on the IWM winner the FIRST entry is `vwap_rejection` while the callout was
`lower_high_continuation`. Reading `[0]`, or the strongest, reports a strategy that was
never traded. The match is on the strategy that was actually selected, and null when none
matches rather than falling back to whichever sorted first. A regression fixture puts a
different strategy in slot 0 for exactly this reason.

The two numbers disagree on the same callout — selection strength 100, delivery quality 81
— which is the whole argument for keeping them apart, and it is why the delivery-quality
split measured earlier in this session (below 75: PF 0.5162 over 25 trades; 75 and above:
PF 0.7615 over 42) is a DIFFERENT cut from the one the audit reported, not a weaker
version of it.

With the real field the audit's finding reproduces, on 67 closed owner trades:

| selection strength | n | profit factor | mean | winners |
|---|---|---|---|---|
| = 100 | 36 | **1.1885** | +4.06% | 19 |
| 75–99 | 5 | 1.4533 | +8.89% | 3 |
| < 75 | 26 | **0.1670** | −31.00% | 5 |

The audit reported n~34 at PF ~1.205 and n~13 at PF 0.027; the direction and the magnitude
of the split hold, the exact counts do not, and the sub-75 bucket is twice the size it was
described as. 14 of the 74 mirrors carry no strength at all — their case holds no
evaluation matching the strategy that was traded — and those are null, never zero.

This is RESEARCH ONLY and is stated here so the next session argues with a number rather
than a memory. It is in-sample on a single 7-session window, the sub-75 bucket is
26 trades, and `OWNER_SELECTION_STRENGTH_GATE_V1` remains uncreated.

### `OWNER_VALIDATION_PAPER` is a lane now, in both senses

`QuantLane` had seven members and this was not one of them, so the lane most relevant to
whether the callouts work had no row in the quant report at all. It has one, with its
MFE/MAE recomputed from same-contract marks rather than the contaminated stored columns.
The contrast is now visible in one table: `owner_validation_paper` reports an average MFE
of **+26.55%** while `delivered_alert_paper`, still reading the stored column, reports
**−19.47%** — a *negative maximum favourable excursion*, which is not a number that can
exist. The older lanes still read those columns and are deliberately left alone.
Moving their published numbers is a separate decision from repairing owner identity.

Evidence Learning already carried `OWNER_VALIDATION_PAPER` as its own audience
(`ai.ownerLane` PASS in production) and needed no change. `paper_trade_outcomes` is keyed
on `paper_trades(id)` — the legacy stock table — so an options mirror is structurally
ineligible for it. **No owner rows were forced into it.** That is a real gap and it is a
schema decision, not an identity one.

### Two caveats worth more than the numbers beside them

**100% PRE_TRIGGER is not a finding.** All 70 owner rows grade PRE_TRIGGER with a median
detection-to-alert gap of **1.6 seconds**. A stage computed over a 1.6-second window is not
measuring earliness; it is measuring that detection and delivery happen in the same tick.
The stage column is doing almost no work in the owner lane and should not be read as
"every callout was early" until the detection instant genuinely precedes the alert.

**`medianRewardRemainingFraction` is 1.0 on 65 of 70 rows.** A metric that returns its
maximum for almost every row is a metric that has not yet discriminated anything.

### What remains research / shadow only

Everything above. No gate, threshold, ranking weight, contract selection, target, stop,
exit or subscriber decision reads any of it. The AI may analyse, compare and propose
bounded experiments; it may not edit code, deploy, change a live threshold, alter ranking
or selection, move a target or a stop, approve a subscriber strategy, or rewrite history.
A test reads the two new modules as source and fails on any INSERT, UPDATE, DELETE or
provider call in them.

### Regression cover

`tests/owner-mirror-identity.test.mjs`, 22 tests, every fixture built the way production
builds one — **no alert id anywhere** — so a regression cannot pass by handing the code the
subscriber lane's shape. The fixtures in `lhc-nightly-research`, `pre-move-nightly` and
`after-close-autonomy` were doing exactly that and were seeding `DELIVERED_ALERT_PAPER`
rows with an `alert_id` while calling them owner alerts; they now seed owner callouts.

Pinned: the pending id stays a pure function of the fingerprint; a wrong-contract mirror
and a double-claimed case both fail closed; a case id is matched exactly, never as a
substring and never through the LIKE wildcard that `oc_` carries in its own name; owner and
subscriber stay disjoint on the same contract in the same session; a Saturday does not
count toward independence and two trades on one Monday are one session; the probability
floors still refuse at four sessions; a stored peak nothing printed does not become an
excursion; `PATH_UNKNOWN` is never rendered as `NEVER_WORKED`; and the winner and loser
traces stay distinguishable.

`npm test` twice: 4263 pass, 0 fail. `npx tsc --noEmit` clean. `npm run build` clean.

## Packet update — 2026-08-10 (5) The session count was right, the bookkeeping was not, and the realized profit factor is 0.94

### Verified state (checked, not assumed)

- Baseline verified from git AND production BEFORE any change:
  local = `origin/main` = production = `b28f04d`. Tracked tree clean, 19 untracked scratch
  files untouched — still 19 at the end.
- Production healthy throughout. Session `AFTERHOURS` for the whole engineering window, so
  the historical miner gate allowed off-peak work and the live scanner kept provider priority.
- `LHC_SELECT_V1` **untouched** — neither experiment file opened.
- No strategy threshold, ranking weight, stop, exit, provider cap, owner quality gate or
  subscriber readiness rule changed. Subscriber distribution still BLOCKED. No real money.
- Recaps, nightly AI, owner alerts, `OWNER_VALIDATION_PAPER` and `PRE_MOVE_DISCOVERY_V1`
  all left ENABLED. Nothing disabled anywhere.

### PRIORITY 1 — the "6 sessions over a 5-day window" discrepancy: the count was CORRECT

The premise was that 21 events across 6 independent sessions could not come from bars
spanning 2026-08-03..08-07, which is five trading dates.

The six sessions are `2026-07-27, 07-29, 07-30, 07-31, 08-03, 08-06` — six distinct
genuine weekdays, none a holiday. Nothing was wrong.

**The conflation was between two datasets.** Winner events are anchored on option NBBO
coverage, which spans `2026-07-27..2026-08-06` (nine trading sessions). Bars span
`2026-08-03..2026-08-07` (five). Comparing the event-session count against the BARS range
is what made a correct number look inflated. `coverageBreakdown.datasetSpanMismatch` now
states both spans side by side so the question cannot be asked the same way twice.

**But the count was correct and UNGUARDED, which is a different finding.** Independence was
`new Set(sessionDate).size` over Eastern CALENDAR dates, and a calendar date is not a
trading session. A weekend, a market holiday or a corrupt epoch produces a well-formed
`YYYY-MM-DD` that clears an independence floor, and by the time the value reaches the floor
it is a number nobody can question.

`trading-sessions.ts` now counts independence against a rule-based NYSE calendar — rules
rather than a hardcoded table, because a table fails PERMISSIVELY the year it runs out.
Verified against all ten published 2026 closures plus 2025 spot checks, including
Independence Day 2026 falling on a Saturday and closing Friday 3 July. Rejected dates are
REPORTED, not dropped: "your floor of 5 was cleared using a Saturday" is the most useful
thing the count can say.

The test suite's own `population()` helper was generating `2026-08-08` and `08-09` — a
Saturday and a Sunday — for any fixture wanting six or more sessions. It now walks real
trading sessions.

### PRIORITY 17 — a milestone denominator that counted contracts nobody watched

Two of the 21 events had **zero post-entry quotes** and were still sitting in every
milestone denominator as though they had failed to reach the milestone. A contract nobody
observed is not a contract that went nowhere, and counting its silence as a miss biases
every probability down by exactly the size of the coverage gap.

Denominators are now WITNESSES only, which moved the real numbers:

| milestone | before | after |
|---|---|---|
| +10% | 7/21 = 0.3333 | 7/19 = **0.3684** |
| +25% | 3/21 = 0.1429 | 3/19 = **0.1579** |

`pStopBeforeFirstMilestone` had the same defect twice over: it counted unwatched members
AND scored members with no known outcome as non-positive via `?? 0`.

**And `probability: 0` was two opposite claims sharing one rendering.** Milestones now say
which — `OBSERVED`, `OBSERVED_ZERO` (witnesses existed, none reached it) or
`EVIDENCE_UNAVAILABLE` (nothing could look) — each carrying a Wilson 95% upper bound. 0 of
19 bounds the true rate below ~16.8%; it does not zero it. This matters most at
+50/+100/+200, where a coverage gap and a genuine absence of tail moves are otherwise
indistinguishable.

`HISTORICAL_EDGE_SHADOW_V1` inherits the mirror of its own founding rule. It already
refused to let an absent component become a FAVOURABLE zero; an unobservable milestone must
not become an UNFAVOURABLE one either, or candidates get penalised for our coverage gaps.

### PRIORITIES 2 and 3 — realized outcomes joined, and the answer is not flattering

`HIST_REALIZED_V1` joins each event to the paper mirror that traded it. Identity is refused
unless provable: exact OCC, same opportunity case, entry instant within the window. The
case rule is the tempting one to drop and the reason not to — one liquid contract gets
selected by several cases in a week, and an OCC-only join attaches a return to whichever
decision the query returned first. Two equally valid matches are AMBIGUOUS, not resolved.

**The entry-price rule was wrong and the data proved it.** At a two-cent tolerance it
refused 12 of 21 real joins, every one the historical NBBO ask at the detection instant
against the live fill minutes later, differing by a nickel (−0.05 to +0.50, median 0.02).
Those are two MEASUREMENTS of one trade, not two trades — and the realized return is
computed from the mirror's OWN fills, so cross-source disagreement cannot make it wrong.
The comparison is kept and REPORTED as `entryAgreement` with its delta; it no longer
discards outcomes. Joins went 9/21 → **21/21**.

Realized returns are recomputed from the fills, never read from the stored `return_pct`
(which can drift from its own prices unnoticed), and **never derived from MFE**. There is
no code path from an excursion to a realized return. An open position stays OPEN rather
than being marked to market, because marking an unclosed loser is how it becomes a statistic.

**The realized record, now that it clears its floor at 21 closed trades over 6 sessions:**

| | |
|---|---|
| win rate | 23.81% (5 of 21) |
| mean return | **−2.07%** |
| median return | −41.12% |
| average winner | +139.44% |
| average loser | −46.30% |
| **profit factor** | **0.9412** |
| payoff ratio | 3.01 |
| PF excluding best trade | 0.4769 |
| PF with returns capped at +100% | 0.4746 |
| best trade share of gross profit | 49.3% |
| survives best excluded | **false** |

The excursion side looks healthy — a third of setups touch +10% — and the policy that
traded them gave back slightly more than it captured. Those are the two numbers that must
never be read as one picture, which is why they now live under separate keys with separate
floors and separate denominators.

**This printed with an EMPTY warnings array.** The tail warning only fired above PF 1, and
the concentration warning only at a majority share — this cohort sits at 49.3%, just under.
So the two most important facts about the population were the two it did not mention.
Sub-1 PF and non-positive expectancy now warn explicitly, and the concentration threshold
drops to a third.

### PRIORITIES 9 and 18 — and the root cause of the 27% executable rate

`HIST_COVERAGE_V1` attributes every refusal to a cause and, more usefully, to a REMEDY:
MINEABLE (a window we have not fetched), NOT_MINEABLE (the provider had no executable
quote), IDENTITY_DEFECT (the candidate does not identify a tradeable contract). Pooling
those makes a solvable problem look permanent. It calls the SAME quote resolver the replay
engine calls with the SAME staleness tolerance, so it can never report coverage we lack —
it is a work list, not a relaxation.

The verdict on 78 candidates: **21 SUPPORTED, 54 MINEABLE, 3 NOT_MINEABLE.** The 27%
support rate was almost entirely a fetching gap.

**Then the work list contradicted the job table, and the job table was lying.**

Every option-quote job read COMPLETE with zero resumable work, so the planner planned 0
windows. Meanwhile 54 events had no entry quote. The rows settled it:

```
O:SPY260807P00770000    requested 7h   stored 13:30:00 -> 13:37:22   4,477 rows
O:GOOGL260807P00357500  requested 7h   stored 14:36:21 -> 15:11:41   4,165 rows
O:IWM260807P00300000    requested 7h   stored 13:30:00 -> 13:40:15   4,468 rows
```

Every job stopped at roughly 4,200–4,600 rows. That is a bounded provider page, and on a
liquid contract NBBO updates thousands of times a minute — so 4,500 rows is MINUTES of a
seven-hour window. The runner issued one fetch, did not throw, and recorded
`completed_through_ms = toMs`. **COMPLETE meant "the call succeeded", not "the data covers
the window".**

The previous packet had already written down the risk — *"Truncation is surfaced, not
swallowed. On a liquid contract 5,000 NBBO rows can span under a minute"* — and the adapter
did compute a `truncated` flag. `liveIngestDeps` dropped it on the way through by taking
`.rows`. The hazard was identified, documented, and then lost in one destructuring.

So coverage is now derived from the rows that actually landed rather than from a flag that
had already proven droppable. A window is COMPLETE only when stored data reaches its end,
within a two-minute tolerance that sits inside the five-minute staleness bound the replay
engine uses. A capped page records IN_PROGRESS with the cursor at the last instant STORED,
and the next pass resumes from there. Two guards prevent infinite retry: an empty response
closes the window, and a page that does not advance past the cursor closes it too — each
recording why, and those closures mean "examined and exhausted" rather than "assumed
covered".

Two existing tests asserted the old behaviour: their fakes returned one quote near the
start of a full-day window and expected COMPLETE. They were encoding the bug.

### PRIORITIES 7 and 8 — replay and context rows now persist

`PRE_MOVE_DISCOVERY_REPLAY_V1` was computed and thrown away; `historical_market_context`
had a table, a writer and a reader and 0 rows because nothing called them.

`HIST_DERIVE_V1` persists both, and the load-bearing decision is that **origin is part of
the PRIMARY KEY**, not a column beside it. A live discovery row is something the scanner
really saw; a replay row is an inference from whatever a backfill happened to fetch. Shared
identity would let a reconstruction of the past satisfy a lookup meant for a forward
observation, and every prospective statistic downstream would be contaminated invisibly. A
test writes both origins for the same instant and asserts two rows survive.

Repeat safety comes from that key, not from bookkeeping — same version UPDATES, new version
ADDS — and `created_at_ms` is deliberately untouched by the upsert so a reconstruction that
changed once more history arrived is detectable.

**First real run, zero provider requests:**

- replay: 78 examined, **78 persisted**, 0 failed. Stages: 13 `EARLY_CONFIRMATION`,
  6 `EARLY_EXPANSION`, 3 `MATURE_MOVE`, 4 `TOO_LATE`, **52 `UNGRADABLE`**.
- market context: **0 → 70 rows** across 5 sessions (08-03..08-07), every one `COMPLETE`
  quality.

The 52 UNGRADABLE rows are the same contracts with no executable entry quote. Discovery
staging and executable-entry coverage are bottlenecked on the SAME pagination defect, which
is the strongest available argument for fixing it before reading anything into the stages.

Context rows are only derived for sessions with SPY/QQQ bars, and an INSUFFICIENT
reconstruction is NOT written — `readHistoricalMarketContextOnDb` would return it as the
context in force, and an UNKNOWN regime would start looking like a measured one.

### What did NOT get done, and why that matters

This session did not reach: shadow live observation on ranked candidates (P12), the
prospective baseline-vs-shadow scoreboard (P13), extending history toward the provider's
earliest entitled date (P5), the option-trade entitlement question (P10), pre-run winner
research (P11), nightly/weekly AI context (P14), Ask OptiScan exposure of the new evidence
(P15/P16), and the owner forward-evidence reconciliation (P19).

**P11 in particular should not be attempted yet.** Pre-run winner research compares setups
that reached +50/+100/+200 against losers, and the current evidence has ZERO observed
milestones above +25% — with an upper bound of 16.8% rather than a demonstrated zero. There
is no winner population to characterise until the mineable windows are backfilled. Running
it now would produce a characterisation of three or four events and read as a finding.

### The number to watch next session

`profitFactor 0.9412` on 21 closed trades, 49.3% of gross profit from one trade, not
surviving best-excluded. That is the first realized measurement this lane has ever produced
and it does NOT support a subscriber decision. Forward evidence remains the only thing that
can validate the hypothesis; historical replay can only initialize one.

---

## Packet update — 2026-08-10 (4) The historical intelligence phase is built end to end, and the first real backfill ran

### Verified state (checked, not assumed)

- Baseline re-verified from git AND production BEFORE any change:
  local = `origin/main` = production = `eafa421`, `shaAttribution.state OBSERVED`.
  Tracked tree clean, 19 untracked scratch files untouched — still 19 at the end.
- Production healthy throughout: `ok:true`, `loopRunning:true`, `quotaExceeded:false`,
  scheduler owner = this process.
- `LHC_SELECT_V1` **untouched** — neither experiment file opened.
- No strategy threshold, ranking weight, stop, exit, provider cap, owner quality gate or
  subscriber readiness rule changed. Subscriber distribution still BLOCKED.
- **Recaps, nightly AI and every live observation lane were left ENABLED.** Nothing was
  disabled in `/config` or anywhere else.

### The session had a hard constraint, and it shaped the order of work

The whole engineering phase ran during RTH. Rather than idle until the close, every part
that does not spend provider budget was built and tested first against fixtures and the
empty store; only the backfill itself waited for the session to end.

### PART 1 — real fetchers, and one stale claim corrected

The ingestion framework took its fetchers as injected dependencies, which made it
testable and left it inert: nothing in production supplied them. `adapters.ts` supplies
them from the SAME provider and auth infrastructure the rest of OptiScan already trusts,
rather than opening a second path with its own key handling and its own budget.

An adapter does exactly two things: **shape translation and EVIDENCE LABELLING**. There
is deliberately no adapter turning trades into quotes, no midpoint synthesis, no
carry-forward across a gap. A period with only trades yields trades, and replay then
reports no executable quote — which is true, and is what stops a backtest filling where
nobody was showing.

**Truncation is surfaced, not swallowed.** On a liquid contract 5,000 NBBO rows can span
under a minute; the "peak" of a truncated window is the peak of an arbitrary prefix.

### PART 2 — expired contract reference

`fetchContractUniverse` already existed (the capability matrix had wrongly said
otherwise, corrected in the previous session). It is now bound to a durable table with an
upsert, a resolver, and a bounded ingestion job. Replay resolves an expired OCC from the
local store and **never substitutes a current-chain contract for a historical one** — the
survivorship error the whole store exists to avoid.

### PARTS 3, 4, 6, 20, 21 — the miner, its plan, and its fences

`planner.ts` makes ingestion **evidence-centred**. OptiScan already knows which moments
mattered — thousands of cases with exact timestamps, symbols and frozen OCCs — so windows
exist because a real case happened there, not because a symbol exists. Every window
carries the reason that justifies it, so an expensive plan can be audited **before** the
budget is gone.

Underlying context is deliberately allowed to be broader than contract ingestion: bars
cost one request per symbol per month, per-OCC NBBO one per contract per window. Pricing
them the same would either starve regime reconstruction or bankrupt the contract lane.

`miner.ts` runs phases in dependency order — **reference, then bars, then quotes** —
because quotes are useless for a contract we cannot describe or place in a market
context. All phases share ONE accountant; per-phase accountants would make the real
ceiling the SUM of the caps, which is the quiet way a bounded lane stops being bounded.

Scheduled every 15 minutes as `historicalMiner`, and **the gate lives in the runner**, not
in the scheduler or the route: scheduling is not authorization, and a diagnostics POST
hits the same refusal. Scheduler state records the REFUSAL as well as the run, because
"the gate said no" and "it ran and found nothing" look identical in a row count.

The diagnostics GET is zero-provider and reports **no ETA** — an estimate from a plan that
has never executed against this provider would be a fabricated number in a diagnostics
payload, and those get quoted.

### PART 5 — PRE_MOVE_DISCOVERY_REPLAY_V1

REUSES `classifyDiscovery` rather than reimplementing it. A second implementation would
drift, and the whole point of comparing replay against live is that the same rule was
applied to both. Only the inputs differ.

> **REPLAY_DERIVED is never OBSERVED_LIVE** — and it is on the row, not in a comment.

Detection and decision instants are kept apart: collapsing them scores every setup as
instantly actionable, which is the flattering answer and makes "how much did we consume
while confirming" unanswerable. An absent trigger level yields **null, not false** — a
false asserts "the move has not begun" and short-circuits the measurement, which is
precisely the degenerate column the live lane already had to fix once.

### PART 6 — historical winner events

The entry convention is the whole argument:

```
ENTRY = the ASK at T   (a buyer crosses the spread)
LATER = the MID        (the conservative reading of what the position was worth)
```

Ask for both understates every move; bid for both overstates it; mid for entry claims a
fill nobody was offering. The pairing is recorded ON the event.

**No executable quote at T produces NO event**, not an event with an assumed entry. A
contract that WAS executable and went nowhere **is** an event, because the control group
depends on it — and the census counts that separately from `refusedNoEntry`. Pooling them
would make missing data look like evidence of no edge.

### PARTS 7–9 — HISTORICAL_COHORT_V2 and robustness

A **new version**, not a widening of V1. V1 measures the local paper record; V2 measures
the historical replay record. Different populations, different entry conventions, same
vocabulary — merging them would produce a number meaning neither.

V2 deliberately **inherits** V1's two floors, its counts-without-rates rule, and lane
separation. Those are not conveniences; they are what stops a small or pooled sample
becoming a probability, and re-deriving them differently would create two standards of
evidence in one system.

Robustness is attached to every result and is computed **even when the floors fail** — a
six-event cohort that is 90% one symbol is worth seeing before more collection is
planned. Best-winner-excluded, capped returns, per-session expectancy, symbol/strategy/
regime concentration and tail frequency all travel together.

### PART 10 — HISTORICAL_EDGE_SHADOW_V1

> **MISSING EVIDENCE MUST NEVER BECOME A FAVOURABLE ZERO.**

The easy implementation gives an absent component the neutral value and sums. Under that
scheme a candidate with NO comparables outranks one with twenty bad ones: absence beats
measured disadvantage, and the model learns to prefer the unknown. Components therefore
score only where evidence exists, the mean is taken over what was available, and coverage
is a first-class field.

An insufficient cohort returns a **NULL score, not a low one**. A low score is a finding
about the setup; a null is a finding about us. `UNGRADABLE` and `UNKNOWN` score null for
the same reason — scoring them neutral rewards a blind spot.

Weights are **declared, not fitted**. A weight vector learned over a handful of historical
events would be an overfit dressed as a model, and this is explicitly a hypothesis
generator whose job is to be tested forward.

### PART 11 — prospective comparison

`compareBaselineToShadow` pairs a live baseline rank with a shadow score. `UNCOMPARABLE`
is its own outcome and is **never** counted as agreement — folding it in would make the
shadow look more correct as its coverage got worse.

### PART 12 — Ask OptiScan

Extended the existing loader; no second chatbot. Every historical item declares pipeline
`historical_replay`, separate from every live figure, because a chat that can cite a
number will cite it — if they shared a label, "we have seen 40 setups like this" would
silently mean "we reconstructed 40 from a backfill whose coverage we never stated".

POSSESSION is loaded first and deliberately: every probability below it is meaningless if
the store is empty.

### Commits (5, by concern)

```
5d42de3  Give the mining lane real fetchers, a plan, and a place in the scheduler
4310b14  Answer "where in the move was this" for the past, without cheating
9751b23  Estimate a historical edge, and refuse to let absence look like strength
ee7c371  Let Ask OptiScan cite history, and say how thin the history is
```

Validation: `npm test` twice → **4173/4173** both runs (from 4128; +45). `tsc` clean,
`npm run build` clean, `git diff --check` clean. No new migrations this session — the six
historical tables shipped in the prior one.

### PARTS 13–19 — the first real backfill, after the close

Production reported `session: afterhours` at 20:01Z. `HISTORICAL_INGESTION_ENABLED=1`
was set then and not before; the gate had been refusing all afternoon
(`POWER_HOUR` → `live scanner has provider priority`).

**First bounded run** (defaults: 25 option windows, 15 symbols, 5-minute ceiling):

```
ran=true  session=AFTERHOURS  elapsed 27.6s
plan: 25 option windows, 15 symbols, 18 reference targets, 73 estimated requests
written 117,654   duplicates skipped 15,222   requests 43   blocked 0
jobs completed 58   resumable 0
```

**Idempotence.** The naive check — run it again — did NOT test idempotence, and saying
so matters: the planner correctly ADVANCED to the next 23 windows, so run 2 wrote 92,598
genuinely new rows on 23 new contracts. That is resumability working, not duplication.

The real test is running once the queue is exhausted:

```
RUN3  planWindows=0  written=0  duplicates=0  requests=0
RUN4  planWindows=0  written=0  duplicates=0  requests=0
RUN5  planWindows=0  written=0  duplicates=0  requests=0
coverage unchanged at 326,461 quotes / 73 contracts
```

Zero rows AND **zero provider requests**. `underlying_bars` also reported
`written=0 requests=0` from the very first explicit run, because the scheduler had
already completed those jobs minutes earlier.

**Coverage now possessed** (was zero at session start):

| store | rows | detail |
|---|---|---|
| `historical_underlying_bars` | **60,164** | 15 symbols, 2026-08-03 → 2026-08-07 |
| `historical_option_quotes` | **326,461** | 73 exact OCCs, 2026-07-27 → 2026-08-06 |
| `historical_option_trades` | 0 | not ingested — reported as absent, not implied |
| `historical_contract_reference` | **21,790** | 32 underlyings, expired-inclusive |
| `historical_ingestion_progress` | 144 jobs | 100 COMPLETE, 0 resumable, no errors |
| `historical_market_context` | 0 | derivable on demand; none persisted yet |

**No-hindsight, proven on real data.** `/api/diagnostics/replay-verify` →
`FENCE_HOLDS_ON_REAL_DATA`: 6 contracts checked, 3 verifiable, **0 violations**, 0 extreme
violations. AVGO: quote at T stamped 9s before T, 4,248 quotes after T, entry 8.25 while
the later best ask reached 11.05, forward MFE +27.88% measured only from what followed.

**The verifier's first run said FENCE_VIOLATION, and it was wrong.** Two defects in the
CHECK, not the fence. It scored a contract with no quote at T as a violation — that is the
fence refusing correctly for a T in an overnight gap, and a diagnostic that reports its own
safety behaviour as failure gets ignored exactly when it matters. And it tested that
session-to-date high DIFFERS from the day's final high, which is legitimately equal
whenever the high was made before T; AAPL showed exactly that (312.75 at T and at the
close, while the low still moved). It now tests for EXCESS, which is the thing actually
impossible without hindsight.

**First historical winner events and cohort, on real evidence:**

```
78 delivered-case candidates → 21 events, 57 refusedNoEntry (a COVERAGE gap)
quality: 19 VERIFIED, 0 THIN, 2 UNSUPPORTED
+10 reached 7/21   +25 reached 3/21   +50 0/21   +100 0/21   +200 0/21

HISTORICAL_COHORT_V2:lane=REPLAY_HISTORICAL|replayVersion=PRE_MOVE_DISCOVERY_REPLAY_V1
floors SUPPORTED — 21 events over 6 independent sessions, 2026-07-27 .. 2026-08-06
P(+10) 0.3333    P(+25) 0.1429    P(+50) 0    P(+100) 0
extremeSample INSUFFICIENT_EVIDENCE (19 < 20) → expected MFE/MAE withheld
HISTORICAL_EDGE_SHADOW_V1: SCORED 0.1205, components 3/11, quality INSUFFICIENT
```

Three of those numbers deserve to be read carefully:

- **57 of 78 candidates were refused for no executable entry quote.** Coverage is 27%, not
  a finding about the market. It is counted apart from contracts that were executable and
  went nowhere, precisely so it cannot be mistaken for evidence of no edge.
- **P(+50) = 0 over 21 events is a real, sobering result** — no delivered-case contract in
  the ingested window reached +50% from the ask within 6 hours of detection. It rests on
  21 events over 6 sessions and nothing more.
- **Expectancy, PF and win rate are null**, because a winner event knows its excursion and
  not where the position was eventually closed. Inferring one from the other is the
  peak-as-outcome error, so the module refuses. Joining realized outcomes onto events is a
  named remaining gap.

### Commits (7, by concern)

```
5d42de3  Give the mining lane real fetchers, a plan, and a place in the scheduler
4310b14  Answer "where in the move was this" for the past, without cheating
9751b23  Estimate a historical edge, and refuse to let absence look like strength
ee7c371  Let Ask OptiScan cite history, and say how thin the history is
a8ce4fc  Prove the time fence against real ingested data, by observation
bf72111  Stop the fence verifier from failing the fence for behaving correctly
```

`npm test` twice → **4173/4173** both runs. `tsc` clean, build clean, `git diff --check`
clean. No new migrations. **Recaps, nightly AI and every live lane were left enabled.**

### Remaining gaps

1. **Winner events carry no realized outcome.** Expectancy/PF/win-rate are null across V2
   until events are joined to their closes. This is the single highest-value next step —
   without it the cohort can describe trajectories but not results.
2. **Option TRADES were never ingested** (0 rows). The adapter exists; no plan phase calls
   it. Deliberate — quotes answer "what could have been paid" and trades do not — but it
   means trade-based studies are unsupported.
3. **`historical_market_context` is empty.** Derivation works and is tested; nothing
   persists it on a schedule yet.
4. **Coverage is 27% of delivered cases.** Windows exist for 73 contracts of 78 candidates,
   but only 21 had an executable quote at their exact detection instant.
5. **Replay-derived discovery rows are not persisted.** The classifier runs on demand;
   there is no `pre_move_discovery_replay` table, so cohorts cannot yet stratify by
   replay-derived stage.
6. **The shadow score is not yet recorded beside live candidates.** The comparison function
   exists and is tested; nothing calls it on the live path.

### Exact resume point

The lane is live, bounded, resumable and proven not to cheat. Next, in order:

(a) join realized outcomes onto winner events so V2 can report expectancy and PF;
(b) persist replay-derived discovery rows so cohorts can cut by stage;
(c) let the miner widen — the queue is exhausted at 100 COMPLETE jobs, so raise
    `maxOptionWindows`/lookback and let it keep running off-peak;
(d) wire `compareBaselineToShadow` on the live path to start the prospective record;
(e) schedule market-context derivation.

## Packet update — 2026-08-10 (3) The historical record is now possessed rather than rented, and fenced so a backtest cannot cheat

### Verified state (checked, not assumed)

- Baseline re-verified from git AND production BEFORE any change:
  local = `origin/main` = production = `5f7998d`, `shaAttribution.state OBSERVED`.
  Tracked tree clean, 19 untracked scratch files untouched — still 19 at the end.
- Production healthy throughout: `ok:true`, `loopRunning:true`, `quotaExceeded:false`,
  scheduler owner = this process.
- `LHC_SELECT_V1` **untouched** — neither experiment file opened.
- No strategy threshold, ranking weight, stop, exit, provider cap, owner quality gate or
  subscriber readiness rule changed. Subscriber distribution still BLOCKED. Owner private
  alerts, OWNER_VALIDATION_PAPER, PRE_MOVE_DISCOVERY_V1 live capture, marks, lifecycle,
  grading and the nightly/weekly lanes all continued uninterrupted.

### The finding that reframed the session

The previous audit reported "no durable underlying bar store" as a gap. Surveying the
code first showed the gap was **larger and different**: the fetchers already existed and
were good — `fetchHistoricalOptionQuotes`, `fetchHistoricalOptionTrades`,
`fetchHistoricalBars`, `fetchQuoteAtInstant`, `fetchPremiumCurve`, and
`fetchContractUniverse` (expired-inclusive) — along with a content-addressed cache and a
per-run request accountant.

What did not exist was **possession**. Every fetch was answered from the provider and
discarded; the cache was in-memory. So "the provider has 2023 NBBO" kept being read as
"we can build a 2023 cohort", when in fact every study was one process restart from
having no data at all.

`buildCohorts` confirmed the shape: it is called from a script and from tests, never from
a live path, and it re-fetches from the provider on every run.

### PART 1 — entitlement, corrected against the code

The capability matrix was re-checked against the repo rather than re-read. One row was
**materially stale**: expired-contract reference was recorded `providerMethod: null`,
`NOT_INTEGRATED`, blocker "this is the next integration to build" — while
`fetchContractUniverse` had already shipped **in the same module the rows above it cite**.
A stale row here is expensive in a specific way: it sends a session off to rebuild a
fetcher that exists, and makes an available dataset look unreachable.

Corrected to `INTEGRATED_UNUSED` with the blocker that is actually true. **Entitled,
integrated, and populated are three different states**, and the row now names which one
we are in.

Everything else in the matrix was probed on 2026-07-31 and was **not re-probed today** —
no provider budget was spent on re-proving what runtime evidence already recorded.

### PARTS 2, 4, 5, 6, 20 — the durable store and the lane that fills it

Six additive tables (`CREATE TABLE IF NOT EXISTS`, no backfill, repeat-safe), all inert:
no scanner, gate, alert, stop or exit reads any of them.

```
historical_underlying_bars       PK (symbol, timeframe, ts_ms)
historical_option_quotes         PK (occ, ts_ms)            -- executable NBBO
historical_option_trades         PK (occ, ts_ms, seq)       -- prints
historical_contract_reference    PK (occ)                   -- expired-inclusive
historical_ingestion_progress    PK (job_key)               -- resumability
historical_market_context        PK (session_date, as_of_ms, origin)
```

Three rules hold across the store. **Identity is the primary key**, so re-ingesting a
window is a no-op and dedupe cannot be forgotten by a caller. **Source and quality travel
with the row.** **Nothing stored is derived** — these hold what the provider returned,
normalized, so changing how we reason never requires rewriting history.

Quotes and trades are separate **tables**, not one table with a `kind` column. A trade
print says where the contract traded; an NBBO says what could have been paid. Two tables
cannot be conflated by a forgotten filter.

**The ingestion lane is fenced three ways, all enforced in the runner:**

1. **A session gate that REFUSES** during `REGULAR_SESSION`, `OPENING_DISCOVERY` and
   `POWER_HOUR`. A refusal, not a throttle — slowing mining down during RTH still
   competes for the same minute-partition the scanner needs. A gate that cannot determine
   the session also refuses; guessing "closed" would let a backfill run through the open.
2. **The existing `RequestAccountant`, reused rather than duplicated.** A second budget
   module would mean two ledgers and no real ceiling. Requests are counted *before* they
   are issued, so a cap is a ceiling rather than a target.
3. **A per-run wall clock.** A run that spends its time yields, leaving its cursor.

**Resumable, not restartable.** Each job persists a cursor that advances BEFORE the next
fetch, so a crash loses at most the window in flight. The completion watermark uses `MAX`
so a narrower re-run cannot walk it backwards and re-spend budget on data already held.

Ingestion is **target-driven**: `TIER_1_SYMBOLS` is what OptiScan actually scans, and
option quotes are fetched for event-centred windows. Enumerating every contract's every
day first is how a mining lane spends a month of budget on windows no study will open.

**One real defect found while testing**: the session-state helper was loaded with a lazy
`require` that failed to resolve under the test runner. The gate then refused everything —
safe, but it silently disables the entire lane, and that failure mode is
indistinguishable from "the market is open". Now a static import; the module is pure.

### PARTS 7–8 — the replay engine, and proving it cannot cheat

`HISTORICAL_REPLAY_V1`. The one rule:

> **ONLY DATA TIMESTAMPED <= T MAY BE VISIBLE.**

Every read is fenced by `asOfMs` **in SQL**, never post-filtered in TypeScript. A
post-filter is a line someone can move, reorder or short-circuit, and the resulting leak
produces a backtest that looks brilliant and predicts nothing. `WHERE ts_ms <= ?` cannot
be bypassed by editing a caller. This is also why replay reads the STORE and not the
provider: a live fetcher has no notion of "as of".

Session extremes are **session-to-date through T**, computed from the fenced bars the
module fetched itself. The day's final HOD/LOD is the most seductive leak in this
codebase precisely because it is what makes a "share of the move consumed" metric look
precise.

Forward measurement lives in the same file, named so it cannot be mistaken for
reconstruction, and is the **only** place hindsight is legitimate. Entry is the **ASK at
T** (a buyer crosses); later observations are the **MID**. Using the ask for both
understates every move; the bid for both overstates it.

**The harness proves the fence by INVARIANCE, not inspection** — reconstruct at T, write
the future, reconstruct again, assert byte-identical. A leaking replay also "looks right";
it looks *better*. Only invariance distinguishes them. 14 tests, including:

- the stock **doubles** after T → the session high at T is unchanged
- a **+900% quote one second later** → not the quote in force at T
- 300 later bars → the view at T is byte-identical
- a trade print exists at T but no NBBO → `executableAsk: null`, `INSUFFICIENT`. Someone
  traded there; that is not proof we could have.
- no quote within tolerance → `null`, never the nearest one
- another symbol's bars → cannot leak into this symbol's state
- `settledOnly` excludes the bar still forming at T

### PART 3 — why regime was empty, and what actually fixes it

`market_context_snapshots` had 0 rows and **the writer is not broken**.
`recordMarketContext` works; its only caller is an on-demand HTTP route, so a snapshot
exists only if somebody loads a page. Nothing scheduled has ever called it. Meanwhile the
scheduled watchlist job writes a **different** table (`watchlist_market_context`, keyed by
trading day), which is why regime never looked missing from the product side.

Scheduling the old writer would not fix the real gap. **Regime at an INSTANT** is what
replay needs, and a once-a-day snapshot cannot answer it for 09:47 on a Tuesday.
`deriveHistoricalMarketContext` computes it at any instant from stored bars, under the
same time fence.

`origin` is part of the **PRIMARY KEY**, not a comment: a reconstruction and a measurement
written to one table with one shape become indistinguishable, so a derived row can never
overwrite an observed one, and the reader prefers the measurement when both exist.

Three states a lazy implementation collapses are kept apart, because a cohort stratified
on a regime that silently means "no data" is stratified on nothing and will look like a
real effect: **UNKNOWN** (could not see the indices), **MIXED** (saw them, they
disagreed), **FLAT** (saw them, barely moved).

### Production state of the new store

Deployed and verified at `c0f166f`. All six tables exist and answer queries (0 rows, not
errors). Ingestion gate: `allowed: false`, reason `HISTORICAL_INGESTION_ENABLED!=1`.

**The store is EMPTY, and that is the honest headline.** An empty store and an absent one
support exactly the same amount of research. Everything downstream of it — replay-derived
discovery, winner events, cohorts v2, edge shadow — is built on data that does not exist
yet and would produce `INSUFFICIENT_EVIDENCE` by construction.

Ingestion was deliberately **not** switched on in this session: the flag change is a
production configuration change that spends provider budget, and the session ran entirely
during RTH, when the gate would have refused anyway.

### Commits (5, by concern)

```
22ec77d  Possess the historical record instead of renting it, and fence it in time
14c4d87  Let mining fill the store without ever competing with the scanner
8dbd71d  Give regime a history, and say when it is a reconstruction
c0f166f  Make possession of the historical record inspectable
5c42f2e  Correct a capability row that had been overtaken by the code
```

Validation: `npm test` → **4128/4128** (from 4094 at baseline; +34). `tsc --noEmit` clean.
`npm run build` clean. `git diff --check` clean. Six additive migrations, no backfill.

**One intermittent failure** in one of four full-suite runs; three subsequent runs were
clean and its name was not captured. The previous session identified
`options-monitor.test.mjs` #6 (a 10ms wall-clock assertion) as flaky under load, and no
other test has ever failed intermittently here — but this specific occurrence is
**unconfirmed**, and it is recorded as unconfirmed rather than assumed.

One commit (`8dbd71d`) was amended before push after `tsc` caught a `ProcessEnv` type
error in it. Nothing broken was pushed.

### NOT BUILT this session, and why

Parts 9–19 were **not** built. They are the analysis layers — replay-derived
`PRE_MOVE_DISCOVERY_REPLAY_V1`, the verified +25/+50/+100/+200 winner universe, pre-run
winner research, cohort V2, `HISTORICAL_EDGE_SHADOW_V1`, the Ask OptiScan extension —
and every one of them consumes the durable store.

Building them against an empty store would produce modules whose every method returns
`INSUFFICIENT_EVIDENCE`, tested only against synthetic fixtures, with no way to tell a
correct implementation from a broken one. That is the same mistake as
`PRE_MOVE_DISCOVERY_V1` shipping complete-and-uncalled, which cost a session to discover.

They are recorded as **engineering still incomplete**, not as done, and they are
**unblocked the moment ingestion runs**.

### Exact resume point

The foundation is deployed and inert. To unblock everything downstream, in order:

(a) set `HISTORICAL_INGESTION_ENABLED=1` in Railway and run the first backfill **off-peak**
    (the gate enforces this; a weekend is ideal). Start with `TIER_1_SYMBOLS`, `1m` bars,
    a bounded window, and read `/api/diagnostics/historical-store` for cursors and
    coverage. Verify the second run writes ~0 rows — that is idempotence working;
(b) wire the real fetchers to the ingestion deps (`fetchBars`/`fetchContracts`/
    `fetchQuotes` are injected and currently supplied by nothing scheduled);
(c) backfill expired-contract reference for the symbols with historical opportunity cases,
    then event-centred NBBO windows around them;
(d) only then build `PRE_MOVE_DISCOVERY_REPLAY_V1` on top of the replay engine — keeping
    its identity separate from live-observed `PRE_MOVE_DISCOVERY_V1`, and stamping every
    row `REPLAY_DERIVED`;
(e) then the winner universe, cohort V2, and `HISTORICAL_EDGE_SHADOW_V1` in shadow.

The two hardest problems are already solved and tested: the store cannot double-count, and
the replay cannot see the future.

## Packet update — 2026-08-10 (2) The correction pass ran, earliness started measuring, and two metrics that always agreed with us were caught doing it

### Verified state (checked, not assumed)

- Baseline re-verified from git AND production BEFORE any change:
  local = `origin/main` = production = `683411e`
  (`/api/runtime/status` → `shaAttribution.state OBSERVED`, source `RAILWAY_GIT_COMMIT_SHA`).
  Tracked tree clean, 19 untracked scratch files untouched — still 19 at the end.
- Production healthy at baseline and throughout: `ok:true`, `loopRunning:true`,
  `quotaExceeded:false`, session `regular`, scheduler owner = this process.
- `LHC_SELECT_V1` **untouched**. Neither `selection-experiment.ts` nor
  `experiment-registry.ts` was opened. Still frozen, still `SHADOW_PAPER_ONLY`.
- No strategy threshold, ranking weight, stop, exit, provider cap, owner quality gate or
  subscriber readiness criterion changed. No real-money path. Nothing subscriber-approved.

### PART 1 — the correction pass ran against production, twice

`runExcursionCorrectionPassOnDb` existed, was repeat-safe, and had **no caller**. It now
has one, split by verb: `GET /api/diagnostics/excursion-correction` is a DRY RUN,
`POST` applies. A GET that wrote would make the audit a side effect of reading it, and
the guarantee that the pass cannot worsen the history it audits would depend on nobody
curling it. A test asserts both produce an identical census.

**Authoritative production census (delivered scope, 78 cases, applied at `abb74f1`):**

| state | count |
|---|---|
| `VERIFIED_EXCURSION` | **20** |
| `INSUFFICIENT_MARKS` | **15** |
| `UNSUPPORTED_MAX_RETURN` | **31** |
| `MAX_FLOORED_AT_ZERO` | **8** |
| `NO_MIRROR` | **4** |
| `OCC_IDENTITY_MISSING` | **0** |
| `storedValuesWrong` | 39 |
| publishable | 20 |

Correction store: **78 recorded**, corrected canonical MFE **20**, corrected canonical
MAE **20**, **unresolved (null) 58**, stored values condemned 58.

`unresolved` is reported as its own number rather than folded into "corrected" or
"clean". A correction can be recorded and still resolve to nothing: `UNSUPPORTED_MAX_RETURN`
establishes the stored value is wrong without establishing the right one.

**Repeat safety verified live**: the POST was run twice; identical census, 78 rows, keyed
by case so the second pass updated rather than duplicated. `opportunity_cases` was never
edited — the original `summary.maxReturnPct` survives verbatim beside the record that
condemns it.

*(The counts differ from the 2026-08-07 audit's 22/36/20/4 because marks have accrued
since. The population is the same 78; the evidence under it moved.)*

### PART 2 — two more doors the unverified peak was still walking through

**The historical digest.** The individual draft renderer was fixed to supersede
`opportunity_content_events.max_return_percent` with a claim check. The digest read the
same column **raw** and rendered it as "best mark". Measured in production: the pending
digest quoted +87.7256% and +64.4518% on two AAPL outcomes, neither resolved through any
excursion evidence. `readHeldDraftRows` now resolves through
`resolvePublishableExcursionOnDb` at the LOAD boundary, so the grouping,
`deriveFailureCause` and the evidence-quality score all reason over the verified value —
otherwise a withheld peak would still be narrating "gave profit back" one function later.

**The trade-level column.** `options_paper_trades.mfe_pct` was aggregated
`MAX(return_pct) WHERE trade_id=?` with **no contract predicate**, and the 0DTE lane
ratcheted it off its own previous stored value. Both are the shape that produced the
+185.4% case peak. Both now derive from marks whose own `option_symbol` is the position's
contract. No exit, stop or gate reads the column — the AI lanes, quant and the report
cards do.

A trade may be `REALIZED_RETURN_VERIFIED` + `EXCURSION_UNSUPPORTED`, and everywhere this
session that state is preserved: the realized outcome is never discarded to avoid a peak.

### PARTS 3–4 — NO NEW FAILURE OBSERVED (and that is not the same as "the fix holds")

The audit reported ONE prospective rate measured from the mirror fix
(2026-08-07T23:14:28Z). Reason capture shipped much later, in `683411e`, live on Railway
at **2026-08-10T15:29:01.506Z** (CONFIGURE_NETWORK completed — the moment the container
began serving, not the moment the deploy was created; the previous build served for the
~3 minutes in between).

Quoting one rate across both epochs lets three permanently undiagnosable failures keep
describing a period in which the system can actually explain itself. `postInstrumentation`
is now its own block, not a filter on the existing one.

**Production, end of session:**

```
prospective        : openings 16, mirroredExact 13, mirrorRate 0.8125
postInstrumentation: openings  5, mirroredExact  5, mirrorRate 1.0,
                     failures [], verdict NO_NEW_FAILURE_OBSERVED
```

The three unmirrored openings — SPY 13:31:15Z, TLT 13:31:21Z, TSLA 14:21:24Z — **all
predate reason capture**, all carry `mirrorAttemptReason: null`, and their causes are
**unrecoverable**. Nothing was reconstructed for them. Every one of the 5 instrumented
openings carries `mirrorAttemptReason: "opened"`.

**A clean sample of 5 is NOT evidence the fix holds.** The verdict vocabulary says
exactly that, in the payload rather than in a comment. An instrumented opening that fails
WITHOUT a reason is flagged `reasonMissing` — a hole in the instrumentation, not an
unexplainable event.

### PARTS 5–8 — PRE_MOVE_DISCOVERY_V1 is live, and its first metric was lying

The module was complete and tested and **nothing called it**. A classifier with no capture
site is a function, not a measurement.

Capture is wired at `persistCaseFromOptionsLive` in the options loop — the boundary where
pre-entry evidence still exists. Every value is lifted from what the scan already had:
the decision-time candidate, the selected contract, and the enriched feature block the
monitor computed from bars it had already fetched. **No provider call.** A field the
scanner did not compute is stored null and named in `missingFields`.

`opportunity_pre_move_discovery` is additive, `IF NOT EXISTS`, repeat-safe. The invariant:

> **DETECTION-STAGE EVIDENCE IS WRITE-ONCE.**

The scanner re-evaluates the same living case many times a session. If a later observation
could overwrite "the underlying when we first saw it", the stage would compare the alert
price against a price taken moments earlier and report every alert as perfectly early.
Three deliberate exceptions, each with a stated reason: session high/low use MAX/MIN so
the day's extent can widen but never narrow (a shrinking denominator inflates the share
consumed), and `underlying_at_latest` / `option_at_latest` are overwritten every scan
because they are the honest current endpoint for a case that never alerted — most of the
research and shadow population, which would otherwise measure detection against itself.

`OWNER` is not assignable at capture. `recordPreMoveAlertOnDb` promotes the row only
after an owner send actually succeeds, and the alert timestamp is write-once so a retry
cannot shorten a measured lead.

**Lead-time grading** (`pre-move-nightly.ts`, deterministic, no model call): ms from the
alert to +10/25/50/100/200 on the frozen contract's own marks, post-alert MFE (VERIFIED
excursion only), premium consumed before the alert, and `milestonesReachedBeforeAlert`
counted separately. **REWARD_REMAINING** is advisory and null — never 0 — when the day
offered no measurable favourable extent.

#### The degenerate column, caught in production four hours after shipping

At `9018ae5`: **174 of 174 captured rows classified `PRE_TRIGGER`**, evidence quality
`COMPLETE` on every one. That is not a market observation.

`triggerTaken` compared price to `nearestResistance` for a call and `nearestSupport` for a
put. `features.ts` builds those by filtering candidate levels to those strictly **above**
and strictly **below** the current price — so `price >= nearestResistance` is structurally
impossible for every candidate that will ever be evaluated. The input was always false.

The damage was larger than one field. `classifyDiscovery` checks `PRE_TRIGGER` first and
short-circuits, deliberately, so an always-false trigger **silenced the consumed-fraction
measurement for the entire population**. The system would have reported itself as
perfectly early, on complete evidence, indefinitely.

`triggerTaken` now comes from the direction-aware break flag (`hodBreak` for a call,
`lodBreak` for a put) — taking out the session extreme in the direction the trade needs IS
the trigger event, and unlike the comparison it varies. Absent flag ⇒ **null, not false**:
a false asserts "the move has not begun" and skips the measurement. Two tests pin the
class, not the instance: `PRE_TRIGGER` must be both earnable and losable from otherwise
identical inputs, and an unknown trigger must not short-circuit a provably spent move.

### PART 9 — the nightly can now ask whether we found it before it ran

`buildPreMoveNightlyReport` is wired into `nightlyResearchContext`, so the narration
prompt carries it, and exposed at `/api/diagnostics/pre-move`. Lane-separated —
OWNER / RESEARCH / SHADOW / EXPERIMENT are never pooled. `OWNER_VALIDATION_PAPER` was
already its own audience in Evidence Learning and was verified so.

Rates are computed over GRADABLE rows only: including `UNGRADABLE` in the denominator
would let a day of missing inputs read as a day of late discoveries — the opposite
finding. The standing questions are emitted as question/answer pairs so a refusal stays
legible; `INSUFFICIENT_EVIDENCE` is a finding, a silently omitted metric is not.

### PART 10 — historical data truth (`/api/diagnostics/data-truth`)

**A. Underlying.** There is **NO persisted bar/candle table.** Bars are fetched per scan,
consumed by `computeOptionsFeatures`, and discarded. What survives is the derived feature
snapshot at scanner cadence, not the price series. This is a STORAGE fact, not a provider
limitation, and conflating the two sends the fix to the wrong place.

| store | rows | range |
|---|---|---|
| `options_candidates` | 75,332 | 2026-07-22 → 2026-08-10 · 2,967 symbols · 15,195 contracts |
| `options_research_observations` | 105,234 | 2026-07-31 → 2026-08-10 · 2,755 symbols · 7 sessions |
| `market_context_snapshots` | **0** | empty — regime context has no rows at all |

**B. Provider (probed 2026-07-31, not re-probed today — no quota spent).** 10 proven,
0 not entitled, 1 unproven, **5 integrated, 5 entitled-but-UNINTEGRATED**. Per-OCC NBBO
back to 2023-07-31 is `INTEGRATED_UNUSED`. Expired-contract reference is `NOT_INTEGRATED`
and is the blocker for enumerating any historical cohort universe. Historical OI and
Greeks are **not reconstructible** for a past session.

**C. Actually ingested.**

| store | rows | range | contracts |
|---|---|---|---|
| `options_paper_marks` | **228,120** | 2026-07-24 → 2026-08-10 | 422 |
| `options_paper_trades` | 864 | 2026-07-22 → 2026-08-10 | 496 |
| `options_snapshots` | 41,474 | legacy TEXT dates — id ordering only | 435 |
| `opportunity_contract_candidates` | 724 | 2026-07-29 → 2026-08-10 | 448 |
| `opportunity_cases` | 49,405 | 11 sessions | — |
| `opportunity_excursion_corrections` | 78 | applied today | — |
| `opportunity_pre_move_discovery` | 247+ | from 16:11:59Z today | 184 |

**PROVIDER HAS IT != OPTISCAN HAS IT.** Local option history spans **17.02 days**.

### PARTS 11–13 — the gate is open; the first result was a pooled fiction

Gate evaluated live rather than asserted, and all five checks pass: correction pass
applied (78 records), no raw-column excursion reader left, PRE_MOVE wired (rows
accruing), exact OCC enforced, local option history present.

`HISTORICAL_COHORT_V1` is deterministic, shadow only, and its whole purpose is making one
refusal automatic: **AI confidence is not a probability, and neither is a small sample.**
Two floors, required together because they fail for different reasons — 20 trades (too
little data) and 5 independent sessions (too little independence). Counts are always
reported; the RATE is withheld, because "3 of 4" cannot be misquoted and "75%" can.

Two admission rules, deliberately different: trajectory claims need `VERIFIED_EXCURSION`;
realized claims need only a verified closed outcome. Demanding the stronger evidence for
the weaker claim would discard realized returns that reconcile perfectly.

**First live run at `4beb355` — and it caught the module's own worst defect.** The ALL
cohort reported profit factor **0.5246**, win rate 0.2757, over 642 "verified realized
outcomes" across 9 sessions. Arithmetically correct; describes nothing. Those 642 spanned
`DELIVERED_ALERT_PAPER`, `OWNER_VALIDATION_PAPER`, `RESEARCH_ONLY_PAPER` and
`ZERO_DTE_RESEARCH_PAPER` — four disjoint lanes that have never coexisted as one tradeable
population. The sample floors stop a rate computed from too few observations; they say
nothing about whether the observations belong together, and **pooling is what makes the
sample large**.

`paperKind` is now the first field of `CohortKey` and part of the cohort id. A cohort
spanning lanes sets `pooledAcrossLanes` and carries a limitation forbidding it being
quoted as the system's performance. The route returns `byLane` **always, never behind a
flag** — making the honest cut opt-in is how the pooled number ends up quoted.

Pooled figures observed (DIAGNOSTIC ONLY, not a performance claim): P(+10) 0.5971,
P(+25) 0.4248, P(+50) 0.2524, P(+100) 0.0267 on 412 verified excursions over 9 sessions;
expected MFE +27.97%, expected MAE −29.33%.

### PART 14 — HISTORICAL_EDGE_SHADOW_V1: NOT BUILT, deliberately

Its stated inputs include discovery stage on historical rows. `opportunity_pre_move_discovery`
holds **1 session**, all captured today, and historical cases have no prospective capture.
Building a rank-comparison model on that would mean inventing the very field the model
ranks on. Recorded as **engineering still incomplete**, not as done.

### PARTS 16–17 — Ask OptiScan audited, not rebuilt

The existing chat's grounding contract is sound: `validateAdvisoryAnswer` refuses any
numeric claim not traceable to an `EvidenceItem`. The gap was never the validator — it was
that `loadSupplementalEvidence` loaded only exit-policy and watchlist evidence, so "did
you find this before it ran", "how early" and "how much reward was left" had no citable
item and were **unanswerable rather than wrong**.

It now also loads the owner lane and the PRE_MOVE owner-lane census, each in its own try
block. The two mirror rates are carried as SEPARATE items with separate meanings — a chat
that can cite a number will cite it, and one blended rate would let three undiagnosable
failures describe an instrumented period. Each item's `meaning` states the trap: an
unmarked alert is unmeasured, an open mirror is not a zero return, a realized win does
not imply a verified excursion.

**Explain This**: exact case identity already flows (`opportunityCaseId` is the join key
across cases, alerts, mirrors, marks, corrections and now discovery rows). No trade is
identified from ticker text. Not separately re-plumbed this session.

### PART 18 — readiness architecture

**Nothing subscriber-approved. Subscriber distribution remains BLOCKED.** Readiness stays
strategy/version specific and human-gated. The new evidence (discovery stage, lead time,
reward remaining, post-instrumentation mirror integrity, per-lane expectancy) is now
computable and is deliberately NOT wired into the readiness gate — that is a live
authority change and was out of scope.

### Commits (12, by concern)

```
d6b5498  Give the correction pass a way to be read before it is applied
68fe841  Price a trade's stored excursion on the contract the trade actually holds
abb74f1  Give PRE_MOVE_DISCOVERY_V1 a capture site so it measures something
1e78756  Stop one mirror rate from describing two different questions
b7bbcaf  Close the second door the unverified peak was still reaching the owner through
87bf45d  Separate what the provider would sell us from what we actually hold
6bd58ee  Let the nightly ask whether we found it before it ran
9018ae5  Keep the pre-move module inside the model-free boundary
26bacc5  Make refusing to state a probability the automatic path
4beb355  Give Ask OptiScan the evidence to answer the owner's actual questions
ebc96c2  Stop PRE_TRIGGER being the only answer the capture could give
bc3664f  Refuse to let one cohort describe four populations at once
```

Validation: `npm test` twice → **4094/4094** both runs (from 4048 at baseline; +46).
`npx tsc --noEmit --incremental false` clean. `npm run build` clean. `git diff --check`
clean. Two additive migrations (`opportunity_pre_move_discovery` + its two indexes),
`CREATE TABLE IF NOT EXISTS`, no backfill, repeat-safe.

**One flaky test observed and NOT fixed**: `options-monitor.test.mjs` #6 asserts a 10ms
wall-clock budget on a synchronous prefix. It failed once in four full-suite runs and
passed 3/3 in isolation on an unchanged tree. It is load-dependent, not a regression from
this session, and rewriting a timing assertion was out of today's scope.

### Remaining defects

1. **58 of 78 delivered cases have no provable excursion.** By design — the correction
   store records that the stored value is wrong without inventing a replacement. But it
   means 74% of the delivered history cannot support a trajectory claim of any kind.
2. **`market_context_snapshots` is EMPTY (0 rows).** Regime is a stated cohort
   stratification dimension and there is no regime data to stratify on. Not investigated.
3. **5 provider capabilities are entitled and unintegrated**, including expired-contract
   reference — the blocker for any historical cohort universe beyond the local 17 days.
4. **No persisted underlying bar store.** Pre-run winner research is limited to
   scanner-cadence feature snapshots unless a re-fetch lane is built.
5. **The three unmirrored owner openings stay ungradable forever.** Recorded, never
   reconstructed.
6. **Other hand-built test fixtures remain.** One more was converted this session
   (`historical-digest`), and every new test file uses the real migration; others still
   hand-copy.

### Exact resume point

The measurement foundation is **live and accruing** rather than designed: the correction
pass has run and is repeat-safe, PRE_MOVE_DISCOVERY captures on every qualified candidate,
lead time and reward remaining compute from same-contract marks, the nightly consumes all
of it lane-separated, and the probability layer exists with its refusals wired in front of
its numbers.

Two metrics that always agreed with us were caught and killed **in production, by looking
at the output rather than the tests** — the always-`PRE_TRIGGER` column and the
lane-pooled cohort. Both had passing tests and complete-looking evidence.

Next session, in order:
(a) read `/api/diagnostics/pre-move?days=0` for the FIRST owner-lane discovery rows with a
    real alert — none existed when this session ended, so every earliness figure is still
    `INSUFFICIENT_EVIDENCE`;
(b) cut the cohort `byLane` once each lane clears 20 trades / 5 sessions and see whether
    the delivered lane's expectancy survives separation;
(c) investigate why `market_context_snapshots` is empty before relying on regime anywhere;
(d) integrate expired-contract reference if historical cohorts beyond 17 days are wanted;
(e) only then consider `HISTORICAL_EDGE_SHADOW_V1`, which needs discovery stages that do
    not exist on historical rows.

## Packet update — 2026-08-10 The peaks are quarantined, the owner lane is visible, and earliness now measures the move

### Verified state (checked, not assumed)

- Baseline re-verified from git AND production BEFORE any change:
  local = `origin/main` = production = `d69a640`
  (`/api/runtime/status` → `deploy.commit d69a640445646abc3ff8f1e074b5c9c982befedc`,
  `shaAttribution.state OBSERVED`). Tracked tree clean, 19 untracked scratch files
  untouched — and still 19 at the end.
- Production healthy at baseline: `ok:true`, `loopRunning:true`, `quotaExceeded:false`.
- **Scanner watchdog verified live**: `/api/diagnostics/loop-health` → `HEALTHY`,
  1030/1030 ticks completed, 0 timeouts, 0 abandoned, `schedulerOwner.isThisProcess true`.
- `LHC_SELECT_V1` **untouched**. `LHC_SELECT_V1_DEFINITION_HASH` still
  `80e5c5d878f5f9e185661981c87afc63`, mode still `SHADOW_PAPER_ONLY`. Neither
  `selection-experiment.ts` nor `experiment-registry.ts` was modified.
- No strategy threshold, ranking weight, stop, exit, provider cap, subscriber readiness
  criterion or owner alert quality gate changed. No real-money path. No probability
  model built.

### PRIORITY 1–2 — a mark must name its contract

`applyOpportunityMarkOnDb` took **no OCC at all**. Every price handed to it was divided
by the frozen entry and ratcheted into `maxReturnPct`, which is precisely how marks from
re-selected strikes became the +185.4077% GOOGL peak.

It now requires `markOptionSymbol` and refuses unless it equals the case's frozen OCC.
**Absent and ambiguous fail exactly like mismatched** — a case observes many contracts on
one underlying, so symbol-only identity is not identity. Refusal states are explicit:
`MARK_OCC_MISSING`, `FROZEN_OCC_MISSING`, `MARK_OCC_MISMATCH`, `CASE_NOT_FOUND`.

**A refusal writes nothing.** Identity is settled before any row is touched: no
RETURN_MILESTONE, no NEW_HIGH, no summary, no Discord claim. A guard that rejected the
return but still stamped a milestone would only have moved the contamination.

`closeOpportunityOnDb` got the same guard with one deliberate difference: **closing is a
lifecycle fact and still happens**. Only the exit price and return are dropped when they
cannot be tied to the frozen contract — the position really did exit.

The one production caller (`grade.ts`) passes `pos.option_symbol`; a refusal is recorded
as a lifecycle suppression rather than swallowed.

### PRIORITY 3–4 — excursion is a different claim from realized return

`lib/opportunity-case/excursion.ts`. Realized return is ONE observation and reproduces on
the frozen contract for all 78 delivered cases. An excursion is a claim about EVERY
moment of the holding period, and a trade marked twice cannot support one.

Canonical recomputation uses only the frozen OCC, the frozen entry, and marks whose own
`option_symbol` is that OCC. States are explicit and uncollapsed:

`VERIFIED_EXCURSION` · `INSUFFICIENT_MARKS` · `UNSUPPORTED_MAX_RETURN` ·
`MAX_FLOORED_AT_ZERO` · `NO_MIRROR` · `OCC_IDENTITY_MISSING`

**Ordering defect found and fixed during implementation.** A stored `0` on a losing trade
is *also* numerically above the best mark, so a naive exceeds-check swallowed it and
reported contamination. It is classified first. Reporting a seeded zero as cross-contract
would be its own false claim and would have buried the 36 cases that genuinely are.

`MIN_MARKS_FOR_EXCURSION = 3` — a floor on honesty, not a statistical result. Two marks
show two moments; calling the better one "the maximum" asserts the gaps held nothing
larger. A VERIFIED excursion is always stated as "the best mark observed", never "the high".

**Corrections are added records, never edits.** `opportunity_cases` keeps its original
`summary.maxReturnPct` verbatim so a number that was once published stays visible.
`opportunity_excursion_corrections` (new table, additive, `IF NOT EXISTS`, repeat-safe,
keyed by case so a re-run updates rather than duplicates) holds the original value, its
source, the state that condemned it, the corrected value where provable, the SHA, the
timestamp and the reason. **Where nothing is provable the corrected value is `null`** —
knowing a value is wrong is not knowing the right one — and there is no code path back to
the stored legacy number.

### PRIORITY 5–6 — withhold the peak, not the trade

Two defects in the content gate, pointing opposite ways.

**It only refused a peak it could prove WRONG.** A case with no marks — nothing to
contradict — passed and printed whatever the summary held. The gate now requires POSITIVE
evidence: unprovable fails closed exactly like disproven.

**It sank the whole draft for excursion-only defects.** That would suppress dozens of
realized returns that reconcile perfectly in order to avoid one false peak.
`realizedReturnIsPublishable` ignores `UNSUPPORTED_MAX_RETURN` and `MAX_FLOORED_AT_ZERO`,
so realized and excursion are gated independently.

**Passing the gate was never enough.** The renderer read
`opportunity_content_events.max_return_percent` — a copy of the ratcheted summary and the
literal source of the published figure. A claim check now supersedes that column: a
verified peak replaces it, an unverified one blanks it, `renderLine` drops every line
whose placeholder is missing, and `buildDraftBundle` drops any draft that discusses a
maximum favourable move in prose without one. `deriveFailureCause` reads the same verified
value, so a floored 0 can no longer narrate "never moved in our favour" for a trade that did.

Net effect on the GOOGL case: **the draft publishes its realized +47.2103% and says
nothing about a peak.** `observedBestMarkPct` reports the truthful +47.2103% for diagnosis
and is never rendered.

### PRIORITY 7–9 — the nightly can finally see the lane it validates

Evidence Learning excluded `OWNER_VALIDATION_PAPER`, so on a day whose only deliveries
were 16 owner openings the AI saw an empty session.

It is now included **as its own audience and source_kind, never blended** — an owner
validation trade is not a subscriber delivery, and pooling their expectancies describes a
population that has never existed. Same reasoning gives it its own `FindingPipeline` and
its own `examples.ownerValidation` count.

**Realized and trajectory are now separate measurements at every meeting point.**
`mfe_pct`/`mae_pct` come from `excursionForPaperTradeOnDb` — same-contract marks only,
null unless there are enough — instead of the stored column, and `missing_fields` reports
the peak as unmeasured. A VERIFIED +47% winner with two marks stays a WIN with no MFE.

`/api/diagnostics/owner-mirror` now carries `realizedEvidence`
(`VERIFIED`/`STILL_OPEN`/`UNAVAILABLE`) and `excursionState` per opening, and the
prospective block counts `withMarks`, `withoutMarks`, `realizedVerified`,
`realizedStillOpen`, `realizedUnavailable`, `excursionVerified`, `excursionInsufficient`.

### Monday arrived DURING this session — and the mirror fix is 0.7, not 1

Production moved from `afterhours` to `regular` mid-session, and 2026-08-10 produced
**10 owner openings after the mirror fix**. This is the first live exercise of the chain,
and it is a partial pass:

```
prospective: openings 10, mirroredExact 7, mirrorRate 0.70,
             withMarks 7, withoutMarks 0,
             realizedVerified 1, realizedStillOpen 6, realizedUnavailable 3,
             excursionVerified 7, excursionInsufficient 0
```

**7 of 10 hold the full chain**: exactly one mirror, the exact alerted OCC, a frozen
entry, same-contract marks (6–160 of them), and a VERIFIED excursion. QQQ 13:32Z has
already closed with `realizedEvidence VERIFIED`.

**3 left no mirror at all**: SPY 13:31:15Z, TLT 13:31:21Z, TSLA 14:21:24Z — all
`NO_FORWARD_PAPER_EVIDENCE` / `NO_MIRROR`. Two of the three are in the first minute after
the open. **`mirrorRate` is 0.70. The fix does NOT hold universally, and it is reported as
0.70 rather than rounded up.**

**Root cause is not yet known, and the reason it is not known was itself a defect.**
`openOwnerValidationPaperOnDb` returns a precise reason — `entry_gate:*`,
`paper_gate_rejected`, `exact_occ_required`, `quote_freshness_unavailable` — and the call
site returned it to nobody and persisted nothing. The audit could see WHICH openings lost
their mirror but never WHY, and "no mirror" has several very different causes with
different fixes.

`recordOwnerMirrorOutcomeOnDb` now writes the outcome onto the case JSON the audit already
loads, and `mirrorAttemptReason` is surfaced per opening. **The three failures from this
morning predate that capture and their reason is not recoverable** — nothing was
reconstructed for them. The next owner opening that fails will say why.

### PRIORITY 10 — the old metric was not earliness

`earliness_phase` is `(price − LOD) / (HOD − LOD)`: where price sits inside the session
range so far. Sound, pre-entry safe, and **not earliness**:

- **Direction-blind.** For a PUT a low fraction means the downside move has largely
  already happened — the latest possible entry — and it was bucketed `"early"`.
- **Unstable.** The denominator grows through the day.
- **No lifecycle.** It cannot tell "has not moved yet" from "round-tripped to the low".
- **No reward remaining.** It cannot size how much of the move is left.

**The stored column, buckets and thresholds are untouched.** Silently redefining old rows
would make the record less trustworthy, not more. What changed is the name it is reported
under: `SESSION_RANGE_POSITION`, carrying `SESSION_RANGE_POSITION_SEMANTICS` — including
the PUT warning — **as data rather than as a caption**, because captions are edited more
often than data contracts. The recap now prints
`Session range position (not earliness): low · mid · high`.

### PRIORITY 11–14 — PRE_MOVE_DISCOVERY_V1

`lib/research/options/pre-move-discovery.ts`. **Diagnostic only** — no gate, threshold or
ranking weight reads any of it.

Favourable is defined by the contract: **up for a CALL, down for a PUT**, so "consumed"
always means favourable move already spent. `favorableMovePct` returns POSITIVE for both
when the move went the trade's way.

Stages: `PRE_TRIGGER` → `EARLY_CONFIRMATION` → `EARLY_EXPANSION` → `MATURE_MOVE` →
`TOO_LATE`, plus `UNGRADABLE` for absent inputs — a real answer, never 0. `PRE_TRIGGER` is
checked first because a move that has not begun cannot be "25% spent".

**No hindsight.** `classifyDiscovery` reads nothing dated after the alert. Outcomes exist
only in `gradeDiscovery`, which asks the different question "was the label useful?". Fusing
them yields a metric that grades itself perfectly in backtest and is worthless live.

**Lead time keeps both answers apart.** `computeAlertLeadTime` reports ms-to-+10/25/50/
100/200 measured FROM the alert, and separately `milestonesReachedBeforeAlert` and
`premiumConsumedBeforeAlertPct`. A milestone reached before the alert is never counted as
lead time. `postAlertMfePct` is withheld unless the excursion is VERIFIED.

**REWARD_REMAINING** is advisory, uses only already-defensible inputs, and is `null` — not
0 — when the day offered no measurable favourable extent. No probability engine: that needs
VERIFIED excursion evidence that does not exist yet.

### PRIORITY 15 — provider units

49 and 780 were both right and neither carried its unit.
`providerPressureAccountingOnDb` reports `attempts`, `distinctSymbols`, `retryRatio` and
the `window` (`FULL_SESSION` vs `ROLLING_WINDOW`) together, with an explicit
`warning: attempts and distinctSymbols are DIFFERENT UNITS`. Retry inflation is 1.26× —
the time range was always the explanation. **No cap raised, no cadence changed.**

### PRIORITY 16 — the recap, proven against the schema production has

The `option_side` fix from `2c1a891` was verified present and correct. But its regression
test **still built `discord_deliveries` by hand** — the very practice that let the broken
query ship green.

`applyProductionSchemaOnDb` is now exported from `lib/db.ts` and runs the real `migrate()`.
`SCHEMA` stays private: it is only half the shape (`opportunity_cases.session_date` exists
only after the ALTERs), and a fixture built from half a schema is the same class of bug.

Converting three test files immediately surfaced columns the hand-copies never had —
`discord_deliveries.channel_type`/`webhook_name`, `opportunity_cases.source_path`,
`options_paper_trades.result_class`. **`owner-mirror-audit.test.mjs` was silently broken**:
its fixture omitted `return_pct`, so the audit's query threw and every mirror read as
missing, green.

Proven: empty owner population builds AND formats without throwing; non-empty does too;
every column the recap reads exists. `option_side` asserted absent so a future edit fails
here rather than on a Monday morning.

### PRIORITY 17 — Monday preflight

`GET /api/diagnostics/monday-preflight` — zero provider calls, no writes, no send
authority. Checks scanner loop + watchdog, owner routing, owner mirror, exact-OCC mark
enforcement, excursion correction store, recap schema, LHC frozen/shadow-only, subscriber
blocked, owner lane in the AI, PRE_MOVE_DISCOVERY_V1, provider accounting.

**Biased toward UNKNOWN by design.** Every defect this session fixed was invisible because
something reported healthy while having measured nothing. A subsystem that cannot be
inspected reports `UNKNOWN`, `UNKNOWN` never rounds down to `PASS`, and the verdict is the
**worst** check, not the average. **`BLOCKED` is the passing subscriber state**;
`SUBSCRIBER_READY` is the WARNING. It states in its own payload that it predicts nothing.

### Commits (6, by concern)

```
c99ce8d  Refuse a mark that cannot name the contract it was observed on
f0aa269  Separate what a contract printed from what a case claims it printed
9be20d7  Withhold the peak, not the trade
11322a0  Let the nightly see the lane it is meant to be validating
305e40e  Measure earliness by the move, not by the day's range
d7106cf  Name the unit, prove the schema, and check before Monday opens
```

Validation: `npm test` twice → **4046/4046** both runs (from 3966 at baseline; +80).
`npx tsc --noEmit --incremental false` clean. `npm run build` clean. `git diff --check`
clean. One additive migration (`opportunity_excursion_corrections`), `CREATE TABLE IF NOT
EXISTS`, no backfill, repeat-safe, ordered inside `SCHEMA` before its index.

### Remaining defects

1. **The 36 inflated and 20 floored values still sit in `opportunity_cases`.** By design —
   corrections are recorded beside history. `runExcursionCorrectionPassOnDb` exists and is
   repeat-safe but **has not been run against production**; every consumer already resolves
   through `resolvePublishableExcursionOnDb`, which recomputes live, so nothing leaks
   meanwhile.
2. **The owner mirror fix holds 7 of 10 live (`mirrorRate` 0.70), not 1.** SPY, TLT and
   TSLA left no mirror on 2026-08-10; two of the three within a minute of the open. Their
   reason was not captured and cannot be reconstructed. `mirrorAttemptReason` now records
   it prospectively — this is the first thing to read after the next owner opening.
3. **PRE_MOVE_DISCOVERY_V1 is not yet wired to a capture site.** The module and its grading
   are complete and tested; no scanner path calls `classifyDiscovery` yet, so no discovery
   row is persisted. Historical rows have no prospective capture and none was invented.
4. **617 distinct symbols/session still lose contract selection to provider quota.**
   Measured, not acted on — any change there is a provider-allocation change.
5. **Other hand-built fixtures remain.** Three were converted; others still hand-copy
   schema and can drift the same way.

### Exact resume point

Excursion evidence is now **classified and quarantined** rather than trusted: 36 inflated
peaks and 20 floored zeros cannot reach content, the AI, or grading, and realized returns —
which were always sound — are no longer suppressed alongside them. The historical
probability / similarity engine remains **not started**, per instruction, and may consume
only `VERIFIED_EXCURSION` rows when it does.

Next session, in order:
(a) run `runExcursionCorrectionPassOnDb` against production and record the census;
(b) diagnose the 0.70 mirror rate from `mirrorAttemptReason` on the next failing owner
    opening — the open-minute clustering (SPY/TLT at 13:31Z) suggests the entry or paper
    gate, but that is a hypothesis and the data to settle it did not exist this morning;
(c) wire `classifyDiscovery` to a capture site so PRE_MOVE_DISCOVERY_V1 starts accruing
    prospective rows — it grades nothing until it is called;
(d) only then consider the probability engine.


## Packet update — 2026-08-07 (3) The realized numbers were true, the peaks beside them were not, and the recap was one trading day from silence

### Verified state (checked, not assumed)

- Baseline re-verified from git and production BEFORE any change:
  local = `origin/main` = production = `653d465`, tracked tree clean, 19 untracked
  scratch files untouched. Production `ok:true`, `loopRunning:true`,
  `quotaExceeded:false`, session `afterhours`.
- `LHC_SELECT_V1` re-verified frozen and **untouched by this session**:
  `immutability.frozen true`, `definitionHashAtFreeze 80e5c5d878f5f9e185661981c87afc63`,
  `experimentVersion 1`, shadow-only. Scoreboard exactly as reported:
  67 decisions, 1 session (`2026-08-07`), baselineAdmits 0, experimentAdmits 3,
  bothReject 64, closedOutcomes 0, unlinkedDecisions 67,
  verdict `INSUFFICIENT_EVIDENCE` ("needs >= 20 closed outcomes over >= 5 sessions;
  has 0 over 1"). Unlinked open observations are **not** performance.
- No strategy, threshold, ranking weight, stop/exit policy or provider cap changed.
  Nothing subscriber-approved. No real-money path enabled. No probability model built.

### The GOOGL reconciliation — the draft was about a different case than the audit was

The prior audit examined `oc_13p0wzs` and found seven OCCs across five expirations. The
content draft was never built from that case. It came from **`oc_15gylwt`**, a separate
GOOGL case. Both are real, both are contaminated, and conflating them hid which numbers
were actually published.

`oc_15gylwt` frozen contract: **`O:GOOGL260807P00357500`**, strike 357.50, expiry
2026-08-07, frozen entry **$2.33**. The alert (`oa_1a0sp4l`, SENT) names that exact OCC.
Its one mirror (trade 795, `DELIVERED_ALERT_PAPER`) is on that exact OCC with entry_fill
2.33 and carries **427 marks, every one of them on the frozen contract, zero off-contract**.

- **Realized +47.2103% — YES, same OCC.** `(3.43 − 2.33) / 2.33` exactly, on 427
  same-contract marks. The contract, the entry and the realized return in the draft are
  all correct.
- **MFE +185.4077% — NO.** The frozen contract's best mark across all 427 observations is
  **+47.2103%**. Nothing on this trade ever printed +185.4%. It is the running maximum the
  case accumulated while the loop re-selected longer-dated strikes
  (`O:GOOGL260812P00357500`, `O:GOOGL260819P00355000`, `O:GOOGL260817P00355000`, …),
  priced against an entry those contracts were never bought at.

`oc_13p0wzs` is the same shape: frozen `O:GOOGL260807P00360000` @ $2.70, realized
+47.037% correct on 278 same-contract marks, claimed peak +157.4074% against a true best
mark of +47.037%.

**Content draft status: INVALID for the peak, valid for the realized return.** Draft
`cd_1lkfxsl` was not merely generated — it was **delivered to the recap channel as Discord
message `1535296903401570365`**. Seven sibling drafts on the same case were suppressed as
duplicates. No draft was retracted or rewritten by this session; the false peak stands in
the historical record and the gate below stops the next one.

### The contamination path

`applyOpportunityMarkOnDb` (the milestone/`NEW_HIGH` writer) never took an OCC at all, and
`refreshCaseSummaryOnDb` ratchets `maxReturnPct` upward from whatever
`currentReturnPct` it is handed. Before `320d651`,
`attachEvidenceToOpportunityOnDb` handed it marks from the freshly re-selected preferred
contract. `320d651` ("Price a case's return only on the contract it froze its entry on",
2026-08-06 18:01 PDT) added `markMatchesFrozenContract` and stopped new contamination —
but the already-poisoned `maxReturnPct` persists on every case written before it, and the
content engine read those stale values on 2026-08-07 and published one.

### System-wide audit — 78 delivered cases carrying a performance number

New `/api/diagnostics/trade-identity` reconciles each case against the contract it froze.

| | |
|---|---|
| `SAME_OCC_VERIFIED` (publishable) | **22** |
| `UNSUPPORTED_MAX_RETURN` (peak above anything the frozen contract printed) | **36** |
| `MAX_FLOORED_AT_ZERO` (seeded 0 standing in for an unmeasured excursion) | **20** |
| `NO_PERFORMANCE_MIRROR` | **4** |

The reassuring half, and it is load-bearing:

- **Realized returns: 78 of 78 reproducible on the frozen contract.** Zero contamination.
- **Zero off-frozen marks anywhere.** Zero mirror-OCC mismatches. Zero alert-OCC
  mismatches. Zero multi-OCC performance. The mirrors and mark series are clean.
- The damage is confined to `summary.maxReturnPct`, and it correlates with re-selection:
  **34 of the 41 cases that re-selected a contract** carry an inflated peak, versus **2**
  of the 37 that did not.

`MAX_FLOORED_AT_ZERO` is deliberately **not** reported as contamination. The summary seeds
`maxReturnPct` at 0 at open and a trade that only ever traded down never raises it, so
every loser's excursion is silently floored at break-even. Real defect, sound contract
identity — calling it cross-contract would have been its own false claim and would have
buried the 36 that are.

### Content now fails closed

`buildSubscriberClaimPacket` required a SENT alert and a mirror whose entry price matched
the frozen entry. Neither question mentions the contract, so any price-matched position on
any strike satisfied it, and the peak was never checked against anything. It now requires
the mirror to be the **same OCC** the alert named, and performance categories must pass
trade-identity reconciliation, with peak-quoting categories additionally requiring the
stated peak be supported by marks on the frozen contract. Failures return
`CONTENT_PERFORMANCE_UNVERIFIED` and carry the **truthful** peak beside the refusal. Loss
copy and non-performance observations are unaffected.

### The scanner wedge — root cause confirmed exactly

```
const beat = async () => {
  if (!busy) { busy = true; try { await tick(); } catch {} busy = false; }
  setTimeout(beat, intervalMs);          // outside the guard
};
```

The reschedule is outside the guard so the timer fires forever, but `busy` only clears when
`await tick()` **settles**. A rejection is caught; a promise that never settles is not.
`busy` stays true for the life of the process, every later beat short-circuits, and
`loopRunning: true` keeps reporting health throughout. That is the ~5.5 hour outage with
`lastTickAgeMs` climbing monotonically and the session frozen at `regular` past the close.

Clearing `busy` on a timer would have been worse: the hung tick is suspended, not gone, and
on resume it still holds the same symbol state and can still reach `captureZeroDte`.

Each tick now runs under a generation carried in `AsyncLocalStorage` — the same mechanism
`provider-context` already uses, and the only one that survives an arbitrary chain of
awaits. A tick past budget is abandoned so the loop continues, and abandoning it is what
fences it: `sideEffectAllowed()` is false inside that tick forever, and the send site
refuses if it ever wakes. Late settles are recorded (a hang that clears means the budget is
too tight, not that the subsystem died). Abandoned ticks are capped; past the cap the loop
stops launching work and reports `WEDGED` rather than stacking suspended ticks. The
advisory lock keeps beating across a wedge so a wedged instance never invites a second loop.

`/api/diagnostics/loop-health` separates `HEALTHY` / `DEGRADED` / `RECOVERING` / `WEDGED`
from aliveness and retains timeout cause, counts and scheduler owner. **Verified live in
production**: `HEALTHY`, 23/23 ticks completed, 272 ms last tick, 0 timeouts,
`schedulerOwner.isThisProcess true`.

### The recap was one trading day from silence

`653d465` split the recap by audience and asked `discord_deliveries` for **`option_side`**.
That column has never existed — `createDiscordDelivery` does not write it, no migration
adds it, it appears nowhere in the table's history. SQLite raises *no such column* at
prepare time, which does not degrade the CALL/PUT split: it throws out of
`buildDailySummaryOnDb` and takes the **entire daily recap** with it.

It had not fired only by timing. `653d465` deployed at 23:14Z on 2026-08-07, after that
day's recap had already sent and written `last_summary_day`. **The first execution would
have been Monday's recap, and it would have been silent.**

The test did not catch it because the fixture created `discord_deliveries` with an
`option_side` column of its own — it was testing a schema that does not exist. The fixture
now mirrors `lib/db.ts` and a regression test asserts the column is absent before building
the recap. The split now comes from the opportunity case the delivery already references;
when it cannot be derived the count is `null` and the recap prints
"split unavailable, not zero".

### Owner validation paper — and a correction to the count

`/api/diagnostics/owner-mirror` walks each delivered owner opening to its
`OWNER_VALIDATION_PAPER` mirror and checks there is exactly one, on the exact OCC alerted,
carrying marks.

**Production shows 16 owner openings on 2026-08-07, not 3.** The three named previously
(QQQ `oc_1m1p4bu` 15:22Z, META `oc_19hkuii` 15:25Z, SPY `oc_1jd0vu4` 15:28Z) are simply the
earliest. The full set runs 15:22Z → 18:22Z and includes AAPL, NFLX, IWM, GOOGL, AMZN,
DRAM, HOOD, XOM, NVDA, TSLA, IBIT, BAC, TLT.

**All 16 have zero forward paper evidence.** All 16 predate the mirror fix (23:14Z), so all
16 are permanently `DELIVERED_OWNER_ALERT_WITHOUT_FORWARD_PAPER_EVIDENCE`. Nothing was
reconstructed and nothing may be. `prospective.mirrorRate` is **`null`** — no owner opening
has occurred since the fix, so the fix remains **unproven in production**. The next owner
opening is still the first true live verification.

### The nightly AI was never contaminated by the recap — because it never reads it

Audited directly rather than assumed. `buildDailySummaryOnDb` and
`formatDailySummaryMessage` have **zero** callers in `lib/ai/` or
`nightly-research.ts`. The nightly builds its own aggregate from `ai_reports.summary_json`
(`buildNightlySummary`), `options_candidates`, `options_alerts`,
`options_delivery_decisions` and `DELIVERED_ALERT_PAPER`. The recap's population semantics —
before or after `653d465` — never reached it.

**Therefore no nightly finding was contaminated by recap labelling, and none was
invalidated.** Writing `INVALIDATED_BY_DATA_CORRECTION` onto findings that were not
corrupted would itself be a false record. The latest report (`nightly:19`, tradingDay
2026-08-06, generated 2026-08-08T00:05Z) carries
`narrative.status: VALIDATION_FAILED` — the AI prose failed anti-fabrication validation and
was not persisted; its deterministic findings stand.

**But the AI is blind in the same way the recap was.** `evidence-learning.ts` includes
`DELIVERED_ALERT_PAPER`, `RESEARCH_ONLY_PAPER`, `ZERO_DTE_RESEARCH_PAPER` and **excludes
`OWNER_VALIDATION_PAPER`**. On a day whose only deliveries were 16 owner openings, the
nightly AI sees nothing. That is an open defect, listed below — not fixed here, because it
changes what the learning arm consumes.

### Earliness — it does not measure what the name claims

The recap's `early 1989 / during 3842 / late 1869` comes from
`options_candidates.earliness_phase`, written in `monitor.ts` from exactly one line:

```
fractionMove   = (price − lod) / (hod − lod)      // position in today's range SO FAR
earlinessPhase = fractionMove >= 0.75 ? "late" : fractionMove <= 0.4 ? "early" : "during"
```

What that is, precisely:

- **Unit:** one contract-selection attempt (a candidate evaluation that reached stage 2),
  not an opportunity and not a delivered alert. Heavily duplicated per symbol per session.
  The three buckets sum to 7700 — the same population as "candidates".
- **Pre-entry safe: yes.** `hod`/`lod` are session-to-date and known at decision time.
  There is **no hindsight** in the live path.
- **But it is not earliness.** It is the current price's percentile position inside the
  session range observed so far. It is **direction-blind**: for a PUT, a low `fractionMove`
  means the downmove has largely already happened, and it is labelled `"early"`. Its
  denominator grows through the day, so it is unstable near the open. It says nothing about
  acceleration, expected total move size, or reward remaining.

**Mapping to the product states: the current system does not measure them.**
`BEFORE_RUN`, `EARLY_IN_RUN`, `LATE`, `TOO_LATE` are statements about a move's lifecycle
and remaining reward. `fractionMove` is a range-position ratio. It cannot distinguish "has
not moved yet" from "round-tripped back to the low", and it labels both `"early"`.

An equivalent-but-different grader already exists in `lib/alert-earliness.ts`
(`EARLY`/`DEVELOPING`/`LATE`/`EXHAUSTED`/`UNGRADABLE`, from VWAP extension, day move and
velocity), explicitly post-hoc and applied to stock alerts. **No second earliness system was
built**, per the instruction. The next session should decide whether to extend
`alert-earliness.ts` to options rather than reinterpret `fractionMove`.

### Lead-time capture — mostly already present

`options_candidates` already carries `first_detected_at_ms`,
`underlying_at_first_detection`, `option_at_first_detection`, `first_ready_at_ms`,
`underlying_at_ready`, `option_at_ready`, `session_state_at_detection`,
`ready_expires_at_ms`, `trading_session_date`,
`market_structure_snapshot_json`. With the owner mirror in place, alert-to-+10/+25/+50/+100
becomes derivable from `options_paper_marks` (`mark_at_ms`, `return_pct`) against the frozen
entry — **prospectively, for owner openings that occur after the mirror fix**. Nothing is
backfilled. Missing stays missing.

### Funnel population truth (2026-08-07)

Measured, with the unit named:

| Stage | Attempts | Distinct symbols |
|---|---|---|
| `CONTRACT_SELECTED` | 6513 | 1511 |
| `PROVIDER_QUOTA_EXCEEDED` | 780 | 617 |
| `NO_CONTRACTS_RETURNED` | 379 | 281 |
| `NO_TWO_SIDED_MARKET` | 28 | 19 |
| **total** | **7700** | — |

- The recap's **"7700 candidates"** is **contract-selection attempts**, not opportunities.
- The recap's **"1826 symbols scanned"** is `COUNT(DISTINCT symbol)` over
  `options_candidates` — symbols that *produced a candidate row*, not symbols scanned.
- The recap's **`rejected 0` / `too-late 0`** count `options_alerts.state` — the
  **subscriber final delivery stage only**. They are structurally blind to the **1187**
  attempts (780 + 379 + 28) that terminally failed *contract selection* and never reached
  an alert row. `deltaSource.unselected` is 1187, matching exactly. The recap's zero was
  arithmetically correct for its population and meaningless as a global claim.

### Provider 49 vs ~780 — reconciled

Both numbers are real and neither is a candidate count.

- **780** = `PROVIDER_QUOTA_EXCEEDED` **attempts** across the whole 2026-08-07 session,
  spanning **617 distinct symbols**.
- Retry inflation is therefore only **780 / 617 = 1.26×** — it does **not** explain the gap.
- The gap is the **time range**. The intraday reading of 49 came from the contract-funnel
  endpoint's rolling window (`windowMs`, default 15 minutes), not a session total. A
  ~6.5 hour session holds ~26 such windows, and 780 / 49 ≈ 16 — the same order.

`terminalReasonBreakdownOnDb` now returns `distinctSymbols` beside `count` and the response
states which unit is which, so a refusal total can no longer be quoted as a candidate total.
**No provider cap was raised and no retry cadence changed.**

### Provider efficiency

Reviewed without changing anything. `withProviderConsumer` is attribution-only — it labels
requests and never blocks, retries or budgets. Live scanner safety already holds priority
(Gate B7) and options marking is attributed separately, so delivered-trade marking is not
starved. **617 distinct symbols losing contract selection to quota in one session** is the
signal worth acting on, but any change there is a provider-allocation change and is out of
scope for a measurement session. Recorded, not acted on.

### Commits (7, by concern)

```
052caae  Ask whether a case's numbers came from the contract it froze
ae841b5  Audit the cases that can carry a claim, not the ones that never did
afce8e8  Stop one hung tick from silently ending the scanner
2ba0fb1  Tell an inflated peak apart from a peak that was never measured
c6a1e1e  Refuse to publish a number that cannot be tied to one contract
2c1a891  Keep Monday's recap from dying on a column that never existed
924812e  Count provider refusals in both units so 49 and 780 can be compared
```

Validation: `npm test` twice → **3966/3966 pass** both runs.
`npx tsc --noEmit --incremental false` clean. `npm run build` clean. `git diff --check`
clean. No migration added; the two new columns read are existing ones.

### Remaining defects (not fixed here, deliberately)

1. **36 delivered cases still carry an inflated `summary.maxReturnPct` in the DB.** The
   gate stops publication and the diagnostic reports the truthful peak, but the stored
   values were not rewritten — correcting persisted history is a separate, auditable
   operation and history is not edited silently.
2. **20 cases report `maxReturnPct: 0` for trades that only ever traded down.** The seeded
   0 should be `null` until a positive mark exists. Fixing it changes a persisted field's
   meaning and belongs with (1).
3. **`applyOpportunityMarkOnDb` still takes no `markOptionSymbol`.** It is currently safe
   because its only production caller passes a position whose OCC is fixed at creation, but
   the guard is circumstantial rather than structural.
4. **The nightly AI excludes `OWNER_VALIDATION_PAPER`** and is blind to the owner lane.
5. **The owner mirror fix is still unproven live** — 0 owner openings since it shipped.
6. **`earliness_phase` does not measure earliness.** Decide whether to extend
   `alert-earliness.ts` to options rather than reinterpret `fractionMove`.
7. **617 distinct symbols/session lose contract selection to provider quota.**

### Exact resume point

The measurement foundation is now trustworthy in the ways that matter for the next phase:
realized returns are proven same-OCC across all 78 delivered cases, unverifiable
performance cannot be published, the scanner cannot silently wedge, and every recap number
names its population. What is **not** yet trustworthy is **MFE/excursion** — 36 stored peaks
are wrong and 20 are floored — so any work that consumes excursion (asymmetry, convexity,
reward-remaining) must wait for defects 1–3.

Do **not** start the historical-similarity or empirical-probability engine until (1)–(3) are
closed, because both would train on excursion. The next session should:
close (1)–(3) as one auditable correction pass; confirm `prospective.mirrorRate` reaches 1
on the first post-fix owner opening; then decide the earliness question in (6).


## Packet update — 2026-08-07 (2) The AI now receives the evidence, keeps what it concludes, and cannot be switched off by accident

### Verified state (checked, not assumed)

- Baseline re-verified from git, `origin/main` and production BEFORE any change:
  local = `origin/main` = production = `62d1c80`
  (`/api/runtime/status` → `deploy.commit 62d1c80af371550d310c6c75f6d7b5154e251c7f`).
  Tracked tree clean, the 19 untracked scratch files untouched.
- Production healthy at baseline: `ok:true`, `loopRunning:true`, `quotaExceeded:false`,
  `dbWritable:true`, `schemaOk:true`, `schemaMissing:[]`, scheduler owner.
- `LHC_SELECT_V1` frozen and unchanged: definition hash
  `80e5c5d878f5f9e185661981c87afc63` expected == actual.
- **`decisionCount: 0`.** Zero prospective RTH decisions. `sessionsObserved 0`,
  `closedOutcomes 0`, expectancy and PF **unavailable** (not zero), verdict
  `INSUFFICIENT_EVIDENCE`. Six deterministic findings persisted, each stamped `2460dc3`.
- Subscriber readiness `NOT_READY`, 12 blocking gates, `subscriberActive: 0`.
- AI budget verified from the ledger: **$0.0824 of $20.00**, 4 nightly requests,
  0 skipped for budget.
- Owner private Discord alerting ACTIVE. No gate, threshold, ranking or env var changed.

**LHC_SELECT_V1 was not touched.** No gate, threshold, ranking, cohort reinterpretation or
promotion. This packet is infrastructure only.

### THE DEFECT — the evidence was built and then not handed over

`buildAiResearchContext` existed, was tested, and was passed to nobody. The nightly narrator
received a scanner funnel and described it while knowing nothing about the alerts the owner
actually received or the experiment being tested. The weekly received the experiment but not
the owner lane. Two models reasoning from two partial views of one session produce two
verdicts and give the operator no way to tell which one was looking at less.

`buildAiResearchContextOnDb` now assembles it **once** and both jobs receive the same object:
owner Discord lane (openings, closed, wins, losses, expectancy, PF, best/worst, immediate
failures, profit given back, per-strategy, per-policy-version), `LHC_SELECT_V1` (frozen state,
sessions, admit/reject by arm, closed outcomes, winners retained, losses avoided, winners
rejected, expectancy, PF, ex-top-winner and capped-return robustness, evidence limitations),
confirmation cost, research/shadow lane, missed opportunities, and system/data quality.

### FINDING — the payload has to carry the reading rules, not the prompt

The arm has **zero** decisions. A model handed `profitFactor: null` and told nothing will
write "profit factor 0", which reads as a catastrophic result rather than the truth, which is
that nothing has been measured. `0` and `null` are the difference between "the lane lost
everything" and "the lane has closed nothing".

So `readingRules` and `unavailableMetrics` live **inside** the payload. A prompt is edited far
more often than a data contract, and the rule must not depend on which edit came last. Every
section names the fields whose null means "not measured", and a count of zero stays reportable
as zero. Confirmation medians are computed only over rows whose per-field basis is `OBSERVED`
or `DERIVED` — a row that never measured a delay must not pull the median toward zero, which
is exactly the substitution that made the historical cohort unable to answer the question.

### FINDING — the validator has to see what the model saw

The anti-fabrication guard rejects any number the model was not shown. Passing new evidence to
the prompt without passing it to `validateNightlyNarrative` would have made every accurate
citation of an owner-lane figure look like a fabrication. Both now receive the same object.
With no context supplied the prompt is byte-for-byte what it was: additive, not a rewrite.

### WHAT WAS BUILT — analysis, not narration

`nightly_research_analysis` reasons over that context against a fixed list of the questions an
operator would otherwise open Claude Code to ask, and writes each conclusion into
`options_learning_findings` — the store the NEXT night's context is built from.

What a finding costs to make:

- `limitations` is required and is **never defaulted in**. A claim whose qualification can be
  omitted will be quoted without it.
- A conclusion resting on 0 rows must be `INSUFFICIENT`. That is the `PF 0` error applied to
  conclusions.
- `{ findings: [] }` is a **successful** run, and the prompt says so, so the model is not
  pushed to manufacture one.
- Findings are namespaced `AI_NIGHTLY_` and cannot collide with a frozen deterministic
  finding. An AI row able to overwrite `LHC_SELECT_V1_TAIL_DEPENDENCE` could delete the
  sentence that keeps the experiment honest.
- Each is screened for claims of validation, promotion, live execution or gate weakening
  before storage, and the AI's authorship is appended to its own limitations, not substituted
  for them.

### FINDING — the AI flags were switching off the deterministic evidence

`runAiScheduledJobs` returned immediately unless `AI_ENABLED` was set, and each job was gated
on its own AI flag. Both jobs are deterministic-first — owner aggregation, experiment
scoreboard, lifecycle advance and findings are computed and persisted **before** any provider
is contacted — so turning off narration, losing the API key, or exhausting the month silently
stopped all of it. The budget contract says exhaustion may stop optional reasoning and nothing
else; this was the path that broke it.

The jobs now run whenever the ET clock says they are due. Every AI call keeps its own flag and
its own pre-flight cost reservation. `tests/after-close-autonomy.test.mjs` runs the whole
chain from the scheduler's entry point with **AI fully off and no key present** and asserts the
session's evidence still lands.

### FINDING — a bad deploy and old data were the same string

`railway up` carries no git metadata, so a deploy made that way sets no commit variable, and
`freezeAttribution` collapsed that absence into `UNKNOWN_LEGACY_VERSION` — the value reserved
for rows written before attribution existed. A live row from an unidentifiable deploy became
indistinguishable from a July row, so the one signal that would have caught the deploy was the
signal that hid it.

`RUNTIME_SHA_UNAVAILABLE` is now a separate state stamped only on rows created now.
`deploymentShaAttribution()` reports whether the process can name its commit and, when it
cannot, names the remedy; it is surfaced in `/api/runtime/status.shaAttribution` and in
`/api/research/options/lhc-prospective`. `censusShaAttribution` keeps `observed`,
`runtimeUnavailable` and `legacy` apart, because "old data" and "the current deployment is
broken" have different remedies. **No SHA is fabricated and no historical row is rewritten.**

### SUPPORTED PRODUCTION DEPLOYMENT PATH

**Deploy OptiScan through the GitHub/`main` path.** Railway builds from the pushed commit and
injects `RAILWAY_GIT_COMMIT_SHA` / `RAILWAY_GIT_BRANCH`, which is what makes every row written
by that deploy attributable to an exact commit.

**Do not use `railway up` for a production deploy.** It uploads a directory, carries no git
metadata, and every row written during that deployment is stamped `RUNTIME_SHA_UNAVAILABLE`.
That is now visible rather than silent — but the row still cannot be attributed, and the loss
is permanent, because attribution is frozen at creation and is never backfilled.

To confirm a deploy: `/api/runtime/status` → `deploy.commit` must equal `git rev-parse HEAD`,
and `shaAttribution.state` must be `OBSERVED`.

### FIRST-RTH READINESS — proven from rows, not from tests

Unit tests prove the code *can* write the row; they cannot prove the deployed process, against
the live schema, with real market inputs, *did*. That gap is where this system has lost
evidence before: the confirmation columns existed and were degenerate, the paper mirror
existed and missed four rows, the SHA column existed and one deploy wrote null.

`/api/research/options/lhc-prospective` now returns `firstRthReadiness`, checking each
invariant against `options_experiment_decisions`: baseline decision recorded, V1 decision
recorded, arms disagreeing without the baseline's delivery changing, no denylisted hindsight
field in the feature vector, exact OCC, frozen experiment version, confirmation capture with a
per-field `OBSERVED`/`DERIVED`/`UNAVAILABLE` basis, no `UNAVAILABLE` field carrying a value,
full policy attribution, recorded deploy SHA, and the baseline still alerting.

**A check with no rows reports `NOT_YET_OBSERVED`, never `PASS`.** Right now every row-based
check is `NOT_YET_OBSERVED` and `awaitingFirstSession` is `true` — the board deliberately does
not go green on an empty table.

### WHAT SHOULD HAPPEN AUTOMATICALLY TOMORROW (2026-08-07 RTH)

No Claude Code session is required for any of this.

1. Each `lower_high_continuation` candidate reaching `decideDeliveryBatch` gets a baseline
   decision **and** an `LHC_SELECT_V1` decision written side by side, in all four arms, with
   the exact OCC, the frozen experiment version, the full policy attribution, the deploy SHA,
   and the confirmation-cost capture.
2. Owner private Discord alerts continue on the baseline path, unchanged. The experiment sends
   nothing and changes nothing.
3. After the close the scheduler runs the nightly: deterministic aggregation → Evidence
   Learning findings → AI research context → AI narration → AI analysis → persisted findings →
   owner recap led by **OWNER DISCORD ALERTS**.
4. The weekly (Friday night) runs the multi-session review, whose ceiling is
   `READY_FOR_HUMAN_REVIEW`. `SUBSCRIBER_APPROVED` does not exist as a status.

**Verify after the session:** `/api/research/options/lhc-prospective` → `decisionCount > 0`,
`firstRthReadiness.awaitingFirstSession: false`, every check `PASS`, and
`shaCensus.runtimeUnavailable: 0`.

### VALIDATION

- Full suite **3910/3910**, run twice (was 3845; **+65 new**).
- `npx tsc --noEmit --incremental false` clean. `npm run build` exit 0. `git diff --check` clean.
- New: `tests/deployment-sha-attribution.test.mjs`, `tests/ai-research-context.test.mjs`,
  `tests/ai-research-analysis.test.mjs`, `tests/lhc-first-rth-readiness.test.mjs`,
  `tests/after-close-autonomy.test.mjs`.

### WHAT IS STILL TRUE

`LHC_SELECT_V1` is **PROMISING and UNVALIDATED**. Historical PF 1.240 falls to 0.611 without
one +343.93% trade and to 0.721 capped at +60%. It has recorded **zero** prospective decisions.
Nothing in this packet moved it, and no automatic path to subscriber approval exists.

---

## Packet update — 2026-08-07 (1) LHC_SELECT_V1 is frozen and now has a real prospective arm — and it has proven nothing yet

### Verified state

- Baseline `5bc4a68` verified from git, `origin/main` and `/api/runtime/status`
  (`commit 5bc4a688a3d8…`) BEFORE any change. Tracked tree clean, 19 untracked scratch
  files untouched.
- Shipped `d73881c` → `50b2063` → `70ecb82` → `e7bdec0` → `f0ad29e` → `b7743bb` → `eab1eed`
  → `2460dc3`. **Production verified at `2460dc3`** (`/api/healthz` commit
  `2460dc3d781b14fd13a105e935b91d2e1ecf63ea`).
- Full suite **3845/3845**, run twice (was 3764; **+81 new**).
  `tsc --noEmit --incremental false` clean. `next build` exit 0. `git diff --check` clean.
- Production healthy: `ok:true`, `loopRunning:true`, `quotaExceeded:false`, `dbWritable:true`,
  `schemaOk:true`, `schemaMissing: []`, lifecycle active, scheduler owner.
- Subscriber readiness `NOT_READY`, 12 blocking gates, `subscriberActive: 0`.
  **No promotion occurred and none is reachable automatically.**
- Owner private Discord alerting remains ACTIVE. No gate, threshold, env var or provider cap
  was changed. Every new surface reports `productionBehaviorChanged: false`.

### The four open cases, re-verified from production before anything was built

All four were still OPEN at `5bc4a68`, with exactly the decisions the prior packet recorded:

```
770 AMZN  O:AMZN260807P00272500  ADMIT   marks 737
779 TSLA  O:TSLA260807P00320000  ADMIT   marks 677
795 GOOGL O:GOOGL260807P00357500 ADMIT   marks 287
796 HOOD  O:HOOD260814P00090000  REJECT  ATM_BAND, SHORT_DTE, UNDERLYING_LIQUIDITY, IV_CEILING
```

The frozen cohort also re-verified exactly: `LHC_DELIVERED_V1`, 58 members
(8W/46L/4 open), 7 sessions, 42/58 trajectory-trustworthy, baseline n=54 mean **-27.83%**
median **-41.67%** PF **0.311**; experiment n=20, 8W/12L, PF **1.240**, **0** winners
rejected, 34 losses avoided. Three AMZN/TSLA/GOOGL puts expire 2026-08-07, so they resolve
in the next session and become the first genuinely out-of-sample outcomes.

### WHAT WAS BUILT — the decision is now written down before the outcome

Everything known about V1 was measured on the 58 rows it was read from. `decideDeliveryBatch`
is the choke point that already holds the baseline's decision, the frozen contract and the
confirmation-timing inputs, so the arm READS that decision and writes a row beside it. It has
no return value the caller acts on.

`options_experiment_decisions` records **all four quadrants** — `BOTH_ADMIT`,
`BASELINE_ONLY`, `EXPERIMENT_ONLY`, `BOTH_REJECT`. Recording only the admits is how the
trailing-stop study produced a policy that never appeared to cost anything: its costs were
never measured. `BASELINE_ONLY` is what puts V1's rejections on trial.

### FINDING — the freeze has to be content-addressed, not a promise

A rule read off a cohort gets quietly improved until it fits, and the improvement is
unfalsifiable because rule and evidence moved together. `definitionHash()` probes every gate
across a numeric sweep and hashes the RESULTS, so a moved threshold changes the hash even
when the id and rationale are untouched. `LHC_SELECT_V1_DEFINITION_HASH` is
`80e5c5d878f5f9e185661981c87afc63`. The registry write REFUSES to overwrite a differing hash
rather than accepting it. **The remedy for a mismatch is never to update the constant — it is
to register V2.**

`ExperimentStatus` has **no `SUBSCRIBER_APPROVED` member**, and a test asserts it is
unreachable from every status. The ceiling is `READY_FOR_HUMAN_REVIEW`, which is a request.

### FINDING — confirmation cost is only answerable forward, and 0 is not "not observed"

`first_detected_at_ms == entered_at_ms` for all 58 historical rows, so this cannot be
backfilled. `captureConfirmation()` writes every timing field as **null when unobserved,
never 0** — substituting 0 is precisely what made the historical columns degenerate — and
carries a per-field `OBSERVED` / `DERIVED` / `UNAVAILABLE` basis so a report can say what it
is entitled to use. `underlyingMoveBeforeEntryPct` is signed in the thesis direction, so both
directions report "move already spent" as a positive number.

### FINDING — two real defects the tests caught

1. **`exTopWinner` deleted the whole winning side.** Dropping the top winner by VALUE removes
   every trade tied at the maximum. On a flat return distribution that is all of them, turning
   a robustness check into a far harsher test than it claims to be. It now drops exactly one.
2. **The weekly verdict oscillated.** The intermediate promotion hop fired from
   `READY_FOR_HUMAN_REVIEW` as well, walking the status BACK to `PROMISING` every week the
   verdict held. The step is now forward-only; a five-week regression test pins it.

### The honest state of the experiment

```
status                 PROPOSED (no prospective decision recorded yet)
prospective sessions   0
closed prospective     0
expectancy / PF        UNAVAILABLE — not zero, unavailable
```

`buildProspectiveScoreboard` computes expectancy and PF from **CLOSED outcomes only**, never
counts a positive MFE as a win, and computes `experimentExTopWinner` and `cappedAt60`
unconditionally. `weeklyVerdict` returns FAILED when V1 rejects winners without improving PF,
and caps a tail-carried arm at PROMISING.

Six findings are persisted to `options_learning_findings`, each with a **required non-empty**
`limitations` array and a `mustNotBeSummarizedAs` naming the specific wrong summary it invites.
The improvement finding is rated **WEAK** (measured on its own source cohort); the
tail-dependence finding is **STRONG**. `findingsForPrompt` renders both, so the model cannot
receive `PF 1.240` without `0.611`.

### Owner recap now leads with the owner's own alerts

The recap opened with the internal paper portfolio — a disjoint population that has
coincidentally been the same size as the delivered lane, so "Trades: 5 | Wins: 0 | Losses: 5"
read as a verdict on the owner's alerts on a day the delivered lane was profitable.
`OWNER DISCORD ALERTS` now leads; the paper block stays below and drops its "(PRIMARY)" label
when it is no longer first. Session membership is computed in JS because SQLite's `localtime`
is UTC on Railway, which would migrate every post-20:00 ET opening into the next day.

### AI budget

`AI_MONTHLY_HARD_LIMIT_USD` already defaults to **20** and `costGateOnDb` already gates
nightly and weekly pre-flight. What was missing was the statement of scope:
`BUDGET_EXEMPT_SUBSYSTEMS` names the nine that run regardless — scanner, owner Discord, paper
mirror, marks, lifecycle, grading, Evidence Learning capture, readiness, deterministic
experiment tracking — and a test fails if one ever appears in the skippable set.

### New surfaces

`GET /api/research/options/lhc-prospective` · `GET /api/research/options/lhc-weekly`
(`?persist=1` for the lifecycle write). Both read-only, zero provider calls.

### Not done — next session starts here

- **The prospective arm has recorded ZERO decisions.** It has never run during an open RTH
  session. Everything above is machinery, not evidence. Verified live at `2460dc3`:
  `decisionCount 0`, `lifecycle.currentStatus null`, expectancy and PF `null`,
  `immutability.frozen true`, 6 findings persisted, all with non-empty limitations.
- `railway up` deploys without git metadata, so `deployInfo().commit` read null for one
  deploy. **Deploy via GitHub push only** — `railway up` breaks SHA attribution.
- Two defects were found by running against production rather than by the tests: the weekly
  reported `findings 0` because seeding lived only in the nightly (fixed in `2460dc3`), and
  the SHA stamp read null after a `railway up` deploy.
- AMZN/TSLA/GOOGL/HOOD are still open and are NOT yet linked into the prospective arm — they
  pre-date it. Their outcomes must be read from the cohort endpoint, not the scoreboard.
- The AI research context is built but not yet passed into the nightly narration prompt.
- Duplicate-delivery gate scope and the 4 legacy missing mirrors remain diagnosed, not changed.

---

## Packet update — 2026-08-06 (9) the lane bought more implied move than it could outrun, and the two best "predictors" were hindsight

### Verified state

- local = `origin/main` = production = `ad947f6` (baseline `d264f34` verified from git,
  origin and `/api/runtime/status` before any change; production re-verified after deploy).
- Production healthy: `ok:true`, `loopRunning:true`, `session:closed`, scheduler owner,
  `quotaExceeded:false`, `schemaOk:true`.
- Full suite **3764/3764** (was 3739; +25 new). `tsc --noEmit --incremental false` clean.
  `next build` exit 0. `git diff --check` clean. 19 untracked scratch files untouched.
- Subscriber readiness `NOT_READY`, `subscriberActive: 0`. No promotion has occurred.
- Owner private Discord alerting remains ACTIVE. No gate, threshold, env var or provider
  cap was changed. Every new surface is read-only and reports `productionBehaviorChanged: false`.
- All evidence read from the production SQLite volume and the authenticated diagnostic path.
  No secret printed.

### FINDING 1 — the two strongest apparent predictors were hindsight

Ranked naively over the delivered `lower_high_continuation` cohort, the best separators were
`contractUpdateCount` (AUC 0.892) and `contractCandidateCount` (AUC 0.875) — ahead of every
genuine feature. Both are lifetime accumulators on `opportunity_cases.case_json`:

```
contractCandidates[].observedAtMs    0 of 222 observed at or before entry
contractUpdates[].changedAtMs        0 of 163 changed  at or before entry
```

They measure how long a position survived, not how it was chosen. A rule built on them
would have backtested beautifully and done nothing live. They are on `HINDSIGHT_DENYLIST`
and `assertNoLeakage` throws if either reaches a selection rule.

### FINDING 2 — confirmation cost is not measurable historically

`confirmationDelayMs` is **0 for all 58 rows** (`first_detected_at_ms` == `entered_at_ms`),
`underlyingMoveBeforeEntryPct` is 0 for all 58, and premium expansion carries only bid/ask
rounding (21/58 non-zero, median 0). The columns exist and production never wrote a
distinguishing value. `degenerateFeatures()` reports this as **unmeasured**, so no packet can
claim "confirmation delay did not matter". Priority 10 is prospective-only work.

### FINDING 3 — the cohort, frozen

`LHC_DELIVERED_V1` = every `DELIVERED_ALERT_PAPER` mirror of a `lower_high_continuation`
owner opening. 58 members, 7 sessions, all with alert id, case id and Discord message id.

```
WINNER 8 | LOSS 46 | OPEN 4 | UNGRADABLE 0      trajectory-trustworthy 42/58 (>=20 same-contract marks)
baseline  n=54  8W/46L  winRate 15%  mean -27.83%  median -41.7%  PF 0.311
```

Every member is a PUT. The 35-trade figure in packet (8) was the recent-40 slice across all
strategies; this is the full delivered history for the strategy and supersedes it as the
denominator for this lane.

### FINDING 4 — one defect, seen four ways: the lane bought implied move it could not outrun

Contract selection pins delta near 0.45, so at fixed delta the **strike distance measures the
implied move already priced in**. A delta-0.45 put sits 0.24% from spot on low-vol AAPL and
1.85% away on ACHR. The losing population is where the market had already priced a move large
enough that the strike sat over 1% out — and the -40% premium safety band then fires on
ordinary noise before the thesis resolves.

Repeated across both halves of a date-separated split (development 07-29→08-03, validation
08-04→08-06), winner median vs loser median:

```
feature                AUC     Wmed          Lmed          devAUC  valAUC  repeats
contractVolume        0.815   5411          940            0.795   0.778    yes
dte                   0.245   1             2              0.295   0.000    yes
moneynessPct          0.750   -0.24%        -0.48%         0.780   0.611    yes
vwapDistPct           0.745   -0.24%        -1.15%         0.770   0.611    yes
spreadPct             0.283   1.52%         2.78%          0.260   0.222    yes
dollarVolume          0.701   $20.2B        $9.5B          0.660   0.667    yes
iv                    0.315   0.333         0.400          0.385   0.111    yes
```

Explicitly **not** discriminators — separated overall, reversed in validation:
`callPutVolRatio`, `ivLevel`, `concurrentOpen`, `nearestResistanceDistPct`. Session crowding
looked strong in development (AUC 0.23) and inverted in validation (0.86). It is not used.

### FINDING 5 — `LHC_SELECT_V1`, and the number that says it is not a fix

Four gates, each a view of Finding 4, each repeated across dates:
`ATM_BAND` (strike within 0.5% of spot, not ITM) · `SHORT_DTE` (<=3) ·
`UNDERLYING_LIQUIDITY` (>= $4B) · `IV_CEILING` (contract IV <= 0.55).

```
                     baseline                    experiment            winnersRejected
OVERALL     n=54  8W/46L  mean -27.83  PF 0.311   n=20 8W/12L  +6.57  PF 1.240      0
DEVELOPMENT n=45  5W/40L  mean -30.55  PF 0.280   n=14 5W/ 9L  +8.88  PF 1.303      0
VALIDATION  n= 9  3W/ 6L  mean -14.22  PF 0.529   n= 6 3W/ 3L  +1.17  PF 1.051      0
```

**Zero winners rejected in every split.** All eight are retained, including +343.93% AAPL,
+50.27% SPY, +47.04% GOOGL and +46.35% IWM. 34 of 46 losses avoided (-1634 pts). Per-session
hold-out: 3 BETTER, 0 WORSE, 4 neutral — no session is made worse.

**And it is still not a profitable system.** Strip the single +343.93% run and cap the tail:

```
                   baseline PF   experiment PF
headline              0.311          1.240
ex-top-winner         0.153          0.611
capped at +60%        0.181          0.721
```

The improvement is large and repeated in all three framings. The lane is still carried by one
convex trade. This is a shadow experiment, not a promotion argument.

### FINDING 6 — selection is not selectively better at the immediate failures

Of 32 trustworthy losses: **14 never cleared +5%** (no post-entry policy could have saved
them) and 18 worked first. The rule rejects 71% of never-worked and 78% of worked-then-lost —
it is a general contract-quality filter, not a thesis filter. Four worked-then-lost trades
survive it (531 NVDA peak +25→-41, 614 IWM +15→-41, 735 AMZN +17→-51, 758 AMZN +37→-43) and
those are the remaining job for exit policy.

Loss taxonomy: `INSUFFICIENT_EVIDENCE` 14, `WORKED_MARGINALLY_THEN_LOST` 11,
`CONTRACT_TOO_FAR_OTM` 8, `PROFIT_GIVEN_BACK` 7, `IMMEDIATE_SETUP_FAILURE` 4,
`PREMIUM_CHASE` 1, `WRONG_DTE` 1.

### FINDING 7 — winners need room: worst drawdown before profit is -20.2%

Winner paths (6 of 8 trustworthy): median drawdown before profit **-11.3%**, worst **-20.2%**
(787 IWM). Time to +25% ranges 8m to 1431m. Any trailing stop tighter than -20%, and any time
stop under ~24h, destroys at least one winner — consistent with packet (8)'s corrected
simulator. `simulate()` reports `winnersRejected` before `lossesAvoided` so this cannot be
hidden again.

### FINDING 8 — the last "duplicate delivery" is a legitimate re-entry, and both legs won

`duplicateDeliveredCount: 1` traces to fingerprint `of_odhrje` / `O:AAPL260805P00305000`:

```
oa_1u6xvui  2026-08-03 10:21 ET  case oc_1kevqxw  msg 1533842179284271104  -> paper 687  +48.84%
oa_1u6xvjt  2026-08-03 13:57 ET  case oc_b3zulh   msg 1533896504371056650  -> paper 711  +45.13%
```

3.6 hours apart, distinct cases, distinct Discord messages, each with exactly one mirror, each
graded, **both winners**. The first position had closed, which the unique indexes explicitly
permit. The readiness gate counts "same fingerprint + same OCC ever delivered twice" and so
flags a valid second entry. This is the same class of mistake as `ac948b0` — do not widen
dedup. Recommended scope: same session **and** the prior position still open. Not changed here.

### FINDING 9 — the 4 missing mirrors are all legacy

`missingMirror: 4` = `oa_j7t1d4` (AMZN), `oa_1xnsw2d` (META), `oa_kb76c5` (TSLA),
`oa_1byyt25` (AVGO), all sent **2026-07-29 13:56–15:14 ET**, all with a Discord message and
`paper_reservation_state` NULL — the reservation was never attempted. Every one of the 115
alerts sent after that timestamp is mirrored. Prospective owner-opening mirror rate is
**100%**; the gate is reporting three-day-old rows that pre-date the atomic reservation path.

### Shipped this session

```
ad947f6  Freeze the lower_high cohort and ask what was knowable before entry
```

`lib/research/options/pre-entry-features.ts` (feature set + leakage denylist + degeneracy
report) · `lower-high-cohort.ts` (frozen `LHC_DELIVERED_V1`, trust gating, loss taxonomy) ·
`lower-high-cohort-loader.ts` (read-only, same-contract marks only) ·
`pre-entry-comparison.ts` (AUC + cross-date repetition gate) ·
`selection-experiment.ts` (`LHC_SELECT_V1`, shadow-only, simulator that can clip a winner) ·
`GET /api/research/options/lower-high-selection`.

### Not done — next session starts here

- `LHC_SELECT_V1` is measured but not yet **prospectively** paper-tracked alongside baseline;
  it needs a shadow arm writing per-opportunity admit/reject rows during RTH.
- Confirmation-cost capture (Priority 10) must be written prospectively — `firstEligibleAt`,
  `confirmationStartedAt`, `contractSelectedAt`, `firstEligibleAsk`, `rewardRemainingAtEntry`.
  The existing columns are degenerate and cannot be backfilled.
- Strategy/policy attribution still stamps `UNKNOWN_LEGACY_VERSION`; freeze real versions at
  case creation going forward.
- Evidence Learning does not yet consume `LHC_SELECT_V1` findings; nightly/weekly rollup
  unchanged.
- Duplicate-delivery gate scope (Finding 8) and the legacy mirror rows (Finding 9) are
  diagnosed, not changed.
- 4 open positions carry a shadow decision: 770 AMZN, 779 TSLA, 795 GOOGL ADMIT;
  796 HOOD REJECT (all four gates). Their outcomes are the first genuinely out-of-sample test.

---

## Packet update — 2026-08-06 (8) the losses are an exit-policy failure, and the backtest that would have proved it could not clip a winner

### Verified state

- local = `origin/main` = `4d60022` (was `9a6c9f0`, verified from git and production first).
- Production healthy throughout: `db:true`, `schemaMissing:[]`, lifecycle active, loop running.
- Full suite **3739/3739**, run twice. `tsc --noEmit --incremental false` clean.
  `next build` exit 0. `git diff --check` clean. 19 untracked scratch files untouched.
- No env var written. No provider cap changed. No threshold changed.
- Subscriber readiness still `NOT_READY`, `transitionId: 0` — no promotion has ever occurred.

### FINDING 1 — the delivered lane holds directional options for days

`mark-evidence`, lane `DELIVERED_ALERT_PAPER`, 45 days, n=575:

```
medianHoldMinutes   3188.84      (53 hours)
exitReasons         stop_hit 265 | expiration_no_quote 190 | time_stop 61 | target_hit 55
neverMarked         271
```

**25 of the 26 losses in the 35-trade cohort exited `stop_hit`; one `time_stop`.
Not one loss was cut by a thesis or momentum rule.** Peak-to-exit gaps run to
4,255 minutes — the position reached its best price and was still held for days.

### FINDING 2 — over a third of the losses were profitable first

Best gain actually reached on the frozen OCC, 26 losses:

```
never cleared +5%     14     mean final -46.36%
+5% to +20%            7     mean final -48.04%
reached >= +20%        5     mean final -38.67%
```

Five losers reached +28% to +40% and closed between -22% and -45%. Ten reached
+10% or better. `PROFIT_GIVEN_BACK` is the single largest deterministic tag (10),
ahead of `EXIT_TOO_SLOW` (11 combined with marginal gains), with only 2
`STOP_TOO_WIDE` and 2 `THESIS_FAILED_IMMEDIATELY`.

Twelve of 26 losses were trades that worked and were not monetised, so exits are a
real and measurable opportunity. **They are not the whole answer** — see the post-fix
measurement below, where the best evidenced exit policy still leaves the lane at
PF 0.905, short of break-even. Selection has to improve too.

### FINDING 3 — the winners exit AT their peak, which is why they look untouchable

All 9 winners closed `target_hit` with `profitCapturedPct` 100.5–102.2%. They did
not give anything back. The largest, AAPL 260803P330 at **+343.93%**, took 1,431
minutes to reach its MFE — a long hold is load-bearing for the convex winners,
so a naive time-stop would destroy them.

### FINDING 4 — the backtest could not have caught any of this

`trailing()` in `exit-policy-research.ts` re-armed `armedAt` on **every** new high,
so `twoConsecutiveExit` only scanned marks after the **global peak**. It could only
exit after the best price of the whole trade — structurally unable to clip a winner.

Measured on the 35-trade cohort before the fix:

```
policy            n   mean%     PF     W   worstClipVsCurrent
Current          35   -8.39   0.751    9   —
Break-even +15%  35   -2.50   0.905    8   GOOGL -54.81
Trail 10%        35  +10.86   1.652   15   0.00   <- free lunch = the tell
```

All 9 winners returned "exit condition not confirmed; canonical result retained",
while 17 of 26 losers were improved. A trailing stop that never costs anything is
a broken measurement, not a good policy. Armed once at the first high above entry,
it can now clip — which is the precondition for Priority 11 being answerable at all.

**No production exit behaviour changed.** Exit-policy research is advisory and
already reports `productionBehaviorChanged: false`.

### FINDING 5 — evidence quality is strategy-dependent

```
strategy                  n    trustworthy  medianMarks  coverage
lower_high_continuation   58      51            131        0.939
breakout_forming          20      11             14.5      0.973
vwap_rejection            28      17              4.5      0.018
premarket_level_break    320       0              0        0
```

`premarket_level_break` (320 of 575 delivered rows) has **no marks at all** — it is
the legacy import and cannot support any trajectory claim. `lower_high_continuation`,
which dominates the cohort (20 of 26 losses, 6 of 9 winners), is densely marked and
is the only strategy where policy simulation is currently trustworthy.

### FINDING 6 — owner alerting is active and now says what is tracking it

Owner Discord openings were never disabled: 9 sent in the last session, `paperLinkRate 1`.
The gap was that the opening did not state whether the contract shown was the one being
mirrored. An owner opening with a reserved mirror is now headed
`OWNER VALIDATION — PAPER TRACKED` and carries the exact OCC and the paper position id;
one without a mirror reads `OWNER WATCH` and says it is not tracked. Subscriber-grade
copy is unchanged and still cannot show the OCC.

### Commits

```
f770142  Let the trailing-stop backtest clip a winner
4d60022  Say on the owner opening which paper position is tracking it
```

Production verified at `ff163c7` and the policy table re-read from it.

### FINDING 7 — post-fix measurement: the trailing stop was pure artifact

Re-read from production at `ff163c7`, same 35-trade cohort, corrected simulator:

```
policy             n   mean%     PF     winnerValueDestroyed
Current           35   -8.39   0.751    —
Break-even +15%   35   -2.50   0.905    -54.8 pts   <- only candidate
Break-even +10%   35   -4.29   0.823    
Break-even +20%   35   -6.38   0.790
Trail 15%         35   -6.32   0.685
Trail 10%         35   -8.03   0.549   -628.8 pts   <- was +10.86 / 1.652
Time stop 10m     35   -9.87   0.247
Time stop 30m     35  -13.33   0.257
```

Trail 10% went from mean **+10.86% / PF 1.652** to **-8.03% / PF 0.549** — now WORSE
than doing nothing. It clips 7 of the 9 winners, and takes the +343.93% AAPL run down
to **-7.14%**. Every time-stop variant does the same. Long holds are load-bearing for
the convex winners; any policy that caps duration or retracement destroys the tail
that carries the lane.

Break-even +15% is the only policy that improves both mean and PF, and it touches a
single winner (GOOGL +47.04% -> -7.78%, -54.8 pts) leaving the other eight untouched.

**But PF 0.905 < 1.0.** The best evidenced exit change does not make this lane
profitable. It is worth a shadow experiment; it is not a fix.

### Not done this session

Untouched: the frozen audit
cohort table (P1), persisted loss taxonomy (P3), pre-entry winner/loser feature
comparison (P5), contract-selection runner-up analysis (P10), the duplicate-delivery
race (P14), confirmation-cost capture (P9/P17), strategy/policy attribution (P13),
and the nightly aggregator + AI loop (P17-P20).

---

## Packet update — 2026-08-06 (7) the owner's winners were being excluded as duplicates, and the published stop could never be reached

### Verified state

- local = `origin/main` = `ac948b0` (was `41bac1e`, verified from git and origin before any change).
- Production healthy before and after: `/api/health` `ok:true`, `loopRunning:true`, `session:closed`.
- Full suite **3735/3735** (was 3729; +6 new tests). `tsc --noEmit --incremental false` clean.
  `next build` exit 0. `git diff --check` clean. 19 untracked scratch files untouched.
- Gates unchanged. No env var written. No provider caps changed. `SUBSCRIBER_APPROVED` still 0.
- Evidence read from production over the authenticated `/api/research/options/paper-chain`
  diagnostic via `railway run`, read-only. No secret printed.
- One unexplained single-test failure in 1 of 9 full-suite runs; not reproduced in the other 8
  and not identified. Pre-existing flake, unrelated to these changes. **Still outstanding.**

### FINDING 1 — 10 of 40 owner alerts were written off as duplicates, and they skewed to the winners

`buildPaperChainDiagnostic` decided duplication by unioning the mirrors linked to an alert
with every mirror sharing its `thesis_fingerprint`. That fingerprint is deliberately broad:

```
thesis_fingerprint = symbol | direction | optionType | sessionDate
```

The lookup filtered on neither status nor session, so two *separate* owner alerts that
re-entered the same session thesis each counted the other as a duplicate — even though
each had exactly one mirror. The unique indexes (`status='ENTERED'`, and
`status IN ('PENDING_DELIVERY','ENTERED')`) permit exactly this: a closed position frees
the thesis for a legitimate second alert.

Production impact, all 40 delivered alerts:

```
VERIFIED_REALIZED   26
DUPLICATE_POSITION  10   <- false positives
VERIFIED_OPEN_MARK   3
STALE_MARK           1
```

The discarded cohort held the four best percentage winners — **+50.27% (SPY 770P), +48.84%
and +45.13% (AAPL 305P), +47.04% (GOOGL 360P)** — but also five losses. Measured after the
fix, those 10 rows are 4 wins / 5 losses, mean **-2.59%**, net **-131.20 USD**.

So the exclusion was not one-directional. It hid the headline winners while making the
dollar total look **better** than reality: verified P&L moved from -4739.80 to **-4871.00**
once the rows came back, and validTrades rose 101 -> 111. The defect was silent
misrepresentation of a quarter of the owner's alerts, not a bias in one direction.

Duplicate now means more than one mirror for THIS alert. The separate check for two live
positions on one opportunity case is untouched — that one is real.

### FINDING 2 — the published stop was a level the position could never reach

Two stop authorities existed and `decideOptionExit` closes on whichever comes first:

```
risk-model stop PRICE   targets.ts   mid * (1 - 0.45)          -> published to Discord
premium safety band     grade.ts     returnPct <= -40 of fill  -> what actually fired
```

On a falling premium the higher price is reached first, so the -40% band always pre-empted
the -45% stop. Confirmed in production: repeated `stop_hit` exits land on exactly
**-40.0000%**, never near -45%. Every one of the 40 delivered alerts published a stop at
-43.5% to -45.6%; none was ever the binding level.

`resolveGoverningStop()` resolves the two into one and the opening publishes that. **Neither
threshold moved and no exit behaviour changed** — only the number the owner reads. T1/T2 keep
the risk model's levels, which do bind as computed (target_hit fires at +45% to +56%).

### FINDING 3 — every delivered case claimed DTE 0

`claimOpportunityOpenOnDb` hardcoded `selectedContract.dte = 0` while the frozen OCC and the
decision timestamp were both in scope. Every delivered case looked like a 0DTE trade, so
DTE-partitioned research was measuring a constant. Now derived from the OCC via
`parseOccSymbol`. Legacy rows are not backfilled — historical DTE cannot be proven.

### FINDING 4 — verified owner Discord performance is negative across the full history

With the duplicate exclusion corrected, the 40 most recent delivered owner alerts read:

```
closed 35 | open 4 | ungradable 1
wins 9  losses 26     win rate 25.7%
mean closed return    -8.39%
profit factor          0.811
net realized          -647.60 USD
best +343.93%   worst -96.76%
```

The prior packet's `PF 1.789 / mean +12.67%` was **one session of 9 openings**. Across the
full delivered history the same lane is a losing system. This is evidence for the resume
packet's own warning not to generalise a single profitable session into subscriber
readiness — `SUBSCRIBER_APPROVED` must stay 0.

### Commits

```
4c8cb31  Publish the stop that actually closes the position
ac948b0  Stop writing off the owner's own winners as duplicates
1d6a951  Packet (superseded by this entry)
```

Production verified at `1d6a951`: `duplicatePositionsExcluded` 10 -> **0**,
`DUPLICATE_POSITION` classifications 10 -> **0**, validTrades 101 -> **111**.

### Not done this session

Priorities 1-6 and 9-17 of the resume packet were **not** implemented. Priority 1 (canonical
mirror) and 4 (reconciliation) were audited and found already satisfied: production reports
`paperLinkRate: 1`, `sent24h: 9`, `linked24h: 9`, and `reserveDeliveredPaperOnDb` →
Discord → `finalizeDeliveredPaperReservationOnDb` is already the single atomic opening path,
with `delivery.ts` the only production caller. The remaining priorities — population renaming,
immutable strategy/policy attribution, confirmation-cost capture, matched cohorts,
break-even experiments, the canonical daily aggregator, the nightly recap rewrite, nightly and
weekly AI research, and AI budget enforcement — are untouched.

---

## Packet update — 2026-08-06 (6) the nightly review reported a lane the owner never traded, and case returns were priced across contracts

### Verified state

- local = `origin/main` = `d2f905d`. Production SHA verified separately below.
- Prior packet baseline `1d999a8` confirmed from git and the Railway container before any change.
- Full suite **3729/3729** (was 3723; +6 new tests). `tsc --noEmit` clean. `next build` exit 0.
  `git diff --check` clean. 19 untracked scratch files untouched.
- Gates unchanged. No env var written this session. No provider caps changed.
  `immediateAlertsPaused: true`, `HIGH_ASYMMETRY_IMMEDIATE_ALERTS_ENABLED=0` still set.
- Evidence read directly from the production SQLite volume over `railway ssh`, read-only.

### FINDING 1 — the "5 losses" were never the owner's Discord alerts

Two disjoint populations, both of size 5, sharing **zero contracts**:

```
LANE A  nightly review  (paper_trade_outcomes -> paper_trades, PRIMARY)
  5 rows / 4 distinct trades  ALL zero_dte_momentum  alert_id NULL  lane NULL
  0 wins / 5 losses      never delivered to Discord

LANE B  delivered Discord alerts  (options_paper_trades, DELIVERED_ALERT_PAPER)
  9 openings, 5 closed / 4 open
  3 WINS  +47.04%  +46.35%  +50.27%   (all target_hit)
  2 LOSSES -40.00%  -40.29%           (both the -40% safety band)
  mean closed return +12.67%   profit factor 1.789
```

`buildNightlySummary.overall` is fed only by `gatherOutcomesForDay`, which reads the
paper portfolio. The recap printed `Trades: 5 | Wins: 0 | Losses: 5` with no lane, so
it read as a verdict on the delivered alerts. The delivered lane was **profitable**
that day.

Lane A also double-counted: `paper_trades` 421 and 422 are one IWM fill written twice
6 ms apart, identical contract/entry/exit. 6 such duplicate groups exist historically.

### FINDING 2 — case returns were priced on a contract the case never held

`lib/research/options/loop.ts` passed `res.contract.bid` — the freshly RE-SELECTED
contract — into `attachEvidenceToOpportunityOnDb`, which divided it by the ORIGINAL
contract's frozen entry with no identity check. Five call sites, same defect.

`oc_1a50klb` (the SPY CALL the owner received):

```
frozen  O:SPY260811C00772000  entry 3.44 (mid; bid 3.42 / ask 3.45)
12:06   swap -> O:SPY260918C00782000  (+38 days, +10 strike)  bid 8.58
        (8.58 - 3.44)/3.44 = +149.42%  <-- stored as maxReturnPct
12:13   swap -> O:SPY260813C00771000  bid 3.87  -> +12.50%
15:27   swap -> O:SPY260814C00771000  bid 4.50  -> +30.81%
```

The frozen contract was observed **exactly once, at entry**, and never marked again.
Blast radius: 119 delivered cases, 41 re-selected a contract, **27 have no post-entry
observation of the contract they recommended**. Today: 9/9 swapped, 7/9 with none.
Evidence rows also show the *strategy* changing mid-case (`longer_dated_swing`,
`reversal_bounce` attached to a case opened as `breakout_forming`).

### FINDING 3 — the SPY -40.3% genuinely never worked (verified separately)

The corrupted +149% MFE is not the trade's history. `options_paper_trades` #789 and its
**529 same-contract marks** are contract-consistent and authoritative:

```
peak  -0.76%  at 11:11:27 ET (t+2.5m)     never reached +5%, ever
exit  -40.29% at 15:50:01 ET  reason stop_hit  entry_quality_verdict EARLY
```

So for THIS trade "never worked" is true — but it is an `IMMEDIATE_SETUP_FAILURE`
held 278 minutes from peak to exit, not a profit giveback. The other loss that day
(`#766` SPY 0DTE P770) DID reach **+28.26%** at t+3.4m and gave back 68 pts — that one
is the real `GOOD_SETUP_BAD_EXIT`.

Also: the published stop was $1.89 (-45%) but the engine exits on the **-40% safety
band** (`OPTIONS_PAPER_STOP_LOSS_PCT`), so the stop shown to the owner is unreachable.

### FINDING 4 — the delivered/research gap is mostly evidence quality, not execution

```
                                  DELIVERED        RESEARCH
all closed rows                   -31.04%  PF .351   +1.49%  PF 1.054
excluding the 2026-07-22 bulk     -17.52%  PF .436   +1.49%  PF 1.054
  ... and requiring >=20 marks     -9.99%            +0.53%
```

413 of 575 delivered rows come from **one day (2026-07-22) with avgMarks 0.3**; 189 of
them exited `expiration_no_quote` with a NULL return. Gap decomposition: ~13.5 pts
legacy bulk, ~7.5 pts residual low mark coverage, **~10.5 pts genuine residual**.

The residual is a **win-rate / MFE** gap (24.3% vs 39.1%; avgMFE +15.0% vs +38.9%) at
identical DTE, hold time, exit engine and entry convention — i.e. selection, not
execution.

**Research entry is NOT flattered** (Priority 5 answered): research avg fill is
-0.94% below ask vs delivered -1.12%; delivered has 160 OPTIMISTIC_MIDPOINT entries,
research has **zero**; forcing research to the ask still leaves it positive
(+1.487% -> +0.535%).

### FINDING 5 — a RESEARCH_ONLY strategy could look subscriber-ready

The message the owner actually received, verbatim from `options_alerts.message`:

```
🟢 SPY CALL ALERT
SPY 08/11 $772 Call
Entry: $3.42–$3.45
Why: SPY pressed against resistance as momentum increased.
```

`breakout_forming` was `RESEARCH_ONLY / INSUFFICIENT_EVIDENCE` at that moment. No lane,
readiness, strategy, version or case id. All 9 openings that day were for strategies in
`RESEARCH_ONLY` or `DEMOTED`, all with `research_only = 0`.

### Profit protection — measured, and the naive policy is WRONG

From 295 closed trades with >=20 same-contract marks, ex-bulk:

```
+25% reached  n=135  avgPeak 62.7%  avgFinal 34.2%  35% ended red  giveback 28.5 pts
+50% reached  n= 84  avgPeak 78.8%  avgFinal 69.1%  10% ended red  giveback  9.8 pts
+100% reached n= 10  avgPeak 199.7% avgFinal 199.7%  0% ended red  giveback  0.0 pts

CURRENT        expectancy -3.14%  PF 0.882
TP@+25%        expectancy -7.35%  PF 0.628   (86 winners clipped)
TP@+50%        expectancy -8.58%  PF 0.661
BE-after-+20%  expectancy -1.76%  PF 0.899   <-- best candidate
BE-after-+25%  expectancy -1.90%  PF 0.904
```

**Every hard take-profit makes realized expectancy worse.** Clipping winners costs more
than the losers avoided. Only a break-even stop after +20-25% helps, and only by
~1.2-1.4 pts — it does not make the lane profitable. Not implemented; evidence only.

### Shipped this session

- `320d651` price a case's return only on the contract it froze its entry on
- `6d863c9` stop the nightly review calling a lane it does not measure "the day's trades"
- `d2f905d` make every opening state its lane and readiness

### NOT done — next session starts here

- Strategy/version attribution is still not persisted; openings report
  `UNKNOWN_LEGACY_VERSION` and readiness rows remain keyed `@unknown`.
- The duplicate-open race in the paper engine (421/422) is diagnosed, not fixed.
- Published stop (-45%) vs enforced band (-40%) mismatch not reconciled.
- `selectedContract.dte` is hardcoded 0 in `claimOpportunityOpenOnDb` — DTE buckets on
  opportunity cases are wrong (case showed dte 0 for a 5-DTE contract).
- Break-even-after-+20% profit protection: not implemented, shadow experiment not built.
- Matched delivered/research cohorts, confirmation-delay and premium-expansion buckets:
  not built (delivered latency fields are NULL, so the inputs do not exist yet).
- The autonomous nightly AI research cycle was not started.


## Packet update — 2026-08-06 (5) the marking gap is a legacy artifact, and the strategies are still negative

### Verified state

- local = `origin/main` = production = `9b94e35`. Read from git and `/api/healthz`.
- Six deploys this session: `acbe8b9` → `a8bb45c` → `9bb05af` → `f76327e` → `9b94e35`.
- `/api/healthz`: `ok:true`, db writable, `schemaMissing: []`, lifecycle active.
- Full suite **3723/3723**. `tsc` clean. `next build` exit 0. `git diff --check` clean.
- Gates unchanged: `immediateAlertsPaused: true`, `directionalAuthorityMode: enforce`,
  `strategyReadinessMode: enforce`, `indexStrategyActionable: false`,
  `paper0dteResearchEnabled: false`. No provider caps changed.

### ROOT CAUSE PROVEN: the marking gap is a LEGACY IMPORT, not a live defect

`api/research/options/mark-evidence` over 60 days, 799 positions:

```
COMPLETE_TO_EXIT        301     MULTI_MARK_PARTIAL       52
SINGLE_POST_ENTRY_MARK  175     ENTRY_ONLY              271
excursion trustworthy   353     untrustworthy           446
realized usable         779     immediate-failure usable 276
```

The decisive discriminator is the ENTRY DATE, not the strategy:

```
DELIVERED lane
  premarket_level_break  n=320  medObs=  0  100% untrust  entered 2026-07-22 .. 2026-07-22
  pullback_continuation  n= 44  medObs=  1   82% untrust  entered 2026-07-22 .. 2026-07-28
  reversal_bounce        n= 39  medObs=  1   56% untrust  entered 2026-07-22 .. 2026-07-28
  opening_range_breakout n= 11  medObs=  0   91% untrust  entered 2026-07-22 .. 2026-07-29
  ---- marking starts working ----
  lower_high_continuation n=58  medObs=131   12% untrust  entered 2026-07-29 .. 2026-08-06
  breakout_forming       n= 20  medObs=14.5  45% untrust  entered 2026-07-22 .. 2026-08-06

RESEARCH lane (began 2026-07-27)
  every strategy          0% untrust, medObs 62 - 650
```

**`premarket_level_break` alone is 320 of 575 delivered rows, ALL entered on
2026-07-22, none ever marked.** It is also the strategy P3 proved never matches live.
These are legacy rows from a superseded creation path, not current behaviour.

Exit reasons corroborate: `expiration_no_quote` is 190 in the delivered lane and
**0** in research. Nothing closed inside one grader tick, so the 30s grader cadence is
not the cause. The marking subsystem became reliable around 2026-07-27/29 and has
worked since.

### THE STRATEGIES ARE STILL NEGATIVE ON TRUSTWORTHY EVIDENCE

This is the part that matters. Removing the corrupted rows did NOT rescue anything:

```
DELIVERED lane, re-graded on real observation series
  momentum_acceleration   n=25  exp -33.2%  PF 0.094   DEMOTED
  reversal_bounce         n=30  exp -32.9%  PF 0.031   DEMOTED
  lower_high_continuation n=54  exp -27.8%  PF 0.311   DEMOTED   (MFE 8.5, immFail 38%)
  vwap_rejection          n=28  exp -26.2%  PF 0.378   DEMOTED   (MFE 16.7, immFail 20%)
  premarket_level_break   n=179 exp -36.4%  PF 0.383   DATA_CONTAMINATED (179/179 degenerate)
  pullback_continuation   n=27  exp -35.7%  PF 0.248   DATA_CONTAMINATED (19/27)
```

The marking gap qualified the MFE/immediate-failure numbers. It did not qualify the
LOSSES — realized returns never depended on excursion history, which is exactly why
that separation was built. **Delivered alerts really were losing money.**

### THE OPEN QUESTION: delivered vs research is real, not a marking artifact

Research-lane rows have ZERO degenerate excursions, so this gap cannot be explained
away by missing marks:

```
                        delivered            research
pullback_continuation   -35.7%  PF 0.248     +0.50%  PF 1.019   FORWARD_VALIDATED
reversal_bounce         -32.9%  PF 0.031     +6.49%  PF 1.246   FORWARD_VALIDATED
momentum_acceleration   -33.2%  PF 0.094    +16.74%  PF 1.749   PROMISING
```

Same strategies, same window, opposite outcomes. The difference must be in ENTRY
BASIS or exit policy between the two lanes. **This is now the single highest-value
investigation** — if the research lane's entry convention is achievable, it is worth
more than any strategy change.

### Readiness after re-grading

```
DEMOTED         4   lower_high_continuation, momentum_acceleration,
                    reversal_bounce, vwap_rejection
RESEARCH_ONLY   7
SUBSCRIBER_APPROVED    []      SUBSCRIBER_CANDIDATE   []
```

### Exact next-session resume point

1. **Diagnose the delivered-vs-research entry basis.** Compare `entry_fill` against
   contemporaneous ask for the same strategy in both lanes. This is the top item.
2. Prospective RTH: confirm new delivered positions now accrue multiple distinct
   observations (recent rows already do — `lower_high_continuation` medObs 131).
3. Persist strategy/version attribution at creation. Still `unknown` everywhere;
   nothing may be back-filled, legacy stays `UNKNOWN_LEGACY_VERSION`.
4. Historical reconstruction of the 2026-07-22 batch is **NOT_RECONSTRUCTABLE** — no
   contemporaneous option quote series was persisted. Do not interpolate.
5. Cohorts still not run; they need per-session replay data the current store does
   not carry with a complete leakage fence.
6. `trend_continuation` and index bullish-only remain open from the prior packet.
7. Alert pause stays ON. Nothing is subscriber-approved.

---

## Packet update — 2026-08-06 (4) readiness, ranking, learning, cohorts

### Verified state

- local = `origin/main` = production = `7940311`. Read from git and `/api/healthz`.
- Three deploys this continuation: `415f4b6` → `3f25c96` → `7940311`.
- `/api/healthz`: `ok:true`, db writable, **`schemaMissing: []`** (the two new tables
  migrated onto the real production database), lifecycle active.
- Full suite **3707/3707 twice**. `tsc --noEmit --incremental false` clean.
  `next build` exit 0. `git diff --check` clean.
- Gates confirmed live via `api/research/options/readiness-board`:
  `immediateAlertsPaused: true`, `directionalAuthorityMode: enforce`,
  `strategyReadinessMode: enforce`, `indexStrategyActionable: false`,
  `paper0dteResearchEnabled: false`.

### Subscriber eligibility is now EXPLICIT, and nothing is eligible

Assessed against **799 real outcomes** from the paper-trade store:

```
SUBSCRIBER_APPROVED   []          <- nothing may send a subscriber opening
SUBSCRIBER_CANDIDATE  []          <- nothing auto-promoted
DEMOTED               2           lower_high_continuation, vwap_rejection
RESEARCH_ONLY         9
```

Every delivered-lane strategy measured negative:

```
premarket_level_break    n=179  exp -36.4%  PF 0.383
pullback_continuation    n= 27  exp -35.7%  PF 0.248
momentum_acceleration    n= 25  exp -33.2%  PF 0.094
reversal_bounce          n= 30  exp -32.9%  PF 0.031
lower_high_continuation  n= 54  exp -27.8%  PF 0.311   DEMOTED
vwap_rejection           n= 28  exp -26.2%  PF 0.378   DEMOTED
sr_reclaim               n= 19  exp  -3.7%  PF 0.870
```

The gate fails CLOSED: absence of a record is absence of permission, so a legacy
database does not silently grant delivery. `SUBSCRIBER_APPROVED` is reachable only
through `recordHumanApproval`, which refuses an empty or system-looking actor.

### TWO DEFECTS THE FIRST PRODUCTION RUN EXPOSED — both fixed in `7940311`

**1. The research lane was overwriting the delivered lane.** Readiness keys on
strategy@version but segmentation is per lane, so the last write won:

```
pullback_continuation   delivered -35.7%  |  research  +0.50%   (36.2pp)
momentum_acceleration   delivered -33.2%  |  research +16.74%   (49.9pp)
reversal_bounce         delivered -32.9%  |  research  +6.49%   (39.4pp)
lower_high_continuation delivered -27.8%  |  research +35.99%   (63.8pp)
```

The research row won, promoting `pullback_continuation` to SUBSCRIBER_CANDIDATE
while it was losing 35.7% on alerts subscribers actually received. Exactly backwards.
`DELIVERED_ALERT_PAPER` now governs; where both lanes exist the WORSE verdict is
taken; research-only evidence is capped below subscriber candidacy.

**2. MFE equal to MAE is a marking gap, not a trading result.** Peak-favorable cannot
sit below worst-adverse over a multi-mark position — both fields were filled from a
single mark. Production scale of this:

```
pullback_continuation    89% of priced rows lack real excursions
momentum_acceleration    84%
reversal_bounce          83%
sr_reclaim               79%
opening_range_breakout   75%
premarket_level_break    55%  (98 of 179 rows)
```

Those rows keep their RETURN and are excluded from excursion metrics; above 50% the
segment is CONTAMINATED so it can neither promote nor condemn. **This is why only 2
strategies are DEMOTED rather than 7** — the rest are not subscriber-eligible either
way, but they have not been condemned on evidence that does not exist.

**This materially qualifies the -7.2% / 59.9% baseline.** Any immediate-failure or
MFE figure computed over these rows was partly measuring absent marks.

### Ranking, learning, cohorts

`opportunity-ranking@1` — 17 weighted components, 10 penalties. Missing data is
excluded from the weighted mean, never scored zero. Execution weight 0.34 vs setup
0.33, because the audited population failed on execution. Hard blockers and
directional conflicts are fatal, never scored around. The whole comparison persists
to `opportunity_rank_breakdown` — winner, runners-up and blocked, with per-runner-up
reasons.

Learning proposals are inert by construction: no `apply()`, no threshold field any
runtime reads, no `promote()`, lane restricted to SHADOW/PAPER_VALIDATION/
RESEARCH_ONLY. A test asserts those levers are absent.

Cohorts require improvement across 3 independent sessions; expectancy up AND
immediate failure not worse; an incomplete hindsight fence is `LEAKAGE_RISK`.

### Production reachability and 0DTE, confirmed live

All 12 0DTE-permitting strategies are selectable and plan a `0-0dte` partition,
including `zero_dte_index` and `index_intraday_momentum`. Only `trend_continuation`
remains unselectable — the acknowledged catalog duplicate.

### Exact prospective RTH resume point

Everything below needs an OPEN regular session and could not be observed now.

1. **Confirm no symbol holds two actionable directions.** Watch
   `api/diagnostics/contract-funnel?symbol=SPY` and the delivery decisions for
   `readiness_gate:` and `OPPOSITE_DIRECTION_ACTIVE` refusals.
2. **Observe an index strategy actually planning a 0DTE partition.** Needs a bullish
   index leg: both index strategies require `above_vwap` + `price_acceleration` and
   cannot fire on a down day.
3. **Confirm zero subscriber openings are sent** while every strategy is
   non-approved, and that scanning, capture, journaling, lifecycle, grading, paper
   and owner watches all continue.
4. **Fix the marking gap** (`options_paper_marks` coverage) before trusting any MFE,
   MAE or immediate-failure number. This is now the top data-quality blocker.
5. Re-run `api/research/options/readiness-board?persist=1` after marks improve; the
   DEMOTED set will likely grow beyond 2.
6. Decide `trend_continuation`: distinct signals or retire.
7. Give the index strategies bearish counterpart signals, or accept bullish-only.
8. Alert pause stays ON. Subscriber promotion still requires human approval.

---

## Packet update — 2026-08-06 (3) directional authority and the unreachable strategies

### Verified state

- Start of session: local = `origin/main` = production = `80e5bf5`. Read from git
  and `/api/healthz`, not assumed.
- Two deploys this session: `2a57a34` → `8779c33`.
- `/api/healthz`: `ok:true`, db writable, `schemaMissing: []`, lifecycle active.
  `/api/health`: `loopRunning:true`, `quotaExceeded:false`, session `regular`.
- Full suite 3647/3647 twice. `tsc --noEmit --incremental false` clean.
  `next build` exit 0. `git diff --check` clean. **No migrations touched.**
- **`HIGH_ASYMMETRY_IMMEDIATE_ALERTS_ENABLED=0` untouched.** Confirmed live in
  `/api/research/asymmetry/timing`: `immediateAlertsPaused: true`.
- `PAPER_0DTE_RESEARCH_ENABLED` remains unset. Not needed by either fix.
- New env, both defaulting to the SAFE value:
  `DIRECTIONAL_AUTHORITY_MODE` (default `enforce`),
  `INDEX_STRATEGY_ACTIONABLE_ENABLED` (default off → RESEARCH_ONLY).

### The contradictory SPY alert is traced to exact production evidence

`api/opportunity-cases/oc_x5r3u9`, read through `railway run`:

```
caseId   oc_x5r3u9      alertId oa_16dpkke     thesisFp ot_l73wt8
symbol   SPY            direction bearish      setupFamily lower_high_continuation
detected 2026-08-06 11:11:08 ET               lifecycle CLOSED
contract O:SPY260807P00770000  bid 2.21 / ask 2.22  spread 0.45%
         delta -0.456  OI 10,786  volume 42,816
```

`bid 2.21 / ask 2.22` is exactly the owner's reported "$2.21–$2.22". The call leg
is corroborated by the SPY-scoped contract funnel in the same window:
`breakout_forming` → **call**, expirations including **2026-08-11**, and
`lower_high_continuation` → **put**, expirations including **2026-08-07**. Both
`CONTRACT_SELECTED`. The two Discord reason strings map to those two strategies
verbatim in `plainEnglishAlertReason` (`format.ts:156,164`).

**Root cause: every exclusion key encoded DIRECTION, so nothing could see it.**

- `clusterKey(symbol, side)` yields `index:call` / `index:put` as separate
  clusters. The delivered put's own recorded reason was literally
  `subscriber_worthy: quality 0.7806 >= bar 0.7 …; cluster index:put`.
- `opportunityThesisFingerprint` is `symbol|direction|optionType|sessionDate`,
  and that is the PRIMARY KEY of `opportunity_thesis_active_index` — the table
  whose whole job is "one open thesis". Per-direction, so a CALL claim and a PUT
  claim both succeed.
- A second path: `maybeSendBearishOwnerReview` (`delivery-decision.ts:519`) sends
  via `sendOwnerResearchNotify` BEFORE and independently of the main gating.

The case recorded `auditAnswers.strategiesConflicted: []` while
`strategiesApplicable` held BOTH `breakout_forming` and `lower_high_continuation`.
The conflict existed and nothing watched for it.

`2a57a34` adds a symbol-scoped authority that ignores direction, checked inside
`claimThesisIndexOnDb` — the single choke point BOTH opening paths reach. An
opposite direction is refused unless it arrives as an explicit reversal naming the
active case it supersedes, explaining what changed, with evidence post-dating that
case. Uses `idx_opportunity_thesis_symbol`; no migration.
`tests/directional-authority.test.mjs` (15 tests) reproduces the SPY incident.

**`tests/opportunity-lifecycle-dedup.test.mjs` had asserted the defect** — "CALL
direction owns a separate thesis", expecting TWO simultaneous active IWM theses.
Corrected to assert one actionable direction per symbol.

### The 8 dead strategies: 2 proven unselectable, and it is the same defect as 0DTE

`selectOptionsStrategy` takes ONE winner, `applicable[0]`, ordered by
`matched/earlySignals.length` — a RATIO — and `Array#sort` is stable in V8, so
ties resolved by **catalog array position**. A strategy's score depends only on
its own signals, so activating exactly its own set is the provably optimal
witness, which makes reachability **decidable**:

> S is unselectable ⟺ some EARLIER catalog entry's signal set is a subset of S's.

Exactly three qualified, including both strategies written for SPY/QQQ 0DTE:

```
trend_continuation        ← pullback_continuation
index_intraday_momentum   ← pullback_continuation, trend_continuation
zero_dte_index            ← all three above
```

Verified against the real selector: a perfect SPY 0DTE candidate scored
`zero_dte_index` **1.0, applicable=true**, and the selector still returned
`pullback_continuation` (`preferredDte 1-7dte`).

`planPartitions` reads ONLY the selected strategy's `preferredDte`, so SPY/QQQ
never emitted a 0dte partition. `8779c33` makes the tie-break explicit
(ratio → matched count → index scope on index symbols → catalog order) and adds
`symbolScope: "index"`. The perfect SPY candidate now selects `zero_dte_index`
with `preferredDte 0dte`, and `planPartitions` emits a `0-0dte` partition.

**These strategies stay RESEARCH_ONLY** (`INDEX_STRATEGY_ACTIONABLE_ENABLED`
default off): they were unreachable, so they have no forward record, and a wiring
fix must not put an unproven strategy in front of subscribers.

`trend_continuation` is NOT fixed: its signals are identical to
`pullback_continuation`'s and both are core-scoped, so nothing at decision time
distinguishes them. That needs a catalog decision, not an invented discriminator.
A guard test fails if the unselectable set ever grows.

### CORRECTION: 0DTE is NOT globally unfetched, and 774P was not the wrong strike

Two claims carried into this session did not survive production evidence.

**1. "The 0DTE chain is never requested" is too strong.** The 2026-08-06 funnel
shows `momentum_acceleration`, `vwap_rejection` and `opening_range_breakout` all
fetching `0-0dte` with expiration `2026-08-06` present. 0DTE IS fetched whenever a
0DTE-permitting strategy is selected. The real defect is narrower and matches the
above: for SPY/QQQ the *index* 0DTE strategies were unselectable, so index 0DTE
coverage depended on accidentally matching a core strategy that happens to permit
it. On SPY that day, only `vwap_rejection` did.

**2. The 770P/774P pair does not show a wrong strike.** From the frozen audit:

```
                  decisionAsk  spread   MFE    MAE   classification
O:SPY260806P00770000   1.48    1.35%   +87%   -13%  VERIFIED_EXECUTABLE_WINNER
O:SPY260806P00774000   2.58    1.16%   +97%   -15%  REJECTED_BUT_GOOD
```

The 774P had the **higher** MFE and the **tighter** spread. Ranking picked the
better executable contract. It was then refused on `ENTRY_TOO_LATE_6M` — a
30-second ceiling taken from `freshnessMaxMs`, a QUOTE-staleness constant, applied
to candidate age, for a strategy declaring an "hours–2 days" horizon. **The loss
was a clock rule, not strike selection.** (That reprieve exists in `7285829` and
remains OFF.)

**What IS a real ranking defect:** `oc_x5r3u9` persists `rank: null`,
`rankExplanation: null`, `rejectedContracts: []`. The system cannot explain why one
contract beat another, so questions of this shape are structurally unanswerable
from stored evidence. **Not fixed this session.**

### LIMIT OF THE REACHABILITY FIX: both index strategies are bullish-only

Making them selectable does NOT mean they would have caught the 2026-08-05 misses,
and this must not be claimed. Their early signals are:

```
zero_dte_index          opening_range_development, above_vwap, price_acceleration
index_intraday_momentum above_vwap, price_acceleration
```

`activeSignals` only adds `price_acceleration` when `accelPct > 0`, and `above_vwap`
when the underlying is above VWAP. **Neither strategy has a single bearish early
signal, despite both declaring `side: "either"`.** Measured on a bearish SPY
(velPct -0.5, accelPct -0.4, below VWAP, LOD break):

```
zero_dte_index          applicable=false  score=0.333  matched=[opening_range_development]
index_intraday_momentum applicable=false  score=0      matched=[]
```

All 12 verified winners on 2026-08-05 were PUTS. These two strategies could not
have produced any of them, before or after this fix. They are a coverage gain for
bullish index days only. Giving them bearish counterpart signals is a catalog
change and is NOT done.

**The genuinely useful discovery from the same test:** on that bearish SPY input
the selector returns **`momentum_breakdown`, `preferredDte 0dte`**. That strategy
is one of the eight reported "dead" ones, it is reachable, it is put-side, and it
DOES plan a same-day partition. So bearish index 0DTE coverage does exist when the
bearish signals actually fire — which reframes the remaining question from "why is
this strategy dead" to "why did its signals not fire on 2026-08-05". That is the
next measurement, and it is not answered here.

### Provider budget is a live constraint on any 0DTE widening

2026-08-06 funnel: 976 candidates, terminal reasons `CONTRACT_SELECTED` 794,
**`PROVIDER_QUOTA_EXCEEDED` 108**, `NO_CONTRACTS_RETURNED` 74. Quota at read time:
`callsToday 9,157` against `dailyCap 200,000` but `minuteCap 280`. The binding
constraint is the **per-minute** cap, not the daily one. 11% of candidates already
die on it before any 0DTE widening. No caps were changed this session.

### Exact resume point

1. **Measure the two fixes in RTH.** Both are deployed but neither has forward
   evidence. Confirm no symbol holds two directions, and that SPY/QQQ now request
   a 0DTE partition, via `api/diagnostics/contract-funnel?symbol=SPY`.
2. **Persist the contract rank breakdown** (`rank`, `rankExplanation`,
   `rejectedContracts`). Until then no 770P-vs-774P question is answerable.
3. **Quarantine by strategy version.** Expectancy -7.2% / PF 0.49 is still a
   POPULATION number; it has not been segmented per strategy/version, so nothing
   has been quarantined yet.
4. Decide `trend_continuation`: give it distinct signals or retire it.
5. Deterministic opportunity-ranking objective — not started.
6. Learning/experiment wiring, cohort replays — not started.
7. Alert pause stays ON. Subscriber promotion still requires human approval.

---

## Packet update — 2026-08-06 (2) the called-versus-missed audit

### Verified state

- Local HEAD = `origin/main` = production: `e8ea895`. Read from git and
  `/api/healthz`. Three commits: `f9758fd` → `7285829` → `e8ea895`.
- Full suite 3623/3623 twice. `tsc --noEmit --incremental false` clean.
  `next build` exit 0. `git diff --check` clean. No migrations touched.
- **`HIGH_ASYMMETRY_IMMEDIATE_ALERTS_ENABLED=0` is SET in Railway.** Verified in
  production: `immediateAlertsPaused: true`. Capture, marks, grading, paper,
  lifecycle and subscriber behaviour all untouched.
- `PAPER_0DTE_RESEARCH_ENABLED` remains unset.
- `ASYM_LATE_ENTRY_REPRIEVE_ENABLED` unset → OFF.

### The counter disagreement was a QUERY-PARAMETER BUG, not a counter bug

`Number(url.searchParams.get("limit"))` is 0 when absent and `Number.isFinite(0)`
is true, so the documented default of 200 was unreachable and
`/api/research/asymmetry/timing` read **one row**. `ratio.*` is SQL over the
session and was right; `suppression.*` and `distributions.*` are built from the
row LIST and described a one-row session. Proven against production at one
instant: `?limit=1` → notifiedCaptures 0, immediateAlerts 0; `?limit=1000` → 1
and 1, `ratio.decisions` 199 in both. Now fixed and verified live: default
returns all 269 rows and **`ratio.notified` = `notifiedCaptures` =
`immediateAlerts` = 1.**

**This corrected the last packet.** The surviving row was AVGO
`O:AVGO260810P00415000` (REJECTED, `UNUSABLE_SPREAD_26.0`), and because
`distributions` was built from it the alert was described as `sr_reclaim`. The
alert was **NFLX `O:NFLX260807P00074000`, `pullback_continuation`**, 09:47:28 ET,
ask 0.74, spread 2.7%, quality 88, chase 0%, capture→notify 10.8s, send latency
1.87s, `notify_outcome=SENT` with a matching `notified=1` transition.
**NBBO-verified: +70.3% MFE within 25 minutes against -17.6% MAE. A good alert.**

### The owner's three concerns, answered with measurements

**"OptiScan missed SPY calls that made huge returns" — there were no calls to
miss.** SPY on 2026-08-05: open 775.85, high 776.85 at 09:39, close 769.79. Best
UP leg **+0.30%**; best DOWN leg -0.94%. Of 292 contracts screened, 34 showed an
apparent gain ≥200%. NBBO-verified from a fixed no-hindsight 10:30 ET entry:
**12 VERIFIED_EXECUTABLE_WINNER — all PUTS, zero calls.** Plus 8 BAD_PRINT,
4 ZERO_BID_ARTIFACT, 8 HINDSIGHT_ONLY (7 of them calls), 2 TINY_CAPACITY.
Best real trade **+203%**. The "+3,450%" SPY 770P is **+194%** from a payable
ask — the headline compares a 0.02 low in the last 15 minutes to a 0.71 high.
**No contract anywhere near +10,000% survived verification.**

**"Discord surfaces poor-quality ideas" — confirmed, with numbers.** 181 alerts
sampled by even stride from 862 across 07-31/08-03/08-04/08-06, priced
ask-to-bid: **60% never gained more than 5%**, median MFE **+1.6%**, median MAE
-15.8%, median EOD -9.0%, profit factor **0.49**, expectancy **-7.2%**.
Alert-to-capture was 53.3% / 39.8% / 44.5% on those three sessions.

**"Alerts arrive late" — the opposite is the bigger problem.** 111 decisions were
rejected as ENTRY_TOO_LATE on candidate age alone; **82% still had ≥10% reward
remaining and 91% had seen premium expand ≤10%** by the system's own measures.

### The dominant root cause is UNFIXED and named as such

**The 0DTE chain is never requested.** Across 5,562 journal rows over five
sessions, 19 decisions (0.3%) involved a contract expiring that day. On
2026-08-05: **ZERO across 165 symbols and 1,056 decisions.** 11 of the 12
verified missed winners were 0DTE — never fetched, never ranked, never quoted.

Partitions come only from bands the matched strategy permits. SPY matched
`pullback_continuation`, `sr_reclaim`, `reversal_bounce`, `breakout_forming`,
`longer_dated_swing` — none permit 0DTE. **8 of the 12 0DTE-permitting
strategies have never matched a candidate in any session with data**, including
`zero_dte_index` and `index_intraday_momentum`, both written for SPY/QQQ, and
the put-side breakdown strategies that describe exactly what SPY did.

### One good entry was found and refused

SPY `O:SPY260806P00774000`, 2026-08-05. Seen 10:05:47 → OWNER_WATCH
(`CONFIRMING_EVIDENCE_INCOMPLETE_9`). Rejected 10:09:01 on **`ENTRY_TOO_LATE_6M`**
at ask 2.58, spread 1.16%, ask size 222. NBBO-verified from that instant: peak
bid **5.08** at 12:09, size 70. **+97% MFE, -15% MAE.** The ceiling it breached
was **30 seconds**, taken from `strategy.freshnessMaxMs` — a QUOTE-staleness
constant — for a strategy declaring a "hours–2 days" holding horizon.

`7285829` adds a narrow reprieve (chase < half the limit AND not extended AND
reward above minimum AND under 15 minutes; any missing measure = no reprieve;
staleness/spread/OI/volume untouched; journaled as `NOTIFY_AGE_REPRIEVED`).

**It is OFF and must stay off.** Replay recovers 55 of 111. Priced ask-to-bid
they beat the sent alerts on immediate failure (35% vs 60%) and median MFE
(+9.9% vs +1.6%) but barely on +25% rate (20% vs 18.6%) and are worse on
drawdown (-29% vs -15.8%). The motivating case went +97%; the median goes +9.9%.
One winner is not repeated evidence.

### Owner surface

`GET /api/research/asymmetry/spy-audit` — token-gated, read-only, zero provider
calls, `actionable: false`, own `asOf`. Frozen evidence in
`lib/research/asymmetry/spy-audit-2026-08-05.ts`.

### Exact resume point

1. **Fix 0DTE coverage — this is where the missed winners are.** Either give the
   index/breakdown strategies a matcher that can actually fire, or let a
   0DTE partition be requested for index symbols independently of strategy band.
   Measure with the 19-of-5,562 baseline above.
2. Diagnose why `zero_dte_index`, `index_intraday_momentum`,
   `momentum_breakdown`, `support_break_retest`, `bearish_opening_range_break`,
   `failed_breakout_reversal`, `failed_breakout`, `premarket_level_break` never
   match. Eight dead strategies is a detection defect, not a market fact.
3. Shadow the late-entry reprieve; demote it if reprieved alerts underperform
   unreprieved ones over 30 decisions.
4. Backfill `decisionMetrics` reasoning for pre-08-05 sessions, or accept the
   replay can never reach them.
5. Lift the alert pause only after 1 and 2 land.

---

## Packet update — 2026-08-06 the digest consumer, and High-Asymmetry alerts for the first time

### Verified state

- Local HEAD = `origin/main` = production: `c5b5e41`. Read from git and `/api/healthz`,
  not assumed. Three deploys this session: `2047e8e` → `d0e30b6` → `c5b5e41`.
- `/api/healthz`: `ok: true`, db writable, `schemaMissing: []`, lifecycle active.
- Full suite 3568/3568 twice. `tsc --noEmit --incremental false` clean.
  `next build` exit 0. `git diff --check` clean.
- `PAPER_0DTE_RESEARCH_ENABLED` remains unset.
- New env, all OFF/bounded by default: `CONTENT_DIGEST_DISCORD_ENABLED`,
  `CONTENT_DIGEST_MIN_INTERVAL_MS` (24h), `CONTENT_DIGEST_MAX_OUTCOMES` (12).

### HIGH-ASYMMETRY HAS ALERTED. The arithmetic fix worked.

Measured live at 14:22Z on 2026-08-06, **52 minutes into a real RTH session** —
the clean post-fix RTH cohort the last two packets could not obtain.

```
decisions 151 · distinctCases 130 · notified 1
byAction   HIGH_ASYMMETRY_ALERT 1 · OWNER_WATCH 2 · PAPER_ONLY 19
           TOO_LATE 30 · REJECTED 99
byTiming   ON_TIME 121 · ENTRY_TOO_LATE 25 · STALE_EVIDENCE 5
notified   state HIGH_ASYMMETRY · strategy sr_reclaim · premium chase <10%
           capture→notify <60s · staleness <30s
```

Three things this settles, none of which the cumulative counts could:

1. **`CONFIRMING_EVIDENCE_INCOMPLETE_9` is GONE from the blocker list.** It was
   111 and top of the list at `a757342`. It does not appear at all in today's
   `byReason`. The six structural unsupplied labels are no longer making
   notifiable states unreachable — exactly what `a6c451c` predicted, and what the
   91→111 rise was wrongly feared to disprove.
2. **A genuinely qualified fresh case reached HIGH_ASYMMETRY and alerted.** One,
   not a forced one: 130 distinct cases produced exactly one alert.
3. **The gates still refuse everything they should.** AVGO
   `O:AVGO260810P00415000` reached `toState: HIGH_ASYMMETRY` and was still
   REJECTED on `UNUSABLE_SPREAD_26.0` (bid 6.35 / ask 8.25). Premium-expanded
   cases went PAPER_ONLY (19, `STATE_NOT_NOTIFIABLE_PREMIUM_CHASE`), late ones
   TOO_LATE (30), wide spreads and thin OI REJECTED. Reaching the state is not
   the same as passing the gate, and the gate held.

**Counter disagreement, unresolved:** `ratio.notified` is 1 and
`byAction.HIGH_ASYMMETRY_ALERT` is 1, but `suppression.notifiedCaptures` is 0 and
`suppression.immediateAlerts` is 0 with `silentCaptures: 1`. Two counters over the
same session disagree about whether a notification happened. The alert is
corroborated by `byAction` and `distributions.stateAtNotification`, so the likely
fault is in the suppression counter's source, not in the alert. NOT chased this
session — recorded so it is not later read as evidence either way.

### `fieldLineage` already answers Priorities 8 and 9

The endpoint reports, per field, where it can come from and what it costs:

```
marketAlignment         CACHE                 freeToFix: true   providerCallJustified: false
delta/gamma/IV          FETCHED_OPTION_CHAIN  freeToFix: true   providerCallJustified: false
optionVolume            FETCHED_OPTION_CHAIN  freeToFix: true   providerCallJustified: false
bid/ask/quoteTimestamp  LIVE_SCANNER_PAYLOAD  "already satisfied from a free source"
```

Every remaining unsupplied field is "already fetched and then dropped. Fix the
mapping; zero additional calls." No new provider request is needed for any of
them. That is the wiring instruction for the next session, with its cost already
proven to be zero.

### The held drafts had no reader (Priorities 1–3, done and verified)

`a29688b` stopped the flood by rerouting old events and writing
`HELD_FOR_HISTORICAL_DIGEST`. Production confirmed that half working:
`eventsAwaitingRecovery: 0`, `SENT` flat at 1083. But the reason code was named
for a digest **that did not exist** — 30 drafts held, nothing reading them. A
terminal status pointing at an absent consumer is a silent queue loss.

`lib/content/historical-digest.ts` (pure) + `historical-digest-runtime.ts` (db)
collapse held drafts to one summary per canonical outcome. Verified against the
real 30 rows in production at `c5b5e41`:

| | value |
|---|---|
| held digest rows | 30 |
| unique canonical outcomes | **5** |
| digest-ready | 3 |
| excluded ALREADY_DELIVERED_INDIVIDUALLY | 2 |
| duplicate variants collapsed | 22 |
| Discord messages prevented | 24 |
| verified winners / losers / unresolved | 2 / 1 / 0 |
| verified root causes | 1 (`PROFIT_GIVEN_BACK`) |
| contradictory outcomes | 0 |
| `SENT` before / after | 1083 / **1083** |
| total drafts before / after | 3784 / **3784** |

Grouping keys on `outcomeFingerprint` and deliberately EXCLUDES the close event
id — `EXIT_HIT` and `OPPORTUNITY_CLOSED` are two event ids for one closure, so
keying on it would preserve the duplication the collapse exists to remove.

Discord delivery is OFF by default. Generation is in-app and always available;
delivery needs `CONTENT_DIGEST_DISCORD_ENABLED` or a manual
`POST /api/content-digest {"deliver":true}`, and the scheduled path yields
entirely whenever the live scan delivered in the same tick.

Diagnostics: `GET /api/diagnostics/historical-digest` (read-only, zero provider
calls). Owner surface: `GET /api/content-digest`, `?preview=1` for the next
digest without persisting.

### Two defects found by verifying production, not by tests

**`d0e30b6` — an undelivered digest buried the outcomes it never reported.**
The scheduled path generated `dig_xhf3b4` over 3 outcomes and correctly refused to
send it. The next candidate then excluded all three as `ALREADY_IN_PRIOR_DIGEST`.
A digest the owner never received was suppressing the one they would have — the
same silent loss, one layer up. Coverage is now defined as DELIVERY, and the
digest id derives from its outcome set rather than the clock so a three-minute job
upserts one pending row instead of accumulating hundreds.

**`c5b5e41` — "cLOSed" turned two winners into losers.**
The first real digest reported two outcomes as `LOSER` with `returnPercent` of
**+45.1** and **+48.8**. The data was right and the classifier was wrong: draft
`cd_jpfsgi` is a CLOSED_WINNER that closed +45.1% ($2.77 → $4.02), and its
`result_type` is `REALIZED_CLOSED_RETURN` — the name of the MEASUREMENT, not a
verdict. A substring test for `LOS` matched the LOS inside `cLOSed`.

Win/loss now comes from the content CATEGORY corroborated by the recorded return.
When they disagree neither is asserted: UNRESOLVED plus a data-quality warning.
Winners are also excluded from the failure-cause counters — they had inflated
"insufficient evidence" to 2 and printed "No verified root cause has been
established" directly underneath a +45% close.

### Not done

Priorities 4 (cohort VERSION tagging — today's data is clean post-fix RTH, but
`LEGACY_PRE_FIX` / `POST_FIX_RTH` interpretation states are not persisted), 6–7
(future-timestamp lineage; `INVALID_FUTURE_*` did NOT appear in today's blockers,
so live samples were not available to trace), 8–9 (wire the free fields — lineage
above says zero provider cost), 10 (provider pressure), 11 (Quant/Paper
reconciliation), 12 (page audit), 13 (pipeline audit), 14 (Ask OptiScan), 15
(Create Claude Task), 16 (UI redesign), 17 (smoke test).

### Exact resume point

1. Re-read `/api/research/asymmetry/timing` at the CLOSE of 2026-08-06 for the
   full-session post-fix RTH funnel, and capture the notified case's complete
   lineage (case id, OCC, first-eligible / capture / decision / quote timestamps,
   entry ask, spread, Discord message id).
2. Resolve the `notified: 1` vs `notifiedCaptures: 0` counter disagreement.
3. Wire `marketAlignment` from cache and `delta` / `gamma` / `IV` / `optionVolume`
   from the already-fetched chain. `fieldLineage` proves all are zero-cost.
4. Future timestamps: `INVALID_FUTURE_*` did not fire today. Collect real samples
   before assuming a source; do not chase it from the old cumulative counts.

---

## Packet update — 2026-08-06 the Recaps flood, inverted failure causes, null-to-zero

### Verified state

- Local HEAD = `origin/main` = production. Verified from git and `/api/healthz`, not assumed.
- Commits this session: `a29688b` (flood + grounding), `a757342` (null preservation),
  plus the drafts-API contract columns.
- `/api/healthz`: `ok: true`, db writable, `schemaMissing: []`, lifecycle active.
- Full suite 3539/3539 twice. `tsc --noEmit` clean. `next build` exit 0.
- `PAPER_0DTE_RESEARCH_ENABLED` remains unset.

### The owner-reported defect, measured

Read from production at `cb1fc98` via `/api/diagnostics/content-delivery` and
`/api/content-drafts` (new script: `scripts/audit-historical-content.mjs`):

- 449 undelivered drafts across **148 events**, draining ONE event per scan
- 63 canonical outcomes had already produced **265 delivered drafts**
- `oc_4pu17q` (IWM): 9 drafts, **9 consecutive Discord snowflakes**, one closure
- `oc_kmzobp` (NVDA): CLOSED_LOSER 02:38:30Z then WHY_THIS_FAILED 02:44:48Z

Three independent multipliers, all fixed in `a29688b`:

1. `EXIT_HIT` and `OPPORTUNITY_CLOSED` BOTH map to `CLOSED_LOSER` in
   `eligibleCategories` — two content events per closure.
2. `OPPORTUNITY_REPORT_CARD_READY` adds `WHY_THIS_FAILED` — a third.
3. Three template variants per event; historically each its own message.

New `lib/content/outcome-delivery-lane.ts` adds the lane
(LIVE_CURRENT / RECENT_RECOVERY / HISTORICAL_DIGEST / ARCHIVE_ONLY) derived from
the AGE OF THE EVENT, and the canonical-outcome fingerprint. Dedup keys on the
opportunity CASE, not the event. Only the recommended variant goes to Discord.

**Live outranks backlog in both directions**, which needed two changes, not one:
the PENDING scan now orders live-window events first (plain `occurred_at_ms ASC`
queued a 30-second-old closure behind every older event — found by a regression
test, not by reading), and the recovery sweep yields entirely on any run that
already delivered live content.

Rerouting an old event costs no Discord post, so the sweep examines up to 50 per
run instead of one. Otherwise 148 events take 148 scans just to stop dripping.

### Production verification of the fix (on `a29688b`)

| | before `cb1fc98` | after `a29688b` |
|---|---|---|
| drafts awaiting delivery | 449 | **124** |
| events awaiting recovery | 148 | **41** |
| scans to drain | 148 | **41** |
| messages sent in the sweep | 1/scan | **0** (50 examined, all rerouted) |

`SENT` stayed at 1083 — nothing new was posted. New reason code
`HELD_FOR_HISTORICAL_DIGEST` appears with 17. No draft, evidence id, timestamp
or delivery record was deleted or rewritten.

### The failure explanations were INVERTED, not merely generic

`varsForEventRow` filled `reason` from `original_thesis_json` — the ENTRY thesis —
and the WHY_THIS_FAILED templates printed it as the cause. Draft `cd_ew04f1`,
event `ce_1k0xr40`:

```
originalThesis: ["Lower high continuation with bearish structure intact."]
strategyKey:    "lower_high_continuation"
optionType:     PUT        returnPercent:    -48.5714
direction:      bearish    maxReturnPercent:  55.5556

draft_text: "Why $AAPL failed:
             - Lower high continuation with bearish structure intact.
             Closed -48.6%. Lessons > hype."
```

A bearish structure staying intact is the condition under which that PUT WINS.
The sibling template read "the setup broke when Lower high continuation with
bearish structure intact.." — the setup broke by holding.

The row also carried the REAL cause and discarded it: up 55.6% at its best
recorded mark, closed -48.6%. That is PROFIT_GIVEN_BACK, arithmetic on two
persisted marks.

`lib/content/failure-cause.ts` derives only what evidence establishes
(PROFIT_GIVEN_BACK, THESIS_FAILED_IMMEDIATELY), says "a verified root cause has
not yet been established" otherwise, and `validateFailureExplanation` rejects
both the contradictory and the bare-condition forms. Direction quality, entry
timing, spread, liquidity and contract selection are deliberately NOT derived —
that evidence lives in the alert and asymmetry records, not on this row, and
inventing them from a strategy name is the defect being replaced.

### Null is not zero (`a757342`)

`parseOptionsSnapshot` had `volume: numOrNull(day.volume) ?? 0` and
`openInterest: numOrNull(r.open_interest) ?? 0`. Absence now survives. A real
reported 0 still reads as 0 — both directions are pinned by tests.

The gates were already conservative with null, so nothing that passed now fails.
What changed is what they SAY: "open interest unavailable — cannot clear the 500
minimum" instead of "open interest 0 < 500", a measurement never taken.

Three adjacent defects surfaced while proving it:

- `numOrNull("n/a")` returned **NaN**, not null. `?? 0` does not catch NaN, so it
  flowed through — JSON `null`, the string "NaN", and false against every
  threshold. Three wrong answers from one value.
- `SelectionRejection` discarded per-gate messages, keeping only counts — exactly
  the granularity at which "unavailable" and "zero" are indistinguishable. Added
  `gateFailures`.
- `deriveFailureCause` initially made the SAME mistake: `Number(null) === 0` made
  an unrecorded peak read as THESIS_FAILED_IMMEDIATELY. Caught by its own test.

### Drafts API now exposes the contract (unblocks contract verification)

`listContentDraftsOnDb` selected only `symbol`, `event_type`, `occurred_at_ms` —
so the API could not answer "does the displayed contract match the persisted
one?", the exact question a realized-return claim must survive. **This is why the
NFLX 2026-08-07 $71 PUT could not be verified this session.** Contract columns are
now selected, schema-aware: referencing a column SQLite lacks fails the WHOLE
statement, and both readers swallow errors and return empty — so naming them
unconditionally blanked the drafts list on a legacy schema rather than degrading.
Caught by the census suite; pinned by a legacy-schema regression test.

### High-Asymmetry: what the data does and does NOT show

From `/api/research/asymmetry/timing` at `a757342`:

- decisions 1056, **notified 0**, distinctCases 502
- byAction: OWNER_WATCH 513 · REJECTED 393 · TOO_LATE 91 · PAPER_ONLY 59
- byTiming: ON_TIME 947 · ENTRY_TOO_LATE 86 · INSUFFICIENT_TIMING_EVIDENCE 16 ·
  STALE_EVIDENCE 5 · PREMIUM_CHASE 2
- top blocker still `CONFIRMING_EVIDENCE_INCOMPLETE_9` at **111** (was 91)
- `INVALID_FUTURE_OPTION_QUOTE_TIMESTAMP` 9 · `INVALID_FUTURE_UNDERLYING_...` 7

**The rise from 91 to 111 does NOT prove `a6c451c` failed, and must not be
reported as though it did.** These are session-cumulative counts that include
pre-fix decisions. `recentDecisions` holds exactly ONE row, at 13:31Z, reason
`WEAK_OPEN_INTEREST_87` — the market has been closed since. There is no post-fix
RTH sample. The question is open and can only be settled by measuring during a
live session.

The future-timestamp GUARDS are working as designed — they refuse those 16 cases.
What is unproven is why the timestamps are future in the first place.
`live-quote.ts` reads `c.providerTimestamp`, which IS normalized by
`providerTimestampMs` at the polygon boundary, so the raw-value path claimed in
the previous packet was not confirmed this session.

### Not done

Priorities 3 (contract/OCC verification — now unblocked), 6 (digest BUILDER;
the routing and reason codes exist, the digest message itself does not), 7
(future-timestamp root cause), 9 (marketAlignment wiring), 10 (RTH re-measure),
11 (Quant/Paper reconciliation), 12 (page audit), 13 (pipeline audit), 14 (Ask
OptiScan), 15 (Create Claude Task), 16 (UI redesign), 17 (smoke test).

### Exact resume point

1. Re-run `railway run -- node scripts/audit-historical-content.mjs` now that the
   drafts API returns strike/expiration/option_type, and verify the displayed
   contracts — starting with the NFLX 2026-08-07 $71 PUT — against the persisted
   exact OCC on `options_alerts.option_symbol`.
2. Build the HISTORICAL LEARNING DIGEST reader over
   `discord_delivery_reason='HELD_FOR_HISTORICAL_DIGEST'`. The routing is live and
   rows are accumulating; nothing consumes them yet.
3. Re-measure the High-Asymmetry funnel during the next RTH session and settle
   whether `CONFIRMING_EVIDENCE_INCOMPLETE_9` still fires post-`a6c451c`.
4. Only then chase the future-timestamp root cause, with live samples in hand.

---

## Packet update — 2026-08-05 High-Asymmetry evidence arithmetic + Quant Lab false failure

### Verified state

- Local HEAD = `origin/main` = production: `a37e81b`
- Commits this session: `ecb5d36`, `a6c451c`, `a37e81b` (+ `2b2be45` baseline)
- `/api/healthz`: `ok: true`, db writable, `schemaMissing: []`, lifecycle active
- `PAPER_0DTE_RESEARCH_ENABLED` remains unset

### Root cause: why High-Asymmetry has never alerted

Not thresholds — **arithmetic**. `initialStateFor` grades on the COUNT of missing-evidence
labels (0 → HIGH_ASYMMETRY, ≤3 → CONFIRMING) and the gate refuses above
`maxMissingEvidenceForConfirming` (2). But `lib/research/options/loop.ts` passes a hardcoded
`null` for seven capture inputs, firing six labels on **every** candidate regardless of setup
quality:

`NO_CATALYST`, `NO_MARKET_ALIGNMENT`, `NO_SECTOR_ALIGNMENT`, `NO_VOLUME_ACCELERATION`,
`NO_COMPRESSION_STATE`, `NO_LEVEL_DISTANCE`

With a floor of six, ≤3 and 0 are unreachable. Production confirms it exactly: across 200
candidates, **CONFIRMING 0 and HIGH_ASYMMETRY 0** — every case sat at EARLY_ASYMMETRY (143) or
INSUFFICIENT_EVIDENCE (49). The observed `CONFIRMING_EVIDENCE_INCOMPLETE_9` is six structural
labels plus ~three genuine absences. No case has ever reached a notifiable state.

### Fix (a6c451c) — grade on evidence that was sought

`lib/research/asymmetry/evidence-requirements.ts` classifies every label by whether the capture
path supplies it; grading and the score's completeness term use the blocking subset.

**This is not a relaxation.** Every hard blocker in live-intake (exact OCC, contract identity,
executable quote, spread, liquidity) and every gate check (spread, OI, contract volume, premium
chase, entry timing, session authority, quote freshness, future-timestamp guards) is untouched.
Unsupplied labels are persisted separately so the wiring debt stays visible, and an unrecognised
label counts as blocking so a new one must be classified deliberately. As each field is wired
into `loop.ts`, moving it to `supplied` makes the gate **stricter** again.

Also carried `gamma` through `mapOptionContracts` — live-deps mapped `iv` and `delta` but dropped
gamma entirely, so `NO_GREEKS` fired even when the snapshot carried it. Absent greeks stay null.

### Quant Lab root cause (a37e81b) — FRONTEND_RESPONSE_MISMATCH, not a backend fault

The API is healthy. Read authenticated in production, `/api/research/options/quant-lab` returns
HTTP 200, `ok:true`, **sampleSize 102**, full metrics and per-strategy breakdowns.

The page mounts with `report=null` and `loadError=null`, and `decideQuantZeroState` mapped that to
`LOAD_FAILED`. The wording proves it: the message shown is the `report == null` branch, not the
`loadError` branch — nothing had failed because no request had finished. Every visit accused a
working backend before the first fetch resolved.

Added a `LOADING` kind. It still refuses metrics and a sample size and still says UNKNOWN rather
than zero; a real `loadError` still outranks it, and a settled-but-empty response is still
`LOAD_FAILED`.

### Test-suite fragility fixed (ecb5d36, a37e81b)

`analog-seed-worker`'s "API stays responsive" test asserted an absolute `maxLag < 250ms`. That
measures host load as much as worker behaviour: it passed alone, passed serially (3503/3503), and
failed only as `node --test` scheduled more files alongside it — so **adding any test file looked
like a regression**. Verified against a stashed baseline before changing it. Now asserts p95
against a host-relative budget with a 3s absolute ceiling. 3510/3510 on three consecutive runs.

### Not done

Priorities 3 (future timestamps), 4 (re-measure), 5 (provider pressure), 7 (Quant/Paper
reconciliation), 8 (full page/pipeline audit), 9 (Ask OptiScan), 10 (Create Claude Task),
11 (UI redesign), 12 (smoke test) were not started.

The 13 future-dated timestamps remain unfixed. `lib/research/asymmetry/*` never imports
`providerTimestampMs`, though `lib/polygon-provider.js` normalizes at its boundary — so a
non-provider path is supplying raw values. Note `polygon-provider.js` also does
`openInterest: numOrNull(r.open_interest) ?? 0`, a null→zero conversion worth auditing.

### Exact resume point

Re-measure the High-Asymmetry funnel during the next RTH session and confirm whether cases now
reach CONFIRMING/HIGH_ASYMMETRY and whether any genuinely qualified case alerts — the fix removes
the arithmetic blocker but does not by itself prove a good setup exists. Then Priority 3
(future timestamps), then wire `marketAlignment` from `lib/research/context/market-context.ts`
(zero provider cost) to shrink the unsupplied set.

---

## Packet update — 2026-08-05 boot safety net proven, after-hours content fixed, production audit

### Verified state

- Local HEAD = `origin/main` = production: `00861fb`
- Prior SHAs this session: `1808cfd` (boot guard), `b3a630e` (runtime fix baseline)
- `/api/healthz`: `ok: true`, db writable, `schemaMissing: []`, lifecycle active
- Production logs on `1808cfd`: boot ran **exactly once**, 0 `Cannot find module`, 0 `server boot skipped`, 0 seed errors
- `PAPER_0DTE_RESEARCH_ENABLED` remains unset

### CORRECTION to the previous packet entry

The previous entry claimed the server-boot defect meant a fresh container "could sit with no
scanner, scheduler, paper engine or graders until a human opened the dashboard," and offered that
as a candidate cause of late alerts. **That was wrong.**

`/api/healthz` has called `ensureServerBoot()` — deferred via `setImmediate` — since `e9d2cc8`
(2026-07-12), which is before and throughout the entire period instrumentation was broken. The
Railway liveness probe was starting the background runtime all along. That is why the service kept
working while instrumentation silently failed.

The real impact of the boot defect was therefore **much smaller**: runtime start moved from
process boot to the first healthz probe — seconds, not hours. It is NOT a plausible cause of
chronically late alerts. The earlier claim was made by grepping only for `deferServerBoot` and
missing the `ensureServerBoot` call in the same file.

### Priority 1 — healthcheck boot safety net

Already present; it needed proving, not adding. Three paths race for boot (instrumentation,
healthz every 60s, 34 routes via `deferServerBoot`) and webpack inlines server-boot into two
server chunks, so correctness rests entirely on the guard being process-level.

Extracted it to `lib/boot-guard.ts` with `claimBootStart` / `claimBootSchedule` (test-and-set in
one step, injectable scope). Previously it was a module-scoped object literal inside `server-boot`,
which no test could import without also importing the `require("@/lib/...")` graph and really
starting the scanner. `tests/boot-guard-idempotency.test.mjs` now proves: only the first caller
boots, 100 simulated probes start nothing, two module copies share one state object via the
`Symbol.for` registry, and healthz keeps its deferred / try-caught / always-200 shape.

### Priority 2 — the 87 SUPPRESSED_STALE_RESEARCH, reconciled

They are **non-performance (SAFE_CATEGORIES) drafts archived by `1884fd8`'s delivery policy**.
That policy collapsed two different conditions into one `historical` flag: the draft being stale
(cross-session, expired contract, past its delivery window) and the market simply being closed.

This over-suppressed: it archived `NEXT_SESSION_WATCH`, the one category whose entire purpose is
to be read after the close, plus `EDUCATIONAL_BREAKDOWN` and `MARKET_OBSERVATION`. None of them
claims a current executable quote.

**Answer to "should a valid next-session watch have been created instead": yes — and it was
created, then wrongly archived.** Fixed in `00861fb`: a closed session no longer makes those three
categories stale, but genuine staleness still archives them (including a missing timestamp, since
freshness that cannot be proven must not be delivered). They now deliver through a
`DELIVER_NEXT_SESSION_WATCH` lane labelled `NEXT-SESSION WATCH - NON-ACTIONABLE`. Live-looking
research (`HIGH_CONVICTION` etc.) is unchanged — the close still suppresses it.

No historical evidence was deleted or rewritten; the fix is prospective.

### Priority 5 — High-Asymmetry production verification (2026-08-05 session)

From `api/research/asymmetry/timing`, read token-safely:

- decisions: **738 suppressed, 0 notified**
- `byAction`: OWNER_WATCH 358 · REJECTED 256 · **TOO_LATE 77** · **PAPER_ONLY 47**
- `byTiming`: ON_TIME 646 · ENTRY_TOO_LATE 72 · INSUFFICIENT_TIMING_EVIDENCE 13 · STALE_EVIDENCE 5 · PREMIUM_CHASE 2
- `immediateAlerts`: **0** · ownerWatches 1 · digestCases 0

Confirms prospectively: old captures do become TOO_LATE, premium-expanded cases do become
PAPER_ONLY, and **none of them pings Discord** (0 immediate alerts).

**The 40-message/session cap is not the binding constraint — actual immediate alerts are 0.**
Lowering the ceiling would change nothing. Do not tune it; tune what is blocking.

### Priority 3 — latency could NOT be measured, and why

Latency distributions are **n = 1**. `captureToNotifyMsBucket` has a single `<60000` entry.
There is essentially no delivery-latency data because almost nothing is being delivered.

**The reframed diagnosis: for High-Asymmetry the alerts are not late, they are absent.** Top
blockers today:

- `CONFIRMING_EVIDENCE_INCOMPLETE_9` — **91** (9 missing evidence fields against a threshold of 2)
- `UNUSABLE_SPREAD_*` — ~54 across many spread values
- `STATE_NOT_NOTIFIABLE_PREMIUM_CHASE` — 45
- `ENTRY_TOO_LATE_*` — ~26
- `INVALID_FUTURE_OPTION_QUOTE_TIMESTAMP` 6 + `INVALID_FUTURE_UNDERLYING_QUOTE_TIMESTAMP` 7

No pre-fix vs post-fix latency comparison was possible, and none is claimed. Causation is not
asserted where timestamps are missing.

### Two concrete leads for the next session

1. **The largest blocker is missing evidence the provider already returns.** The endpoint's own
   `fieldLineage` reports `derivationGaps: ["trigger", "invalidation"]` and
   `freeWins: ["marketAlignment", "impliedVolatility", "delta", "gamma", "optionVolume"]`, and
   `massiveCapability.blockers` states greeks/IV are "fetched and then dropped before persistence."
   So `CONFIRMING_EVIDENCE_INCOMPLETE_9` — 91 suppressions, the single biggest cause of nothing
   alerting — is substantially self-inflicted. Persisting the free wins is the highest-value fix.
2. **13 future-dated quote timestamps.** `lib/research/asymmetry/*` never imports
   `providerTimestampMs`, the normalizer written for exactly this nanosecond-vs-millisecond bug.
   `lib/polygon-provider.js` normalizes at its boundary, so some other path is supplying raw
   timestamps.

### Not done

Priorities 4, 6, 7, 8, 9 were not started: delayed-alert re-evaluation hardening, High-Asymmetry
provider-pressure reduction, Ask OptiScan, Create Claude Task, and the Options page redesign.

### Exact resume point

Persist the five `freeWins` evidence fields so `CONFIRMING_EVIDENCE_INCOMPLETE` stops being the
dominant suppression, then re-measure whether anything alerts and whether latency data finally
exists. Then Ask OptiScan: extend the LIVE_AND_CONNECTED advisory-chat stack at `/ask-optiscan`
and retire `app/copilot/page.tsx`. Do not build a second chatbot.

---

## Packet update — 2026-08-05 deployed-image module resolution fixed

### Verified state

- Local HEAD = `origin/main` = production: `a10ed2bb0dbe2231464278fa804cf4eb6af36fae` (`a10ed2b`)
- `/api/healthz`: `ok: true`, db writable, `schemaMissing: []`, lifecycle enabled/ready/active
- `/api/health`: `ok: true`, provider `polygon`, loop running (`lastTickAgeMs` 500), session `regular`, `quotaExceeded: false`
- `PAPER_0DTE_RESEARCH_ENABLED` remains unset

### Root cause — one defect, two symptoms

The Docker runner copies **only** `.next/standalone`. Anything the bundler does not trace, and
that `outputFileTracingIncludes` does not literally name, is absent at runtime. Two entry points
are invisible to the bundler, and both were broken while every build stayed green.

**`outputFileTracingIncludes` is a literal file list.** Next copies what the globs match; it does
NOT parse those files and follow their imports. That is why `./lib/data-freshness.ts`,
`./lib/timestamps.ts` and `./lib/trading-session.ts` were already enumerated by hand — they are
`polygon-provider`'s dependencies. When `lib/provider-timestamp.js` was added (a4a7f31,
2026-07-31) as a new dependency of the already-listed `lib/polygon-provider.js`, nothing pulled
it in.

`provider-timestamp.js` was only the FIRST missing file. The worker's real closure also needed
`provider-accounting-sink.ts`, `provider-accounting.ts`, `provider-budget.ts` and
`provider-context.ts` — all absent. Naming one file would have moved the crash, not fixed it.

**Server boot** resolved `lib/server-boot.ts` through a runtime path marked so the bundler would
skip it. Untraceable, so the `.ts` never reached the image. Loading it as raw `.ts` could not have
worked anyway: `server-boot` calls `require("@/lib/...")`, which only the bundler resolves.
Broken since standalone deploys began; `595973c` (2026-07-22, *"restore autonomous boot"*)
changed the path but kept it untraceable, so that fix never took effect.

### Fix

- `next.config.mjs`: added `./lib/provider-*.ts` and `./lib/provider-*.js` to the seed-route
  includes. Targeted, not a whole-repo copy.
- `instrumentation.ts`: `await import("@/lib/server-boot")` — a literal specifier webpack traces
  deterministically.
- `lib/server-boot.ts`: webpack inlines the module into more than one server chunk (verified:
  `chunks/7851.js` and `chunks/9478.js`), so module-scoped `started`/`bootScheduled` could exist
  twice in one process and start the scanner, scheduler, paper engine and graders **twice**.
  Moved that state behind `Symbol.for("optiscan.serverBoot")` on `globalThis`, which is shared
  across duplicate module instances. Production logs confirm boot ran exactly once.

### Regression coverage

`scripts/runtime-module-closure.mjs` recomputes the real import closure of both runtime entry
points from source. `tests/runtime-artifact-modules.test.mjs` (7 tests) fails if any file in that
closure is not covered by the tracing globs, and — when a build is present — asserts the built
artifact actually contains them. Verified by importing `worker/seed-worker.ts` and
`lib/polygon-provider.js` from **inside** `.next/standalone`; both load.

### Production log verification (not healthz alone)

Across the full container lifetime from volume mount:

- `Cannot find module` — **0**
- `server boot skipped` — **0**
- `[optiscan] scanner + alert tracker started at process boot` — **1** (present, and not doubled)
- scanner loop start — 1
- seed-worker `error` / `worker_exit` / `worker_respawn` — **0**

Note on reading seed silence: `slog` only prints `worker_start`/`worker_poll` when `SEED_LOG=1`,
but `error`, `worker_exit` and `worker_respawn` ALWAYS print. Their absence is positive evidence
the crashloop is gone. To positively confirm the worker is polling, set `SEED_LOG=1` or read the
authenticated seed status endpoint.

### Historical impact

- **Seed worker** (broken since 2026-07-31): scope is Analog Engine historical-replay seeding
  only. It does not touch live candidate discovery, direction, contract selection, lifecycle,
  grading, or alert timing — those run in the web process. Impact is bounded to replay/research
  seeding.
- **Server boot** (broken far longer, since standalone deploys began): the background runtime did
  NOT start at process boot. It started only when something hit `/api/health` (which calls
  `ensureServerBoot`) or one of the 34 routes calling `deferServerBoot`. The Railway healthcheck
  hits `/api/healthz`, which does **neither**. So after every deploy or restart, a container could
  sit with no scanner, scheduler, paper engine or graders until a human opened the dashboard.
  This is a plausible contributor to the "alerts arrive late" complaint and should be re-examined
  once latency data is available.

No backfill has been performed. Missed seed runs and the exact per-deploy boot delay are not
determinable from logs alone and need the authenticated seed-run tables.

### Diagnostics authentication — solved without exposing the token

Owner token env var: `SCAN_API_TOKEN`, sent as the `x-scan-token` header (`lib/auth.ts`).

`scripts/prod-diag-fetch.mjs` reads it from the environment only — never from argv, never printed,
and it redacts the value from any response body. Run it with the production environment injected:

```
railway run -- node scripts/prod-diag-fetch.mjs api/diagnostics/content-delivery
```

(Use paths WITHOUT a leading slash under Git Bash, which rewrites `/api/...` into a Windows path.)

Verified working — HTTP 200. First real finding from it: `SUPPRESSED_STALE_RESEARCH: 87`,
confirming the previous concern's after-hours archiving is live in production. Also visible:
1027 SENT, 1708 SUPPRESSED, 0 failed, 968 awaiting delivery across 318 events.

### Exact resume point

Run the Priority 3 audits through `railway run -- node scripts/prod-diag-fetch.mjs`: the
after-hours options-message audit, the end-to-end latency trace, the High-Asymmetry TOO_LATE /
PAPER_ONLY production verification, and queue/Discord delay attribution. Then Priority 4 — rename
and extend the existing LIVE_AND_CONNECTED advisory-chat stack into Ask OptiScan at
`/ask-optiscan`, and retire `app/copilot/page.tsx`. Do not build a second chatbot.

---

## Packet update — 2026-08-05 instrument session authority shipped (Codex handoff completed)

### Verified state

- Local HEAD = `origin/main` = production: `1884fd847469691ca95860171a705796bf0f8af9` (`1884fd8`)
- Previous production SHA: `a577f386c3433e1853d752cbeec6da9eeb55b96a` (`a577f38`)
- Production `/api/healthz`: `ok: true`, db writable, `schemaMissing: []`, lifecycle enabled/ready/active
- Production `/api/health`: `ok: true`, provider `polygon`, key present, loop running, session `regular`, `quotaExceeded: false`
- `PAPER_0DTE_RESEARCH_ENABLED` remains unset
- Railway CLI authenticated this session; deployment verified by SHA, not assumed

### Clock correction

The handoff prompt assumed the options session was closed (2026-08-04 ~16:31 PT). Production
clock at resume was **2026-08-05T15:42Z = 11:42 ET, session `regular`** — the market was OPEN.
After-hours behavior was therefore proven by deterministic injected-clock tests, NOT by live
after-hours observation. No fresh after-hours RTH claim is made.

### Codex partial work recovered

Working tree was recovered intact; nothing was reset, reverted, or discarded. Two Codex commits
(`c6eef4b`, `a577f38`) were already pushed past the reported `a895030` baseline. 21 tracked
modified files plus 2 new lib modules and 3 new test files were preserved.

### Helper extraction (the one item Codex could not finish)

`tests/option-milestone-evidence.test.mjs` could not compile: it imported
`verifiedOptionMilestoneSnapshots` from `lib/alert-tracker.ts`, which pulls `@/lib/*` path
aliases that `node --experimental-strip-types` cannot resolve.

Extracted the real rule into **`lib/option-milestone-evidence.ts`** — dependency-light, no DB,
no provider, injectable `nowMs` and `maxQuoteAgeMs`. `alert-tracker.ts` imports and re-exports
it, so production behavior is unchanged and the test exercises production code rather than a
copy.

### Session authority

`lib/instrument-session-authority.ts` is the single deterministic classifier. States:
`UNDERLYING_RTH_OPEN` / `UNDERLYING_EXTENDED_HOURS` / `UNDERLYING_CLOSED`,
`OPTIONS_REGULAR_OPEN` / `OPTIONS_EXTENDED_SESSION_OPEN` / `OPTIONS_CLOSED`, and
`SESSION_UNKNOWN`, which fails closed to non-actionable.

Instrument classes: `EQUITY_OPTION` (16:00 ET), `ETF_415_OPTION` (explicit Nasdaq 4:15 roster),
`INDEX_GTH_OPTION` (Cboe curb + GTH; PM-settled 0DTE fails closed at the underlying close),
`UNKNOWN`. `optionsSessionAllowsStrategy` keeps session-open and strategy-eligible separate —
an open extended session does not make a regular-session strategy actionable.

### After-hours actionability and delivery re-evaluation

Delivery now revalidates at the network boundary instead of replaying the capture-time decision:
`notifyNewAlert`, `confirmAndSendPending`, `deliverCalloutDiscord`, `retryDiscordDelivery`, and
the asymmetry transition runner all re-check session + quote freshness before sending.
`discord_deliveries.delivery_context_json` persists the context so a queued draft is re-checked,
never trusted. Stale owner research archives as `SUPPRESSED_STALE_RESEARCH`; verified performance
content delivers labelled `HISTORICAL REPORT CARD — NON-ACTIONABLE`. The tracker no longer marks
or finalizes option outcomes once the applicable options session is closed, so after-hours
underlying movement cannot become option performance.

Notify journal → `ASYM_NOTIFY_JOURNAL_V3` (six delivery-outcome columns added through
`addColumnIfMissing`; migration is repeat-safe and migrated cleanly in production).

### Validation

- `npm test`: **3470 pass / 0 fail**, run twice
- `npx tsc --noEmit --incremental false`: clean
- `npm run build`: clean
- `git diff --check`: clean
- One pre-existing test (`asymmetry-notify-journal`) pinned the journal literal at V2 and was
  updated to V3 — that assertion is the intentional schema tripwire, not a behavior change.

### Pre-existing production defects found (NOT caused by this deploy)

Both files below are byte-identical between `a577f38` and `1884fd8`; the diff is empty.

1. **Seed worker disabled.** `Cannot find module '/app/lib/provider-timestamp.js' imported from
   /app/lib/polygon-provider.js` → 5 failures → `seed worker disabled`. The file is tracked, is
   not in `.dockerignore`, and was added 2026-07-31 (82 commits back).
2. **Server boot skipped.** `Cannot find module '/app/lib/server-boot.ts' imported from
   /app/.next/server/instrumentation.js`. The scheduler loop still reports running via a
   different path (`lastTickAgeMs` ~2s), but the instrumentation boot path is dead.

Both look like one root cause: the deployed image cannot resolve `lib/*` source modules from
traced `.next` output. **This is the recommended next concern** — it plausibly affects analog
seeding and boot-time wiring, and it must be understood before any latency numbers from
production are trusted.

### Not done (scope honestly stated)

Priorities 5, 6, 9, 11, 12 were not started. Owner-token-gated diagnostics
(`/api/diagnostics/*`) returned `unauthorized`, so the after-hours message audit and the
end-to-end latency percentile trace could not be run against production data this session.

Priority 10 (AI backend audit) was partially completed by inspection only:
`app/api/ai/advisory-chat` + `lib/ai/advisory-chat{,-evidence,-store,-sources}.ts` +
`components/AdvisoryChat.tsx` + `app/ai/page.tsx` are wired end to end →
**LIVE_AND_CONNECTED** (~1,840 lines). It already emits structured
`FACT / INFERENCE / HYPOTHESIS / RECOMMENDATION / DATA_QUALITY_WARNING`. Ask OptiScan should
**extend this stack and its taxonomy**, not add a second chatbot. `app/copilot/page.tsx` still
exists and must be renamed/retired under the no-"Copilot" naming rule.

### Exact resume point

Fix the deployed-image module resolution for `lib/provider-timestamp.js` and `lib/server-boot.ts`
(seed worker + instrumentation boot), then obtain the owner access token to run the Priority 5
after-hours message audit and the Priority 6 latency trace against real production rows.

---

## Packet update — 2026-08-04 RTH live validation and B7 attribution patch

### Verified state

- Local HEAD: `4afd20c10b4fbc1ba414c71a05cbd42a1b3c144b`
- `origin/main`: `4afd20c10b4fbc1ba414c71a05cbd42a1b3c144b`
- Production `/api/healthz`: serving `4afd20c10b4fbc1ba414c71a05cbd42a1b3c144b`
- Production `/api/health`: `ok: true`, provider `polygon`, key present, DB writable, loop running, session `regular`, quota not globally exceeded at sample time
- Railway backboard API: still `Not Authorized`; Railway deployment metadata is not readable until the owner re-authenticates Railway
- Existing Graphify output was stale before this work: built from `7ab7c4c`, while code/production were already `4afd20c`

### Claude/later work verified, with corrections

- Legacy DB upgrade safety tests remain present in the suite and the full suite passed.
- Contract-funnel symbol scoping is fixed: impossible `symbol=ZZZZ` returns no scoped evidence, not the global funnel.
- The ambiguous chain `[]` result has already been replaced locally and in production by structured outcomes in `fetchOptionChain` / `ChainFetchOutcome`.
- Production is no longer serving `7ab7c4c`; it is serving `4afd20c`.
- SPY calls are no longer uniformly dead at `NO_CONTRACT_IN_DTE_RANGE`: current production scoped SPY CALL evidence shows selected call contracts as well as remaining DTE failures.

### Structured chain result and SPY/QQQ/NVDA live evidence

Current production structured outcomes distinguish successful empties, provider failures, timeouts, missing configuration, quota/budget refusals, and page truncation. Historical rows with old terminal reasons remain historical; no cause was invented for them.

RTH samples from `/api/diagnostics/contract-funnel`:

- SPY CALL: total 51 rows; terminal reasons `NO_CONTRACT_IN_DTE_RANGE` 43, `CONTRACT_SELECTED` 6, `CHAIN_TRUNCATION_SUSPECTED` 2. Recent window observed 4 rows and raised `PAGE_LIMIT_REPEATED`.
- QQQ CALL: total 46 rows; terminal reasons `NO_CONTRACT_IN_DTE_RANGE` 35, `CONTRACT_SELECTED` 9, `CHAIN_TRUNCATION_SUSPECTED` 1, `PROVIDER_ERROR` 1. Recent window observed 5 rows and raised `PAGE_LIMIT_REPEATED`.
- NVDA CALL: total 14 rows; terminal reason `CONTRACT_SELECTED` 14. Recent window observed 1 row and raised no discovery alert.

Root-cause correction: for many remaining SPY/QQQ rows, the top strategies are `longer_dated_swing`, `breakout_forming`, `pullback_continuation`, `reversal_bounce`, and `sr_reclaim`. `longer_dated_swing` asks for 15-90 DTE in the catalog, while the live Stage-2 fetch used by `buildLiveOptionsDeps.getChain` is intentionally 0-14 DTE. The new per-strategy stage breakdown exposes that mismatch. Do not hide this by broadening all live fetches; the next code concern should route/search by the selected strategy's DTE bands or persist enough per-request fields to prove the intended window before changing request breadth.

### B7 provider reserves

Production `/api/system/provider-usage` sample:

- Minute cap 280; live partition total reserved 179; shared pool 101.
- Reserves visible: `scanner` 58, `alert_capture` 5, `options_discovery` 28, `options_paper_mark` 44, `asymmetry_mark` 44.
- Live sample used: `options_discovery` 28/28 reserve, `options_paper_mark` 18/44 reserve, shared 9/101, scanner reserve unused in that minute.
- Durable 2026-08-04 totals at sample: 158,891 provider requests, 516,914 quota blocks, 72 provider errors, 0 HTTP 429.
- By admitted requests: `options_discovery` 65,569, `scanner` 49,975, `options_paper_mark` 36,690, `unattributed` 5,817, `options_shadow_mark` 445, `alert_capture` 247, `premarket` 148.
- B7 decision: keep `PAPER_0DTE_RESEARCH_ENABLED` unset. Core capacity is protected by reserves, but optional/research activation is not justified while quota-block pressure remains this high and unattributed refusals remain enormous.

### Shipped locally in this update

- `/api/agents` and `/api/callouts` now wrap their provider work in `withProviderConsumer("dashboard_api", ...)`.
- `tests/api-regression.test.mjs` now pins those two browser/operator entry points so manual agent/callout probes cannot fall into `unattributed`.
- No cap was raised, no trading gate was weakened, no Discord send path was changed, and no paper/real-money setting was enabled.

### Exact resume point

1. Deploy `7aaff8d` and verify `/api/healthz.commitShort === "7aaff8d"`. Commit/push are done; production was still serving `4afd20c` after two post-push polls, and Railway API auth is unavailable.
2. Re-check `/api/system/provider-usage` after deploy; `unattributed` should stop growing from manual agent/callout probes. If it still grows, inspect remaining direct provider callers not covered by endpoint/scheduler scopes.
3. Fix the strategy/request-window mismatch exposed by SPY/QQQ: the live chain request must be driven by the selected strategy's DTE bands or the evaluator must not blame the market for bands the fetch never requested.
4. Add richer persisted per-request chain diagnostics before changing request breadth: requested expiration start/end, outcome, pages requested/received, truncation, and DTE bucket counts.
5. Only after the live contract path is truthful for SPY/QQQ/NVDA should High-Asymmetry timing/spam audit resume.

Task ID: roadmap-session-4-legacy-upgrade-safety-and-funnel-scope (IN PROGRESS — see resume point)

## Active position (2026-08-04, RTH session)

- Branch: `main` · local = `origin/main` = deployed = **`7ab7c4c`** (Railway
  SUCCESS 16:09Z, verified against `/api/health`)
- Verified: `npm test` **3429/3429 twice**, `npx tsc --noEmit --incremental
  false` clean, `npm run build` clean, `git diff --check` clean
- Production: `/api/health` ok, provider healthy, `loopRunning: true`,
  `quotaExceeded: false`, `session: regular`

### Corrections to the previously reported state

| Claim carried in | Actually |
| --- | --- |
| deployed = `1a4131a` | deployed was `005dd49`; now `7ab7c4c` |
| `observedInWindow` has never held a confirmed RTH row | **False.** 134 → 382 → 390 across this session. The funnel has been capturing live RTH evidence all along |
| `DISCORD_RECAP_ENABLED=0` (owner blocked) | Owner has since set it to **1**. `recapDelivery.state = CONFIGURED_AND_ENABLED` |
| ~2,120 recoverable, 738 unexplained SUPPRESSED | Confirmed exactly: `eligibleForRecovery: 2113`, `suppressedByReason["<none recorded>"]: 738` |
| `PAPER_0DTE_RESEARCH_ENABLED` unset | Confirmed still unset |

## This session's findings

### 1. The migration test could not see the migration it guarded (fixed, `bc0b951`)

`tests/content-drafts-migration.test.mjs` re-declares the migration list
locally, so it can only prove a *copy* of production's ordering is safe.
Measured: with the `0cc84fb` defect reintroduced into `lib/db.ts`, it reports
**3 pass / 0 fail** while production is down.

Root cause of the blind spot: `lib/db.ts` imports through the `@/` alias, which
`node:test` does not resolve, so the real `getDb()` was untestable and every
fixture built a fresh in-memory table — the one case where the defect is
invisible.

`tests/helpers/register-alias.mjs` (`module.registerHooks`, no loader thread, no
new dependency) makes the real `getDb()` importable.
`tests/legacy-database-upgrade.test.mjs` runs it against a seeded legacy **file**.
Verified to catch the outage: defect reintroduced → **7 fail / 0 pass**,
including all three route tests, reproducing the real blast radius.

Incident: [[../04 Bugs/Incident 2026-08-04 Database Init Outage]] — ~16m50s,
15:13:04Z → 15:29:54Z, from the Railway deployment records.

### 2. A scoped funnel query answered with the global funnel (fixed, `7ab7c4c`)

Measured in production before the fix:

```
?symbol=SPY  -> deltaSource.total 38   terminalReasons 1532 PROVIDER_ERROR   observedInWindow 382
?symbol=ZZZZ -> deltaSource.total 0    terminalReasons 1532 PROVIDER_ERROR   observedInWindow 382
```

`ZZZZ` cannot exist and still returned the whole global funnel, under a `scope`
header claiming the filter had been applied. Only `deltaSourceSplitOnDb` took a
scope; the other two readers had no scope parameter, so the route could not have
passed one.

**This changed the diagnosis.** After the fix, SPY's real evidence is:

```
?symbol=SPY       -> 41 rows: NO_CONTRACT_IN_DTE_RANGE 40, PROVIDER_ERROR 1
?symbol=SPY&side=call -> 27 rows: NO_CONTRACT_IN_DTE_RANGE 27, none selected
```

SPY calls die at the **DTE-range filter**, not at the provider. The CRITICAL
`BULLISH_CANDIDATES_NO_CALLS` alert for SPY and QQQ points at contract discovery's
0–14 DTE window, not at provider health. The unscoped view had pinned 1532
provider errors on SPY and would have sent the next session to the wrong subsystem.

### 3. PROVIDER_ERROR is the funnel's top terminal reason and is MIS-NAMED (proven, NOT yet fixed)

Global: **1699 of 3206** contract-discovery rows terminate `PROVIDER_ERROR` (~53%).

The label is wrong. `contract-discovery.ts:292` assigns `PROVIDER_ERROR` purely
on `chain.length === 0`. Three genuinely different outcomes reach that line:

1. `{available: true, contracts: []}` — the provider **succeeded** and there are
   genuinely no contracts in the requested 0–14 DTE range. Not an error at all.
   (`lib/polygon-provider.js:635`)
2. `{available: false, note: err.message}` — a real fetch failure, which also
   absorbs quota/budget refusals thrown as errors. (`:640`)
3. `providerUnavailable()` — no API key. (`:441`)

`lib/research/options/live-deps.ts:88` then discards both `available` and `note`:

```ts
return res?.available ? mapOptionContracts(res.contracts) : [];
```

The sibling single-quote path already fixed exactly this: `fetchOptionQuote`
reports `quotaExceeded` **separately** from `available`, with a comment stating
that a budget refusal is not a missing quote. `fetchOptionChain` never got that
treatment.

Consequence: our own admission control refusing a call, and the provider
genuinely having nothing in range, are both filed as the provider's fault — in
the single largest bucket in the funnel.

## Resume point (exact)

**Next concern, fully specified, not started:** propagate a structured chain
outcome so `PROVIDER_ERROR` stops absorbing budget refusals and genuine empties.

- `fetchOptionChain` (`lib/polygon-provider.js:601`) — return a discriminated
  reason (`OK` / `EMPTY_IN_RANGE` / `PROVIDER_FAILED` / `NO_API_KEY` /
  `QUOTA_REFUSED`) alongside `contracts`, mirroring `fetchOptionQuote`'s
  `quotaExceeded` precedent.
- `live-deps.getChain` (`:88`) — stop discarding it. Note `deps.getChain` is
  typed `(symbol) => Promise<ChainContract[]>` in `monitor.ts:37`; widening that
  return type is the ripple to plan for.
- `selectContractWithEvidence` (`contract-discovery.ts:292`) — take the outcome
  and emit distinct terminal reasons instead of inferring from `chain.length`.
- Regression tests: an empty-but-successful chain must NOT read as
  `PROVIDER_ERROR`; a quota refusal must NOT read as `PROVIDER_ERROR`.

**Then:** SPY/QQQ `NO_CONTRACT_IN_DTE_RANGE` — with scoping fixed, this is now
directly measurable per symbol and side. 27/27 SPY calls died there.

**Untouched this session (whole priorities):** legacy-suppression classification
(738), live-vs-backlog delivery priority, historical FAILED classification, B7
provider reserve validation, after-hours options content safety, High-Asymmetry
quality/spam audit, existing-AI audit, Ask OptiScan, engineering
recommendations, Options page redesign.

**Also observed, not yet investigated:** `/api/diagnostics/content-delivery`
reports `lastScan.result.examined: 0, skipped: 1` — the recovery sweep is
running but processing nothing, while `scansToDrainBacklog: 755`. The backlog is
not draining. Worth confirming before any classification work assumes it is.

## Prior task — High-Asymmetry paper lane (still valid)

- This work: the automatic paper-trading lane, built and **DISABLED**
- Verified at the time: `npm test` 2802/2802, `tsc --noEmit` clean,
  `npm run build` clean, `git diff --check` clean, `graphify update .` run

## Completed — High-Asymmetry paper lane

| Feature | Status |
| --- | --- |
| Separate lane `HIGH_ASYMMETRY_PAPER` (own tables) | BUILT_DISABLED |
| Automatic entry on EARLY_ASYMMETRY / CONFIRMING / HIGH_ASYMMETRY | BUILT_DISABLED |
| Deterministic sizing (FIXED_CONTRACT + FIXED_RISK) | BUILT_DISABLED |
| Versioned management and exits (`HIGH_ASYMMETRY_PAPER_V1`) | BUILT_DISABLED |
| Scheduler job `asymmetryPaper` (60s, clamped) | BUILT_DISABLED |
| Deterministic Quant cohorts, holdout, associations, proposals | BUILT_DISABLED |
| Daily paper report in the EOD review | BUILT_DISABLED |
| Report delivery via recap webhook | BLOCKED_CONFIG (DISCORD_RECAP_ENABLED=0, owner) |
| AI budget: 1 call/session, cached, daily+monthly limits | BUILT_DISABLED |
| Private diagnostics extended | BUILT_DISABLED |
| Owner-private send transport (defect fix) | BUILT — active as soon as a case transitions |
| Executed against a live candidate | MISSING — the radar has still never captured one |
| Subscriber SEND authority | MISSING (permanently, by design) |

## Feature flags

- `HIGH_ASYMMETRY_CAPTURE_ENABLED` — **enabled** (unchanged)
- `HIGH_ASYMMETRY_PRIVATE_ENABLED` — **enabled** (unchanged)
- `HIGH_ASYMMETRY_PRIVATE_WEBHOOK` — **configured** (unchanged, never displayed)
- `HIGH_ASYMMETRY_PAPER_ENABLED` — **NOT SET. Requires owner approval.**

I changed no Railway variable. The paper lane ships inert.

## The defect this work uncovered

`notifyPrivateAsymmetry` takes an OPTIONAL injected `send` and the scheduler
never injected one, so every owner-private notification returned
`NOT_CONFIGURED` while diagnostics reported `enabled: true,
webhookConfigured: true`. **No private message could have been delivered on
Friday.** Fixed and covered by `tests/high-asymmetry-private-send.test.mjs`.

This is the same class of failure the acceptance gate exists to catch — a
module that exists, type-checks, and is fully unit-tested but is not reachable
from anything that runs. The unit tests all injected a sender, so none of them
could see it.

## Second defect — MY defect, found by deploying

The daily paper report was delivered to the recap Discord channel on the first
EOD tick after deploy, without anyone enabling the paper lane.

Two mistakes compounded:

1. `resolveReportDelivery` read the raw `DISCORD_WEBHOOK_RECAP` URL. Production
   also sets `DISCORD_RECAP_ENABLED=0` — the owner's kill switch, and the
   reason `/api/discord/health` reports `recap: false` while the URL is
   present. Reading a webhook URL is not the same as being allowed to use it.
2. The delivery hook hangs off the EOD job, which is gated by CAPTURE, not by
   `HIGH_ASYMMETRY_PAPER_ENABLED`. So a deploy alone was enough to fire it.

It also bypassed `postToDiscord`, so the send never reached the delivery
ledger: `/api/discord/health` still reports `sent24h: 2` against the pre-deploy
baseline. The message was real; the ledger simply never saw it. **Do not treat
that ledger as proof of what this lane has sent.**

Fixed in `15dff21`: both gates are checked before the URL is looked up, with
regression tests written against the exact configuration that shipped.

The lesson to keep: a new outward-facing path must be gated on its OWN feature
flag, not merely inherit the gate of whatever job it was attached to.

## What remains unproven

- **The radar has never executed against a live candidate. Zero cases exist, so
  zero paper positions exist and none of the five paper tables has been created
  on the production volume.**
- Everything in the lane is proven by unit test and by source-level graph
  acceptance. None of it has run against a real quote.
- The OCC-matching question is still open and now matters twice: if
  `fetchOptionChain` returns a contract whose `optionSymbol` does not match the
  stored OCC, both `markRejections` AND the paper lane's entry will fill with
  NO_QUOTE / WRONG_OCC. Safe, but zero positions and zero graded outcomes.
- The private send path has never actually posted a message.

## Pre-session OCC analysis (2026-07-31 01:45 ET, before the open)

The open question has been "will the stored OCC match what the provider
returns". Static tracing narrows it considerably:

- Capture stores `res.contract.optionSymbol`, produced by `mapOptionContracts`.
- `getQuote` matches with `mapOptionContracts(...).find(x => x.optionSymbol === optionSymbol)`.

Same producer, same field, exact string equality. The FORMAT will match.

The windows differ, and that is the part to watch:

| Path | DTE | maxPages |
| --- | --- | --- |
| capture (`getChain`) — stores the OCC | 0-14 | 2 |
| `getQuote` — marks and paper | 0-60 | 3 |

A wider window is not automatically safer: 0-60 returns far more contracts than
0-14, so a 3-page cap could in principle truncate before reaching the target.
Polygon's snapshot pages are ordered by option ticker, and an OCC encodes the
expiration immediately after the underlying, so alphabetical order approximates
expiration ascending and a 0-14 contract should land in the first pages. That
is reasoning about ordering, NOT a guarantee from the provider.

**If NO_QUOTE dominates on Friday, this pagination/window mismatch is the
leading hypothesis, and the smallest safe fix is to align `getQuote`'s window
with capture's rather than to raise page counts.** Do not pre-emptively change
it: the gate must observe the real behaviour first.

## 2026-07-31 live session — what actually happened

Deployed today, in order: `be30aa0` capture telemetry, `68424d7` raw-timestamp
probe, `a4a7f31` timestamp normalization, `7a6267a` thesis-lane authority.

### The zero-case mystery, solved by measuring rather than guessing

Capture telemetry showed `CAPTURE_CALLED 75`, `CAPTURE_BLOCKED 75`, dominant
blocker `EVIDENCE_FROM_FUTURE`. The radar was being called and was refusing
everything — which the previous diagnostics could not distinguish from never
being called at all.

The probe then recorded raw provider timestamps beside the clock they were
compared against:

    COIN raw 1785510912137034800  now 1785510921734  ratio 999999.995

19 digits against 13. **Nanoseconds.** `now - ts` was hugely negative, so every
option quote read as decades in the future.

**Option freshness checking was not strict — it was INERT.** A negative age
passes every "older than X" test, so stale option quotes were never caught on
this field. Normalizing makes that check work for the first time.

Result: cases went 0 -> 13 -> 34 in one afternoon. Rejections are now a truthful
distribution (STALE_QUOTE, DUPLICATE_ACTIVE_CASE, UNUSABLE_LIQUIDITY).

### The AAPL duplicate, root-caused and fixed

Three AAPL PUT alerts on 2026-07-29 for the SAME OCC O:AAPL260729P00340000 at
14:50, 15:02, 15:44. `alertRecentDuplicate` is an 8-minute window for core
symbols; the repeats were 12 and 42 minutes apart. It asks "did we alert
recently", never "is this idea still open".

`lib/thesis-lane.ts` adds authority keyed on symbol + direction + optionType +
session, deliberately EXCLUDING strike, expiration and strategy. It fails OPEN:
if unavailable, the scanner keeps its previous behaviour, because a safety
improvement must not become a new way to silence alerts.

### The activation gate locked today — correctly

The gate ran during 09:40-11:30 ET while everything was still nanosecond-broken,
saw >= 6 attempts with zero accepted, and set `BLOCKED_QUOTE_PATH_DEFECT`. That
is the gate catching a real defect. It is per-day and does NOT auto-unblock;
**do not clear it manually.** It re-arms tomorrow on its own and should pass,
because the quote path now works.

### Watch on Monday

Zero subscriber alerts fired after the normalization deploy. The last Discord
send (09:37 ET) predates the deploy by two hours and alerts cluster at the open,
so this is probably normal — but normalization now makes freshness checks
actually reject stale quotes, so if volume stays at zero through Monday's open
the thresholds are biting on correct data for the first time and need review.
The thresholds themselves were NOT changed.

## Exact next bounded checkpoint
 — AUTOMATIC, NO HUMAN REQUIRED

Task ID: `high-asymmetry-automatic-activation`

Activation no longer needs Claude, a terminal, or the owner's computer. The
scheduler proves the quote path and flips a PERSISTED state on its own.

### Two independent locks

A paper entry requires BOTH. Either alone opens nothing.

1. `HIGH_ASYMMETRY_PAPER_ENABLED=1` — the owner's master authorization
2. persisted activation state `ACTIVE` — the machine's own live proof

`activationActive` defaults to FALSE in the entry writer, so a caller that
forgets to pass it cannot open a position by omission.

### States

`DISABLED` (no master flag) · `ARMED_WAITING_FOR_LIVE_PROOF` · `ACTIVE` ·
`BLOCKED_INSUFFICIENT_EVIDENCE` · `BLOCKED_QUOTE_PATH_DEFECT`

Per trading day. A quote path that worked yesterday proves nothing about today,
so each session re-arms and must re-prove itself.

### What the gate proves

ONE query: a case joined to a mark on the same session AND the same
`option_symbol`, where the case had a fresh ask, the mark has a real bid, and
the mark came LATER than detection. Conditions 2-5 hold simultaneously or not
at all — checking them separately would admit a combination that never
co-occurred.

The gate makes NO provider call of its own. It judges the marks the real
mark-runner produced, so it cannot pass on a parallel path that succeeds where
production fails.

### Classification is deliberate about blame

- dominant `WRONG_OCC` or `NO_QUOTE` over >= 6 attempts, zero accepted
  -> `BLOCKED_QUOTE_PATH_DEFECT` + one owner-private notice
- dominant `PROVIDER_ERROR` -> `INSUFFICIENT`, NOT a defect. An outage must not
  send anyone to change code that is correct.
- thin data -> stays `ARMED`, retries until 11:30 ET, criteria never relaxed
- past 11:30 ET without proof -> `BLOCKED_INSUFFICIENT_EVIDENCE` + one notice

### Window and cadence

09:40-11:30 ET, checked every 2 minutes (clamped), gate job ordered BEFORE the
paper sweep so activation and the day's first entry can land on the same beat.
Before 09:40 the gate refuses outright — an equity premarket print must never
be mistaken for proof that the OPTION quote path works.

### Idempotency

The activation UPDATE is guarded on the row still being `ARMED`. Repeated ticks
and concurrent processes produce exactly one winner, a block cannot demote an
ACTIVE day, arming cannot overwrite a state today already reached, and a
redeploy re-reads the state rather than re-proving it. All asserted by test.

### What the owner must do

Set exactly one variable, tonight:

    HIGH_ASYMMETRY_PAPER_ENABLED=1

Expected immediately after: `activationState: ARMED_WAITING_FOR_LIVE_PROOF`,
`paperEntriesAllowed: false`, `nextGateCheck` counting down to 09:40 ET.

Tomorrow the system verifies and activates by itself, or blocks itself with a
persisted reason and one owner-private message. No computer needs to be on.

### Where to look afterwards

`/api/research/asymmetry/live` -> `paperActivation`:
`masterPaperAuthorized`, `activationState`, `paperEntriesAllowed`,
`activationTimestamp`, `nextGateCheck`, `gateAttempts`, `gateEvidence`,
`gateBlockReason`, `firstAcceptedAsk`, `firstAcceptedBid`.

If it reads `BLOCKED_QUOTE_PATH_DEFECT`, the pre-session hypothesis above
(capture 0-14 DTE / 2 pages vs getQuote 0-60 DTE / 3 pages) is the first thing
to check, and the smallest safe fix is aligning the windows — NOT raising page
counts.

## Stop conditions

- do not set any Railway variable without explicit owner approval
- do not enable `HIGH_ASYMMETRY_PAPER_ENABLED` as part of verification
- do not send any Discord test message
- do not touch trading gates, ranking, or subscriber delivery
- do not stage Obsidian line-ending noise, `graph.json`, `workspace.json`,
  `graphify-out/`, or unrelated files
- do not use `git add .`, `git reset`, or force-push
- do not describe the paper lane as active: it is built and disabled, and has
  never opened a position

## Relevant notes

- [[../02 Components/High-Asymmetry Radar]]
- [[../02 Components/safety]]
- [[../02 Components/deployment]]
- [[../02 Components/Discord Alerts]]
- [[../02 Components/AI Learning System]]

---

# Packet update — 2026-08-02

## The quote-path hypothesis was close, and wrong

This packet predicted the defect was a DTE/page-window mismatch (capture 0-14
DTE / 2 pages vs `getQuote` 0-60 DTE / 3 pages) and advised aligning the windows
rather than raising page counts. Raising page counts would indeed have been
wrong — but so was the diagnosis.

Verified against the live provider: for 35 sampled production cases the target
contract was resolvable **35/35** through BOTH the 3-page chain slice and the
single-contract snapshot. The window was never the problem.

The real cause was **cost**, and a misattribution that concealed it:

- Reading ONE contract cost up to 3 requests via `fetchOptionChain`.
- The transition sweep does that per case per 60s: **~1,119 req/min vs a 280/min
  cap**, ~436,000/session vs a **200,000/day cap shared with the live scanner**.
- `/api/health` confirmed `callsToday = dailyCap = 200,000`.
- After exhaustion, quota refusals were recorded as `NO_QUOTE` with
  `providerError: null` — a *genuine* no-quote. 2,718 of them.

Fixed: single-contract snapshot (2.83x fewer requests, measured), distinct
`PROVIDER_BUDGET` / `NO_TWO_SIDED_MARKET` reasons, a bounded per-sweep budget
with rotation, and retryable transient rejections (a transient failure used to
consume the horizon permanently via the marks PRIMARY KEY).

## What to verify next session

1. `/api/research/asymmetry/timing` → `rolloverCheckViability.usableMarkPct`.
   It was **0.4%**. If the fix worked this should rise sharply during RTH.
2. Same endpoint → `rolloverCheckViability.rejectionsByKind`. `ourFault` should
   collapse; a residual `contractReality` count is expected and healthy.
3. `/api/health` → `callsToday` should stay well under `dailyCap` through the
   close. If it pins at the cap again, the budget is still being consumed
   somewhere else — do not raise the cap, find the consumer.
4. `lastAsymmetryTransitions.casesDeferredForBudget`. Non-zero is NORMAL and
   means rotation is working. Persistently equal to `casesRead` means the budget
   is too tight — tune `ASYM_MAX_QUOTES_PER_SWEEP`, not the provider cap.
5. `paperActivation.activationState`. It should leave
   `BLOCKED_QUOTE_PATH_DEFECT` once marks are usable. **Do not** enable
   `HIGH_ASYMMETRY_PAPER_ENABLED` to force it.

## Do not conclude from this yet

- `asymmetry_notify_decisions` has one partial session. The 120s and 50%
  thresholds remain provisional and unvalidated. Neither was changed.
- The NVDA cohort found 2 winners against 20 controls — **below the minimum of
  20 per cohort**. No feature difference is evidence.
- The rollover threshold could not fire at all while marks were broken, so its
  low suppression count says nothing about whether it is well set.

## Stop conditions (unchanged, plus)

- do not raise `POLYGON_DAILY_CALL_CAP` or `POLYGON_MINUTE_CALL_CAP` to make the
  research lane fit — the lane must yield to the scanner, not the reverse
- do not tune the 120s or 50% thresholds from the NVDA example

---

# Packet update — 2026-08-02 (Checkpoint 1)

## The losses are a BRACKET defect, not a spread defect

Median target **+44.94%**, median stop **−44.94%** — a symmetric 1:1 bracket —
run at an **18.29% win rate**. Implied expectancy **−28.5%** vs observed
**−25.88%**. A 1:1 bracket needs >50% win rate to break even; at 18.29% the
target would need to be ~201% against that stop. **36 of 40 stops are wider
than −40%.**

No exit policy rescues it. Best alternative (`Trail 10%`) reaches PF 0.42 vs
current 0.39. Every one of 17 tested policies stays under PF 0.5.

## The fill convention was misdescribed in the plan

Entry is the **MID** (`delivery.ts` → `entryFill: i.entry.mid`), exit is
**60% toward the bid** (`paper.ts::realOptionExit`). Immediate drag is
**−0.3 × spreadPct**, so a 10% spread costs 3%. Explaining a −24.6% MFE by
spread alone would need an **82% spread**. Spread is NOT the story.

## Two measurement defects, neither about spread

1. **84.1%** of verified trades carry ONE mark reused across all 7 horizon
   buckets. "Return at 1m" is not a 1-minute measurement.
2. **471 of 553** rows fail the paper-chain verifier; Quant Lab filters only on
   `status='EXITED'`. The headline is computed over an **85% unverified**
   population. ORCL/INTC/SQQQ appear **only** in the excluded set.

## Corrected numbers (verified 82 only)

| Metric | Quant Lab (357, unverified) | Verified (82) |
|---|---|---|
| Median return | −44.8% | −42.73% |
| MFE median | −24.6% | **−4.21%** |
| Ever profitable | — | **43.9%** |
| Reached +25% | — | 23.2% |

MFE is far better than the aggregate implied. The signal is **not** dead.

## Do not conclude

- `entryQuality` is **EARLY on all 40** verified rows — these were not late alerts.
- ORCL/DRAM/INTC/SQQQ remain **UNVERIFIED**; they are excluded rows, not graded results.
- Median spread was **not measured** — the −3% drag figure assumes a 10% spread.

## Next

Checkpoint 2 = fix the bracket (asymmetric R:R or much tighter stop) and the
mark density. Do **not** pause strategies on the contaminated 357 sample.

---

# Packet update — 2026-08-02 (Checkpoint 2)

## Quant Lab now counts verified rows only

`delivered` = VERIFIED_GRADED only, and is the **only** lane performance may be
quoted from. `delivered_unverified` keeps the old population visible. A
verification census reports every exclusion by cause. **Nothing deleted.**

The filter is a **conservative approximation** of paper-chain (it cannot see
Discord delivery proof) and says so in the payload.

## Shadow bracket results — verified 82, independent marks only

| Policy | expectancy | PF | R:R | breakeven win% |
|---|---|---|---|---|
| BASELINE_SYMMETRIC_45 | −17.07% | 0.303 | 1.00 | 50.0 |
| ASYM_2R | −8.74% | 0.465 | 2.00 | 33.3 |
| TIGHT_STOP_20 | −6.52% | 0.532 | 2.25 | 30.8 |
| ASYM_3R | −6.34% | 0.545 | 3.00 | 25.0 |
| **TIME_30_STOP_20** | **−6.14%** | **0.551** | 2.25 | 30.8 |
| TRAIL_15_FROM_10 | −9.46% | 0.345 | — | 13 rows only |

**Every candidate roughly halves the loss. NOT ONE reaches PF 1.0.**
Fixing the bracket is necessary but **not sufficient** — the signal still loses.
Target hit rates of 0–4.9% mean +45–60% targets are effectively unreachable.

## Promotion REFUSED

Independent mark rate is **23.4%** (132 of 565 horizons); 84.1% of series are
degenerate. Every simulated exit rests on carried-forward quotes, so no policy
may be promoted. **This is the correct outcome, not a failure.**

## What to do next

Mark density is the blocker for everything. Until the independent rate exceeds
50%, no bracket can be chosen and no strategy can be quarantined.

## Do not conclude

- No bracket has been promoted. Production still runs the symmetric ±45%.
- The 82 verified rows are still below the 60-alert forward-sample requirement,
  and they are backward-looking, not forward.
- `TIME_30_STOP_20` leads by 0.006 PF over `ASYM_3R` — noise at n=82.

---

# Packet update — 2026-08-02 (Checkpoint 3)

## One verification contract, not three

`lib/research/options/verification-contract.ts` is now the sole authority.
Quant Lab joins `options_alerts` and delegates the decision. The Checkpoint 2
approximation is gone — it claimed "stricter-or-equal" but checked FEWER facts,
so it was more permissive, and official numbers were quoted from it.

Every fact is tri-state; **a null never satisfies a requirement**.

## Mark density — NOT improved this checkpoint

Independent mark rate remains **23.4%** (132 of 565 horizons); 84.1% of series
degenerate. **No mark-pipeline change shipped.** The root cause work is
documented but the fix is deferred, because it must be validated during live
options hours and the market is closed.

## Official sample: NOT quotable

`quotable: false`, blockers named. Deploy verification will restate the live
counts under the new contract — expect the verified count to FALL sharply from
276 as delivery proof is now required.

## Still true

- No bracket promoted. Production runs the symmetric ±45%.
- No strategy quarantined.
- Paid launch blocked.
- Zero provider calls added; quant-lab is read-only (asserted by test).

## Next

Mark density is the only thing standing between here and a usable dataset.
It needs a live session.

---

# Packet update — 2026-08-03 (Checkpoint 4, live session)

## PARITY: ACHIEVED

`/api/research/options/parity` runs both verifiers over ONE shared keyed
population. Live result:

| | |
|---|---|
| Shared rows | **490** |
| Matching | **490 (100%)** |
| Mismatches | **0** |
| Quant Lab verified | **89** |
| paper-chain verified | **89** |
| Disagree on verified | **0** |
| Fallback keys used | 0 |

Keys: `OPTIONS_ALERT_ID` 270, `PAPER_POSITION_ID` 129, `OPPORTUNITY_CASE_ID` 91.

The earlier **85 vs 82** was a population artifact, exactly as suspected. Over
the same rows both verifiers agree on every single one.

## The 270 are NOT failed sends

| Class | n | Meaning |
|---|---|---|
| `MISSING_MESSAGE_ID` | **270** | alert SENT, Discord message id never recorded — **instrumentation gap** |
| `MISSING_ALERT_LINK` | **129** | paper row with no alert — paper is not delivery |
| `ACTUAL_DELIVERY_FAILURE` | **0** | — |

**Zero actual delivery failures.** 270 production defects, all of the same
instrumentation kind. Not backfillable — a message id cannot be invented.

## Eligible population

490 total → **361 eligible**, 129 permanently ineligible (no alert link).
**Verified fraction of eligible: 24.65%** (89/361), not 18% of everything.

## Two corrections to earlier claims

1. **The provider-burn alarm was wrong.** I read `callsToday: 144015` at 10:27
   and inferred the daily cap would exhaust by ~11:15. The call meter lives on
   `globalThis` and **resets on every deploy** — after my redeploy it read 311.
   The 144k had accumulated since the previous deploy, not since the open.
   `callsToday` is **per-process, not per-day**. `quotaExceededCount: 17358`
   before restart was real, so the MINUTE cap is genuinely being hit.

2. **The mark blocker has moved.** It is no longer PROVIDER_BUDGET.

## Live mark density

usablePct **24.4%** (Checkpoint 1: 0.4% → now 24.4%). Rejections:

| Reason | n |
|---|---|
| **FUTURE_QUOTE** | **636** |
| PROVIDER_BUDGET | 75 |
| STALE_QUOTE | 41 |

`NO_QUOTE` is gone entirely — the single-contract fix worked.

**FUTURE_QUOTE is now the dominant blocker: 636 of 995 marks.** Provider
timestamps ahead of the server clock. This is the next thing to fix and it was
NOT fixed here — a careless fix would accept genuinely bad timestamps.

Per-horizon usable: 1m 62/170, 3m 52/169, 5m 42/169, 10m 38/150, 15m 35/141,
30m 14/133, **60m 0/63**.

## Still true

- Paper lane is now `ACTIVE`, entries allowed (was `BLOCKED_QUOTE_PATH_DEFECT`).
- No bracket promoted; production still runs the symmetric ±45%.
- No strategy quarantined. Official sample NOT quotable. Paid launch blocked.

---

# Packet update — 2026-08-03 (Checkpoint 5, Gate A — DEPLOYED_UNPROVEN)

## Two causes ruled OUT with evidence

1. **Normalization is correct.** `provider-timestamp.js` puts 19-digit values
   in the ns band; `1785768941130622200` → `1785768941131`. Raw exceeds
   `MAX_SAFE_INTEGER` but the lost digits are sub-millisecond.
2. **The provider clock is never ahead.** Measured live on NVDA/AAPL/SPY/TSLA/AMD:
   skew **−887, −2799, −599396, −2177, −1418 ms**. Always behind.
3. **Wrong timestamp field is ruled out too.** Of 250 NVDA contracts, **0** had
   `last_quote`, `last_trade` or `day.last_updated` ahead of now. The fallback
   chain is not the source.

## Cause found and fixed (partially effective)

`deps.nowMs` is captured ONCE at beat start and reused for the whole sweep.
With ~217 cases at ~200ms/call the sweep runs tens of seconds, so a late quote
is legitimately newer than the sweep start → `quoteAt > nowMs` → FUTURE_QUOTE.

Fixed: `liveAsymmetryQuote` captures `Date.now()` immediately after the
provider responds; the mark runner judges freshness and age against that.
**Guard NOT weakened** — default forward tolerance is **0 ms**, genuine future
quotes still rejected (asserted unit + end-to-end).

## Live result — the fix did NOT resolve the dominant defect

Delta over 300 new marks after deploy:

| | Before (10:43) | After (11:08) | New |
|---|---|---|---|
| Total marks | 995 | 1295 | +300 |
| Usable | 243 (24.4%) | 323 (24.9%) | +80 (**26.7%** of new) |
| FUTURE_QUOTE | 636 | 819 | **+183 (61% of new)** |

Real but small improvement. **60m horizon went 0/63 → 12/128** — the first
usable 60-minute marks ever recorded.

**FUTURE_QUOTE remains the dominant failure at 61%.** There is a SECOND cause
and I have not found it. Do not claim Gate A succeeded.

## What the next session must do FIRST

Instrument per-mark timestamp evidence (raw, source field, unit, observedAtMs,
sweepStartedAtMs, computed skew) and persist it. `mark-timestamp-policy.ts`
already produces all of it — it is **not yet wired to persistence**, which is
why the second cause is invisible. One session of real skew distributions will
identify it; further guessing will not.

Note also: `callsThisMinute 280/280`, `quotaMode: minute_limited` during the
test. The minute cap is saturated, which may interact with mark timing.

## Gates B, C, D, E — NOT STARTED

Gate A's exit condition (FUTURE_QUOTE materially reduced) was not met, so no
later gate was executed. No brackets rerun, no strategies quarantined, no
historical cohorts, no experiment registry, no lifecycle, no conflict authority.
Paid launch remains blocked.

---

# Packet update — 2026-08-03 (Gate A, part 2 — CORRECTION: Gate A PASSED)

## My previous report was wrong. There is no second cause.

I reported that the observation-clock fix "did NOT resolve the dominant defect"
and that a second FUTURE_QUOTE cause existed. **That conclusion was a
measurement error.** The delta window I used (10:43 → 11:08) straddled the
deploy: the fix went live at ~11:04, so 21 of those 25 minutes ran the OLD
code. The +183 FUTURE_QUOTE I attributed to the new code was almost entirely
produced by the old code.

## Bounded live sample, 8 minutes, entirely post-fix

| Metric | Value |
|---|---|
| Attempted marks | **135** |
| Accepted (usable) | **94 = 69.6%** |
| **FUTURE_QUOTE** | **0 = 0.0%** |
| PROVIDER_BUDGET | 32 |
| STALE_QUOTE | 9 |

**FUTURE_QUOTE went to zero and stayed there for eight consecutive minutes.**

Usable rate on new marks: **24.4% → 69.6%**. Cumulative rose 29.1% → 32.7% and
keeps climbing as the old FUTURE_QUOTE rows dilute — the cumulative figure lags
because those terminal rows remain, correctly, in history.

## A second fix also proved itself

At t+3m the PROVIDER_BUDGET delta went **negative (−36)**. That is the
Checkpoint-1 retryability change working: budget-blocked horizons are transient,
get retried on a later sweep, and the upsert replaces the placeholder with a
real observation. Transient failures no longer consume a horizon permanently.

## The binding constraint is now provider budget, not timestamps

`callsThisMinute` pinned at **280/280** for the whole sample, and
`quotaExceededCount` climbed 773 → 4300 (~440/min). PROVIDER_BUDGET is now the
only material rejection cause and it is correctly classified as ours, not the
contract's. **Caps were not raised.**

## Per-horizon usable marks

1m 121/249 · 3m 99/233 · 5m 73/222 · 10m 48/199 · 15m 42/199 · 30m 15/173 ·
60m 12/133. Long horizons still lag — a budget/scheduling matter, not timestamps.

## Gate A: PASSED

- Second cause: **does not exist** — proven by an 8-minute zero-FUTURE_QUOTE sample.
- Genuine future timestamps still reject (unit + end-to-end tests).
- Default forward tolerance remains **0 ms**. Guard not weakened.
- No provider-call growth, no cap increase, no scanner or subscriber change.

## Gate B may start

Its own precondition — `independentMarkPct >= 50%` — is still unmeasured.
Independence instrumentation is Gate B's first task.

---

# Packet update — 2026-08-03 (Gate B, parts B1–B3)

## Horizon windows close the degeneracy hole

`dueHorizons` returns EVERY elapsed unmarked horizon, so one sweep on an
hour-old position saw 1/3/5/10/15/30/60 all due, fetched **one** quote and wrote
it to all seven. That is how 84.1% of series became degenerate.

Each horizon now has a deterministic window bounded by midpoints to its
neighbours — they touch but never overlap, asserted by test across all seven.
A grace period lets a horizon survive one budget-blocked sweep, but a
grace-period horizon is **claimable for retry and NOT independently satisfiable**.

## Independence is keyed on the OBSERVATION, not the price

- same provider timestamp on a second horizon → `REUSED_NOT_INDEPENDENT`
- same price with a different valid timestamp → **independent** (a quiet
  contract legitimately repeats a price)

## `asymmetry_mark_evidence` — a per-ATTEMPT log

Separate table on purpose. `asymmetry_marks` holds one row per horizon and now
replaces transient failures on retry, so attempt history recorded there would
destroy exactly what makes independence measurable. Raw provider timestamps are
stored as **TEXT** (19-digit ns exceeds `MAX_SAFE_INTEGER`).

Additive, repeat-safe, no destructive DDL. Instrumentation issues **zero**
provider calls and its own try/catch means it can never affect a mark.

## Status: DEPLOYED_UNPROVEN

Independence is now **measurable but not yet measured** —
`buildIndependenceReportOnDb` reads persisted evidence only, so a rate appears
after one live RTH session on the deployed code. **Gate C cannot honestly start
before `independentMarkPct >= 50%`.**

## Binding constraint is now provider budget

280/280 minute cap saturated, `quotaExceededCount` climbing ~440/min, consumer
unidentified. **Gate B5 (consumer audit) is the next work.** Do not raise caps.

See `OPTISCAN_AUTONOMOUS_ROADMAP_STATUS.md` for the full gate ledger.

---

# Packet update — 2026-08-04 (content delivery, post-close)

## Verified state, not the state the prompt asserted

| Claim carried into this session | Actual |
|---|---|
| deployed `c7a07e2` | **`12d510a`** — production was already fully current |
| clean tree | **20 untracked files** (audit doc, ~15 railway/probe scripts, `graph.json`) |
| `DISCORD_RECAP_ENABLED` awaiting owner | **already set to `1`** |
| 50 stranded drafts | **2,927 undelivered across 1,026 events**, of 3,446 total |

`local = origin/main = 12d510a` was correct. 3392/3392 was correct.

## The recap kill switch is off and recovery IS running

`recapDelivery.state = CONFIGURED_AND_ENABLED`, `killSwitchEngaged: false`,
`canDeliver: true`. The `c7a07e2` health fix reads correctly in production.

Last scan: **`deferredDelivered: 1`**, `newestDeliveredAtMs` = now. **501 drafts
delivered, all 501 carrying a real Discord message id.** Recovery works.

## I reported the opposite first, and was wrong

I read `/api/content-drafts`, saw 200/200 `SKIPPED_NO_WEBHOOK`, partitioned by
category to widen the window, saw 480 rows with **zero touched tonight**, and
concluded recovery was not firing.

That was a measurement artifact. The endpoint hard-caps at **200 rows ordered
`created_at_ms DESC`** and recovery drains **oldest-first** — so recovered rows
are, by construction, outside the window. Partitioning by category hit the same
cap per category. The true population is **3,446**, not 480. I could not have
seen a recovered row by that method no matter how many I fetched.

This is the same defect class the session was convened to fix — a surface that
could not distinguish "none" from "none visible" — and it caught me.

## Measured census (whole table, SQL aggregate)

| Delivery status | n |
|---|---|
| SKIPPED_NO_WEBHOOK | **2,067** |
| FAILED | **860** |
| SENT | **501** (501 with message id) |
| SUPPRESSED | 18 |
| **total** | **3,446** |

## The real blocker is DRAIN RATE, and it is the owner's call

`cap = Math.min(maxPerScan ?? 20, 1)` — **one event per scan**, deliberately, so
recovery can never burst a backlog into the channel. At the 3-minute
`contentDrafts` interval:

    1,026 events x 3 min = ~51 hours of continuous running

The backlog drains on its own and needs no intervention. But raising the rate
posts faster into the owner's private Discord, so **I did not change it.**
`scansToDrainBacklog` is now reported so the tradeoff is visible.

**Not investigated: the 860 FAILED.** They are retryable and re-enter the sweep,
so they are not lost — but the failure reason is not persisted per draft, only
the status. That is the next content concern.

## Shipped — `3bd59c9`

- `lastContentDrafts` on the scheduler: ran / reason / webhookConfigured / full
  `ContentScanResult` / error. `contentDraftsJob` previously awaited the result
  purely for side effects and discarded every field.
- `buildContentDeliveryCensus` — whole-table counts, tri-state.
  `NOT_INITIALIZED` / `READ_FAILED` carry **null**, never 0.
- `GET /api/diagnostics/content-delivery`.
- Regression test reproducing the 200-row masking directly.

Read-only. No provider call, no send authority, no gate changed.
`npm test` 3398/3398 twice, `tsc` clean, `build` clean, `git diff --check` clean.

## Corrected note on the recovery test

`tests/content-event-engine.test.mjs` proves recovery while injecting BOTH
`webhookConfigured` and `send`. Production injects neither. I re-ran the scan
with only env + a spy send — the production dependency shape — and it delivered
correctly, which is why this commit changes no delivery logic. The packet's
standing warning about paths proven only under injection still applies here.

## Blocked on the 2026-08-04 RTH session — unchanged

Market was closed all session (`session: "closed"`). Untouched:
contract-funnel live validation (`observedInWindow`), B7 provider reserves,
Aggressive 0DTE activation (`PAPER_0DTE_RESEARCH_ENABLED` still **unset** —
correctly, pending B7), Gate B4 independence rate.

## Exact resume point

1. **Re-read `/api/diagnostics/content-delivery`.** `delivered` must exceed 501
   and `eventsAwaitingRecovery` must be below 1,026. If they have not moved,
   `lastScan.result` now names the reason directly.
2. **Decide the drain rate** (owner). Leave at ~51h, or raise `maxPerScan`.
3. **Diagnose the 860 FAILED** — persist a per-draft failure reason first.
4. Then the RTH-blocked items above.
5. Options page redesign remains the next offline-safe code concern, untouched.

## Amendment, same session — the drain is real but partly SUPPRESSED

Two consecutive censuses, one scan apart:

| | first | second |
|---|---|---|
| SKIPPED_NO_WEBHOOK | 2,067 | **2,064** |
| SUPPRESSED | 18 | **21** |
| SENT | 501 | 501 |
| eventsAwaitingRecovery | 1,026 | 1,025 |

`lastScan.result`: `deferredDelivered 1` on the first, `skipped 1` on the second.

So the sweep runs every interval and claims one event each time — but that
event's three drafts went to **SUPPRESSED, not SENT**. `deliverDrafts` writes
SUPPRESSED when `postToDiscord` returns `suppressed: true`. Earlier in the same
window another bundle delivered for real, so this is a **mix**, not a uniform
failure.

**The suppression reason is computed and thrown away.** `defaultSend` builds
`recap suppressed: ${r.suppressionReason}` into `ContentDeliverResult.error`,
and `deliverDrafts` persists only the STATUS — the error string is dropped. So
"suppressed" is visible and "why" is not. Same defect shape as the one this
session just fixed one level up, now one level down.

This raises the FAILED/SUPPRESSED work above the drain-rate decision: draining
faster into a suppressing path only converts the backlog to SUPPRESSED sooner.

**Revised resume order:** persist a per-draft `discord_delivery_reason` (likely
the recap dedup guard in `recap-delivery-guard.ts` — `recapPayloadKey` hashes
the payload, and recovery re-sends persisted text, so identical bundles may key
alike), THEN decide drain rate, THEN the RTH items.

---

# Packet update — 2026-08-04 (suppression root cause, RTH session)

## Verified before relying on it

`local = origin/main = 5bbb96f` ✅ · tree clean of tracked changes (20 untracked,
unchanged) ✅ · production healthy, provider healthy, loop running ✅ ·
**`session: "regular"` — the market is OPEN this session** ✅

**Railway API token has EXPIRED** (`Not Authorized` from backboard GraphQL).
`scripts/*` and the probe path both read `SCAN_API_TOKEN` from Railway, so
production diagnostics could not be read this session. Owner must re-auth.

## The suppression cause — proven, and NOT the payload hash

I carried in the hypothesis that `recapPayloadKey` was hashing recovered text
into collisions. **That hypothesis is wrong.** Read from the guard source:

`lib/notifications/recap-delivery-guard.ts`

    const WINDOW_MS = 10 * 60_000;
    const MAX_POSTS = 2;

The recap channel allows **2 posts per 10 minutes, channel-wide**. The
`contentDrafts` job runs every **3 minutes** and attempts one bundle per run —
**~3.3 attempts per window against a budget of 2**. About **40% of sweeps are
refused for channel budget alone.**

## Why that destroyed drafts

`deliverDrafts` picked its status from one boolean:

    res.ok ? "SENT" : res.suppressed ? "SUPPRESSED" : "FAILED"

`postToDiscord` sets `suppressed: true` for **six** guard verdicts. Three are
transient (`rate_limited`, `in_flight`, `retry_backoff`), and `disabled` is
owner-reversible. `SUPPRESSED` is **not** in `RETRYABLE_DELIVERY_STATES`, so
every draft refused for a momentary budget **left the pool permanently**.

The backlog was not draining. It was being **consumed**: ~2 delivered and ~1.3
destroyed per 10 minutes. That is exactly the observed shape — SKIPPED_NO_WEBHOOK
−3, SUPPRESSED +3, SENT flat.

## The 860 FAILED — same root cause, different state

`deferredDraftEventIds` matched the literal status `SKIPPED_NO_WEBHOOK` only.
A FAILED draft could be retried **only if its source event was re-queued**, and
events are marked PROCESSED at generation time and never are. So all 860 were
**unreachable by any code path**. Not a Discord problem — a query predicate.

An existing test asserted that stranding as correct. Updated deliberately.

## Shipped — `0cc84fb`

Retryability is derived from the reason; status from retryability. Transient
refusals park at `PENDING` and are swept again. `SUPPRESSED_DUPLICATE` and
`SUPPRESSED_RETRY_EXHAUSTED` stay terminal — **dedup is not weakened**.

An unrecognized suppression is classified **transient** on purpose: a future
guard verdict must not silently inherit "delete this draft".

Persisted per attempt: reason code, owner-safe explanation, retryability,
redacted detail, attempt count, last attempt time. Secrets cannot reach the
table — webhook URLs carry their token in the path and are stripped, asserted.

Migration additive/nullable, guarded, mirrored into base schema. **Verified
repeat-safe: 3 passes applied 6 / 0 / 0**, existing rows preserved with reason
NULL — never recorded, so never invented. Queries detect the columns at runtime.

`npm test` **3415/3415 twice**, tsc clean, build clean, `git diff --check` clean.

## Drain policy — the sweep interval is NOT the lever

With the fix, drafts are no longer destroyed. But throughput is now bounded by
the guard, not the job:

    MAX_POSTS 2 per 10 min = 12/hour ceiling
    ~1,025 events -> ~85 hours

**Running the sweep more often cannot help** — it would only produce more
`rate_limited` parks. The only levers are `MAX_POSTS`/`WINDOW_MS` in the recap
guard, or not sending old backlog to Discord at all.

**Recommendation (owner decision, NOT taken):** do not raise `MAX_POSTS`. Split
the queue by age — deliver LIVE and RECENT drafts, and leave historical backlog
in the app as an archive/summary rather than replaying weeks of drafts into the
channel. Priority 4 remains unimplemented.

## Not done this session

Priorities 4–16 untouched: recovery priority queues, after-hours options content
safety, AI backend audit, **Ask OptiScan** (a multi-session build), options page
redesign. RTH items also untouched — the expired token blocked reading
`contract-funnel`, B7 reserves, and 0DTE state, even though the market was open.

`PAPER_0DTE_RESEARCH_ENABLED` remains **unset**, correctly.

## Exact resume point

1. **Owner: re-auth Railway** (`railway login`) so production diagnostics read again.
2. Verify `/api/diagnostics/content-delivery`: `suppressedByReason` should now
   be dominated by `SUPPRESSED_RATE_LIMIT` **falling** while `SENT` rises, and
   `failedByReason` should classify the 860. Confirm no draft is lost.
3. Decide the drain policy above before any rate change.
4. Priority 5 (after-hours options content safety) is the next offline-safe
   concern and is a genuine truthfulness risk — content is being generated
   during a live session right now.
5. Ask OptiScan (Priorities 6–15) needs its own session; audit the existing AI
   backend FIRST so a second chatbot is not built alongside it.

---

# Packet update — 2026-08-04 (fix verified in production, after an outage I caused)

## I broke production, then fixed it

`0cc84fb` shipped `CREATE INDEX ... ON content_drafts(discord_delivery_reason)`
inside `SCHEMA`. On a fresh database that is fine. On the long-lived production
file, `CREATE TABLE IF NOT EXISTS` is a no-op, the reason columns arrive later
via ALTER, and the index therefore ran against a column that did not exist —
`no such column`, which aborts `db.exec(SCHEMA)`.

`SCHEMA` is the first thing every database open runs, so this was **not scoped
to content**. `/api/discord/health` 500, `/api/opportunity-cases` 503,
`/api/content-drafts` 503. Roughly a 20-minute outage.

Fixed in `1a4131a`: the index now runs immediately AFTER its ALTERs. All routes
verified back to 200.

**Why my repeat-safety check missed it:** it seeded a fresh table and applied
only the ALTERs. It proved the migrations were idempotent — they are — and never
asked whether SCHEMA still parsed against a table that predates them.
**Idempotent is not the same as ordered.** No content fixture builds a
pre-migration table, so nothing could have caught this.

Standing gap, recorded in `tests/content-drafts-migration.test.mjs`: the real
`getDb()` is untestable from `node:test` because `lib/db.ts` imports through the
`@/` alias the runner cannot resolve. Closing it means giving the runner the
alias, and would have caught this class directly.

## The fix is confirmed working in production

Four samples, ~2.5 min apart, on `1a4131a`:

| | s1 | s2 | s3 | s4 |
|---|---|---|---|---|
| SENT | 628 | **632** | 632 | 632 |
| FAILED | 859 | **858** | 858 | 858 |
| PENDING | 0 | **1** | 0 | 0 |
| SUPPRESSED | 738 | 738 | **742** | 742 |

Three things proven by observation, not by test:

1. **`FAILED 859 -> 858`.** A previously unreachable FAILED draft was swept.
   `eligibleForRecovery` = 1,261 SKIPPED + 859 FAILED = 2,120 — the 860 are in
   the pool for the first time.
2. **`PENDING: 1` in s2.** A transient refusal parked as RETRYABLE instead of
   being destroyed. This is the whole defect, fixed and observed.
3. **`SUPPRESSED_DUPLICATE: 4` in s3.** A genuine duplicate still terminates,
   and now says why. Dedup is intact.

## ~720 drafts were destroyed before the fix landed

`SUPPRESSED` went **18 -> 738** while the old code ran between the previous
session and this deploy. All 738 carry `<none recorded>` — written by code that
had no reason column.

They are terminal and **outside the recovery pool**. The fix prevents further
loss; it does not resurrect these.

Most were almost certainly `rate_limited` — transient, and their content is
still truthful. But 4 confirmed duplicates in one sample show the bucket is
mixed, so **blanket resurrection would post real duplicates.**

**Proposed, NOT executed (needs owner approval):** return a
`<none recorded>` SUPPRESSED draft to the pool only when no draft sharing its
fingerprint has ever reached SENT. That is a bounded, evidence-checked
reclassification rather than a blind resend. It would add ~738 drafts to a
backlog already 2,120 deep, which is exactly why it is a decision and not a
default.

## Backlog and drain — unchanged advice

758 events awaiting. Ceiling is still the guard: `MAX_POSTS 2 / 10 min` = 12/hr.
**`MAX_POSTS` was NOT raised, and the sweep interval was NOT changed**, per
instruction. Priority 4 (live-vs-backlog queues) remains unimplemented — and it
matters more now: live drafts share one FIFO with a 2,120-deep backlog.

## Not done — the broader roadmap is PRESERVED

Priorities 4-16 untouched: live-vs-backlog recovery policy, after-hours options
content safety, AI backend audit, **Ask OptiScan** (multi-session), evidence
explanations, CREATE CLAUDE TASK, options page redesign.

RTH items untouched despite an open session — the outage and its hotfix took the
session. `contract-funnel` `observedInWindow`, B7 reserves, and 0DTE activation
all still pending. `PAPER_0DTE_RESEARCH_ENABLED` remains **unset**, correctly.

Everything in the earlier packet sections (Gates A/B, mark density, bracket
work, High-Asymmetry, Quant verification contract) stands unchanged.

## Exact resume point

1. **Decide the 738-draft reclassification** above. Nothing else should touch
   that bucket until then.
2. **Priority 4 first** — live drafts must not queue behind 2,120 backlog rows.
   This is now the highest-value content work.
3. Then Priority 5 (after-hours options content safety) — a live truthfulness
   risk while sessions are open.
4. Audit the existing AI backend BEFORE building Ask OptiScan, so a second
   chatbot is not built beside the current one.
5. RTH: contract-funnel, B7, 0DTE — next open session.

---

# Packet update - 2026-08-04 (live options truthfulness, provider attribution, High-Asymmetry gate)

## Verified from the repo and production

Before this packet update, `local = origin/main = a7e1770` and production was
serving `a7e1770`. Production health was green: provider configured, loop
running, database writable, and no provider quota fault reported by health.

The previously reported deployment gap is closed for the provider-attribution
work. `/api/healthz.commitShort` matched the deployed SHA after each push
through `a7e1770`.

Graphify remains blocked locally because the installed launcher points at a
removed Python 3.11 runtime. Existing `graphify-out/graph.json` remains usable
as stale context, but Graphify was not regenerated and no system Python/runtime
repair was attempted.

## Strategy DTE retrieval

Root cause found and fixed: `longer_dated_swing` requested 15-90 DTE while the
Stage-2 chain fetch covered only 0-14 DTE. That made many SPY/QQQ bullish
candidates terminate at `NO_CONTRACT_IN_DTE_RANGE` even when the strategy was
asking for longer-dated contracts.

Shipped earlier in this run:

- `b917a6d` - strategy-aware option-chain DTE fetches.
- `04be096` - range diagnostics in contract-funnel output.
- `8d91b24` - selected quote diagnostics in contract-funnel output.

The fix requests only the expiration partitions required by the active strategy
and reuses compatible cache/in-flight work. It does not globally widen every
chain request and does not weaken DTE, spread, or liquidity eligibility.

Observed live evidence after the fix:

- SPY CALL `longer_dated_swing`: 15-90 DTE fetched; selected contracts appeared,
  including longer-dated calls.
- QQQ CALL `longer_dated_swing`: 15-90 DTE fetched; selected contracts appeared.
- NVDA controls selected both CALL and PUT contracts when the fetched range
  matched the strategy.

Historical ambiguous funnel rows were not backfilled or assigned invented
causes.

## Provider attribution and reserves

Dashboard/manual API calls were verified to attribute as `dashboard_api` rather
than `unknown/unattributed` after controlled `/api/agents` and `/api/callouts`
requests.

Provider usage also showed the exact-OCC High-Asymmetry sweep flood was already
properly attributed after `af91f0c`:

- `asymmetry_mark` exact-OCC quote requests were the dominant blocked consumer.
- `asymmetry_discovery`, `options_discovery`, `scanner`, and
  `options_paper_mark` were separately visible.
- No HTTP 429s were observed in the sampled windows; the large refusal count was
  internal provider budgeting/throttling, not provider quota errors.

One remaining unattributed provider caller was traced to
`/api/research/options/diagnostic`, which called the live provider batch reader
outside any consumer scope. That was fixed in:

- `a7e1770` - wraps the diagnostic route in the `diagnostics` provider consumer.

Controlled production proof after `a7e1770`: diagnostic provider attempts
incremented `diagnostics`, while the old unattributed whole-market snapshot
bucket did not grow.

`PAPER_0DTE_RESEARCH_ENABLED` remains unset. Do not enable it yet: Core scanning
is protected by reserves, but optional High-Asymmetry marking still produces
large internal block counts and needs further pressure reduction before safe
0DTE paper activation.

## High-Asymmetry timing and spam

Most recent-session audit data from the timing endpoint showed high owner-alert
pressure:

- 2026-08-04: 2,028 decisions, 887 distinct cases, 397 notified, 1,631
  suppressed, 44.8% alert-to-capture ratio.
- 2026-08-03: 2,190 decisions, 989 distinct cases, 413 notified, 1,777
  suppressed, 41.8% alert-to-capture ratio.
- 2026-07-31: 287 decisions, 135 distinct cases, 72 notified, 215 suppressed,
  53.3% alert-to-capture ratio.

The audit found a specific late-entry gap: several sent decisions had fresh
quotes but `capture_to_notify_ms` around 42-43 minutes. The existing gate caught
stale quotes, premium chase, and rollover, but did not suppress cases where the
setup itself was old by the time an opening notification was emitted.

Shipped locally in code commit:

- `a99f431` - deterministic High-Asymmetry timing action gate and session-wide
  owner notification cap.

`a99f431` adds:

- `ENTRY_TOO_LATE` suppression when capture-to-notify age exceeds the configured
  threshold, default 15 minutes.
- Deterministic notification actions:
  `HIGH_ASYMMETRY_ALERT`, `HIGH_ASYMMETRY_OWNER_WATCH`,
  `HIGH_ASYMMETRY_PAPER_ONLY`, `HIGH_ASYMMETRY_TOO_LATE`,
  `HIGH_ASYMMETRY_ARCHIVE`, and `REJECTED`.
- Only `HIGH_ASYMMETRY_ALERT` may create an immediate Discord message.
- Premium-chase suppressions map to `HIGH_ASYMMETRY_PAPER_ONLY`.
- Stale, rollover, or old-capture cases map to `HIGH_ASYMMETRY_TOO_LATE`.
- Notify-journal persistence for action and configured capture-age threshold,
  with guarded additive columns for legacy databases.
- Timing endpoint diagnostics for `lateEntrySuppressions` and `byAction`.
- Session-wide owner-private High-Asymmetry message ceiling, default 40 per
  session via `HIGH_ASYMMETRY_MAX_MESSAGES_PER_SESSION`.

Existing per-symbol/session and fingerprint/state dedupe remain in place.
Research evidence is still persisted quietly; spam is reduced through lifecycle
gating and notification budgeting, not by deleting evidence.

## Validation

For `a99f431`, before this packet update:

- Focused High-Asymmetry notification-gate tests passed.
- Notify-journal schema/legacy tests passed.
- Private notification spam/cap tests passed.
- Integration suppression/graph/runtime High-Asymmetry tests passed.
- Full `npm test` passed twice: 3,450 / 3,450 both runs.
- `npx tsc --noEmit --incremental false` passed.
- `npm run build` passed.
- `git diff --check` passed.
- Migration review: additive nullable journal columns, guarded and repeat-safe;
  no destructive migration.

## Exact resume point

1. Push `a99f431` and this packet update to `origin/main`.
2. Let Railway deploy the new main SHA; verify `/api/healthz.commitShort`
   matches the exact live SHA.
3. Verify production health, provider configuration, loop state, and absence of
   new production faults.
4. Verify `/api/research/asymmetry/timing` exposes `lateEntrySuppressions`,
   `byAction`, and action-bearing recent decisions. Future new decisions should
   persist the new action columns.
5. Continue provider pressure reduction using evidence only: compatible cache
   reuse, in-flight dedupe, avoiding repeated empty-range requests, and optional
   suppression under Core pressure.
6. Keep `PAPER_0DTE_RESEARCH_ENABLED` unset until Core capacity protection is
   proven under representative RTH load after the High-Asymmetry cap is live.
7. Next unfinished live-trading concern: deeper High-Asymmetry outcome grading
   and pressure reduction. Ask OptiScan and major UI work remain behind the live
   trading path.

---

# Packet update - 2026-08-04 (post-deploy verification)

`87c3062` was pushed to `origin/main` and deployed successfully. Production
reported `/api/healthz.commitShort = "87c3062"` with health green, provider
`polygon`, key present, loop running, database ready, lifecycle active, and
`quotaExceeded = false`.

This post-deploy note is docs-only. If a later docs-only packet commit is the
branch or production SHA, the runtime High-Asymmetry code is still the code from
`a99f431`.

Live verification completed:

- `/api/research/asymmetry/timing` returned `readOnly: true` and
  `providerCallsIssued: 0`.
- The timing diagnostics exposed `lateEntrySuppressions`, `byAction`, and
  action-bearing recent decisions.
- Controlled calls to `/api/agents?ticker=SPY` and `/api/callouts` increased
  deployment-scoped `dashboard_api` option-chain requests by 9 and increased
  unknown/unattributed requests by 0.
- No HTTP 429s or provider errors were introduced by the controlled probe.

Exact resume point:

1. Do not redo the structured-chain, strategy-DTE, or provider-attribution work
   unless new evidence shows a regression.
2. Continue with evidence-backed provider pressure reduction, especially
   High-Asymmetry exact-OCC marking pressure and repeated empty-range avoidance.
3. Audit the next live High-Asymmetry decisions under `a99f431` behavior and
   confirm late captures become `HIGH_ASYMMETRY_TOO_LATE` instead of immediate
   Discord alerts.
4. Keep `PAPER_0DTE_RESEARCH_ENABLED` unset until Core capacity is proven under
   representative RTH load with the new notification cap live.
5. Graphify still needs owner/runtime repair before regeneration; existing
   graph output remains usable as stale context.

---

# Packet update - 2026-08-04 (High-Asymmetry provider pressure, after-hours guard)

## Verified baseline

- Before this concern, local `HEAD`, `origin/main`, and production were
  `a895030e442e928db6e49b03148c243f3fdbd1ff`.
- Production `/api/healthz` and `/api/health` were green: database ready,
  schema healthy, lifecycle active, Polygon configured, loop running, and
  `quotaExceeded=false`.
- The sampled production session was `afterhours`; ordinary equity/ETF options
  were closed. No fresh RTH High-Asymmetry alert behavior is claimed here.
- `PAPER_0DTE_RESEARCH_ENABLED` remains unset.
- Existing `graphify-out/graph.json` remains usable as stale read-only context.
  Regeneration is still blocked because `graphify.exe` references the removed
  Python 3.11 runtime; no runtime repair or dependency installation was made.

## Measured root cause

Deployment-scoped provider usage for `a895030` over a 33-minute sample recorded
7,842 admitted requests, 4,139 internal budget refusals, zero provider errors,
and zero HTTP 429s. High-Asymmetry was the dominant optional pressure:

- `asymmetry_discovery`: 1,803 admitted and 1,797 refused exact-OCC reads.
- `asymmetry_mark`: 442 admitted and 2,000 refused exact-OCC reads.
- After the ordinary options session closed, the transition sweep still
  attempted about 120 exact-OCC reads per minute.
- Exact-OCC reads had no provider-boundary TTL cache or in-flight deduplication;
  compatible transition, mark, paper, and Core reads could each pay separately.

## Shipped locally in this concern

- Added a process-shared exact-OCC response cache at the Polygon provider
  boundary. Default TTL is 2 seconds, configurable with
  `OPTIONS_EXACT_QUOTE_CACHE_TTL_MS`, clamped to 0-15 seconds, and bounded to
  5,000 completed entries.
- Concurrent identical underlying/OCC reads now join one in-flight provider
  request. Cache hits and in-flight reuse remain visible in provider accounting
  and High-Asymmetry mark evidence.
- Successful exact-contract responses, including a genuine empty snapshot, may
  be reused briefly. Provider errors and internal budget refusals are never
  cached and remain distinct outcomes.
- High-Asymmetry transition enrichment and forward marking now return
  `OPTIONS_SESSION_CLOSED` before reading cases or issuing provider calls once
  the ordinary options quote session is closed.
- No provider cap, strategy rule, contract gate, paper setting, or alert
  threshold was widened.

## Validation

- Focused provider/High-Asymmetry suites: 67 / 67 passed.
- Full `npm test` passed twice: 3,454 / 3,454 both runs.
- `npx tsc --noEmit --incremental false` passed.
- `npm run build` passed.
- `git diff --check` passed.
- Migration review: no database migration in this concern.

## Exact resume point

1. Commit and push this provider-pressure concern, let Railway deploy it, and
   verify the exact production SHA plus green health/provider/loop state.
2. Compare deployment-scoped `asymmetry_discovery` and `asymmetry_mark`
   requests, refusals, cache hits, and dedup avoidance against the baseline
   above. After close, both scheduled sweeps should report
   `OPTIONS_SESSION_CLOSED` and issue zero exact-OCC provider calls.
3. During the next representative RTH session, verify fresh decisions under the
   `a99f431` timing gate. Do not infer live success from after-hours rows.
4. Replace the global 15-minute High-Asymmetry age with deterministic
   strategy/DTE-specific freshness and lower the normal immediate-message
   budget well below the existing emergency ceiling of 40.
5. Audit all options-related after-hours messages and add instrument-aware
   session authority before building owner-facing Ask OptiScan and redesigning
   the Options page.
6. Keep `PAPER_0DTE_RESEARCH_ENABLED` unset.

---

# Packet update - 2026-08-04 (provider-pressure deployment correction)

The provider-pressure concern above is no longer local-only. Commit
`c6eef4b24f3d6625686ded63d118d7dbf91a3f7f` was pushed and deployed. Three
post-handoff health samples reported the exact commit with database, schema,
lifecycle, provider, and scanner loop green and `quotaExceeded=false`.

In the first three deployment minutes, provider accounting reported 311
admitted requests, three exact-OCC cache hits, zero provider failures, zero
HTTP 429s, and no post-close `asymmetry_discovery` or `asymmetry_mark` calls.
This is after-hours evidence only; RTH cache/dedup and Core-capacity impact
remain to be measured on representative traffic.

# Packet update - 2026-08-04 (strategy-aware High-Asymmetry delivery gate)

## Root cause and correction

The 15-minute High-Asymmetry capture-age ceiling ignored the existing 27-entry
options strategy catalog. That allowed a 0DTE momentum setup to remain eligible
far too long while applying the same clock to a multi-week strategy. The live
transition path also discarded current DTE, delta, liquidity, and underlying
facts already returned by the exact-OCC response.

This concern replaces the global live rule with deterministic strategy policy:

- Candidate, option-quote, and underlying-quote maximum ages now come from each
  strategy's existing `freshnessMaxMs` (10-120 seconds in the current catalog).
- Side, preferred DTE band, preferred delta, strategy spread, open interest,
  and contract-volume requirements are rechecked at the notification boundary.
- Current DTE, delta, liquidity, underlying price, and underlying timestamp are
  reused from the same exact-OCC response. No provider request was added.
- Favorable extension is measured from first capture to the current underlying
  quote. The prior-close session move remains context and is not mislabeled as
  chase after eligibility.
- The authoritative options callout's frozen option T1 and stop are persisted
  into new cases. They supply measured reward remaining and distance from
  invalidation; a strategy case without those current decision facts is owner
  watch, not an immediate alert.
- Premium expansion remains PAPER_ONLY. Old/stale, exhausted-target, and
  near-or-below-invalidation cases become TOO_LATE. Future-dated evidence fails
  closed to owner watch.
- Every strategy decision receives a deterministic 0-100 quality score. Only
  score 80 or higher may enter the immediate-owner lane. Lower scores are
  classified OWNER_WATCH or PERIODIC_DIGEST and remain persisted. Scheduled
  digest delivery is not implemented by this concern and must not be claimed.
- Eligible cases in one sweep are ranked before scarce Discord slots are used.
  The default immediate ceiling is now eight messages per session and two per
  symbol/session, down from the emergency 40 and four ceilings.

The timing diagnostics now expose the 27-strategy policy matrix, delivery-level
counts, quality-score buckets, per-strategy counts, and the full policy/metrics
attached to recent decisions. New strategy journal rows are stamped
`ASYM_NOTIFY_JOURNAL_V2`; legacy rows and ambiguous historical causes are not
rewritten.

## Validation

- Focused High-Asymmetry, runtime-edge, exact-quote, journal, migration, ranking,
  dedup, and notification tests: 125 / 125 passed.
- Full `npm test` passed twice: 3,462 / 3,462 both runs.
- `npx tsc --noEmit --incremental false` passed.
- `npm run build` passed.
- `git diff --check` passed before this packet edit.
- Migration review: six nullable journal columns are added after table creation
  with guarded repeat-safe ALTERs; dependent indexes are created by the base
  schema before no new indexed columns are introduced. Case target evidence is
  JSON-only and requires no DDL.
- Existing untracked files remain untouched.
- Graphify was not regenerated because its installed launcher still references
  the removed Python 3.11 runtime.

## RTH boundary and exact resume point

The ordinary options session was closed during implementation. No fresh RTH
High-Asymmetry alert, suppression, Discord delivery, or provider-capacity result
is claimed from offline tests.

1. Commit and push this green concern, deploy it, and verify the exact live SHA
   plus health/provider/loop state.
2. Verify the timing endpoint exposes `ASYM_NOTIFY_V3`,
   `ASYM_NOTIFY_JOURNAL_V2`, the strategy matrix, and delivery-level metrics.
3. During the next representative RTH window, measure fresh ALERT, OWNER_WATCH,
   PERIODIC_DIGEST, PAPER_ONLY, TOO_LATE, duplicate suppression, and actual
   Discord message counts. Confirm a fresh fully evidenced case can alert and
   that old/premium-expanded cases cannot.
4. Measure RTH exact-OCC cache reuse, in-flight dedup, admissions, refusals,
   request counts per case, and Core impact. Do not infer these from after-hours
   zero-work behavior.
5. Continue with the system-wide after-hours options-message audit,
   instrument-aware session authority, and end-to-end latency attribution.
6. Keep `PAPER_0DTE_RESEARCH_ENABLED` unset. Ask OptiScan and the Options page
   redesign remain behind the live trading safety work.
