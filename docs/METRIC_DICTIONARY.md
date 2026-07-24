# Metric Dictionary — OptiScan Production Observability

_Last updated: 2026-07-24. Observability sprint Phases 1–3._

Machine-readable source: [`lib/metrics/dictionary.ts`](../lib/metrics/dictionary.ts).

**Rules**

1. Every Scanner Health / Funnel Explorer metric must appear here.
2. No metric may mix `STOCK_MOMENTUM`, `SUPERVISOR_OPTIONS`, `INDEPENDENT_OPTIONS`, or `PAPER_OUTCOMES` without an explicit pipeline label.
3. If a value cannot be computed from stored deterministic data, show **n/a** — never invent a fallback from another pipeline.
4. Live gates, thresholds, and delivery logic are **out of scope** for this dictionary.

---

## Pipelines

| Pipeline | What it measures | Primary tables |
|---|---|---|
| `STOCK_MOMENTUM` | Stock scanner near-misses, SENT latency, earliness | `momentum_diagnostics` |
| `SUPERVISOR_OPTIONS` | Supervisor cycle funnel (canonical → delivered) | `options_diagnostics` |
| `INDEPENDENT_OPTIONS` | Independent monitor candidate → Discord | `options_candidates`, `options_delivery_decisions`, `options_alerts` |
| `PAPER_OUTCOMES` | Graded paper trade results | `paper_trade_outcomes` → nightly `ai_reports.summary` |
| `INFRA` | Health / schema / provider | various |

---

## Scanner Health components

### Early Alert Rate — `stock_early_alert_rate`

| Field | Value |
|---|---|
| **Pipeline** | `STOCK_MOMENTUM` |
| **SQL** | Derived from `summarizeEarliness(SENT/RESCUED_SENT rows)` stored as `summary.momentum.earliness.pctEarly` |
| **Source tables** | `momentum_diagnostics`, `ai_reports.summary` |
| **Timestamp** | `eval_at_ms` / `trading_day` |
| **Numerator** | Alerts graded EARLY |
| **Denominator** | Gradable SENT/RESCUED_SENT alerts |
| **Assumptions** | Only alerts that actually sent |
| **Limitations** | Null when no SENT rows; not options path |

### Missed Runner Rate — `stock_missed_runner_rate`

| Field | Value |
|---|---|
| **Pipeline** | `STOCK_MOMENTUM` |
| **SQL** | `COUNT(decision='NEAR_MISS') / COUNT(*)` on `momentum_diagnostics` for `trading_day` |
| **Timestamp** | `eval_at_ms` |
| **Numerator** | NEAR_MISS rows (raw) |
| **Denominator** | All momentum diagnostic rows that day |
| **Assumptions** | Persisted table only |
| **Limitations** | **Not opportunity-deduplicated** (Phase 4). Multiple rows per symbol/day possible. Does not prove missed profitable trades. |

### Missed Fast Movers (count) — `stock_missed_fast_movers_count`

| Field | Value |
|---|---|
| **Pipeline** | `STOCK_MOMENTUM` |
| **SQL** | `SELECT COUNT(*) FROM momentum_diagnostics WHERE trading_day=? AND decision='NEAR_MISS'` |
| **Source** | `summary.momentum.nearMisses` only |
| **Assumptions** | Single persisted source |
| **Limitations** | **Never** use `counts.nearMisses` from the in-memory `/api/scanner/live` ring (cleared on restart). |

### False Positive Rate — `paper_false_positive_rate`

| Field | Value |
|---|---|
| **Pipeline** | `PAPER_OUTCOMES` |
| **SQL** | `losses / (wins+losses+breakeven)` from nightly `summary.overall` |
| **Limitations** | Paper outcomes ≠ live Discord fills |

### Win Rate / Signal Quality — `paper_win_rate` / `paper_signal_quality`

| Field | Value |
|---|---|
| **Pipeline** | `PAPER_OUTCOMES` |
| **Source** | `summary.overall.winRate` / `opportunityHitRate` |

### Average Alert Delay — `stock_avg_alert_delay_ms`

| Field | Value |
|---|---|
| **Pipeline** | `STOCK_MOMENTUM` |
| **SQL** | `AVG(trigger_to_discord_ms)` from `momentum_diagnostics` |
| **Correction** | No longer falls back to generic `summary.timing` mixed sources |

### Opportunity Capture (Supervisor Options) — `supervisor_options_capture_rate`

| Field | Value |
|---|---|
| **Pipeline** | `SUPERVISOR_OPTIONS` |
| **SQL** | `SUM(delivered) / SUM(canonical)` from `options_diagnostics` where `trading_day=?` |
| **Numerator** | Delivered supervisor callouts |
| **Denominator** | Canonical supervisor callouts |
| **Assumptions** | Supervisor runtime recorded cycles |
| **Limitations** | **Does not measure independent options monitor.** When `canonical=0`, value is **n/a** (not 0%). |
| **Correction** | Removed fallback to `counts.created / counts.candidates` (mixed PAPER domain). |

### Opportunity Capture (Independent Options) — `independent_options_capture_rate`

| Field | Value |
|---|---|
| **Pipeline** | `INDEPENDENT_OPTIONS` |
| **SQL** | `COUNT(options_alerts.state='SENT') / COUNT(options_candidates.state='READY')` in window |
| **Timestamp** | `created_at_ms` |
| **Shown in** | Funnel Explorer (AI Lab), not the legacy single “Opportunity Capture Rate” tile |

### Profit Factor — `profit_factor`

| Field | Value |
|---|---|
| **Pipeline** | `PAPER_OUTCOMES` |
| **Computable** | **false** — not stored in nightly summary |
| **Display** | Always n/a |

---

## Canonical funnel (Independent Options)

Stages (every transition has timestamp, latency, rejection reason, gate):

1. `observed`
2. `qualified`
3. `strategy_selected`
4. `candidate_created`
5. `delivery_decision`
6. `delivery_attempted`
7. `discord_sent`

**Implementation:** `lib/metrics/funnel-attribution.ts`  
**API:** `GET /api/ai/funnel-explorer`  
**UI:** AI Lab → Funnel Explorer (developer)

---

## persistOk diagnostics

| Sub-reason | Meaning |
|---|---|
| `ring_too_short` | Ring length &lt; persistence window |
| `insufficient_hits` | Some hits but &lt; minHits |
| `rate_below_threshold` | Measurable rates but 0 hits at minRate |
| `no_measurable_rate` | Sub-windows produced no rate |
| `cooldown_first` | Cooldown was the first failed gate |
| `another_gate_first` | Another gate failed before persistOk in evaluation order |

Stored on `momentum_diagnostics.gate_diagnostics_json` (additive; never changes live `persistOk` boolean).

---

## Gate latency

Reported per gate/stage: avg, P50, P95, P99, queue delay (when instrumented), cumulative.

Sources:

- Stock: `first_seen_ms → eval_at_ms`, `trigger_to_discord_ms`
- Options: `options_alerts.latency_ms`, attempt/sent timestamps
- Monitor detection→decision: **live in-memory only** (documented as unavailable in persisted report)

---

## Known incorrect metrics (pre-sprint) and corrections

| Metric | Was wrong? | Correction |
|---|---|---|
| Opportunity Capture Rate | **Yes** — mixed supervisor with paper `created/candidates` fallback; showed 0% when supervisor idle | Supervisor-only; n/a when canonical=0; independent capture separate |
| Missed Fast Movers | **Partially** — dual source (persisted vs in-memory ring) | Persisted `momentum.nearMisses` only |
| Gate breakdown VWAP share | **Yes** — double-counted raw NEAR_MISS rows on top of aggregates | Aggregates only; raw rows are examples |
| Scanner Health grade | **Misleading** — 0% capture dragged grade when measuring wrong pipeline | Capture n/a when supervisor idle |

---

## Phase 4 preview (not implemented)

Deduplicate NEAR_MISS / missed runners by opportunity episode before using counts for tuning.
