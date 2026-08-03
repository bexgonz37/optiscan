# OptiScan — Performance Recovery & Paid-Discord Readiness Plan

**Date:** 2026-08-02 · **Commit:** `18a7a1b` · **Planning only — no code changed.**
**Companion documents:** `OPTISCAN_ARCHITECTURE_AUDIT.md` (architecture — not repeated here), `PHASE3_NEXT.md`, `docs/brain/05 Runtime/CURRENT_PACKET.md`.

---

## New evidence found during planning (supersedes parts of the audit)

The audit measured the 89-alert *launch sample*. The **Quant Lab already holds a 357-alert delivered sample** (`/api/research/options/quant-lab`, `lib/research/options/quant-lab.ts`). It is far more diagnostic, and it changes the plan.

### Headline metrics — delivered lane, all_exited, realized, n=357

| Metric | Value |
|---|---|
| Win rate | **18.8 %** |
| Median return | **−44.8 %** |
| Expectancy | **−32.5 %** |
| Profit factor | **0.335** |
| **MFE** | **−24.6 %** |
| MAE | −36.9 % |
| Stop rate | **86.8 %** |
| T1 hit rate | 13.2 % |
| **T2 hit rate** | **0.0 %** |
| Detection→Discord latency | 247 ms |
| Completeness | **12.9 % (confidence: LOW)** |

### The single most important number: **MFE is NEGATIVE**

Maximum Favourable Excursion of **−24.6 %** means *the average delivered alert never once traded above its entry.* Its best moment was still 24.6 % underwater.

**This is not an exit-management problem. It is an entry problem.** Every plan that starts with "improve exits" is answering the wrong question.

But there are **two competing explanations, and they demand opposite responses**:

| Hypothesis | Mechanism | Response if true |
|---|---|---|
| **H1 — Measurement artifact** | Entry = ASK, marks = BID. On a 20 % spread the position is mechanically −20 % at t=0 before the market moves. `UNUSABLE_SPREAD` values of 15–28 % were observed in the asymmetry lane. | Signal may be fine. Fix the *reporting*, add spread-adjusted metrics, and stop gating on a metric that punishes wide spreads twice. |
| **H2 — Genuine signal failure** | Setups are wrong; 86.8 % stop rate and 0 % T2 are real. | Pause strategies, rebuild selection. |

**Both are partly true.** Evidence: `sr_reclaim` MFE **−6.5 %** vs `premarket_level_break` MFE **−39.7 %`. That dispersion is far larger than spread alone can explain — but the whole distribution is also shifted negative by the convention.

> **TASK A-1 — decompose these before doing anything else.** This is the highest-value hour of work in the entire plan.

### Cohort breakdown (n=357)

**By strategy family**

| Family | n | Win | Median | PF | MFE | Verdict |
|---|---|---|---|---|---|---|
| `premarket_level_break` | **179 (50 %)** | 19.6 % | **−50.1 %** | 0.383 | −39.7 % | **PAUSE** |
| `lower_high_continuation` | 36 | 8.3 % | −41.6 % | 0.284 | +4.6 % | **PAUSE** |
| `reversal_bounce` | 30 | 10.0 % | −28.1 % | **0.031** | −30.3 % | **PAUSE** |
| `pullback_continuation` | 27 | 18.5 % | −55.3 % | 0.248 | −32.7 % | **PAUSE** |
| `momentum_acceleration` | 25 | 12.0 % | −38.4 % | 0.094 | −28.0 % | **PAUSE** |
| `vwap_rejection` | 25 | 20.0 % | −44.8 % | 0.224 | −14.0 % | Contain |
| `sr_reclaim` | **18** | **44.4 %** | **−2.1 %** | **0.786** | −6.5 % | **KEEP — best** |
| `breakout_forming` | **13** | **30.8 %** | **−5.4 %** | **0.542** | −3.4 % | **KEEP — best** |

**By time of day** — `pre_open` n=179, median −50.1 % (this *is* `premarket_level_break`). Contrast `power_hour` n=16 win 43.8 % median −2.4 % MFE **+6.3 %**, `open_drive` n=20 win 40 % MFE **+12.4 %**.

**By DTE** — `dte=2` n=158 (44 %) median −45.8 %; `dte=5` n=18 median **−97.0 %**; `dte=8` n=49 median −60.5 %.

**By side** — calls n=281 median −44.8 %; puts n=76 median −44.3 %, PF 0.207. Direction is not the problem.

**By symbol — total-loss cluster**

| Symbol | n | Win | Median |
|---|---|---|---|
| `ORCL` | 16 | 0 % | **−99.7 %** |
| `DRAM` | 24 | 0 % | **−99.6 %** |
| `INTC` | 17 | 0 % | **−97.0 %** |
| `IWM` | 25 | 4 % | −49.8 % |
| `SQQQ` | 20 | **100 %** | **+159.9 %** ⚠ |
| `NFLX` | 19 | 52.6 % | +2.7 %, PF 1.899 |

**57 alerts (16 %) went to near-total loss.** And `SQQQ` at 100 % win / +159.9 % with an undefined profit factor is **not credible** — flag as suspected data contamination (compare the `seed_spark_*` rows pattern).

### The metadata catastrophe

`metadataCompleteness` from production:

| Dimension | Complete |
|---|---|
| mfeMae | 77.3 % |
| moneyness | **0 %** |
| deltaBand | **0 %** |
| marketRegime | **0 %** |
| exitPolicy | **0 %** |
| **qualityScore** | **0 %** |

> **Setup Quality / Confidence has NEVER been correlated with a single outcome.** The score that decides what every subscriber sees is 0 % populated in the analytics that would validate it.

This makes several of the requested Track A cohorts (moneyness, delta, regime, quality band, rule version) **currently impossible to compute**. Fixing persistence is a prerequisite, not an optimisation.

---

# TRACK A — PERFORMANCE RECOVERY

## A.1 The shortest rigorous process (in strict order)

**Step 1 — Decompose the negative MFE (½ day).**
For the 357 sample compute, per alert: `spreadPctAtEntry`, `MFE_askToBid` (current), `MFE_askToAsk` (spread-neutral), `MFE_midToMid`. Then:
`spreadDrag = MFE_askToAsk − MFE_askToBid`.
- If median `spreadDrag` ≳ 20 pts → H1 dominates → the reporting convention is producing much of the apparent catastrophe.
- If `MFE_askToAsk` is still strongly negative → H2 dominates → the signal is genuinely wrong.
**Nothing else in Track A should start before this resolves.**

**Step 2 — Backfill the 0 % metadata (1–2 days).** Persist `qualityScore`, `moneyness`, `delta`, `marketRegime`, `exitPolicyVersion`, `ruleVersion` at alert creation. Backfill what is derivable from stored evidence; leave the rest null. Without this, Steps 4–6 cannot run.

**Step 3 — Validate the total-loss cluster (½ day).** ORCL/DRAM/INTC at −97 % to −99.7 %: are these real expiries-to-zero, or a grading defect (e.g. missing exit mark graded as total loss)? 57 alerts = 16 % of the sample; if it is a grading defect the whole aggregate is wrong.

**Step 4 — Validate SQQQ (½ day).** 100 % win / +159.9 % / PF undefined over n=20 is not a plausible live result. Confirm or quarantine.

**Step 5 — Re-run the full cohort matrix** once Steps 2–4 land, with the metrics the brief specifies (count, gradeable, win rate, median, mean, expectancy, PF, MFE, MAE, +25/+50/+100/+200/+500, stop rate, invalidation rate, time-to-MFE, time-to-failure, missing-data rate, CI, minimum-sample warning).

**Step 6 — Only then** consider threshold changes, with `MINIMUM_SUPPORTED_SAMPLE = 20` per cohort enforced (already implemented in `cohort-builder.ts`).

## A.2 Immediate containment (does not wait for Step 1)

Independent of which hypothesis wins, these are defensible now because they reduce volume of the *worst-measured* lanes without touching the best:

| Action | Rationale | Volume impact |
|---|---|---|
| **Pause `premarket_level_break`** | 50 % of all alerts, median −50.1 %, MFE −39.7 % | −50 % |
| **Pause `reversal_bounce`** | PF **0.031** — worst in the system | −8 % |
| **Pause `momentum_acceleration`** | PF 0.094 | −7 % |
| **Pause `lower_high_continuation`** | win 8.3 % | −10 % |
| **Pause `pullback_continuation`** | median −55.3 % | −8 % |
| **Keep `sr_reclaim`, `breakout_forming`** | PF 0.786 / 0.542, MFE −6.5 / −3.4, the only credible families | keep |
| **Restrict to `power_hour` + `open_drive` + `afternoon`** | only windows with positive or near-zero MFE | — |
| **Block DTE ≥ 4** | dte=5 median −97 %, dte=8 median −60.5 % | — |

**Net effect: roughly an 83 % reduction in alert volume, retaining the two families with the only non-catastrophic economics.** This is exactly the "fewer alerts, higher quality" principle, and it is derived from measurement rather than taste.

"Pause" means **demote to `RESEARCH_ONLY`**, not delete. They keep capturing, marking and grading — they simply stop reaching subscribers.

## A.3 Findings mapped to the brief's checklist

| Requested finding | Evidence |
|---|---|
| Strategies to pause | 5 families above |
| Strategies deserving more data | `sr_reclaim` (n=18), `breakout_forming` (n=13) — both under the 20 minimum |
| Contract-selection defects | Confirmed: NVDA 0DTE returned +127/+138 % vs +12 % taken (`SIBLING_CONTRACT_CAPTURED`) |
| Late-entry defects | `pre_open` MFE −39.7 % vs `power_hour` +6.3 % |
| Liquidity defects | Cannot isolate — `moneyness`/`delta` 0 % complete |
| Weak setups dominating losses | `premarket_level_break` = 50 % of sample and the worst median |
| MFE positive but exits poor | **Rare — MFE is negative almost everywhere.** Only `lower_high_continuation` (+4.6), `open_drive` (+12.4), `power_hour` (+6.3) qualify |
| No valid target/stop | 69.6 % of alerts (`alertsMissingTargets 385/553`); T2 hit rate 0 % |
| Already premium-chased | Cannot isolate in the delivered lane — needs Step 2 |
| Should have stayed research-only | All five paused families |

## A.4 Deterministic promotion ladder

```
RESEARCH_ONLY → SHADOW → OWNER_PRIVATE → FORWARD_VALIDATED → SUBSCRIBER_ELIGIBLE
```

| Transition | Required evidence |
|---|---|
| `RESEARCH_ONLY → SHADOW` | Deterministic rule; ≥30 captured candidates; exact OCC on ≥95 %; zero AI in the decision path |
| `SHADOW → OWNER_PRIVATE` | ≥50 graded; grading completeness ≥80 %; median return > −10 %; MFE > 0 |
| `OWNER_PRIVATE → FORWARD_VALIDATED` | ≥10 valid trading days **forward**; ≥40 graded; PF ≥ 1.0; expectancy ≥ 0; median ≥ −5 %; stop rate ≤ 60 %; target/stop coverage 100 % |
| `FORWARD_VALIDATED → SUBSCRIBER_ELIGIBLE` | ≥20 valid days; ≥60 graded; PF ≥ 1.2; expectancy > 0; median ≥ 0; unclosed ≤ 5 %; paper link 100 %; Discord delivery ≥ 99 %; zero session/duplicate violations; version isolated |

**Version isolation:** every stage is keyed to `ruleVersion`. Any change to entry, selection or gating **resets the stage to `SHADOW`**. This is the mechanism that prevents "we fixed it, trust us."

---

# TRACK B — DISCORD LIFECYCLE COMPLETENESS

Current state: opening alert (553) + close (46) ⇒ **~92 % of alerts end in silence.** Zero `RETURN_MILESTONE` messages have ever been delivered.

## B.1 Event specification

Common field block for every active update:

```
Contract · Status · Current return · Highest return · Time open ·
Thesis health · What changed · Invalidation · Paper status · Data freshness
```

| # | Event | Deterministic trigger | Source | Dedup | Max freq | Priority |
|---|---|---|---|---|---|---|
| 1 | **OPENED** | delivery decision `DELIVER_TO_DISCORD` | `options_alerts` | 1 per thesis fingerprint | 1 | **P0** |
| 2 | **CONFIRMED** | trigger level trades after open | `opportunity_milestones` | `CONFIRMATION` | 1 | P1 |
| 3 | **NEW HIGH** | mark bid > prior max, < 50 % | `options_paper_marks` | `NEW_HIGH` | 1 / 30 min | P1 |
| 4 | **PULLBACK** | return drops ≥15 pts from MFE **and** MFE was ≥ +10 % | marks | `PULLBACK` | 1 per position | **P0** |
| 5 | **RECOVERED** | return regains prior MFE after a PULLBACK | marks | `RECOVERED` | 1 / 60 min | P1 |
| 6 | **THESIS STRENGTHENED** | ≥1 supporting evidence item added, none removed | thesis object (Track D) | `THESIS_STRENGTHENED` | 1 / 60 min | P2 |
| 7 | **THESIS WEAKENING** | ≥1 contradicting item added | thesis object | `THESIS_WEAKENING` | 1 / 60 min | P1 |
| 8 | **TARGET HIT** | mark bid ≥ T1/T2 | marks + targets | per target | 1 each | **P0** |
| 9 | **INVALIDATED** | invalidation level lost | live quote | terminal | 1 | **P0** |
| 10 | **CLOSED** | exit rule or time-based close | paper engine | terminal | 1 | **P0** |
| 11 | **REPORT CARD** | EOD after close | `report-cards.ts` | 1 per case | 1 | P1 |

**Rate limit:** hard cap **6 lifecycle messages per opportunity per session**. Priority on overflow: INVALIDATED > CLOSED > TARGET HIT > PULLBACK > milestone > NEW HIGH.

## B.2 Copy (deterministic templates, no AI)

**OPENED**
```
🟢 OPENED · NVDA $200 CALL · exp Aug 7
Entry $3.25 (ask) · Setup Quality 82/100
Target $4.55 (+40%) · Stop $2.44 (−25%) · Invalidation: loses VWAP $197.20
Why: level reclaimed, volume 2.4x, above VWAP
Paper: OPENED · Quote age 3s
Research/education only. Not financial advice.
```

**PULLBACK**
```
🟠 PULLBACK · NVDA $200 CALL
Now $3.05 (−6%) · High +34% · Open 42m
Gave back 40% of peak gain. Invalidation still intact ($197.20).
Thesis: unchanged · Paper: OPEN
```

**CLOSED**
```
⚫ CLOSED · NVDA $200 CALL
Final −18% · High +34% · Low −22% · Open 2h 14m
Reason: time-based exit (15:45 ET)
Report card at EOD.
```

## B.3 Discord-only answerability after this track

| Question | After Track B |
|---|---|
| Is it active? | ✅ every message states status |
| Winning or losing? | ✅ current return |
| Current return? | ✅ |
| Highest return? | ✅ |
| Thesis stronger/weaker? | ✅ (after Track D) |
| Pull back? | ✅ new state |
| Recover? | ✅ new state |
| Invalidate? | ✅ |
| Close? | ✅ |
| Why? | ✅ report card |

---

# TRACK C — RENAME AND REDEFINE CONFIDENCE

**Recommendation: `Setup Quality` — displayed as `82/100`, never with a `%`.**

Rejected: *Conviction Score* (implies belief about outcome), *Evidence Strength* (accurate but vaguer to a trader).

## C.1 Display

```
Setup Quality: 82/100

Supporting
✓ Fresh catalyst (12m old)
✓ Strong liquidity (OI 32,325 · vol 249k)
✓ Above VWAP (+0.4%)
✓ Option demand increasing (2.4x)

Penalties
• Wide spread (8.2%)
• Sector confirmation unavailable

Changed 76 → 82 · volume and structure confirmed
Setup Quality is a checklist score, not a probability.
```

## C.2 Specification

- **Inputs and weights:** unchanged from `lib/alert-scoring.js::setupScore` (momentum 20, volume 15, VWAP 8, level 7, contract volume 13, OI 12, spread 10, 0DTE 10, timing 10, risk penalty −25). **Do not retune now** — there are zero labeled quality-band outcomes (`qualityScore` 0 % complete).
- **Missing-data handling — change this.** Today every absent input coalesces to `0` (`Number(x ?? 0)`), so *missing* and *bad* score identically. Replace with: missing → excluded from the denominator, and surface `coverage: 7/9 inputs`. A score computed from 4 inputs must not present like one computed from 9.
- **Versioning:** add `setup_quality_version` to `alerts` / `options_alerts` and stamp every row.
- **Update cadence:** recompute on each lifecycle evaluation; persist the series.
- **Lifecycle event on change:** a move of **≥10 points** emits `THESIS_STRENGTHENED` (up) or `THESIS_WEAKENING` (down), capped at 1/60 min.
- **Avoiding probability implication:** no `%`, always `NN/100`, always the footer line, never adjacent to a win-rate figure.
- **No recalibration** until ≥200 labeled outcomes exist with `qualityScore` populated.

---

# TRACK D — STRUCTURED THESIS

Today `Thesis` = `symbol|direction|optionType|sessionDate` — a dedup key (`thesis-identity.ts:30-46`).

## D.1 Proposed object

```ts
Thesis {
  thesisId, symbol, direction, setupFamily,
  expectedBehavior:   string          // deterministic template, not prose
  confirmation:       { level, source, confirmedAtMs } | null
  invalidation:       { level, source, breachedAtMs }  | null
  supportingEvidence: EvidenceItem[]  // { field, value, source, observedAtMs }
  contradictingEvidence: EvidenceItem[]
  health:             STRONG | INTACT | WEAKENING | INVALIDATED
  lifecycleStatus:    CREATED | CONFIRMED | RUNNING | EXTENDED | CLOSED | INVALIDATED
  version, createdAtMs, updatedAtMs
}
```

## D.2 Rules

| Transition | Deterministic rule |
|---|---|
| Strengthens | supporting item added, none contradicting; or confirmation level trades |
| Weakens | contradicting item added; or Setup Quality falls ≥10 pts |
| Invalidates | invalidation level trades against the position |
| Closes | exit rule, target, or time-based close |
| Evidence attaches | only with `{field, value, source, observedAtMs}` — **no source, no attachment** |

**vs Setup Quality:** Setup Quality is *how good this looked at entry* (a number). Thesis is *what we claimed would happen and whether it still holds* (a state). One is a score; the other is a falsifiable claim.

**Duplicate suppression:** keep the existing fingerprint as the dedup key — it works (7 suppressed). The structured object hangs off it. **Do not make dedup depend on prose.**

**Prerequisite:** `confirmation` and `invalidation` are `null` everywhere today (`transition-runner.ts` passes `trigger: null, invalidation: null`). Deriving them is Track E's job and is the precondition for Tracks B#2, B#7, B#9 and `FAILED_BREAKOUT` measurement.

---

# TRACK E — TARGETS, STOPS, CLOSURE

Only **30.4 %** of alerts carry a target/stop. T2 hit rate is **0 %**.

## E.1 Minimum contract for a subscriber-eligible alert

| Requirement | Rule |
|---|---|
| Exact contract | valid OCC, verified in chain |
| Executable entry | ask > 0, spread ≤ 15 %, quote age ≤ 60 s |
| Confirmation | named level + source |
| Invalidation | named level + source |
| Target or management plan | T1 required; T2 optional; or explicit `MANAGED` mode |
| Time-based exit | mandatory — default 15:45 ET, 0DTE 15:00 ET |
| Max quote age at send | 60 s (stricter than the 120 s research default) |
| Closure rule | target ∪ stop ∪ invalidation ∪ time — always one fires |
| Grading rule | ask-in / bid-out; missing quote ⇒ `UNGRADEABLE`, never a loss |

**An alert that cannot satisfy all nine is BLOCKED from subscribers** and demoted to `RESEARCH_ONLY`. Not a watchlist item — a watchlist entry implies an actionable idea we have just said we cannot specify.

Given 69.6 % currently lack targets, this rule **alone** removes most of the remaining volume — which is the intent. Fewer, complete, followable.

## E.2 Guaranteed closure

Every open position gets a mandatory terminal event via a **sweeper job**:
1. target/stop/invalidation hit → CLOSED
2. else 15:45 ET → CLOSED (`TIME_EXIT`)
3. else expiry → CLOSED (`EXPIRED`)
4. else no mark for 3 consecutive attempts → `UNGRADEABLE_NO_QUOTE` (**never** a loss)

**Unclosed rate becomes a launch gate metric (≤5 %).** This directly attacks the 92 %-silent problem and the 6 `stuck_open` rows.

---

# TRACK F — EVIDENCE LEARNING

## F.1 The loop, with the missing edges named

```
completed opportunity ─✅→ marks ─✅→ outcome ─✅→ cohort aggregation
                                                        │
                                          ❌ EDGE 1: cohort builder is a SCRIPT
                                                        ▼
                              deterministic evidence comparison ─❌ EDGE 2→ research proposal
                                                        │        (improvement_proposals = 0 rows)
                                          ❌ EDGE 3: no review UI/workflow
                                                        ▼
                     human review → new version → shadow → forward → production approval
```

**Edge 1** — promote `scripts/asymmetry-build-cohorts.mjs` to a scheduled, budgeted job writing `research_cohorts`.
**Edge 2** — deterministic `proposal-generator.ts` writing `improvement_proposals` (status `DRAFT`), never applying.
**Edge 3** — a review surface (admin page or Discord owner-private) with explicit approve/reject, writing `approved_by` + `approved_at_ms`.

## F.2 Populations that must be in the ledger

winners · losers · rejected opportunities · silent High-Asymmetry captures · premium-chased · liquidity failures · **missed winners** (`reviewMissedWinners`) · normal scanner alerts · paper positions · historical replays.

Today: all captured **except** missed winners and historical replays, which are `LOCAL_ONLY`.

## F.3 The AI boundary (unchanged, and correct)

**AI may:** summarise findings, explain cohort differences, draft proposal text.
**AI may not:** change thresholds, alter gates, activate strategies, send alerts, open/close trades.

Enforced today by `RESEARCH_STATE_CAN_SEND` (uniformly false), `canResearchStateSend()` (returns false unconditionally), flags default-off, and `improvement_proposals` = 0 rows. **This boundary is the healthiest part of the system — preserve it exactly.**

---

# TRACK G — WEEKEND & CLOSED-MARKET DISCIPLINE

Measured Sunday 2026-08-02 23:40 ET: `callsThisMinute: 167`, `callsToday: 1228`, scanner tick **2 s**, `market_session: "closed"`.

## G.1 Behaviour matrix

| Window | Scanner | Discovery | Asymmetry sweeps | Marks | Grading | Learning | AI |
|---|---|---|---|---|---|---|---|
| Saturday | **OFF** | OFF | OFF | OFF | ON | ON | 1 bounded |
| Sunday | **OFF** | OFF | OFF | OFF | ON | ON | 1 bounded |
| Holiday | **OFF** | OFF | OFF | OFF | ON | ON | 1 bounded |
| Overnight (20:00–04:00) | **OFF** | OFF | OFF | recovery only | ON | ON | OFF |
| Premarket (04:00–09:30) | 30 s | ON | ON | ON | ON | OFF | OFF |
| Regular (09:30–16:00) | 2 s | ON | ON | ON | — | OFF | OFF |
| After-hours (16:00–20:00) | 30 s | OFF | ON (close-out) | ON | ON | OFF | 1 EOD |

## G.2 Implementation shape (not implemented)

A single `sessionAwareJobDue(job, nowMs)` wrapper in `lib/scheduler.ts` consulting `marketSession()`, with a per-job `runsWhenClosed: boolean`. One choke point, one test.

## G.3 Budget safeguards

- Reserve **≥25 %** of `POLYGON_DAILY_CALL_CAP` for the live scanner at all times.
- Research lane hard-capped by `ASYM_MAX_QUOTES_PER_SWEEP` (shipped, default 120).
- Closed-market ceiling: **≤500 provider calls/day** total.
- LLM: 1 call/session, existing daily+monthly caps (`lib/ai/asymmetry-budget.ts`).
- Alert when closed-market spend exceeds the ceiling — the exhausted-budget bug went unnoticed for a full session precisely because nothing alarmed.

**Estimated saving: ~95 % of weekend provider spend.**

---

# TRACK H — WATCHLIST TRUST

**Classification: ADMIN-ONLY NOW. Subscriber-safe only after all of the following.**

| Fix | Requirement |
|---|---|
| Session data lineage | every field carries `sourceTimestampMs` + `sessionDate`; reject cross-session |
| **Direct catalyst validation** | ticker must appear in the **headline**, or the provider marks it primary. Otherwise → `read_through` |
| Sector read-through labeling | explicit `catalystRelation: DIRECT | SECTOR_READ_THROUGH | NONE` |
| Stale-data rejection | quote > 10 min or news > 24 h ⇒ drop the field, not the row |
| Ranking transparency | show the rank inputs |
| Static-universe bias | cap mega-caps at ≤50 % of the list; log universe composition |
| Trigger/invalidation quality | numeric levels + source, not prose |
| Options tradability | verify a tradable OCC exists with spread ≤15 % |

**Why the NVDA/Alphabet case happens:** `fetchNews(symbol)` queries Polygon/Benzinga news by **ticker association**. Publishers tag an article with every ticker mentioned, so an Alphabet TPU story that mentions NVDA in the body returns under `NVDA`; the pipeline takes `results[0].title` as the catalyst with no salience check.

**If the catalyst fixes cannot land before launch, ship the Watchlist without catalyst text.** A watchlist with no catalyst is thin; one with a wrong catalyst is a credibility loss that is hard to recover.

---

# TRACK I — REPORT CARDS

Generated **entirely from stored evidence**. No AI invention. AI may only rephrase text already backed by a row.

```
📋 REPORT CARD · NVDA $200 CALL exp Aug 7 · Jul 31

Entry     $3.25 (ask) 12:23:47 ET
Final     $2.66 (bid) 15:45:00 ET · −18.2%
Highest   +34.1% at 13:10 ET
Lowest    −22.4% at 15:31 ET
Open      3h 21m

Timing    LATE_CONFIRMATION — 80% of the eventual move was already priced at alert
Exit      TIME_EXIT (15:45 ET)
Thesis    INTACT at close (invalidation $197.20 never breached)
Quality   82 → 71 (volume faded 13:40)

Worked    Level reclaimed and held; +34% available within 47m
Failed    Alerted after most of the move; no target was set, so the gain was not taken

Rule v ALERT_V3 · Data v ASYM_HIST_V1
Research/education only. Past results do not predict future results.
```

Every line maps to a persisted field. `Worked`/`Failed` are **selected from a fixed deterministic template set**, keyed by timing classification + exit reason — not free text.

---

# TRACK J — CONTENT ENGINE

**Priority: P3. Explicitly behind performance and lifecycle.**

Five formats, all sourced from verified records: live rationale, follow-up, late-alert lesson, missed-winner lesson, weekly summary.

Every claim requires: timestamps · exact OCC · entry convention · marks · lifecycle history · outcome version. **No automatic publishing in V1** — drafts only, owner-approved.

Isolation already verified in the audit: `contentDraftsJob` is `runJob`-wrapped with its own try/catch and writes only to content tables. **Note it currently runs every 3 minutes and has produced 0 rows — pause the job until V1 is real.**

---

# DETERMINISTIC LAUNCH GATE

Extends `lib/research/subscriber-readiness.ts`. **All REQUIRED gates must pass.**

| Gate | Fail | Warning | Required | Min sample |
|---|---|---|---|---|
| Forward trading days | <10 | 10–19 | **≥20** | — |
| Fully graded alerts | <40 | 40–59 | **≥60** | — |
| **Profit factor** | <1.0 | 1.0–1.19 | **≥1.2** | 60 |
| **Expectancy** | <0 | 0–5 % | **>0** | 60 |
| **Median return** | <−5 % | −5–0 % | **≥0 %** | 60 |
| Unclosed rate | >15 % | 5–15 % | **≤5 %** | — |
| Target/stop coverage | <90 % | 90–99 % | **100 %** | — |
| Paper linkage | <98 % | 98–99 % | **100 %** | — |
| Grading completeness | <90 % | 90–94 % | **≥95 %** | — |
| Discord delivery success | <98 % | 98–99 % | **≥99 %** | — |
| Duplicate rate | >1 % | 0–1 % | **0 %** | — |
| Session violations | >0 | — | **0** | — |
| Data integrity | any unresolved | — | **clean** | — |
| Legal readiness | not attested | — | **attested** | — |
| Billing readiness | not tested | — | **tested** | — |
| Role automation | not configured | — | **configured** | — |
| Support readiness | no runbook | — | **runbook + status page** | — |

**Profitability is not the only gate — but a strongly negative sample can never pass.** PF ≥1.2 with expectancy >0 is the floor.

**Version isolation:** gates evaluate **only** alerts whose `ruleVersion` equals the current one.
**Reset conditions:** any change to entry rules, contract selection, gate thresholds, or strategy activation **resets the forward window to zero**. Cosmetic/copy changes do not.

---

# PRIORITY MODEL

**P0 — before any paid launch:** MFE decomposition; metadata persistence; pause losing families; lifecycle delivery (OPENED/PULLBACK/TARGET/INVALIDATED/CLOSED); target-stop mandate; deterministic closure; rename Confidence; data-integrity fix; ≥20 forward days; Stripe; roles; legal.

**P1 — trustworthy beta:** structured Thesis; report cards; CONFIRMED/NEW HIGH/RECOVERED/WEAKENING; closed-market discipline; watchlist catalyst validation; verify mark fix; active-opportunity count.

**P2 — first month:** cohort scale-up; contract-selection study; threshold validation from the journal; learning edges 1–3; rule-version tracking; put-suppression explanation.

**P3 — research/V2:** content engine; calibration study; analog engine; lane router; Agents V2.

**DO NOT BUILD YET:** TikTok/Shorts/video; Higgsfield; real-money execution; AI-authored alerts; two-speed alerts; historical options replay lane.

> **Billing may be *prepared* in parallel, but paid access stays gated behind the deterministic gate.** Building Stripe does not authorise charging.

---

# THE NEXT 25 TASKS

| # | Task | Scope | Files | Why | Signal | Sub | Trust | Diff | Time | Risk | Deps | Blocks launch | P | Acceptance |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Decompose negative MFE** | Compute ask→bid vs ask→ask vs mid→mid MFE for 357 | `quant-lab.ts`, `shadow-outcomes.ts` | Decides whether signal or measurement is broken | ★★★★★ | — | ★★★★ | M | 4h | None | **YES** | P0 | Spread-drag distribution reported; H1/H2 resolved in writing |
| 2 | **Persist alert metadata** | qualityScore, moneyness, delta, regime, exitPolicy, ruleVersion at creation | `options_alerts`, `delivery.ts`, `live-deps.ts` | 5 of 12 dimensions are 0 % | ★★★★★ | — | ★★★ | M | 1d | Low | None | **YES** | P0 | `metadataCompleteness` ≥90 % on new alerts |
| 3 | **Validate total-loss cluster** | ORCL/DRAM/INTC −97…−99.7 %, n=57 | `shadow-outcomes.ts`, `paper_trade_outcomes` | 16 % of sample; may be a grading defect | ★★★★★ | — | ★★★★ | S | 4h | None | 1 | **YES** | P0 | Each classified real-expiry vs defect |
| 4 | **Validate SQQQ anomaly** | 100 % win / +159.9 % / PF undefined, n=20 | `quant-lab.ts`, `options_alerts` | Not credible; contaminates aggregates | ★★★★ | — | ★★★★★ | S | 2h | None | None | **YES** | P0 | Confirmed or quarantined |
| 5 | **Demote losing families to RESEARCH_ONLY** | Pause 5 families; keep sr_reclaim, breakout_forming | `delivery-decision.ts`, flags | Removes ~83 % of volume, worst economics | ★★★★★ | ★★★ | ★★★★★ | S | 1d | Med | 1 | **YES** | P0 | Only 2 families reach Discord; volume drop logged |
| 6 | **Mandate target/stop** | Block alerts lacking T1+stop+invalidation+time exit | `delivery-decision.ts`, `entry-quality-gate.ts` | 69.6 % lack them; T2 = 0 % | ★★★★ | ★★★★★ | ★★★★★ | M | 2d | Med | 5 | **YES** | P0 | Coverage 100 %; rest RESEARCH_ONLY |
| 7 | **Deterministic closure sweeper** | Every position gets a terminal event | `paper-engine.ts`, new sweeper | 92 % never close; 6 stuck rows | ★★★ | ★★★★★ | ★★★★★ | M | 2d | Med | None | **YES** | P0 | Unclosed ≤5 %; no position >1 session |
| 8 | **Lifecycle delivery: CLOSED** | Wire CLOSED to Discord | `milestones.ts`, `delivery.ts` | Highest-value single message | ★★ | ★★★★★ | ★★★★★ | M | 2d | Med | 7 | **YES** | P0 | 100 % of closed positions post |
| 9 | **Lifecycle delivery: TARGET/INVALIDATED** | Wire both | same | Actionable moments | ★★ | ★★★★★ | ★★★★★ | M | 2d | Med | 6,8 | **YES** | P0 | Fires once per event |
| 10 | **PULLBACK + RECOVERED states** | New states + delivery | `lifecycle.ts`, `milestones.ts` | Missing entirely; peak subscriber anxiety | ★★ | ★★★★★ | ★★★★ | M | 3d | Med | 8 | No | P1 | Fires on ≥15 pt give-back from ≥+10 % MFE |
| 11 | **Rename Confidence → Setup Quality NN/100** | Copy + display; no weight change | `alert-format.js`, `trade-verdict.ts` | Heuristic presented as probability | — | ★★★★★ | ★★★★★ | S | 1d | Low | None | **YES** | P0 | No `%` anywhere; footer present |
| 12 | **Setup Quality missing-data handling** | Missing → excluded, not 0; expose coverage | `alert-scoring.js` | Missing scores as bad | ★★★ | ★★ | ★★★★ | M | 1d | Med | 11 | No | P1 | `coverage: n/9` on every alert |
| 13 | **Fix data_integrity** | `missingMirror=4`, 6 stuck rows | `db-legacy-columns.ts`, grader | Failing safety gate | ★ | — | ★★★★ | S | 4h | Low | None | **YES** | P0 | Gate PASSES |
| 14 | **Closed-market scheduler gate** | `sessionAwareJobDue` + `runsWhenClosed` | `scheduler.ts`, `scheduler-policy.ts` | 167 calls/min on a Sunday | — | — | ★★ | M | 2d | Med | None | No | P1 | Weekend ≤500 calls/day |
| 15 | **Verify mark-path fix live** | Confirm `usableMarkPct` recovery | `/api/research/asymmetry/timing` | Blocks all learning | ★★★★ | — | ★★ | S | 2h | None | RTH session | No | P1 | usableMarkPct >50 %; ourFault ≈0 |
| 16 | **Structured Thesis object** | Schema + population | new `thesis.ts`, `schema.ts` | Currently a dedup key | ★★ | ★★★★ | ★★★★ | L | 5d | Med | 6 | No | P1 | Every alert carries confirmation + invalidation |
| 17 | **Report cards to Discord** | Deliver from stored evidence | `report-cards.ts`, `delivery.ts` | Retention; closes the loop | ★ | ★★★★★ | ★★★★★ | M | 3d | Low | 8 | No | P1 | 100 % of closed get one |
| 18 | **CONFIRMED + NEW HIGH delivery** | Wire remaining events | `milestones.ts` | Completes lifecycle | ★ | ★★★★ | ★★★ | M | 2d | Med | 8,16 | No | P1 | Dedup holds; ≤6 msgs/opportunity |
| 19 | **Watchlist catalyst salience** | Headline/primary-ticker check + DIRECT/READ_THROUGH | `next-session-plan.ts` | NVDA/Alphabet mis-attribution | ★★ | ★★★★ | ★★★★★ | M | 3d | Low | None | Conditional | P1 | No catalyst without salience proof |
| 20 | **Active-opportunity summary** | Hourly "what's open" post | `delivery.ts` | Subscribers can't see state | — | ★★★★ | ★★★ | S | 1d | Low | 8 | No | P1 | Accurate count + returns |
| 21 | **Contract-selection study** | Why Aug-7 over 0DTE (+12 % vs +127 %) | `contract-selector.ts`, cohort builder | Biggest known signal gap | ★★★★★ | ★★ | ★★★ | L | 5d | Low | 2 | No | P2 | ≥3 sessions, ≥20 winners |
| 22 | **Cohort builder → scheduled job** | Promote script to budgeted job | `cohort-builder.ts`, `scheduler.ts` | Learning edge 1 | ★★★★ | — | ★★ | M | 3d | Low | 15 | No | P2 | Writes `research_cohorts` nightly |
| 23 | **Proposal generator** | Deterministic DRAFT proposals | new `proposal-generator.ts` | Learning edge 2 | ★★★ | — | ★★★ | M | 3d | Low | 22 | No | P2 | Rows appear; nothing auto-applies |
| 24 | **Proposal review surface** | Approve/reject with attribution | admin route | Learning edge 3 | ★★ | — | ★★★ | M | 3d | Low | 23 | No | P2 | `approved_by` recorded |
| 25 | **Extend launch gate** | Add unclosed, target coverage, version isolation, reset | `subscriber-readiness.ts` | Makes launch decidable | — | — | ★★★★★ | M | 2d | Low | 6,7 | **YES** | P0 | Gate reflects all criteria; resets on rule change |

**Stripe, Discord roles and legal are deliberately *not* in the top 25.** They are real P0 launch blockers but are independent workstreams that can proceed in parallel and are not on the critical path to knowing whether the product works.

---

# FIRST FIVE ENGINEERING CHECKPOINTS

Each is bounded, testable, reversible, and produces evidence.

### Checkpoint 1 — Diagnose before treating
**Objective:** resolve H1 vs H2 and make the cohort matrix computable.
**Scope:** tasks 1–4. Analysis + metadata persistence only. **No behaviour change.**
**Tests:** unit tests for spread-drag; metadata completeness assertions.
**Verification:** `metadataCompleteness` ≥90 % on new alerts; written H1/H2 determination.
**Rollback:** metadata columns are additive; analysis is read-only. Nothing to roll back.
**Evidence:** spread-drag distribution; total-loss classification; SQQQ verdict.

### Checkpoint 2 — Stop the bleeding
**Objective:** only the two credible families reach subscribers.
**Scope:** task 5 + task 13. Flag-driven demotion.
**Tests:** delivery-decision tests asserting paused families never yield `DELIVER_TO_DISCORD`.
**Verification:** `/api/research/options/pipeline-health` shows only `sr_reclaim` + `breakout_forming` delivering; volume drop logged.
**Kill switch:** `OPTIONS_STRATEGY_ALLOWLIST` env — clearing it restores prior behaviour instantly.
**Evidence:** before/after volume and family mix.

### Checkpoint 3 — Complete the contract
**Objective:** every delivered alert has a target, stop, invalidation and a guaranteed close.
**Scope:** tasks 6, 7.
**Tests:** an alert lacking any required field is `RESEARCH_ONLY`; sweeper closes every open position.
**Verification:** target/stop coverage 100 %; unclosed ≤5 % after one session.
**Kill switch:** `OPTIONS_REQUIRE_TARGETS=0`.
**Evidence:** coverage and unclosed rate before/after.

### Checkpoint 4 — Make it followable
**Objective:** OPENED → CLOSED is never silent.
**Scope:** tasks 8, 9, plus task 11 (rename ships with the copy change).
**Tests:** dedup and rate-limit tests; no `%` in any Setup Quality string.
**Verification:** 100 % of closed positions post a CLOSED message; ≤6 messages per opportunity.
**Kill switch:** `OPTIONS_LIFECYCLE_DISCORD_ENABLED=0`.
**Evidence:** lifecycle message counts by type; unclosed-in-Discord rate.

### Checkpoint 5 — Make the gate decidable
**Objective:** the launch gate reflects reality and resets on change.
**Scope:** tasks 25, 14.
**Tests:** gate math; version isolation; reset-on-rule-change.
**Verification:** `/api/research/options/subscriber-readiness` shows the new gates and the current `ruleVersion` window; weekend spend ≤500 calls/day.
**Rollback:** gate is read-only reporting; stricter gates cannot enable anything.
**Evidence:** first forward-window readout.

Each checkpoint ends with `graphify update .`, a brain-note update, and a `CURRENT_PACKET.md` refresh.

---

## Appendix — what changed vs the audit

The audit's 89-alert launch sample understated the problem. The 357-alert Quant Lab sample shows median **−44.8 %** (vs −21.6 %), PF **0.335** (vs 0.253 — similar), and adds the decisive fact the audit did not have: **MFE is negative**, and **5 of 12 diagnostic dimensions are 0 % populated**. Plan accordingly.

---

# CHECKPOINT 1 RESULT — 2026-08-02 (supersedes the Track A hypotheses above)

The plan's Track A framed the question as spread-drag (H1) vs signal failure
(H2). **Both framings were incomplete.** Measured findings:

1. **The fill convention was misdescribed.** Entry is the MID, not the ask
   (`delivery.ts` → `entryFill: i.entry.mid`), and the exit leans 60% toward the
   bid (`paper.ts::realOptionExit`). Immediate drag is **−0.3 × spreadPct** —
   a 10% spread costs 3%. A −24.6% MFE would need an 82% spread. **H1 as
   originally framed is arithmetically dead.**

2. **The dominant cause is the bracket, which the plan did not consider.**
   Median target **+44.94%**, median stop **−44.94%** (1:1) at an **18.29%**
   win rate ⇒ implied expectancy **−28.5%** vs observed **−25.88%**. 36/40
   stops are wider than −40%. This is structural arithmetic, not measurement
   and not signal direction.

3. **The headline sample is 85% unverified.** 471 of 553 rows fail the
   paper-chain verifier; the Quant Lab query filters only on
   `status='EXITED'`. Over the **verified 82**, MFE median is **−4.21%** (not
   −24.6%) and **43.9% of trades traded profitably at some point**.

4. **84.1% of verified trades have a degenerate mark series** — one mark reused
   across all seven horizon buckets.

**Consequence for the plan:** Track A's "pause the losing families" step is
**suspended**. Those rankings came from the contaminated 357 sample. The bracket
fix (new) and mark density are Checkpoint 2; strategy pauses wait for a clean
re-ranking over verified rows only.
