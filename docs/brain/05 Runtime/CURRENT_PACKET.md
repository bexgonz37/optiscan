# Current Task Packet

Task ID: high-asymmetry-paper-lane-deploy-disabled (PAUSED — see resume point)

## Active position

- Branch: `main`
- Previous deployed commit: `6c15d3b` (docs `c9c5851` on top)
- This work: the automatic paper-trading lane, built and **DISABLED**
- Verified locally: `npm test` 2802/2802, `tsc --noEmit` clean,
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
