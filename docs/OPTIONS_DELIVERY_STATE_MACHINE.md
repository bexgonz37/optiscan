# OPTIONS_DELIVERY_STATE_MACHINE

Honest send states (`options_alerts.state`). `SENT` is written ONLY after a successful Discord response.

```
candidate READY
   │  (flags off / kill)         → READY (no send, no row)
   │  research-only put           → REJECTED (research_only_put_suppressed)
   │  zero-bid / wide spread      → REJECTED
   │  stale quote / chase exceeded→ TOO_LATE
   │  duplicate alertId (SENT/SEND_ATTEMPTED) → dedup (no send)
   ▼
SEND_ATTEMPTED  (row claimed BEFORE the request, so a concurrent call dedups)
   │  webhook 2xx                 → SENT   (sent_at, status, latency)
   │  clear failure (HTTP/err)    → SEND_FAILED  (bounded retry with backoff, then stop)
   │  ambiguous timeout           → SEND_FAILED  (retry_count exhausted → NEVER resent)
   ▼
(EXPIRED — aged out before READY)
```

## Persisted per alert
alert_id, candidate_symbol, strategy, option_symbol, side, research_only, state, message_hash,
message, delivered_bid/ask/underlying, paper_linked, discord_status, latency_ms, retry_count,
failure_reason, attempted_at_ms, sent_at_ms, created/updated. The webhook URL is NEVER stored.

## Duplicate safety
- `alertId` is deterministic (symbol|strategy|contract|5-min bucket).
- A row in `SENT` or `SEND_ATTEMPTED` blocks any further send.
- An `SEND_FAILED` caused by an ambiguous timeout has `retry_count = maxRetries`, so a later call hits
  `retry_ceiling_reached` and cannot resend — a possibly-delivered message is never duplicated.
