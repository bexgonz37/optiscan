# OptiScan Autonomous Roadmap — Status

**Updated:** 2026-08-03 · **Deployed:** `8bd2f44` (confirmed live) · `a7153b6` pushed · **Started from:** `7246304`

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
| **B6** | Durable provider accounting | **PROVEN** | 197 minutes / 55,415 requests read back across a deploy boundary; 4 meter defects fixed in `a7153b6` |
| **B4** | Scheduler fairness / long horizons | **NOT STARTED** | 30m 15/173, 60m 12/133 remain weak |
| **B7** | Per-consumer provider budgets | **NOT STARTED — NOW THE BLOCKING GATE** | Proved necessary: `asymmetry_mark` admitted 263/94,055 = **0.28%**, and **zero** after the cost fix |
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

### Open questions — ALL THREE RESOLVED, all were meter defects (`a7153b6`)

All three were blind spots in the meter, not facts about the system. Each was
harmless while marking pulled whole chains and becomes **actively misleading**
once marking moves onto the exact-OCC path — together they would have made
`a5f5976` read as a regression.

1. **`cacheHits: 0` / `dedupAvoided: 0`** → *instrumentation, not absence.*
   `fetchMarketSnapshot` has both a TTL cache and inflight dedupe, but a hit
   returns **before** `polyFetch`, and `polyFetch` was the only place that
   metered anything. Now emitted — and counted as *avoided*, never as requests.
2. **`asymmetry_mark` returned 0 records** → *the meter was blind, the lane was
   fine.* `recordsReturned` counted only array-shaped `results`; single-resource
   endpoints (including the exact-OCC read) return a bare **object**.
3. **~5,900 requests unaccounted** → *two compounding defects.*
   `normalizeEndpoint` tested `/^O:/` against a segment that arrives
   percent-encoded as `O%3A…`, so **every contract became its own bucket**; and
   `byEndpoint` had a bare `LIMIT 25` that dropped the tail silently, so the
   column never summed to the total. Decode first; and the report now carries an
   explicit remainder row.

---

## Post-deploy observation (2026-08-03, `8bd2f44` live at ~19:45 UTC)

`a5f5976` reached production mid-session. Attribution immediately began working —
`options_discovery` and `options_shadow_mark` appeared as named consumers for the
first time. **But the headline result is a negative one, and it is important:**

| Consumer | Session total | % | Quota blocks | Requests admitted AFTER deploy |
|---|---:|---:|---:|---:|
| unattributed | 36,959 | 66.69% | 305,916 | +962 |
| options_paper_mark | 14,537 | 26.23% | 4,025 | +193 |
| scanner | 3,341 | 6.03% | 582 | +314 |
| **asymmetry_mark** | **263** | **0.47%** | **93,792** | **0** |
| options_discovery | 237 | 0.43% | 16 | +237 (new) |
| options_shadow_mark | 51 | 0.09% | 26 | +51 (new) |
| premarket | 26 | 0.05% | 14 | +2 |
| alert_capture | 1 | 0.00% | 0 | +1 (new) |

### THE EXACT-OCC FIX DID NOT UNSTARVE MARKING

`asymmetry_mark` ended the session on **263 requests against 93,792 refusals — a
0.28% admission rate — and took in ZERO requests after the fix deployed.**

This is the single most useful thing the session established, and it corrects an
assumption this roadmap was carrying. Making marking cheaper does not get marking
served. **There is no reserve.** The minute cap is first-come-first-served, and
discovery asks continuously, so a lane that wakes on a horizon schedule loses
every race regardless of what each of its requests costs.

Cheapness and priority are independent problems. `a5f5976` fixed cost. **Nothing
in the system currently fixes priority** — `quota-policy.ts` has a grader reserve,
but `recordPolygonCall()` is still called with the default purpose, so it has
never once fired.

**This makes Gate B7 the required next gate, on evidence rather than on plan.**
No amount of further cost reduction will move `independentMarkPct`, so Gate B8 and
therefore Gate C cannot be reached without it.

### Secondary observations

- **Two deployments metered concurrently for one minute** during handover (a
  bucket recorded 560 requests against a 280 cap). Transient and expected given
  per-deployment rows, but it means single-minute peaks spanning a deploy are not
  trustworthy. Day totals are unaffected.
- **Spend continues at 280/min with ~2,600 refusals/min after the 16:00 ET
  close.** Extended hours run to 20:00 ET so this is not necessarily waste, but
  session-awareness of the budget is unverified and belongs in B7's scope.
- **`unattributed` still took +962 requests after the deploy**, confirming the
  remaining unscoped sources listed under *Known blockers* are real and active.

---

## Deployment

- `a5f5976` + `8bd2f44` — **confirmed live** at ~19:45 UTC 2026-08-03
  (`durable.deployments: ["8282ecb","8bd2f44"]`), verified mid-session.
- `a7153b6` (meter fixes) — pushed; **confirm before reading any number from it**,
  since it changes what is recorded:

```
GET /api/system/provider-usage → durable.deployments must contain a7153b6
```

## Validation

3274/3274 green **both runs** · `tsc --noEmit` clean · `build` clean ·
`git diff --check` clean · **no migrations in either commit** · graphify updated.
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
3. **The grader reserve still does not function, and this is now the top
   blocker.** `recordPolygonCall()` is still called with the default purpose, so
   the `discovery`/`grader` split in `quota-policy.ts` has **never once fired**.
   The session proved the consequence directly: a lane on the cheapest possible
   request path was admitted 0.28% of the time and got nothing at all after its
   cost fell. `a5f5976` gives the reserve a real consumer to read; **B7 must
   thread it through and prove by test that the reserve is reachable under
   saturation.**
4. **`unattributed` should now fall sharply but will not reach zero** — API
   routes (`app/api/options/[ticker]`), `lib/scan-core.ts`,
   `lib/position-callout.ts`, `lib/paper-engine.ts` and `lib/agents/runtime.ts`
   still make unscoped calls. Each is a bounded, known follow-up.

## Next automatic action — EXACT RESUME POINT

**Start here: Gate B7. It is now the blocking gate, on evidence.**

1. **Confirm `a7153b6` is live** (`durable.deployments`) before reading any
   number from it — that commit changes what the meter records.
2. **Gate B7 — per-consumer budgets and a REACHABLE reserve.** The session proved
   cheapness does not buy priority: `asymmetry_mark` ended at a 0.28% admission
   rate and took zero requests after the cost fix. Required work:
   - Thread the ambient consumer through `recordPolygonCall()` so the
     `discovery`/`grader` split in `quota-policy.ts` stops being dead code. **This
     has never once fired**, and it is the mechanism the reserve depends on.
   - Partition the 280/minute budget in the declared priority order (scanner
     safety → active marks → exact-OCC reuse → bounded research → enrichment).
   - Assert by test that a reserved lane is genuinely reachable when every other
     lane is saturated. That is the property that failed here, and it must fail
     the build, not the session.
   - **Do not raise the cap.**
3. **Then re-read `/api/system/provider-usage` after a full RTH session on B7**
   and record the table beside the two above. The questions:
   - Did `asymmetry_mark`'s admission rate rise off 0.28%?
   - Did `options_paper_mark` records/request fall from 241 toward ~1?
     (Now measurable — before `a7153b6` the exact-OCC path scored 0 records.)
   - Did `unattributed` fall from 66.7%, and what is left in it?
   - Did total requests fall while *useful* marks held or rose?
4. **Close the remaining `unattributed` sources** — `app/api/options/[ticker]`,
   `lib/scan-core.ts`, `lib/position-callout.ts`, `lib/paper-engine.ts`,
   `lib/agents/runtime.ts`. Each is bounded; `+962` requests after the deploy
   confirms they are live.
5. **Gate B4** — scheduler fairness / long horizons.
6. **Gate B8** — live validation (`independentMarkPct >= 50%`).

Gates C–G are unchanged and remain blocked behind B8.

## Safety posture (unchanged)

`canSendSubscriber: false` · `automaticRealTrading: false` · no broker path ·
AI advisory only · no bracket promoted · no strategy quarantined · **paid launch
blocked**. No Stripe/billing/roles work touched.
