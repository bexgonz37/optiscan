# CURRENT_LIVE_DISCOVERY_AUDIT

Evidence-based audit of how live candidates enter the scanner **today** (code at the time of the
Broad Discovery Bridge commit). No proposals here — only what exists. File references are exact.

## How candidates enter the scanner
1. **Curated/static universe** — `lib/universe.js` `DEFAULT_UNIVERSE` = `LIQUID_ETFS` + `MEGA_LARGE_CAPS`
   + `MOMENTUM_NAMES` (~230 hardcoded symbols). Overridable via `SCAN_UNIVERSE` (replace) /
   `SCAN_UNIVERSE_EXTRA` (append). Contains **RKLB, SPCX, TGT**; does **not** contain IREN, ASTS, SPCE.
2. **Broad whole-market discovery** — `lib/scanner-loop.ts` (~line 247): ONE `fetchMarketSnapshot()`
   call per discovery cycle, pre-filtered by `broadStockEligibility` (`lib/stock-momentum-policy.ts`):
   **price $0.50–$50, day volume ≥ 500k (incl. premarket), gain ≥ +10% from prev close**, merged with
   curated names, then `rankDiscovery`/`promotionSet` (`lib/discovery-ranking.ts`). Disable with
   `STOCK_BROAD_DISCOVERY=0`; skipped when near the minute budget.
3. **Closed-session recap movers** — `fetchTopMovers("gainers"/"losers", 20)` only when the market is
   closed (Robinhood-style recap), not merged into live discovery.
4. **Exclusions** — `isRecapNoiseSymbol` (dotted tickers like `BRK.B`; `…W` warrant shapes ≥5 chars;
   price < $0.50) + the broad price/volume/gain floor.

**Cadence:** underlying loop `SCANNER_LOOP_MS` (default **1s**); discovery `SCANNER_DISCOVERY_MS`
(default **10s**); discovery top-N `SCANNER_DISCOVERY_TOP_N` (default 30). **Providers:**
`/v2/snapshot/locale/us/markets/stocks/tickers` (whole market + gainers/losers), `/v2/aggs` (candles),
`/v3/snapshot/options` (present-time chain), `fetchNews` (enrichment only).

**Counts:** the loop already exposes `discoveryStats` = `{curatedCount, broadCount, broadPass,
universeSize, promoted, source}`. `curatedCount` ≈ ~230; `broadCount` = whole-market snapshot size;
`broadPass` = names clearing the broad floor; `universeSize` = merged distinct set ranked that cycle.
(Live values are on Railway — read `loopState()` / `/api/health`; not reproducible from this repo.)

**New listings / the named tickers:** the whole-market snapshot means a **newly listed** or non-curated
name **can enter automatically** — but only inside the broad floor. So:
- **RKLB, SPCX** — always scanned (curated).
- **TGT** — scanned (curated); would NOT enter via broad (price > $50).
- **IREN, ASTS, SPCE** — NOT curated; enter via broad discovery **only while up ≥ +10%, priced
  $0.50–$50, ≥ 500k volume**. So conditionally yes (when running), not continuously watched.
- **TSLA** (~$250) — curated only; > $50 excludes it from broad.

## Discovery-source classification
| Source | State | Evidence |
|---|---|---|
| Static/curated watchlists (hardcoded arrays) | **ACTIVE** | `universe.js` DEFAULT_UNIVERSE |
| Provider whole-market snapshot | **ACTIVE** | `scanner-loop.ts` broad discovery + `broadStockEligibility` |
| Gainers/losers | **PARTIAL** | only in closed-session recap, not live merge |
| Unusual/relative volume | **PARTIAL** | day-volume floor + rel-vol used in ranking/gating, not as an entry source |
| Premarket / after-hours movers | **PARTIAL** | broad snapshot includes premarket volume/gain; no dedicated AH feed |
| Recently listed symbols | **PARTIAL** | appear via whole-market snapshot iff within the floor; no new-listing feed |
| News mentions | **MISSING (as a source)** | `fetchNews` is throttled enrichment AFTER discovery |
| Earnings calendar | **MISSING** | not wired into scanner discovery |
| Options activity (unusual) | **MISSING** | not a discovery source |
| Sector/industry sympathy | **MISSING** | not computed for discovery |
| Per-user watchlists | **MISSING** | `SCAN_UNIVERSE` is operator config, not per-user |
| Real historical/point-in-time universe | **BLOCKED** | provider PIT not entitled (`entitlement/route.ts`) |

## Data-flow (live discovery, today)
```
                              ┌──────────── every SCANNER_DISCOVERY_MS (10s) ───────────┐
 curated ~230 (universe.js) ─►│ merge ◄─ fetchMarketSnapshot (whole market, 1 call)      │
                              │           └─ broadStockEligibility: $0.50–$50, ≥500k,   │
                              │              ≥+10% ; isRecapNoiseSymbol excludes junk    │
                              │        rankDiscovery → promotionSet → promoted set        │
                              └───────────────────────────┬────────────────────────────┘
                                                          ▼  every SCANNER_LOOP_MS (1s)
                              per-symbol momentum/VWAP/rel-vol → hard gates → Discord alert
                                              (deterministic; no analog / no AI)
```

## Bottom line
Live discovery is **curated list + a bounded whole-market broad sweep**. It is dynamic within a
$0.50–$50 / +10% / ≥500k floor and *can* surface non-curated runners (IREN/ASTS/SPCE) when they move,
but it does **not** ingest news, earnings, options-activity, or sector-sympathy as discovery sources,
has no per-user watchlists, and has no point-in-time/broad historical universe. Those gaps are what the
Broad Discovery + Analog Shadow Bridge addresses — in **shadow mode, flag-gated OFF, non-actionable**.
