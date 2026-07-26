# Paid Discord Beta — Launch Checklist

Use `/api/research/paid-beta-readiness` (auth-gated) for live metrics.

## Before accepting money from even one subscriber

### Phase 1 — Alert reliability (Critical)
- [ ] `SCAN_API_TOKEN` set; unauthenticated Discord retry routes return 401
- [ ] `SUBSCRIBER_OPTIONS_DISCORD_OWNER=independent`
- [ ] `AGENT_CALLOUT_DISCORD=0` (supervisor options suppressed)
- [ ] `OPTIONS_CALLOUTS_KILL=0` (test kill switch works)
- [ ] Quota exhaustion shows operator warning on System Health (`discovery_paused` / `operator_warning`)
- [ ] Opening → milestone → close replies thread to original Discord message when `discord_message_id` present

### Phase 2 — Claim integrity (Critical)
- [ ] `/api/research/subscriber-claim/[alertId]` returns ok only for SENT + DELIVERED_ALERT_PAPER + matching frozen entry
- [ ] Performance UI uses delivered-only lane
- [ ] MFE labeled as peak, not realized gain
- [ ] `OPTIONS_SUBSCRIBER_EXIT_MODE=targets_then_bands` matches opening alert copy

### Phase 3 — Lifecycle (High)
- [ ] `OPTIONS_RETURN_MILESTONES=20,30,50,75,100`
- [ ] ≥ 5 milestone Discord updates in soak
- [ ] Confirmation / thesis / exit-warning events remain deferred (no spam)

### Phase 4 — Subscriptions (Critical before payment)
- [ ] `BILLING_ENABLED=1` + Stripe keys + webhook secret
- [ ] Discord bot token, guild id, subscriber role id
- [ ] Test checkout → webhook → role grant → cancel → role revoke
- [ ] Terms + disclaimer in Discord channel and Checkout

### Phase 5 — Social drafts (High before public marketing)
- [ ] Milestone creates `opportunity_content_events` with status PENDING/DRAFTED
- [ ] `/social-drafts` approve / reject / copy workflow
- [ ] No code path auto-posts to X/Twitter

### Phase 6 — Soak gates
- [ ] ≥ 10 trading days with SENT alerts
- [ ] ≥ 20 delivered opportunities
- [ ] ≥ 5 milestone updates
- [ ] 0 duplicate openings per fingerprint/day on subscriber webhook
- [ ] 0 supervisor options posts to subscriber webhook
- [ ] ≤ 5% READY→TOO_LATE/ambiguous (reviewed weekly)

## Recommended targets

| Metric | Target |
|---|---|
| Live soak | 10 trading days |
| Delivered alerts | ≥ 20 |
| Milestone updates | ≥ 5 |
| Duplicate openings | 0 |
| Dual-sender incidents | 0 |
| Ambiguous sends | Review each; log in `discord_send_attempts` |

## Emergency

Set `OPTIONS_CALLOUTS_KILL=1` to stop new subscriber Discord openings immediately. Billing and role sync continue independently.
