# Observability Sprint Report — Phases 1–3

_Date: 2026-07-24. Live gates/thresholds/delivery logic unchanged. AI has no production authority._

## What shipped

| Area | Deliverable |
|---|---|
| Metric trust | Pipeline-labeled Scanner Health; removed mixed-domain fallbacks |
| Dictionary | `docs/METRIC_DICTIONARY.md` + `lib/metrics/dictionary.ts` |
| Canonical funnel | `lib/metrics/funnel-attribution.ts` — Observed→…→Discord Sent |
| persistOk deep diagnostics | `lib/metrics/persist-ok-diagnostics.ts` + `gate_diagnostics_json` on NEAR_MISS |
| Gate latency | `lib/metrics/gate-latency.ts` — avg/P50/P95/P99/queue/cumulative |
| Funnel Explorer | `GET /api/ai/funnel-explorer` + AI Lab developer card |
| Tests | `tests/observability-sprint.test.mjs` |

## Previous dashboard metrics that were incorrect

| Metric | Incorrect behavior | Corrected behavior |
|---|---|---|
| **Opportunity Capture Rate** | Used `options.delivered/canonical`, else fell back to paper `created/candidates` — mixed pipelines; 0% when supervisor idle | Supervisor-only; **n/a** when canonical=0; independent capture reported separately in Funnel Explorer |
| **Missed Fast Movers** | Could use in-memory `counts.nearMisses` (cleared on restart) | Persisted `summary.momentum.nearMisses` only |
| **Gate breakdown** | Added +1 per raw `momentum_diagnostics` row on top of nightly aggregates (double-count) | Nightly aggregates only; diagnostic rows supply examples |
| **Average Alert Delay** | Could mix `summary.timing` with momentum latency | Stock path uses `summary.momentum.avgLatencyMs` only |

## Corrected values (logic)

Exact production numbers require a live day of data after deploy. Fixture-proven behavior:

- Supervisor capture with `delivered=2, canonical=4` → **50%** (unchanged math, correct labeling).
- Supervisor capture with no options digest / `canonical=0` → **n/a** (was previously able to show a misleading paper-derived %).
- Gate VWAP count with `extendedRejections=2` and 10 raw NEAR_MISS rows → **2** (was 12).

## Remaining unknowns

1. **True unique missed-opportunity rate** — still raw NEAR_MISS rows until Phase 4 dedup.
2. **Whether persistOk FN rate is high** — sub-reasons now recorded; forward outcomes not yet labeled (Phase 6).
3. **Monitor detection→decision P95** — live in-memory only; not persisted across restarts.
4. **Independent vs supervisor product mix in production** — Funnel Explorer now shows both; compare after one trading week.
5. **Historical days before this deploy** lack `gate_diagnostics_json` — persistOk sub-reason % starts accumulating going forward.

## Recommendations for Phase 4 (do not implement yet)

- Deduplicate NEAR_MISS / Missed Fast Movers by `{ticker, tradingDay, episodeWindow}`.
- Recompute Missed Runner Rate on deduped episodes.
- Keep raw row counts available behind a toggle for debugging.
- Success metric: headline Missed Fast Movers should drop (often 40–70% hypothetically) without any gate change — validate on ≥5 trading days before replacing the headline.

## Estimated impact of future phases (pre-implementation)

| Phase | Est. impact on signal quality | Est. impact on alert volume | Risk |
|---|---|---|---|
| **4 Dedup metrics** | High clarity / trust; zero live change | None | Low |
| **5 Emitted-but-undelivered attribution** | High diagnostic; zero live change | None | Low |
| **6 Forward outcome labels** | Unlocks evidence for gate FN/FP | None until Phase 8 | Low |
| **7 Shadow challengers** | Parallel measurement | None (flags off) | Low |
| **8 Threshold changes** | Potentially high win-rate | Flat or down by design | Medium — only with ≥100 labeled episodes |

## Explicit non-goals confirmed

- No live trading logic changes
- No threshold changes
- No delivery gate changes
- No AI influence on production decisions
