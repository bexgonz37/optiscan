# FIVE_YEAR_CORPUS_CAPACITY_PLAN

Capacity + cost estimate for a survivorship-safe, broad-universe historical corpus. **No production
seed is performed here.** All figures are engineering estimates for planning only.

## Basis (from the validated pilot)
The one completed production seed (`episode_seed_1784669431399_ep7dcl`): 3 symbols × ~6 months →
**113 episodes / 761 labels**. That is ≈ **6 episodes / symbol / month ≈ 72 / symbol / year** and
≈ 6.7 labels/episode. Episode row ≈ ~4 KB. The seeder chunks by 30-day windows → ≈ **13 provider
calls / symbol / year** (each at Polygon's 50k-bar limit).

## Universe + calendar
- Survivorship-safe broad US equities+ETFs, **including delisted**: ≈ **8,000 active + ~2,000 delisted
  over 5y ≈ 10,000 symbols**. (A current-symbol list is ~6–8k but is survivorship-BIASED and INVALID
  for a GO verdict.)
- Trading days ≈ **252/yr**; 5y ≈ **1,260 days**. Regular-session 1-min bars ≈ 390/day ≈
  ~98k/symbol/yr (≈ ~240k with extended hours).

## Per-tier estimates (episodes only; raw bars are NOT stored)
| Tier | Symbols | Years | Provider calls | Episodes (~) | Storage (~) | Runtime (~) | Regimes | Remaining bias |
|---|---|---|---|---|---|---|---|---|
| 1. Pilot | 50 | 1 | ~650 | ~3,600 | <50 MB | minutes–1h | 1 | survivorship unless PIT/dated |
| 2. One-year broad | 8,000 | 1 | ~104,000 | ~576,000 | ~2.3 GB | ~hours–1 day | 1 (e.g. 2024 bull) | survivorship unless PIT/dated |
| 3. Three-year | 8,000 | 3 | ~312,000 | ~1.7M | ~7 GB | ~2–4 days | 2–3 (2022 bear, 2023–24 bull) | survivorship + no real options |
| 4. Five-year | 10,000 | 5 | ~650,000 | ~3.6M | ~15 GB | ~4–7 days | multiple (2020 COVID, 2021 mania, 2022 bear, 2023–24 bull) | none on stock IF PIT/dated; options still MODELED |

(Provider calls ≈ symbols × years × 13. Runtime dominated by Polygon rate limits + `rateLimitMs`
between chunks; parallelism bounded by plan limits. Storage ≈ episodes × ~4 KB + labels.)

## Railway / provider
- **Storage**: ~15 GB episodes on the mounted volume ≈ **~$4–6/mo** at typical volume pricing. Add
  WAL/index overhead (~1.5×). Raw minute bars for 10k×5y would be ~200 GB — **not** stored (we derive
  episodes and discard bars).
- **Compute**: the seed worker (now Node 22) runs bounded; a multi-day seed is I/O/rate-limit bound,
  low CPU. Keep it out of the web process (already a separate worker).
- **Polygon limits**: `/v2/aggs` historical minute depth + rate depend on plan (Stocks Advanced gives
  multi-year history + high/again unlimited aggregate calls; lower tiers cap calls/min and history
  depth). Confirm plan before tier 2+.

## What is REQUIRED for survivorship-safe (blocking)
- **Point-in-time universe**: provider PIT reference (NOT currently entitled — `entitlement` probe) OR a
  user-dated file (`symbol, active_from, active_to, security_id`). A `current_symbols` seed is
  permanently EXPLORATORY and cannot back a GO verdict.
- **Corporate actions**: adjusted aggregates cover feature prices; **symbol-change/delist mapping needs
  the reference feed** (deferred).
- **Regime/sector/breadth feeds**: SPY/QQQ/IWM + sector-ETF aggregates (available), index/VIX
  (`get_index_quotes` available), earnings calendar (available), sector/industry mapping (reference
  feed needed) — currently the episode `regime/sector/breadth/catalyst/optionsContext` blocks are NULL.
- **Real historical OPTIONS outcomes**: historical option quotes/Greeks/NBBO/OI are **NOT entitled** →
  option outcomes remain MODELED, not real. Real call/put/0DTE outcomes need an options-history vendor
  (Polygon Options Advanced historical, or ORATS/CBOE) — material additional cost.

## Recommendation (not executed)
Start at **Tier 1 pilot** with a **dated universe file** to establish the survivorship-safe pipeline
end-to-end, verify episode density + storage/runtime against these estimates, then scale tier-by-tier.
Do NOT run Tier 2+ until: (a) a survivorship-safe universe source is in place, and (b) the Polygon plan
limits are confirmed. Options outcomes stay MODELED until an options-history vendor is added.
