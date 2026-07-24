# Broker V2 Analytics Policy (B5)

Version: **1** (`ANALYTICS_METHODOLOGY_VERSION`)

Label: **Research Analytics — Not Yet Authoritative**

Analytics are computed from V2 dollar ledgers, fills, positions, and
`broker_equity_snapshots`. They do **not** use cumulative return-point math and
must never replace legacy subscriber reporting.

## Return interval

1. Build an ordered equity series from `broker_equity_snapshots.net_equity` (dollars).
2. Collapse to **one observation per UTC calendar day** (last snapshot that day).
3. Period return \(r_t = E_t / E_{t-1} - 1\) when \(E_{t-1} > 0\).
4. Zero-return / flat equity days are retained (return = 0).
5. Market-closed calendar days with no snapshot are **skipped** (no invented fills).

## Incomplete / stale snapshots

- Default: **exclude** snapshots with `completeness_status` in `INCOMPLETE` / `PARTIAL`
  from return series used for risk ratios (Sharpe, Sortino, VaR, volatility).
- Drawdown dollars/% still report both:
  - `completeOnly` series (risk ratios)
  - labeled counts of incomplete/stale snapshots in `dataQuality`
- Missing marks never invent equity; incomplete points are counted, not silently zeroed.

## Annualization

- Factor: **252** trading days/year (configurable `BROKER_V2_ANALYTICS_ANNUALIZATION`).
- Annualized Sharpe / Sortino / Calmar / volatility are returned **only** when the
  observation window span ≥ `minDaysForAnnualization` (default **30** days).
- Otherwise those metrics are `null` with reason `observation_window_too_short_for_annualization`.

## Risk-free rate

- Default **0** for paper research (`BROKER_V2_ANALYTICS_RISK_FREE`).
- Excess return = period return − daily RF ≈ RF / 252.

## Minimum sample sizes

| Family | Default minimum |
|---|---|
| Trade advanced (payoff, profit factor, expectancy CI) | 10 closed trades |
| Return advanced (Sharpe, Sortino, VaR, CVaR, ulcer) | 20 daily returns |
| Kelly advisory | 10 closed trades; warn if &lt; 30 |
| Annualized ratios | 30 calendar days |

Below minimum → `value: null` + explicit `reason` (never a fake 0).

## Performance definitions (dollars)

- Starting / ending equity from first/last usable snapshot (or account starting cash).
- Net profit $ = ending − starting.
- Total return % = net profit / starting × 100 (null if starting ≤ 0).
- Gross profit / gross loss from **closed round-trip** dollar P&amp;L (fees included in net).
- Profit factor = grossProfit / |grossLoss| (null if no losses).
- Expectancy $ = mean closed-trade net P&amp;L.
- Expectancy return % = mean closed-trade return %.
- Win/loss rates over closed trades only.

## Risk definitions

- Max drawdown from dollar equity peaks (not %-point curves).
- Volatility = stdev of daily returns.
- Downside deviation = stdev of negative daily returns (Sortino mar=0).
- Sharpe = mean(excess) / σ × √252 when annualization allowed.
- Sortino = mean(excess) / downsideDev × √252 when annualization allowed.
- Calmar = annualized return / |maxDD%| when annualization allowed.
- Ulcer index = √(mean(drawdownPct²)).
- Historical VaR / CVaR at configured confidence on daily returns.
- Risk-of-ruin estimate: discrete formula using empirical win rate \(p\) and
  payoff ratio \(b\): if edge ≤ 0 → 1; else \(((1-p)/p \cdot 1/b)^{u}\) with
  unit count from starting equity / average loser (capped). Research-only.

## Options / exposure

- Greeks and sector: **never fabricated**. If unavailable → `null` + reason.
- Exit classification (target/stop/timeout/worthless): from V2 metadata / optional
  legacy link enrichment when present; otherwise counted as `unknown`.

## Kelly (advisory only)

- Full Kelly \(f^* = p - (1-p)/b\) for positive expectancy bets.
- Half / quarter Kelly = \(f^*/2\), \(f^*/4\).
- Confidence-adjusted Kelly shrinks toward 0 when sample &lt; 30.
- **Never** imported by buying-power, dual-write, scanner, Discord, or thresholds.
- UI must show advisory warning.

## Aggregation labeling

Mixing account types or audiences is forbidden unless the response explicitly
sets `aggregationLabel` (default: single account only).
