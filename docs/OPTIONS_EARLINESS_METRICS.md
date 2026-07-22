# OPTIONS_EARLINESS_METRICS

Answers: "Did OptiScan find this before the move became obvious?"

## Recorded per candidate (`options_candidates` + `feature_snapshot_json`)
- first-detected timestamp (candidate `created_at_ms`);
- first-plausible-strategy + chain-fetch + contract-selected timing (via detection→decision latency);
- fraction of the intraday move complete at detection (`fractionMove` = (price − LOD)/(HOD − LOD));
- distance to breakout/reclaim at detection (`nearestResistanceDistPct`);
- earliness `phase`: **early** (fractionMove ≤ 0.4) / **during** (0.4–0.75) / **late** (≥ 0.75).

## Aggregate metrics (`GET /api/research/options` → `monitor`)
- `earliness` counts (early/during/late);
- `fractionMoveComplete` p50/p95;
- `detectionToDecisionMs` p50/p95;
- distributions for rvol / VWAP-distance / compression;
- `optionsActivityEscalations`.

## Honesty
Time-lead-before-expansion and pre-move baseline require richer level history (prev-day/premarket/OR
levels) which are not fully wired yet; those degrade to null and are recorded as missing. No earliness
superiority is claimed until forward REAL_OPTION_PAPER evidence proves it.
