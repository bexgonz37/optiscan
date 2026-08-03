# Phase 3 — Status and What's Next

**Updated:** 2026-08-02
**Deployed from:** `main`

Paste this to another assistant to get useful direction without re-deriving anything.

---

## The three findings that matter

### 1. Historical option data IS entitled. The repo said it wasn't.

Two modules asserted historical option NBBO was "not integrated or entitled".
Only the first half was true. Probed against the live key:

| Endpoint | Result |
|---|---|
| `GET /v3/quotes/{OCC}` | **200** — NBBO + sizes, confirmed back to **2023-07-31** |
| `GET /v3/trades/{OCC}` | **200** |
| `GET /v2/aggs/ticker/{OCC}/...` | **200** — 1-min and daily |
| `reference/options/contracts?expired=true` | **200** — back to 2010 expirations |
| Rate limit | 40 concurrent → 40×200, zero 429s |

Re-verify: `node scripts/massive-capability-probe.mjs`

**Still genuinely unavailable at any depth:** historical Greeks, IV, open
interest. Cohort rows for past sessions leave them **null**, never borrowed.

### 2. The `NO_QUOTE` epidemic was budget exhaustion, misfiled. **FIXED.**

Production 2026-07-31: **2,718 `NO_QUOTE` mark rejections, 7 usable marks (0.4%)**.
Sampling 35 real cases resolved a usable quote **35/35** — the contracts were fine.

Cause: reading ONE contract cost up to 3 requests via `fetchOptionChain`. The
transition sweep does that per case per 60s → **~1,119 req/min vs a 280/min cap**,
~436,000/session vs a **200,000/day cap shared with the live scanner**.
`/api/health` confirmed `callsToday = dailyCap = 200,000`. After exhaustion,
quota refusals were recorded as `providerError: null` — a *genuine* no-quote.

Fixed in `bb5f2a2`:
- `fetchOptionContractSnapshot` — one request, exact contract (**2.83× measured**)
- `PROVIDER_BUDGET` and `NO_TWO_SIDED_MARKET` as distinct reasons
- bounded per-sweep budget with round-robin rotation
- transient rejections are retryable (they used to consume the horizon permanently)

### 3. The NVDA miss was CONTRACT SELECTION, not gate tightness.

First real cohort run (NVDA 2026-07-31, 40 near-the-money contracts, 67 requests):
2 winners, 20 controls, 18 ungradeable.

| Contract | Entry→Exit | Return |
|---|---|---|
| `O:NVDA260731C00197500` (0DTE) | $1.45 → $3.45 | **+137.93%** |
| `O:NVDA260731C00200000` (0DTE) | $0.48 → $1.09 | **+127.08%** |
| `O:NVDA260807C00200000` — *what the radar took* | $3.25 → $3.65 | **+12.3%** |

Right underlying, right side, right session, **wrong expiry**. Classified
`SIBLING_CONTRACT_CAPTURED`. **Loosening ASYM_NOTIFY_V2 would not have found
either winner.** The earlier `LATE_CONFIRMATION` timing verdict still stands, but
it is the smaller of the two problems.

---

## Shipped

| Commit | What |
|---|---|
| `fb34d2f` | `asymmetry_notify_decisions` — every gate decision + thresholds in force |
| `b71ab7b` | Historical exact-OCC client, accounting, caps, cache, capability matrix |
| `6bf8a9b` | Timing classifier, reconstruction, field lineage |
| `0a62fed` | Timing diagnostics endpoint; transitions now carry the fingerprint |
| `bb5f2a2` | **P0** — quote path cost + attribution + retryability |
| `80b0e79` | Historical winner/control cohorts, missed-winner review |
| `e9ce055` | Docs |

**Unchanged on purpose:** no threshold tuned, `canSendSubscriber: false`,
`automaticRealTrading: false`.

---

## Next, in priority order

### P1 — Verify the P0 fix on a live session
Nothing else is trustworthy until marks work. On the next RTH session check
`/api/research/asymmetry/timing`:
- `rolloverCheckViability.usableMarkPct` — was **0.4%**, should rise sharply
- `rejectionsByKind.ourFault` — should collapse; residual `contractReality` is healthy
- `/api/health` `callsToday` — must stay well under `dailyCap`. **If it pins again,
  find the consumer; do not raise the cap.**
- `casesDeferredForBudget` — non-zero is normal (rotation working). Persistently
  equal to `casesRead` means tune `ASYM_MAX_QUOTES_PER_SWEEP`.
- `paperActivation.activationState` should leave `BLOCKED_QUOTE_PATH_DEFECT`.
  **Do not** set `HIGH_ASYMMETRY_PAPER_ENABLED` to force it.

### P2 — Investigate contract selection
This is now the biggest known gap. The radar picked a 3–7 DTE contract when the
0DTE at the same strike returned 10× more. Look at how the asymmetry lane picks
an OCC. **Do not** conclude "always take 0DTE" from one example — run the cohort
builder across more sessions first.

### P3 — Scale the cohorts
`node --experimental-strip-types scripts/asymmetry-build-cohorts.mjs NVDA 2026-07-31 --entry 14:00 --exit 19:45 --max 40`

~2.2 requests per contract. Caps: `ASYM_HIST_MAX_PER_RUN` (2,000),
`ASYM_HIST_MAX_PER_SYMBOL` (200). Need **≥20 winners and ≥20 controls** before
any feature difference is evidence. Run more symbols and sessions.

### P4 — Free mapping wins (zero provider cost)
Already fetched then dropped: `impliedVolatility`, `gamma`, `optionVolume`,
`marketAlignment`. Note `transition-runner` passes `contractVolume: null`, so the
`minContractVolume: 25` gate check is **inert** and cannot fire.

### P5 — Threshold proposals
Only with a populated journal AND a graded cohort. `decideNotification` can be
re-run over stored rows at any threshold with **no provider call** (proven by test).
Proposals only, with sample sizes.

---

## Validation

- `npx tsc --noEmit --incremental false` — **clean**
- `npm run build` — **clean**
- `npm test` — **3071 tests.** One run 3071/3071; the other 3070/3071.

The single failure is `tests/options-monitor.test.mjs` test 6, which asserts
`Date.now() - t0 < 10` — a 10 ms wall-clock budget that flakes under full-suite
load. Passes 5/5 in isolation, unrelated to this work. **Not touched to make the
gate green**; it should be made robust separately.

---

## Do not conclude yet

- `asymmetry_notify_decisions` has one partial session. **120s and 50% remain
  provisional and unvalidated.** Neither was changed.
- 2 winners vs 20 controls is below the minimum of 20 per cohort.
- The rollover threshold's low suppression count means only that it **could not
  fire** while marks were broken — not that it is well set.
