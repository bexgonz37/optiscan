# Phase F — Forward Paper Validation + Two-Speed Alerts

Status: **COLLECTING_DATA**. The infrastructure is complete and flag-gated **OFF**; it produces no
evidence yet. Forward performance and production latency are only valid once measured on real
production traffic. Historical replay speed is **not** live-alert speed and is never presented as such.

## Safety invariants (unchanged)
- `BEARISH_ACTIONABLE` off ⇒ bearish/short ideas are **research-only**; `lib/bearish-gate.ts` is the
  final authority (the two-speed early-watch path routes every bearish/put decision through it).
- **Puts are RESEARCH_ONLY.** No real-money execution anywhere in this phase.
- Captured recommendations are **immutable** — written once, never altered after the outcome is seen.
- Forward outcomes are graded **only** from bars strictly after capture (no look-ahead).

## 1. Forward paper capture
`lib/research/forward/{schema,capture,grade}.ts` + tables `forward_recommendations` (immutable) and
`forward_outcomes`. Every eligible recommendation is recorded prospectively with its decision-time
fields (timestamp, symbol, direction, strategy bucket, underlying price, contract, confidence, gates,
catalyst, technical state, analog result, rejection/abstain reasons). Outcomes are graded at the
horizon ladder (15m/30m/1h/EOD/1d/3d/5d) and compared to the Phase-D backtest. Performance is split by
strategy bucket: bullish/bearish × call/put/stock × 0DTE/short/longer. Flag: `FORWARD_CAPTURE_ENABLED`.

## 2. Two-speed Discord alert architecture
`lib/research/forward/twospeed.ts`. The **EARLY_WATCH** decision (`evaluateEarlyWatch`) takes ONLY fast,
deterministic inputs (velocity/rel-volume trigger + minimum hard safety/liquidity gates) — its input
type cannot even reference analog/LLM/news results, so heavy work is **structurally excluded** from the
critical path. After EARLY_WATCH ships, enrichment runs in parallel (technical confirmation, options
chain, catalyst/news, analog lookup, scoring + remaining gates) and `resolveConfirmation` updates the
original alert to **CONFIRMED | CANCELED | TOO_LATE | EXPIRED**. Flag: `TWO_SPEED_ALERTS_ENABLED`.

```
market event → fast trigger → hard safety/liquidity gates → EARLY_WATCH (Discord)
                                                              │
                    ┌─────────────────────────────────────────┴───────── parallel ───────┐
              technical confirm   options chain   catalyst/news   analog lookup   scoring/gates
                    └───────────────────────────── resolveConfirmation ──────────────────┘
                                              → CONFIRMED / CANCELED / TOO_LATE / EXPIRED (update)
```

## 3. Latency instrumentation
`lib/research/forward/latency.ts` + `two_speed_alerts.latency_json`. Every stage is stamped on **one
clock** (caller-supplied `Date.now()`), so all durations are same-clock differences. Exposed:
event→trigger, trigger→early-watch, event→Discord-delivery, event→confirmation, each as p50/p90/p95/max;
failure/retry counts; TOO_LATE %, canceled %, late-entry % (delivered after the underlying already left
the entry zone); and a `heavyWorkOnCriticalPath` counter that MUST be 0.

**Initial validation targets (NOT yet achieved — must be measured in production):**
- EARLY_WATCH p50 < 3s, p95 < 8s
- no LLM or historical-replay work on the critical path
- explicit TOO_LATE classification instead of sending stale entries
- Discord failures retry safely without duplicate alerts

## 4. Entry freshness
`lib/research/forward/freshness.ts`. Immediately before delivery the underlying is re-checked against
the observed price/timestamp, the suggested entry zone, and a max chase/slippage threshold; if the
move already ran in-direction past the threshold, left the zone, or the observation is stale, the alert
is **TOO_LATE** and is not sent as a live entry.

## 5. Product-readiness report
`lib/research/forward/report.ts` + `GET /api/research/forward` (read-only, token-gated). Sections:
forward sample size, win/expectancy by strategy, max drawdown, calibration by confidence bucket,
backtest-vs-forward degradation, latency distribution, stale/late/canceled rates, provider/data
outages, Discord delivery reliability, and an explicit `missingEvidence[]` list. Status is
`COLLECTING_DATA` until the forward and latency samples are large enough.

## 6. Commercial-readiness gaps (must clear before charging)
These are **not** satisfied and are always listed as outstanding by the report:
- **Production latency proof** — real p50/p95 EARLY_WATCH latency from live traffic.
- **Sufficient forward sample size** — enough graded recommendations per strategy bucket.
- **Uptime & incident monitoring** — alerting on outages, worker death, provider failures.
- **Customer-facing disclaimers & terms** — not financial advice; puts research-only; risk disclosure.
- **Data-vendor redistribution / commercial-use approval** — Polygon/Massive terms for redistributing
  quotes/derived signals to paying subscribers.
- **Subscription / access control** — auth, entitlements, per-tier gating.
- **Audit history** — immutable record of what was sent, when, and why.
- **Alert editing & cancellation behavior** — safe, idempotent updates (no duplicate/late fills).
- **Support / refund expectations** — documented policy.

## Enabling (controlled, later)
Set `FORWARD_CAPTURE_ENABLED=1` and/or `TWO_SPEED_ALERTS_ENABLED=1` on Railway. Both default OFF, so
production behavior is unchanged until explicitly enabled. Do not advance to Phase G until Phase F has
real forward observations and measured production latency; if that needs time, this ships in
COLLECTING_DATA and the report enumerates exactly what evidence is still missing.
