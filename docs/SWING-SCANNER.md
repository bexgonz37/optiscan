# Swing Scanner (1–4 week options) — formulas and rationale

**Status: RESEARCH PREVIEW.** Every formula below is grounded in established
momentum/options practice, but none has been calibrated against OptiScan's own
tracked outcomes yet. Rankings are a research queue, not signals. The path to
"calibrated": paper-trade the top-ranked candidates for ≥1 month, then re-weight
factors against realized results.

## 1. What it is

The intraday scanner asks "what is moving *right now*?" The swing scanner asks
"what is likely to keep moving over the next 1–4 weeks, with an option contract
that makes that bet fillable?" It runs on demand (button, cached 15 min), not
on the 1-second loop — swing setups don't change by the second, and the data
budget belongs to the live scanner.

## 2. Indicator primitives

- **EMA(20), EMA(50)** on daily closes — standard exponential smoothing,
  k = 2/(period+1).
- **ATR(14)** — Wilder's average true range; used everywhere as the
  normalizer so scores mean the same thing on a $6 stock and on SPY.
- **Realized vol (20d)** — annualized stdev of daily log returns
  (σ_daily × √252). Used as the honesty check against option IV.

## 3. Factor scores (composite = Σ score × weight)

### F1 Trend — weight 0.25
**Formula:** 40 points for a full EMA stack (price > EMA20 > EMA50 for calls,
inverted for puts) + up to 60 points for the EMA20 slope over 10 sessions,
measured in ATR units (`(EMA20_now − EMA20_10d_ago) / ATR`), saturating at
±1.5 ATR. Misaligned slope earns 30% credit.
**Why:** multi-week options need a persistent directional drift, and moving-
average alignment is the canonical trend filter — trend-following on this
horizon is one of the most replicated effects in the literature. ATR-
normalized slope makes "steep" comparable across prices.
**Limitation:** lags at turning points by construction; this scanner is
deliberately a continuation tool, not a bottom-picker.

### F2 Momentum — weight 0.20
**Formula:** 20-day rate of change divided by ATR% ("how many typical daily
ranges did the month's move cover"), 8 ATRs = 100 points.
**Why:** intermediate-horizon momentum (weeks, not seconds) is the classic
Jegadeesh–Titman effect; ATR-normalization is the standard fix for comparing
momentum across volatility regimes.
**Limitation:** raw momentum chases extended moves; F4 and the contract gates
push back against buying tops.

### F3 Participation — weight 0.10
**Formula:** 10-day average volume ÷ 50-day average volume, mapped linearly
(0.7× → 0 points, 1.7× → 100).
**Why:** rising participation confirms institutional interest; fading volume
during a "trend" is the classic sign of exhaustion.

### F4 Volatility regime — weight 0.10
**Formula:** ATR as % of price. Band-scored: <0.8% = dead tape (scored low),
~2.2% = sweet spot (100), >4% = increasingly penalized.
**Why:** an option buyer needs the underlying to MOVE (too-quiet kills theta-
adjusted returns), but extreme ATR% means option premium already prices the
chaos — you'd be buying volatility at the top.

### F5 Contract economics — weight 0.25
**Hard gates first (rejection, not scoring):** spread ≤ 8%
(`SWING_MAX_SPREAD_PCT`), open interest ≥ 250 (`SWING_MIN_OI`), 0.40 ≤ |Δ| ≤
0.70, DTE 7–35, mid ≥ $0.10. A setup with no qualifying contract can only be a
shares watch.
**Scoring on qualifiers:** base 40 + tighter-spread bonus (up to 25) + delta
proximity to 0.55 (up to 20) + IV honesty bonus (15 when IV ≤ 1.1× realized
vol, 8 when ≤ 1.5×, 0 above).
**Why:** the audit's founding lesson — a directional win with a bad contract
is still a losing trade. 0.55Δ swing entries lean intrinsic (less pure theta
gamble than 0DTE's 0.35–0.65 zone). The IV-vs-realized check is a crude but
honest substitute for IV rank until enough IV history accumulates locally.
**Limitation:** true IV Rank/Percentile needs a year of per-symbol IV history
we don't store yet; the engine snapshots IV each run, so this improves over
time. Documented as v2.

### F6 Market regime — weight 0.10
**Formula:** SPY EMA20/EMA50 trend, agreement check: candidates aligned with
the index trend score 50 + SPY-trend/2; counter-index candidates score
50 − SPY-trend/2.
**Why:** "don't fight the tape" — most single-name swings fail when the index
turns against them; correlation to the market is the dominant risk factor.

## 4. DTE selection: why 21–28 days

Preferred expiration window is 21–28 DTE (falling back to 7–35): far enough
out that week-one theta and gamma-week whipsaw don't dominate, close enough
that the position expresses a 1–4 week view without paying for months of time
value. Positions should be exited or rolled around 7 DTE (gamma week) — the
paper-trading smart exits handle this horizon naturally.

## 5. Factors deliberately NOT in v1 (and why)

| Factor | Status | Reason |
|---|---|---|
| Earnings proximity | **flagged, not scored** | reliable earnings-calendar data isn't wired yet; every candidate carries a "verify earnings date" flag because buying a 3-week option through earnings is an IV-crush trap |
| IV Rank / Percentile | v2 | needs stored IV history (snapshots begin accumulating now) |
| Support/resistance levels | v2 | needs a robust swing-point algorithm; naive pivots produce noise |
| News catalysts | v2 | the intraday catalyst classifier is tuned for same-day headlines, not multi-week theses |
| Sector strength | v2 | needs sector ETF mapping per symbol |
| Gamma | indirect | delta band + DTE window bound gamma exposure implicitly |

## 6. Data budget

Manual runs only, cached 15 minutes. Cost per run: 1 daily-candles call per
symbol + 1 chain call per symbol that passes the price-action screen, + 1 SPY
candles call — ≈ 40–60 metered calls per run on the ~25-name universe. All
calls go through the central quota meter; the run refuses to start near the
minute cap.

## 7. Calibration plan (the exit from "research preview")

1. Each run's top-5 candidates can be paper-traded in one click.
2. After ≥30 closed paper swings, compare factor scores vs realized outcomes
   (the paper analytics bucket-cuts do this by confidence automatically).
3. Re-weight factors (or drop useless ones) from that evidence; only then does
   the swing scanner earn a place next to the calibrated intraday track record.
