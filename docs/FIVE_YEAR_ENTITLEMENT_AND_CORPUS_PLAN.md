# FIVE_YEAR_ENTITLEMENT_AND_CORPUS_PLAN

Supersedes FIVE_YEAR_CORPUS_CAPACITY_PLAN.md with an ENTITLEMENT audit first.

## Entitlement audit (verify with `/api/research/entitlement`, do not assume)
| Data | Code path | Status |
|---|---|---|
| Historical stock minute bars | `/v2/aggs` (`fetchCandles`) | AVAILABLE (chunked seeder works) |
| Point-in-time / delisted universe | `/v3/reference/tickers?date=` | **NOT verified** (probe) — needed for survivorship-safe |
| Corporate actions (splits/divs) | `/v3/reference/{splits,dividends}` | probe; symbol-change/delist mapping deferred |
| Historical options contracts | — | **NOT integrated** |
| Historical option quotes / NBBO | — | **NOT entitled** |
| Option volume / open interest (historical) | — | **NOT entitled** (present-time only via snapshot) |
| Greeks / IV (historical) | — | **NOT entitled** |
| Earnings history/calendar | — | **NOT wired** (see EARNINGS_PROVIDER_AUDIT) |

## Consequence
- Stock-history analog outcomes are REAL (underlying). **Real historical OPTION performance cannot be
  claimed** without historical option quotes — those outcomes stay MODELED and are labeled separately
  (`MODELED_OPTION_RESEARCH` vs `REAL_OPTION_PAPER`).

## Staged corpus (begin ONLY the safe pilot; no production seed in this task)
1. **Core liquid** — SPY,QQQ,NVDA,TSLA,AMD,AMZN,META,AAPL,MSFT,GOOGL (~10) × pilot span. Fast, cheap.
2. **Diversified liquid-options pilot** — add HOOD,TGT,IREN,RKLB,ASTS,SPCE where data exists (~30–50).
3. **One-year broad** — see capacity plan (~8k symbols × 1y).
4. **Three-year** / **5. Five-year** — only with a survivorship-safe (PIT/dated) universe.

The pilot must span MULTIPLE regimes (e.g. include 2022 bear + 2023–24 bull months). Stock-history
analog outcomes and any option outcomes remain SEPARATELY LABELED. Do not seed production here.
