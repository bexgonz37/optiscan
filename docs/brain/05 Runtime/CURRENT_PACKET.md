# Current Task Packet

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
