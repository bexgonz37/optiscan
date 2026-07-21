# OPTIONS_PAPER_COLLECTION_RUNBOOK

Goal: collect forward REAL_OPTION_PAPER evidence with no Discord and no real money.

## Enable (Railway env), safest order
1. `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1` — the monitor observes + records candidates (no paper, no
   Discord). Watch `GET /api/research/options` → `monitor` metrics + `report.candidates`.
2. `REAL_OPTION_PAPER_ENABLED=1` — real-option paper entries begin (regular session only, fresh quote,
   conservative fill, dedup + max-concurrent + per-symbol exposure). Watch `report.paper.byClass`
   (only REAL_OPTION_PAPER) and `performance` split by strategy/side/DTE/core-vs-broad.
3. Leave `EARLY_OPTIONS_CALLOUTS_ENABLED` OFF (public delivery is a later, approved step).

## Exposure controls
`OPTIONS_PAPER_MAX_CONCURRENT` (20), `OPTIONS_PAPER_MAX_PER_SYMBOL` (2),
`OPTIONS_PAPER_DEDUP_BUCKET_MS` (60s). Fills conservative (60% toward ask); exits 60% toward bid; P&L
from the option contract ×100.

## Verify
- candidates rising; chains fetched << symbols scanned; breaker closed; throttles low.
- paper rows all `REAL_OPTION_PAPER`; calls AND puts both present (puts RESEARCH_ONLY); reports NOT
  blended with the stock radar.

## Rollback
Unset the flag (Railway redeploys). No schema rollback (additive). The monitor stops cleanly; the
stock radar is unaffected throughout.
