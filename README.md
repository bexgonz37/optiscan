# OptiScan — Options Scanner

A standalone, dark "trading terminal" web app that scans the options market for two
kinds of setups and alerts you when strong ones appear. **Signals only — it never
places orders.**

- **Momentum tab** — the best call/put on the stocks with the strongest intraday
  momentum (score, grade, target-delta contract, entry, breakeven, greeks).
- **Unusual Activity tab** — option contracts trading far above their open interest
  (volume/OI ratio), a tell for fresh, aggressive positioning.

Data comes from [Polygon / Massive](https://polygon.io/) (stocks + options from one
key). The heavy signal math is reused from the momentum-radar project; everything
here (UI, API, unusual-activity detector, caching) is new.

## Quick start

```bash
# 1. install deps
npm install

# 2. add your key
copy .env.local.example .env.local   # Windows (use cp on macOS/Linux)
#   then edit .env.local and set POLYGON_API_KEY=your_key

# 3. run
npm run dev
```

Open http://localhost:8780.

Without a key the UI loads and explains what to add; with a key both scanners fill
with live signals.

## How it works

```
Browser (dark UI, polls every 15-120s)
  └─ /api/scan/momentum  ┐
  └─ /api/scan/unusual   ├─ runScan()  (cached ~45s)
  └─ /api/scan/[symbol]  ┘     │
                               ├─ Polygon: bulk quotes + top movers -> shortlist
                               ├─ per symbol (bounded concurrency):
                               │     candles -> buildMomentumSignal
                               │     option chain -> buildOptionSignal + unusual detector
                               └─ ranked momentum[] + unusual[]
```

One underlying scan feeds both tabs. Results are cached for `SCAN_CACHE_MS` and
per-symbol fan-out is capped by `SCAN_CONCURRENCY`, so frequent polling stays within
Polygon's rate limits.

## Alerts

Click **Alerts on** in the top bar to enable browser desktop notifications + a sound
whenever a new **STRONG** (score ≥ 80) signal appears in either tab. Alerts are
de-duplicated per contract so you're only pinged once.

## Configuration

All tuning is via `.env.local` — see `.env.local.example` for the full list:
scan sizing / rate-limit controls, momentum thresholds, options contract selection,
and unusual-activity thresholds.

### Rate limits

The Polygon free tier allows ~5 calls/min and returns 15-minute delayed data. Each
shortlisted symbol costs ~2 calls (candles + chain), so keep `RADAR_SHORTLIST` small
(e.g. 4-6) on the free tier and raise it once you're on a paid Stocks + Options plan
for real-time data and higher throughput.

## Notes

- Signals only. Always verify quotes in your broker before trading.
- Not financial advice.
