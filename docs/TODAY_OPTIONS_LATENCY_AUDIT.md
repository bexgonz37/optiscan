# TODAY_OPTIONS_LATENCY_AUDIT

I cannot read Railway production logs/DB from this environment, so this is the exact method +
queries to attribute today's late/sparse options callouts to a pipeline stage using STORED data.

## Stored timestamps
`momentum_diagnostics` records `first_seen_ms`, `first_ranked_ms`, `first_promoted_ms`,
`first_actionable_move_pct`, `discord_move_pct` and per-window returns. `alerts` records
`signal_detected_at`, `last_confirmed_at`, `data_timestamp`, `expires_at`. `paper_trades` records
`created_at_ms`, `entry_at_ms`, `freshness_at_entry`.

## Attribution queries (run read-only on production)
```sql
-- detection → rank → promote → actionable lead, and the move already gone at each stage
SELECT symbol, first_seen_ms, first_ranked_ms, first_promoted_ms,
       first_seen_move_pct, first_ranked_move_pct, first_promoted_move_pct, first_actionable_move_pct, discord_move_pct
FROM momentum_diagnostics ORDER BY first_seen_ms DESC LIMIT 50;

-- options paper fills: how much of the move elapsed before entry, and non-fill reasons
SELECT ticker, option_symbol, created_at_ms, entry_at_ms, (entry_at_ms-created_at_ms) AS queue_ms,
       status, close_reason, freshness_at_entry
FROM paper_trades WHERE option_symbol IS NOT NULL AND created_at_ms >= (strftime('%s','now','-1 day')*1000)
ORDER BY created_at_ms DESC;
```

## Interpretation
- Large `first_actionable_move_pct` ⇒ the move was already extended at actionability ⇒ **too late**
  (tighten early signals / chase limit, not confirmation).
- Large `first_ranked_ms − first_seen_ms` ⇒ ranking/promotion delay.
- Large `entry_at_ms − created_at_ms` with `close_reason` "entry window" ⇒ revalidation/freshness
  rejected the fill (stricter confirmation delayed/blocked delivery).
- Chain fetch is up to 4 provider calls per triggering symbol (0–1 then 0–5 DTE, 2 pages each); if
  `getCallStats` shows minute-budget pressure, discovery + chain fetches are skipped ⇒ sparse callouts.

No production numbers are asserted here; run the queries to get them.
