# OptiScan Autonomous Roadmap — Status

**Updated:** 2026-08-03 (evening) · **Deployed:** `819eda6` (confirmed live) ·
`1b7939f` pushed · **Started from:** `7246304`

Durable status for the Gate B–G roadmap. Updated after every gate.

---

## Current stage

**Gate B — IN PROGRESS.** B1/B2/B3/B5/B6/B7 shipped; **B5 is MEASURED**,
**B6 is PROVEN**, **B7 is PASSED (extended hours) / RTH-UNCONFIRMED**. B4 not
started; B8 needs one RTH session.

---

## Gate B7 — PASSED under saturation. The reserve is reachable.

`asymmetry_mark` admission rate, sliced **per deployment** — which is the only
reason this is answerable at all:

| Deployment | B7 live? | Requests | Quota blocks | Admission | Req/min |
|---|---|---:|---:|---:|---:|
| `8282ecb` | no | 263 | 90,588 | **0.29%** | 1.4 |
| `8bd2f44` | no | 0 | 4,492 | **0.00%** | 0 |
| `718c0cc` | no | 0 | 1,254 | **0.00%** | 0 |
| `226ba96` | **yes** | 748 | 9,703 | **7.16%** | **39.4** |
| `819eda6` | **yes** | 453 | 3,285 | **12.12%** | **56.6** |

**From zero to ~40–57 requests/minute against a 44/minute reserve.** The lane
that took in *nothing at all* across three consecutive deployments now consumes
its reserve in full and bursts into the shared pool on top of it. The live
partition read back from production during a saturated minute:

```
minuteCap 280 · totalReserved 179 · sharedPool 101 · sharedUsed 101/101
  scanner             37/58
  options_paper_mark  23/44
  asymmetry_mark      44/44   ← reserve fully consumed
  options_discovery    0/28
  alert_capture        0/5
```

The shared pool is exhausted (101/101) while `asymmetry_mark` still gets served.
That is precisely the property that failed on 2026-08-03 morning, and it is now
observed rather than asserted.

**Two corrections this measurement forced:**

1. **The exact-OCC fix DID work — the mixed total was hiding it.**
   `options_paper_mark` records/request: **240.7** on `8282ecb` → **1.0** on
   `226ba96`/`819eda6`. Read against the day's total it still looked like 227,
   because 94% of the lane's requests came from the pre-fix deployment. The
   previous session recorded "effect unconfirmed"; the effect was complete, and
   only the measurement was wrong.
2. **A trading date was never a measurement window.** Four deployments metered
   into 2026-08-03. Every before/after conclusion drawn from the day's totals —
   including "the cost fix did not unstarve marking" — was drawn from evidence
   that summed the sessions before a change with the session after it.

**Why this is not yet a full PASS.** `226ba96` reached production at roughly the
16:00 ET close, so both B7 deployments were measured in **extended hours only**
(19 + 8 minutes). Contention was real — 44,258 refusals in those 19 minutes — so
reachability-under-saturation is genuinely demonstrated. What is *not* yet shown
is behaviour under RTH demand, where discovery and the scanner ask far harder.

**Exact future validation requirement:** one full RTH session on `1b7939f` or
later, read with `?deployment=<sha>`. B7 becomes unconditionally PASSED if
`asymmetry_mark` holds ≥ ~30 requests/minute while `scanner` and
`options_paper_mark` stay above 90% admission.

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
| **B7** | Per-consumer provider budgets | **PASSED (extended hours) — RTH unconfirmed** | `asymmetry_mark` 0.00% → **12.12%**, 0 → **56.6 req/min** against a 44/min reserve, measured per-deployment. Shared pool 101/101 exhausted while the reserve still served |
| **B8** | Live Gate B validation | **BLOCKED** | Needs one full RTH session on `1b7939f`+ |
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

3291/3291 green **both runs** · `tsc --noEmit` clean · `build` clean ·
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

## Gate B7 — SHIPPED (`604e04e`), effect UNPROVEN

Per-minute budget partitions. Each consumer holds a reserve it can always spend,
plus fair access to a shared pool; a call is admitted when the consumer is inside
its own reserve **or** the pool has room. Nothing another lane does can take a
reserve away — the exact property that failed on 2026-08-03.

At the production cap of 280:

| Lane | Reserve | Why |
|---|---:|---|
| `scanner` | 58 | live scanner safety, highest priority |
| `options_paper_mark` | 44 | active subscriber-lane marks |
| `asymmetry_mark` | 44 | **separate** reserve — see below |
| `options_discovery` | 28 | discovery must work, but must not win every race |
| `alert_capture` | 5 | bounded checkpoint sweep |
| *shared pool* | 101 | everything else, first-come-first-served |

**The two mark lanes hold separate reserves.** A shared `mark` reserve would have
been won by the subscriber lane every minute, reproducing the same starvation one
level down.

**Reserves are fractions of the cap, not absolute counts.** The first draft used
counts tuned for 280; the suite caught it immediately — at a cap of 2 they
consumed the whole budget and refused the first call of every unreserved lane.
The shared pool also has a floor, so an over-reserving config degrades to
prioritisation rather than deadlock.

**No cap was raised.** A test asserts total admissions can never exceed the cap.
A partition refusal throws a distinct `minute_partition` quota kind, so like
every other budget refusal it can never be recorded as missing market data.

Two independent reasons the pre-existing reserve had never fired, both now fixed:
`recordPolygonCall()` was always called with the default purpose (it now reads
the ambient consumer — the first code to use Gate B5's attribution for a
*decision* rather than a report), and that reserve guards the DAILY cap, which at
55,415/200,000 was never remotely approached.

**Status is DEPLOYED_UNPROVEN.** The guarantee is asserted by test; the effect on
`asymmetry_mark`'s 0.28% admission rate is not yet measured.

---

## Attribution — the anonymous spenders are named (`1b7939f`)

`unattributed` per deployment: 36,543 (`8282ecb`) → 1,795 (`226ba96`, 39.6% of
that deployment) → 691 (`819eda6`, 36.8%). Still the largest single bucket.

`1b7939f` names the sources found by tracing every path that reaches a metered
call. Under B7 this is not cosmetic: an unscoped caller holds **no reserve**, so
anonymous traffic competes for the shared pool against protected lanes.

| Source | New owner | Why |
|---|---|---|
| `lib/paper-engine.ts` sweep | `options_paper_mark` | Runs every 30s, up to 5 **whole chains**, owned by nobody. It marks paper trades — bounded ~10/min against a 44/min reserve |
| `lib/supervisor-cycle.ts` | `options_discovery` | Reaches `runAgentsForTicker` → 0-90 DTE chain per ticker |
| `app/api/options/[ticker]` | `dashboard_api` | A whole chain per browser request |
| `app/api/candles/*`, `scan/*`, `scanner/live`, `context/zero-dte` | `dashboard_api` | Browser/operator spend — holds no reserve **on purpose** |
| `app/api/research/options/replay` | `historical_research` (`historical: true`) | Research must never read as live spend or borrow a live reserve in RTH |

`lib/position-callout.ts` needed nothing — it already runs inside the scanner
tick's scope. Scopes are opened **only at true entry points**, never inside
shared helpers, so innermost-wins still bills a shared function to its real
caller. Effect is unmeasured: `1b7939f` deployed after the close.

---

## Next automatic action — EXACT RESUME POINT

**ALWAYS read provider numbers with `?deployment=<sha7>` from now on.** The
unscoped total is a sum across deployments and cannot answer a before/after
question. `/api/system/provider-usage` also accepts `?sinceMs=`/`?untilMs=`, and
returns `minuteBudget` — the live partition, read directly rather than inferred
from refusal counts.

1. **Confirm `1b7939f` is live**, then take the **2026-08-04 RTH session** as the
   first clean full-session window. Read it scoped. The questions:
   - **Does `asymmetry_mark` hold ≥ ~30 req/min under RTH demand?** Extended
     hours gave 39.4 and 56.6. RTH is the harder test — discovery and the
     scanner ask far more.
   - **Does `scanner` stay above 90% admission?** It was 93.5% on `226ba96`.
     A reserve that protects marking by starving the scanner is a regression.
   - **How far does `unattributed` fall from ~37%?** `1b7939f` targets the paper
     sweep, the supervisor cycle and the dashboard routes. Whatever remains is
     the next bounded list — trace it the same way, do not file it under
     `OTHER_EXPLICIT`.
   - **Is `options_discovery` starved?** It read 0/28 reserve used with the pool
     exhausted. Either demand genuinely moved to the supervisor cycle (now named
     by `1b7939f`) or discovery is being refused before it asks.
2. **Gate B4** — scheduler fairness / long horizons. B7 changes its inputs:
   30m (15/173) and 60m (12/133) coverage may have been a *budget* failure, not a
   scheduling one. **Re-measure before designing a scheduler fix** — the
   asymmetry lane went from 0 to ~40 req/min, which is exactly the capacity long
   horizons were missing.
3. **Gate B8** — live validation (`independentMarkPct >= 50%`), which is now
   reachable for the first time: marking has capacity.

Gates C–G are unchanged and remain blocked behind B8. Not started, and not
silently dropped: Gate C signal/entry/contract/exit research, the 2026-08-03 QQQ
missed-winner investigation, the permanent Missed Opportunity Agent, the
agent/module architecture audit, Gate D historical learning, Gate E experiment
registry, the High-Asymmetry → regular-callout feedback bridge, Gate F lifecycle
and report cards, and Gate G subscriber readiness all remain outstanding.

## Safety posture (unchanged)

`canSendSubscriber: false` · `automaticRealTrading: false` · no broker path ·
AI advisory only · no bracket promoted · no strategy quarantined · **paid launch
blocked**. No Stripe/billing/roles work touched.
