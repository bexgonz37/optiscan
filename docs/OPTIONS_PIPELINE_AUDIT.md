# OPTIONS_PIPELINE_AUDIT

Evidence-based trace of the CURRENT options flow (code at 5aba5a8). No changes here.

## End-to-end flow (files/functions)
1. **Universe** — `lib/universe.js getZeroDteUniverse()` = `ZERO_DTE_UNIVERSE` (`OPTIONS_CORE_SYMBOLS`
   + a few leveraged ETFs) **∪ promoted discovery names** (`s.promoted`). Watched by the ~1s loop.
2. **Underlying observation** — `lib/scanner-loop.ts` bulk snapshot (`fetchBulkQuotes(getZeroDteDiscoveryUniverse())`)
   every `SCANNER_LOOP_MS` (~1s); broad discovery merge every `SCANNER_DISCOVERY_MS` (~10s).
3. **Trigger** — a symbol passing `shouldTrigger()` (momentum/velocity/rvol/VWAP; `lib/zero-dte.ts`)
   proceeds. **Options candidates depend on the SAME momentum trigger as the radar.**
4. **Chain fetch** — `fetchOptionChain(ticker, { dteMin:0, dteMax:1, maxPages:2 })`, fallback
   `dteMax:5` (`scanner-loop.ts:594`). **0DTE-focused (0–1, then 0–5 DTE); no 0–14 band.**
5. **Contract filter + rank** — `rankZeroDteContracts(chain.contracts, "call"| "put", …)`
   (`lib/contract-selector.ts`) → best call + best put.
6. **Strategy** — one implicit "0DTE momentum" strategy; NO separate strategy catalog (added now as
   research-only `lib/research/options/strategy-catalog.ts`).
7. **Gates** — momentum invariants + options worth/spread/liquidity gates (`lib/zero-dte.ts`,
   `paper-revalidation.ts`); bearish routed through `bearish-gate.ts`.
8. **Capture / callout** — `captureZeroDte(...)` (`lib/alert-capture.ts`) → alert row → Discord.
9. **Paper** — `lib/paper-engine.ts` + `paper-entry/exits/fill-model/revalidation/options-analytics`.
   Option trades carry a real `option_symbol`, `entry_bid`/`entry_ask`, ×100 multiplier; equity trades
   have `option_symbol IS NULL`.

## Answers (from code)
- **Monitored universe:** curated `ZERO_DTE_UNIVERSE` + promoted broad-discovery names.
- **Cadence:** ~1s underlying loop; ~10s discovery; chain fetched on trigger.
- **Triggers:** `shouldTrigger()` momentum; options fire from it.
- **Gates:** momentum invariants, options worth/spread/OI/volume, freshness (`paper-revalidation`),
  bearish-gate.
- **Do options depend on stock-radar candidates?** YES — same `shouldTrigger` momentum path.
- **Can options > $50 / off-curated enter?** Only if the underlying is in `ZERO_DTE_UNIVERSE` or gets
  promoted by broad discovery ($0.50–$50 / +10% floor) — so a > $50 non-curated name generally does NOT
  enter for options.
- **Earnings independently introduce a candidate?** NO.
- **Options-activity independently introduce a candidate?** NO.
- **Do calls and puts use different rules?** Both are ranked (`rankZeroDteContracts` call/put); puts are
  research-only via bearish-gate. No per-side strategy differentiation.
- **Late/sparse callouts today — which step?** Cannot read production logs from here. Structurally the
  candidates are gated by the momentum trigger + 0DTE chain fetch + worth/liquidity gates; a name that
  never clears the momentum invariant, or whose 0–5 DTE chain is illiquid, yields no callout. Use the
  stored timestamps (below) to attribute latency.
- **Did stricter confirmation delay delivery?** Determinable only from stored `momentum_diagnostics` /
  alert timestamps — see TODAY_OPTIONS_LATENCY_AUDIT.md for the exact SQL.
- **Chain fetch / ranking slow?** Chain fetch is 2 pages ×(0–1 then 0–5 DTE) = up to 4 provider calls
  per triggering symbol; ranking is in-memory (fast).
- **Price recheck before delivery?** Yes for paper entry (`paper-revalidation.ts`); the public alert
  path should also re-check via the two-speed freshness layer (Phase F, flag OFF).

## Gaps this task addresses (research-only, flags OFF)
Separate strategy catalog, independent earnings + options-activity discovery (shadow), early options
detection signals, real-option-paper classification, analog scorer loading, AI shadow model caller.
