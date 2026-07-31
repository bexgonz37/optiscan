# Phase 3 — Where We Are and What's Next

**Written:** 2026-07-31
**Deployed from:** `main`
**Previous checkpoint:** `84ca695` (ASYM_NOTIFY_V2)

This file is a handoff. It is written so you can paste it to another assistant
and get useful direction without re-deriving anything.

---

## 1. The two findings that matter most

### Finding A — Historical option data IS entitled. The repo said it wasn't.

Two modules asserted that historical option quotes/NBBO were **"not integrated
or entitled"**:

- `lib/research/replay-provider.ts`
- `lib/research/asymmetry/source-priority.ts` (`historicalOptionQuotes: NOT_AVAILABLE`)

**Half of that was wrong.** Nothing was *integrated* — true. But the Massive plan
**is entitled**. A direct probe on 2026-07-31 confirmed:

| Endpoint | Result |
|---|---|
| `GET /v3/quotes/{OCC}` | **200** — full NBBO with `bid_price`, `ask_price`, `bid_size`, `ask_size`, nanosecond `sip_timestamp`. Confirmed back to **2023-07-31** on expired contracts. |
| `GET /v3/trades/{OCC}` | **200** — price/size/conditions |
| `GET /v2/aggs/ticker/{OCC}/...` | **200** — 1-min and daily OHLCV on option tickers |
| `GET /v3/reference/options/contracts?expired=true` | **200** — expired contracts back to 2010 expirations |
| Rate limit | 40 concurrent requests → **40× 200, zero 429s**, no rate-limit headers |

**Consequence:** the historical winner/control cohort work (plan sections 5–7)
was believed impossible. It is possible. That belief is why no cohort ever existed.

Re-verify anytime: `node scripts/massive-capability-probe.mjs`

**Still genuinely unavailable at any depth:** historical Greeks, historical
implied volatility, historical open interest. These are snapshot-only. Cohort
rows for past sessions must leave them **null**, never borrow today's value.

### Finding B — The rollover half of ASYM_NOTIFY_V2 is INERT in production.

The 50% give-back check reads `peakAskSinceCapture` from persisted forward marks.
Production on 2026-07-31:

```
markRejections: NO_QUOTE 1183, FUTURE_QUOTE 39, STALE_QUOTE 1
markHealth (usable/total by horizon):
  1m 2/217   3m 3/205   5m 1/204   10m 1/196   15m 0/186   30m 0/162   60m 0/60
```

**~7 usable marks out of ~1,230 attempts (0.6%).** So `peakAskSinceCapture` is
`null` for virtually every case, and the give-back threshold **cannot fire**.

A low rollover-suppression count therefore does **not** mean the population is
healthy — it means the check never ran. The same quote-path defect also has paper
trading blocked: `activationState: BLOCKED_QUOTE_PATH_DEFECT`, `entriesSkipped: 204`.

**This is the highest-priority fix. Everything about the 50% threshold is
unmeasurable until it lands.**

---

## 2. NVDA reconstruction — what actually happened

Reconstructed from persisted case rows + historical exact-OCC NBBO.
Command: `node --experimental-strip-types scripts/asymmetry-reconstruct-nvda.mjs <live-snapshot.json>`

### `O:NVDA260807C00200000` — the one the current gate lets through

| | |
|---|---|
| First capture | 16:23:47.611Z @ ask **$3.25**, underlying $197.23 |
| HIGH_ASYMMETRY sweep | 16:52:00.199Z @ bid $3.55 / ask **$3.65**, underlying $198.10 |
| Capture→alert delay | **1,693s (28 min)** |
| Quote age at alert | **0s** (fresh) |
| Premium expansion | **+12.31%** (under the 20% chase bar) |
| Peak-to-alert give-back | 0.00% |
| 5-min momentum | +0.09% (positive) |
| VWAP | $196.69 — price **above** |
| Session peak premium | $3.75 |
| **Verdict** | **`LATE_CONFIRMATION`** — **80%** of the session's eventual premium gain was already realized at the alert |
| **Would ASYM_NOTIFY_V2 suppress it?** | **NO. `notify=true`, reason `NOTIFY`.** |

### `O:NVDA260803C00197500` — the one the current gate stops

| | |
|---|---|
| First capture | 15:38:24.421Z @ ask **$1.78**, underlying $196.28 |
| HIGH_ASYMMETRY sweep | 16:52:00.199Z @ bid $2.60 / ask **$2.62** |
| Capture→alert delay | **4,416s (73 min)** |
| Premium expansion | **+47.19%** |
| **Verdict** | **`PREMIUM_CHASE`** |
| **Would ASYM_NOTIFY_V2 suppress it?** | **YES** — `PREMIUM_CHASE_47.2` |

### The conclusion

**ASYM_NOTIFY_V2 does not catch the failure mode that prompted the concern.**

The 200C alert passed all three checks — fresh quote, no give-back, chase under
20% — and still arrived with 80% of the move already priced in. The gate has no
check for *"how much of the eventual move is left"*, because at decision time
that requires lookahead it does not have.

**Do not fix this by tightening the chase threshold from one example.** The
honest next step is a *leading* proxy for "move mostly over" that needs no
lookahead. Candidates worth testing against the cohort once one exists:

- time since the underlying's local high
- premium expansion **rate** (per minute) rather than level
- distance from VWAP as a fraction of the session range
- whether the state promotion lagged the underlying breakout

### Caveat, stated plainly

Which of the two was the message the user actually saw is **not attributable**
from the diagnostics that existed at the time — `asymmetry_transitions` did not
select `fingerprint`, and a whole sweep shares one `occurred_at_ms`. **That gap is
now fixed** (fingerprint added to both diagnostics endpoints). Inference: the
197.5C would have been suppressed as `PREMIUM_CHASE_47.2`, so the delivered one
was almost certainly the **200C**.

---

## 3. What shipped in this checkpoint

| Module | Purpose |
|---|---|
| `lib/research/asymmetry/notify-journal.ts` | **`asymmetry_notify_decisions`** — every gate decision with full evidence **and the thresholds in force**. This is what makes 120s/50% evaluable later. |
| `lib/research/asymmetry/historical/request-accounting.ts` | Deterministic per-kind request counting, caps, backoff, circuit breaker, `PROVIDER_BUDGET_BLOCKED` |
| `lib/research/asymmetry/historical/cache.ts` | Cache keyed `[OCC \| window \| dataType \| providerVersion \| dataVersion]`; settled windows never expire |
| `lib/research/asymmetry/historical/massive-historical.ts` | Historical NBBO / trades / aggregates, point-in-time quote, truncation reporting |
| `lib/research/asymmetry/historical/capability-matrix.ts` | The **probed** capability matrix — evidence, not assumption |
| `lib/research/asymmetry/timing-classification.ts` | Post-hoc verdict, exactly one of the eight labels |
| `lib/research/asymmetry/reconstruct.ts` | Case timeline rebuild from persisted rows + historical data |
| `lib/research/asymmetry/field-lineage.ts` | Field-by-field lineage; `resolutionPlan()` **refuses** to justify a provider call for presentation-only fields |
| `app/api/research/asymmetry/timing/route.ts` | Read-only timing diagnostics. **Issues zero provider calls.** |
| `scripts/massive-capability-probe.mjs` | Re-runnable entitlement proof (~15 requests) |
| `scripts/asymmetry-reconstruct-nvda.mjs` | The reconstruction above |

**Behaviour deliberately unchanged:** no threshold was tuned, `canSendSubscriber:
false`, `automaticRealTrading: false`, capture/marks/paper/Quant untouched.

### Free wins found by the lineage audit (zero provider cost)

These are **already fetched and then dropped before persistence**:

- `impliedVolatility`, `delta`, `gamma` — in the chain payload, only `delta` is mapped
- `optionVolume` — **`transition-runner.ts` passes `contractVolume: null`, so the
  `minContractVolume: 25` gate check is INERT and can never fire**
- `marketAlignment` — market context is already computed each tick, never written to the case

---

## 4. What's next, in priority order

### P0 — Fix the quote path feeding forward marks
Without this, marks stay at 0.6% usable, the rollover threshold stays inert, paper
stays `BLOCKED_QUOTE_PATH_DEFECT`, and no outcome grading is possible.
Start at `lib/research/asymmetry/mark-runner.ts` and the `NO_QUOTE` rejection path.
**Everything downstream is blocked on this.**

### P1 — Let the journal accumulate
`asymmetry_notify_decisions` starts empty. Give it real sessions before drawing any
conclusion about 120s or 50%. The counterfactual replay is already proven by test:
re-run `decideNotification()` over stored rows at any threshold, **no provider calls**.

### P2 — Wire the historical client into a cohort builder
Everything needed exists. Build `historical/cohort-builder.ts`:
1. `GET /v3/reference/options/contracts?expired=true` + expiration range → universe
2. `fetchPremiumCurve()` (1-min aggregates) → find +100% / +200% / +500% moves
3. `fetchQuoteAtInstant()` → ask-based hypothetical entry, bid-based marks
4. Match controls on date, time-of-day, liquidity, side, DTE, premium, moneyness, spread

**Rules:** ask for entry, bid for marks, never midpoint, no future evidence, no
control cohort → no winner analysis. Missing executable quote → **ungradeable**, not a loss.

**Cost warning:** cost is linear in contracts. The caps exist for this
(`ASYM_HIST_MAX_PER_RUN` default 2,000; `ASYM_HIST_MAX_PER_SYMBOL` default 200).
Start with **one symbol, one day** and read the accounting before scaling.

### P3 — Collect the free mapping wins
Persist IV/gamma/volume/marketAlignment. Zero provider cost, and it makes the
`minContractVolume` gate actually work (strictly stricter, never looser).

### P4 — Only then, threshold proposals
With a graded cohort and a populated journal, measure whether 120s/50% suppress
genuine winners. **Proposals only, with sample sizes. Do not auto-change either.**

---

## 5. Not done, and why

| Plan section | Status |
|---|---|
| §5 Historical cohorts | **Not built.** Client + accounting + caps are ready; the builder is not. Blocked behind P0/P2. |
| §6 Quant timing analysis | **Not runnable.** The journal is empty and no graded cohort exists. Machinery is in place. |
| §7 Missed-winner review | **Not runnable.** Needs §5. |
| Threshold validation | **Deliberately not done.** No sample. Reporting a number here would be fabrication. |

The `/api/research/asymmetry/timing` endpoint reports cohorts as
`available: false` **with a reason** rather than as zeros — "not yet measured"
must never read as "measured and empty".

---

## 6. Validation status (be honest about this)

- `npx tsc --noEmit --incremental false` — **clean**
- `npm run build` — **clean**
- `npm test` — **3029 tests. One run 3029/3029 green. Two runs 3028/3029.**

The single failure is **`tests/options-monitor.test.mjs` test 6**, which asserts
`Date.now() - t0 < 10` — a 10 ms wall-clock budget that flakes under full-suite
load. It passes **5/5 in isolation** and is unrelated to this work (options-monitor,
not asymmetry). **It was not "fixed" to make the gate green** — it is a real
pre-existing flake and should be made robust separately.

---

## 7. Live validation still outstanding

- Confirm `asymmetry_notify_decisions` is populating in production after deploy
- Confirm `/api/research/asymmetry/timing` returns `rolloverCheckViability.inert: true`
  (it should, until P0 lands — that is the check working correctly)
- Confirm the alert-to-capture ratio computed from the journal matches the counters
- Confirm no change in provider spend (this checkpoint adds **zero** calls to the live path)
