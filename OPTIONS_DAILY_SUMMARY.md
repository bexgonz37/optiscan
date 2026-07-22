# OPTIONS_DAILY_SUMMARY

An automatic, private, once-per-day recap of the options scanner. No manual command; built from the DB
and delivered to a private webhook. Source: `lib/research/options/daily-summary.ts`.

## When it sends

- Fired from the grader tick via `maybeSendDailySummary` (cheap; deduped) — no separate scheduler.
- Only after `OPTIONS_SUMMARY_HOUR_ET` (default **16:00 ET**, post-close) for the current ET day.
- **Idempotent per day**: `options_runtime.last_summary_day` guards against a second send.
- **HARD no-op** unless `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1`.
- **Never sent when the system was disabled and did nothing** — `buildDailySummaryOnDb` returns `null`
  (flag off + zero activity), and the day is marked so it stays silent.

## Delivery target

Private webhook: `DISCORD_WEBHOOK_RECAP` when set, otherwise the options webhook. `skipPublicCheck:true`
(this is a private operator recap, not a public callout). Carries the `PAPER/BETA TEST — NOT FINANCIAL
ADVICE` label. On send failure the day is **not** marked, so it retries on the next tick.

## Contents (concise)

- symbols scanned; candidates found
- calls vs puts **evaluated** (puts are research-only / not actionable)
- callouts sent / failed / too-late / rejected, with top rejection reasons
- paper trades opened / closed; wins / losses; current open positions
- earliness: early / during / late counts
- provider failures; whether the monitor stayed healthy (from the persisted heartbeat)

Example line format:

```
📊 OptiScan Options — daily summary 2026-07-21
Scanned 12 sym's · candidates 3 · calls 9/puts 4 evaluated
Callouts: sent 2, failed 0, too-late 1, rejected 4
Paper: opened 3, closed 2 (W 1 / L 1), open now 1
Earliness: early 2 · during 1 · late 0
Provider failures 0 · monitor healthy ✅
Top rejections: spread_too_wide×3, stale_quote×1
PAPER/BETA TEST — NOT FINANCIAL ADVICE
```

## Windowing

One ET calendar day, approximated as `04:00Z`→ +24h (covers the ET trading day across EDT/EST). Counts
come only from the options tables (`options_candidates`, `options_alerts`, `options_paper_trades`) — the
Stock Momentum Radar is never blended in.

Tested: content is built from the DB, exactly one summary is sent per day, and a disabled+idle system
sends nothing.
