# Historical Analog Engine — the learning path, and where it stops

**Status: RESEARCH ONLY / NOT_CALIBRATED_FOR_LIVE_AUTHORITY.**
Nothing described here is read by the scanner, strategy selection, contract selection,
targets, stops, exits, delivery eligibility, Discord routing or subscriber readiness.

## The loop

```
OBSERVE / FREEZE        setup_episodes (Zone A only, max_feature_as_of_ms <= t0)
      ↓                 episode/leakage.ts refuses to persist a leaky episode
LABEL                   episode_labels (V1, seeded replay)
                        episode_outcome_labels_v2 (V2, live forward, censoring preserved)
      ↓
HISTORICAL MEMORY       analog/corpus.ts — ONE evidence class per load, never mixed
      ↓
ANALOG RETRIEVAL        analog/retrieval.ts — chronological fence, self/duplicate exclusion,
                        per-ticker cap, partial-coverage distance
      ↓
OUTCOME DISTRIBUTION    analog/cohort-outcomes.ts — claim permitted BY THE CLASS,
                        abstains below 20 observations / 5 independent sessions
      ↓
EVALUATION              analog/analog-evaluation.ts — chronological, leak-audited
      ↓
SHADOW RESEARCH         GET /api/research/analog (authenticated, read-only)
```

**The loop is deliberately NOT closed into live authority.** Nothing feeds back. The last
arrow ends at a research surface, and it stays there until analog output is calibrated and
forward-validated on evidence it did not see.

## Evidence classes

Permission to make a claim is a property of the class, not a decision at the call site.

| Class | Exact option? | Option claim | Underlying claim |
|---|---|---|---|
| `FORWARD_EXACT_OPTION` | yes | ✅ | ✅ |
| `HISTORICAL_EXACT_OPTION` | yes | ✅ | ✅ |
| `PAPER_DELIVERED_FORWARD` | yes | ✅ | ❌ |
| `MODELED_OPTION` | no (Greeks reprice) | ❌ | ✅ |
| `FORWARD_UNDERLYING_ONLY` | no | ❌ | ✅ |
| `HISTORICAL_UNDERLYING_ONLY` | no | ❌ | ✅ |
| `SHADOW_OBSERVATION` | no | ❌ | ❌ |

`optionOutcomeDistribution` **throws** for any class in the ❌ column. Mixing classes throws
`EvidencePoolingError`. `HISTORICAL_EXACT_OPTION` and `PAPER_DELIVERED_FORWARD` keep their
existing engines (`historical/cohort-v2.ts`, `options/cohort-probability.ts`) — this layer
does not re-derive them.

## What the evidence actually supports (measured 2026-08-20, production)

| Class | rows | labeled | censored | symbols | sessions | range |
|---|---|---|---|---|---|---|
| `HISTORICAL_UNDERLYING_ONLY` | 11,679 | 11,679 | 0 | 5 | 247 | 2023-07-03 → 2024-06-28 |
| `FORWARD_EXACT_OPTION` | 6,051 | 710 | 5,341 | 21 | **1** | 2026-08-20 |
| `FORWARD_UNDERLYING_ONLY` | 7,665 | 0 | 7,665 | 33 | **1** | 2026-08-20 |
| `MODELED_OPTION` | 0 | — | — | — | — | — |

Consequences, stated plainly:

- **No option-return probability is computable today.** The only class with session breadth
  is underlying-only; the only class with exact option evidence has one trading day.
- **Every V2 episode is dropped as incomparable** (6,935 and 8,615 rows) because V2 rows
  carry a null `liquidity_tier`. That is a data gap, not a retrieval failure — and the
  engine refuses rather than defaulting a null tier to "low", which would have silently
  described 6,935 mega-cap episodes as low-liquidity.
- The two populations sit two years apart and are never pooled.

## Out-of-sample result, and why it should not be believed yet

200 chronological queries, leakage audit CLEAN (0 future, 0 self), 3 distinct query symbols:

| horizon | Brier | constant-predictor Brier | ECE | top vs bottom tercile |
|---|---|---|---|---|
| 5d | **0.2098** | 0.2496 | 0.135 | 0.788 vs 0.212 |
| 1d | **0.2552** | 0.2487 | 0.090 | 0.561 vs 0.439 |

At 5d the realized frequency rises monotonically with the prediction
(0.21 → 0.27 → 0.64 → 0.78) and beats a constant predictor. At 1d it is flat
(0.55 → 0.50 → 0.54 → 0.55) while predictions span 0.33–0.67, and the engine is **worse
than predicting the base rate every time**.

The most economical explanation of that gap is not a setup edge. It is multi-day drift
shared by three correlated mega-caps in a 2023–24 bull market: the longer the horizon, the
more of the label is common market direction, and neighbours selected on setup features
inherit the regime they sit in. The horizon closest to how OptiScan actually trades —
intraday, short-dated — is the one showing nothing.

The 5d number is also miscalibrated (ECE 0.135 against the 0.10 ceiling the Phase-D report
already uses) and rests on three tickers.

## Before any of this can earn authority

1. **Symbol breadth.** Three symbols cannot separate setup from regime. This is the binding
   constraint, and raising the per-ticker cap to work around it would only let one name
   supply a cohort.
2. **A regime/base-rate baseline inside the evaluator.** It currently reports no
   baseline comparison; `eval/harness.ts` has the bootstrap-CI machinery to borrow.
3. **`liquidity_tier` on V2 episodes**, or a comparability key that V2 actually records —
   without it the entire forward exact-option population is unreachable.
4. **More than one session of exact-option evidence.** The floor is 5 independent sessions
   and the population has 1.
5. **Forward validation** on evidence collected after these conclusions were written.
