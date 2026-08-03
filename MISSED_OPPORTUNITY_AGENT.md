# Missed Opportunity Agent

**Status:** core SHIPPED and DEPLOYED (`a5b763d`, `f225774`) · RESEARCH_ONLY ·
scheduling and live-recovery routing NOT STARTED
**Owner question it answers:** "Why did I find out about a +2,000% SPY call on
Twitter instead of from my own system?"

---

## Why it exists

On 2026-08-03 the owner reported SPY and NVDA calls running ~+2,000% and QQQ
~+200%. OptiScan called none of them. The owner should not be the system's miss
detector.

This subsystem answers, deterministically and per session:

1. Did a genuinely **executable** extreme move exist?
2. Did OptiScan **see** it?
3. If it saw it, **why did nothing go out**?

It is **not** a trader. It never sends a subscriber alert, opens or closes a paper
position, mutates a scanner rule, or promotes a strategy. Its output is evidence
and research proposals.

---

## The grading rule that makes it honest

**You enter by paying the ASK and exit by hitting the BID.** That is the only
convention that can produce `VERIFIED_EXECUTABLE`.

Every other basis is computed and **quarantined as a diagnostic**, in a separate
field, so no report can quote one as the result:

| Basis | Why it is not a result |
|---|---|
| `ASK_TO_ASK` | pretends you sold into your own offer |
| `MIDPOINT` | pretends the spread does not exist |
| `LAST_TRADE` | ignores whether anyone would trade with you |
| `DAILY_HIGH` | a print, not a fill |

A "+2,000% day" measured midpoint-to-midpoint on a contract with a 40% spread is a
statement about arithmetic, not about money. The suite pins this: a case whose
midpoint runs +900% while the bid never leaves the entry ask grades **0%
executable**.

### Two evidence tiers, never blurred

Verifying ask→bid for a **closed** session requires historical NBBO. Option
aggregates are TRADE prints — they prove a price occurred, never that it was
available.

| Tier | Source | Ceiling |
|---|---|---|
| **NBBO** | bid/ask OptiScan captured **live** (`options_research_observations`, `options_paper_marks`) | `VERIFIED_EXECUTABLE` |
| **TRADE** | minute aggregates fetched after the fact | `LAST_TRADE_ONLY`, forever |

**A contract OptiScan never quoted cannot produce an official missed-winner
claim.** That is the honest consequence of not having been there. It is a real
limit on this subsystem and is stated rather than papered over.

---

## Verification gates diagnosis

The classifier reads top to bottom and the first branch that holds decides.
Verification comes first: **a case that is not a verified executable winner cannot
be a "miss" at all.** Otherwise an unverified social-media percentage drives
engineering.

**A correct rejection is a first-class outcome.** Passing on a wide spread or an
already-extended move is the system working. Counting those as defects would
manufacture pressure to loosen exactly the gates that protect the subscriber, so
`rootCauseTally()` excludes them.

---

## Safety, structurally

| Guarantee | How it is enforced |
|---|---|
| Cannot starve live lanes | Provider work runs as `historical_research`, which holds **no minute reserve** — it can only spend from the shared pool |
| Cannot compete while saturated | The forensic makes **zero** provider calls; it reads persisted decisions and persisted NBBO |
| Cannot send / trade / mutate | Asserted by **import boundary test**, not by convention |
| Cannot silently change production | Every stored case records `productionChanged: false` |
| Bounded discovery | `MAX_PROVIDER_REQUESTS_PER_RUN = 40` |

The zero-provider-call property matters specifically because one thing this agent
must be able to investigate is *whether the provider budget caused the miss* — an
investigation that spent budget would corrupt its own evidence.

---

## Modules

| File | Responsibility |
|---|---|
| `types.ts` | Vocabulary: verdicts, root causes, recoverability, failure families |
| `returns.ts` | Executable return verification, threshold ladder, MFE/MAE. Pure |
| `reconstruct.ts` | What OptiScan saw, from the DB only. Zero provider calls |
| `classify.ts` | Deterministic root cause. No model is consulted |
| `forensic.ts` | Session forensic; joins the above into a case |
| `store.ts` | `missed_opportunity_cases`, additive and repeat-safe |
| `app/api/research/missed-opportunity/route.ts` | Owner-only, token-gated |

### Endpoint

```
GET /api/research/missed-opportunity
  ?date=2026-08-03&direction=CALL&symbols=SPY,NVDA,QQQ
  &threshold=2000&claimed=2000&source=...&persist=1
```

---

## First run — 2026-08-03, the session that prompted this

Run against production on the completed session. **RESEARCH_ONLY. NOT OFFICIAL
PERFORMANCE. NO PRODUCTION CHANGE.**

| | SPY | NVDA | QQQ |
|---|---|---|---|
| Verdict | `UNVERIFIED_EXTERNAL_CLAIM` | `PARTIALLY_EXECUTABLE` | `UNVERIFIED_EXTERNAL_CLAIM` |
| Executable ask→bid | **unverifiable** | **+64.06%** | **unverifiable** |
| Best OCC | — | `O:NVDA260810C00202500` | — |
| Candidate rows | 162 | 274 | 161 |
| Direction tally | **bullish 98** / bearish 64 | **bullish 169** / bearish 105 | **bullish 98** / bearish 63 |
| **Call contracts priced** | **0** | 13 | **0** |
| Put contracts priced | 1 | 9 | 3 |
| NBBO call contracts | **0** | 14 (827 obs) | **0** |
| Terminal reason | `no eligible contract in the preferred delta/DTE band` | `contract gate: insufficient_oi` | `no eligible contract in the preferred delta/DTE band` |
| Root cause | `INSUFFICIENT_EVIDENCE` | `NOT_A_VERIFIED_EXTREME_WINNER` | `INSUFFICIENT_EVIDENCE` |

### What this establishes

**Direction was not the failure.** OptiScan was predominantly **bullish** on all
three names — SPY 60%, QQQ 61%, NVDA 62% of candidate rows. The system read the
day correctly.

**On SPY and QQQ it never priced a single call contract.** 98 bullish candidate
rows each, and not one produced a selected call. The only contracts that reached
selection were puts. This is a **contract-selection** failure, not a discovery
failure and not a direction failure.

**It is not isolated.** Session-wide, `no eligible contract in the preferred
delta/DTE band` terminated **5,039 of 9,214 candidates — 54.7% of the entire
funnel.**

**NVDA is the control that proves the point.** It *did* price 14 call contracts
and produced 827 NBBO observations. Among the calls OptiScan actually quoted, the
best executable ask→bid return was **+64.06%** (paid 3.20, best later bid 5.25) —
reaching +25% in 22 minutes and +50% in 31 minutes, and never reaching +100%. The
claimed +2,000% contract was not among the ones it quoted, so from OptiScan's own
evidence that claim can be neither verified nor refuted.

### Named suspect for the next session — NOT PROVEN

`lib/research/options/live-deps.ts:91` fetches the Stage-2 chain as:

```ts
fetchOptionChain(symbol, { dteMin: 0, dteMax: 14, maxPages: 2 })
```

`maxPages: 2` is a hard truncation, and SPY/QQQ have by far the largest 0–14 DTE
universes in the market — thousands of contracts across daily expirations. NVDA's
is far smaller, and NVDA is the one name that *did* get calls priced.

**Ruled out already:** missing greeks. A live chain probe returned 342 SPY calls,
**323 with delta and 304 with bid > 0** — so `selectContractFromChain`'s
`delta != null` filter is not what emptied the call side.

**Exact test for the next RTH session:** log the post-filter chain composition at
`selectContractFromChain` for SPY — contracts received, how many survive each of
`side`, `bid > 0`, `dteOk`, `delta != null` — and compare against NVDA in the same
minute. If SPY's chain arrives without near-the-money calls for the traded
expiration, truncation is confirmed and the fix is a targeted fetch, not a larger
`maxPages`.

---

## Not yet built

Deliberately deferred; the core had to exist first.

- **Intraday monitoring** of a bounded liquid universe with provisional cases
- **End-of-day / weekend schedules** and owner-private reports
- **Live-recovery routing** — `LIVE_RECOVERABLE_OPPORTUNITY` re-entering the
  normal deterministic scanner, which decides on its own terms
- **Trade-tier discovery sweep** (`discoverTradeTierMoves` exists and is tested-by-
  construction but is not yet scheduled)
- **Quant findings, experiments, and the feedback bridge** to regular callouts
- **Matched controls** — no winner cohort may be studied without matched losers

## Invariants

- Never sends a subscriber alert. Subscribers never receive hindsight alerts.
- Never opens, closes, or marks a position.
- Never mutates a scanner rule, threshold, or strategy version.
- A `LIVE_RECOVERABLE_OPPORTUNITY` is **routed**, never promoted — the normal
  scanner reruns freshness, liquidity, spread, premium chase, conflict, and
  contract selection and makes its own decision.
- The advisory layer may explain a case; it may never decide one.
