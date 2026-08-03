# OptiScan Autonomous Roadmap — Status

**Updated:** 2026-08-03 · **Deployed:** `a5f5976` (pushed; see *Deployment* below) · **Started from:** `7246304`

Durable status for the Gate B–G roadmap. Updated after every gate.

---

## Current stage

**Gate B — IN PROGRESS.** B1/B2/B3/B5/B6 shipped; **B5 is now MEASURED**.
B4, B7, B8 not started.

## Gate ledger

| Gate | Scope | Status | Evidence |
|---|---|---|---|
| **A** | FUTURE_QUOTE root cause + fix | **PASSED** | 8-min live sample: 135 marks, **0 FUTURE_QUOTE**, 69.6% usable (from 24.4%) |
| **B1** | Persist per-attempt mark evidence | **DEPLOYED_UNPROVEN** | `asymmetry_mark_evidence` table live; no session has populated it yet |
| **B2** | Define/enforce mark independence | **DEPLOYED_UNPROVEN** | Enforced in the runner; rate not yet measured |
| **B3** | Horizon windows | **DEPLOYED** | Non-overlap asserted by test across all 7 horizons |
| **B5** | Massive consumer audit | **MEASURED — defects fixed, effect unconfirmed** | Full live table below; three defects found and corrected in `a5f5976` |
| **B6** | Durable provider accounting | **PROVEN** | 172 minutes / 48,135 requests recorded and read back across a deploy boundary |
| **B4** | Scheduler fairness / long horizons | **NOT STARTED** | 30m 15/173, 60m 12/133 remain weak |
| **B7** | Per-consumer provider budgets | **NOT STARTED** | Unblocked and now well-specified by the B5 table |
| **B8** | Live Gate B validation | **BLOCKED** | Needs one full RTH session on `a5f5976` |
| **C** | Verified performance | **BLOCKED** | Requires `independentMarkPct >= 50%` |
| **D** | Historical learning | **NOT STARTED** | Independent of C |
| **E** | Experiment registry | **NOT STARTED** | — |
| **F** | High-Asymmetry lifecycle | **NOT STARTED** | Owner-private parts could start early |
| **G** | Subscriber readiness | **BLOCKED** | Paid launch blocked |

---

## Gate B5 — THE MEASUREMENT

Read live from `/api/system/provider-usage` at **2026-08-03 19:22 UTC**, mid-RTH,
on deployment `8282ecb`. 172 minutes observed, `accountingVersion: 1`.

### Totals

| Metric | Value |
|---|---|
| Total requests | **48,135** |
| Total quota blocks | **337,431** |
| Peak requests/minute | **286** (cap 280 → 102.1%) |
| Avg requests per active minute | **279.9** |
| Provider errors | 3 |
| HTTP 429 | 0 |
| Cache hits recorded | **0** |
| Dedup avoided recorded | **0** |

The minute cap was pinned at **280/280 for essentially every minute of the
session**, and the system attempted roughly **3,180 calls a minute to get 280
through** — an admission rate near **8%**. This is not a busy system; it is a
system in permanent refusal.

### By consumer

| Consumer | Requests | % | Records returned | Records/request | Quota blocks |
|---|---:|---:|---:|---:|---:|
| **unattributed** | 32,044 | **66.57%** | 6,060,360 | 189 | 254,844 |
| **options_paper_mark** | 12,975 | **26.96%** | 3,124,152 | **241** | 3,455 |
| scanner | 2,833 | 5.89% | 461,628 | 163 | 523 |
| **asymmetry_mark** | 263 | 0.55% | 0 | — | **78,595** |
| premarket | 20 | 0.04% | 67,822 | 3,391 | 14 |

### By endpoint

| Endpoint | Requests | % |
|---|---:|---:|
| `/v3/snapshot/options/:sym` — **whole chain** | 34,116 | **70.88%** |
| `/v2/aggs/ticker/:sym/range/...` | 6,729 | 13.98% |
| `/v2/snapshot/locale/us/markets/stocks/tickers` | 846 | 1.76% |
| `/v2/reference/news` | 212 | 0.44% |
| **exact-OCC snapshots (21 distinct, combined)** | **323** | **0.67%** |

### What the table proves

**1. One contract cost a whole chain.** 241 records per request on
`options_paper_mark` is the signature of a lane downloading up to 750 contracts
and calling `.find()` on one of them. This exact defect was fixed on the
asymmetry lane on 2026-08-02; the **subscriber** grade lane
(`buildLiveGradeDeps().getQuote`) and the alert tracker's finalize path never
were. Chain reads were **70.9%** of the day's spend; exact-OCC reads were **0.7%**.

**2. The starvation was self-inflicted.** `asymmetry_mark` — already on the cheap
exact-OCC path — was refused **78,595 times** and got **263 requests** through
(0.55%), while the expensive lane spent 27% of the budget pulling chains. The
lane that had already been fixed was being starved by the lane that had not.

**3. The largest consumer had no name.** Two thirds of all spend was
`unattributed`: the independent options monitor, the shadow-outcome grader, the
0DTE research runtime, the swing scan and the alert-tracker sweep all ran outside
every scope.

**4. A diagnostic competed with live marking.**
`/api/diagnostics/alert-decision` spent 2 metered candle fetches per call against
the same saturated cap it was being used to investigate, attributed to nothing.

### Fixed in `a5f5976`

- Subscriber grade lane and alert-tracker finalize read **`fetchOptionContractSnapshot`** — one request, exact OCC, no pagination.
- The grade lane no longer collapses a quota refusal into "no quote", and judges freshness against the **observation clock** (the Gate A rule, which had never been applied to this lane).
- Five schedulers opened consumer scopes; four consumers declared (`alert_capture`, `options_shadow_mark`, `zero_dte_context`, `swing_scan`). The three research lanes are categorised `research` so **B7 stops them before any live lane**.
- `alert-decision` returns **`NOT_AVAILABLE_WITHOUT_LIVE_CALL`** by default, before the provider module is imported. `&live=1` authorises the spend inside the `diagnostics` scope — always attributed, never silent.

**Effect is not yet confirmed.** The fix is deployed logic, not a measured
outcome. It must be re-measured against the next RTH session before any claim of
improvement is recorded here.

### Open questions this measurement raised

1. **`cacheHits: 0` and `dedupAvoided: 0` across 48,135 requests.** Either no
   caching/dedup happens on the hot path, or neither is instrumented. Both are
   plausible and they have opposite fixes. Resolve before B7 sets budgets.
2. **`asymmetry_mark` returned 0 records across 263 requests.** Most likely the
   exact-OCC path never populates `recordsReturned`; if so, records/request is
   not comparable across lanes and the report should say so.
3. **~5,900 requests are unaccounted between the endpoint table and the total** —
   consistent with `byEndpoint` truncating a long tail of per-OCC buckets.
   Confirm the endpoint report is not silently lossy.

---

## Deployment

`a5f5976` pushed to `main` at 2026-08-03. **Production was still serving
`8282ecb` at last check** (`durable.deployments: ["8282ecb"]`) — Railway build in
flight. Confirm the deployment before treating any later measurement as evidence
about the new code:

```
GET /api/system/provider-usage → durable.deployments must contain a5f5976
```

## Validation

3267/3267 green **both runs** · `tsc --noEmit` clean · `build` clean ·
`git diff --check` clean · no migrations in this commit · graphify updated.
No cap raised, no budget widened, no strategy promoted or demoted, no bracket
promoted, no subscriber or Discord behaviour changed.

## The measurements that unblock everything

1. `independentMarkPct >= 50%`, from `buildIndependenceReportOnDb`.
2. Per-consumer request share — **now measured once**, and must be re-measured on
   `a5f5976` to size B7's partitions against real post-fix demand rather than
   against demand that was mostly waste.

## Known blockers

1. **Provider minute cap saturated (280/280).** The consumer is now named. **Do
   not raise the cap** — the correct response to 70.9% chain reads was to stop
   making them, not to buy more of them.
2. **Long-horizon coverage weak** — 30m 15/173, 60m 12/133 (B4, unmeasured since
   horizon windows shipped).
3. **The grader reserve still does not function.** `recordPolygonCall()` is still
   called with the default purpose, so the `discovery`/`grader` split in
   `quota-policy.ts` remains dead code. `a5f5976` gives it a real consumer to
   read; **B7 must thread it through and prove the reserve is reachable.**
4. **`unattributed` should now fall sharply but will not reach zero** — API
   routes (`app/api/options/[ticker]`), `lib/scan-core.ts`,
   `lib/position-callout.ts`, `lib/paper-engine.ts` and `lib/agents/runtime.ts`
   still make unscoped calls. Each is a bounded, known follow-up.

## Next automatic action — EXACT RESUME POINT

1. **Confirm `a5f5976` is live** (`durable.deployments`). Nothing below is
   evidence until it is.
2. **Re-read `/api/system/provider-usage` after the next full RTH session.**
   Record the new table beside the one above. The specific questions:
   - Did `options_paper_mark` records/request fall from 241 toward ~1?
   - Did `asymmetry_mark`'s 78,595 quota blocks fall, and did its request count rise?
   - Did `unattributed` fall from 66.6%, and what is left in it?
   - Did total requests fall while *useful* marks held or rose?
3. **Resolve the three open questions above** (cache/dedup instrumentation,
   `recordsReturned` on the exact-OCC path, endpoint-table truncation).
4. **Gate B7** — per-consumer budgets, sized against post-fix demand. Thread the
   consumer through `recordPolygonCall()` so the grader reserve finally works.
5. **Gate B4** — scheduler fairness / long horizons.
6. **Gate B8** — live validation (`independentMarkPct >= 50%`).

Gates C–G are unchanged and remain blocked behind B8.

## Safety posture (unchanged)

`canSendSubscriber: false` · `automaticRealTrading: false` · no broker path ·
AI advisory only · no bracket promoted · no strategy quarantined · **paid launch
blocked**. No Stripe/billing/roles work touched.
