# Discord Alerts

Status: LIVE_AND_VERIFIED

## Purpose

Deliver qualified options alerts while preserving deduplication, paper linkage, evidence, and delivery safety.

## Measured routing history (2026-07-13 → 2026-07-30, 396 ledger rows)

Read from a production snapshot. Webhooks ever used: `options` (217 sends),
`stocks` (176), `watchlist` (3). **`recap` has never appeared — not once.**

Payload types ever sent: `stock_buy` 174, `callout` 158,
`owner_intraday_actionable` 57, `test` 4, `owner_next_session_watchlist` 2,
`owner_premarket_watchlist_update` 1.

### The recap question — resolved

No daily recap has ever been delivered. `DISCORD_WEBHOOK_RECAP` is unset, the
`Recaps` route reports `BLOCKED` with `lastSend: null`, and no recap-shaped
payload type exists anywhere in the ledger's 17-day history.

What was almost certainly mistaken for a recap is the **NEXT SESSION
WATCHLIST** message on the `watchlist` webhook, which lands right after the
close and is summary-shaped:

- 2026-07-29 18:04 ET — `owner_next_session_watchlist`
- 2026-07-30 08:32 ET — `owner_premarket_watchlist_update`
- 2026-07-30 18:01 ET — `owner_next_session_watchlist`

Status: recap = **MISSING**, never configured. Setting the variable is an owner
decision and has deliberately not been made.

## paperLinkFailure — diagnosed, no defect (2026-07-30)

The session audit reported `paperLinkFailure: 17`. All 17 share one reason:

```
paper_reservation_failed:active_thesis_lane_mismatch:RESEARCH_ONLY_PAPER
state = REJECTED · paper_linked = 0 · discord_message_id = NULL (0 of 17)
```

**None reached Discord.** These are not post-send linkage failures; they are
alerts REJECTED before delivery because the thesis already held an active
position in the `RESEARCH_ONLY_PAPER` lane, so the delivered-alert lane could
not reserve it. That is the paper-linkage-before-delivery gate working as
designed — no reservation, no send. Nothing was delivered, so nothing is
ungraded and no recap is affected.

Separately verified: all 6 SENT non-research alerts that day have
`paper_linked = 1`. No code change was made.

Caveat worth remembering: the metric NAME is misleading. "paperLinkFailure" in
the funnel reads like delivered alerts that failed to link, when it counts
pre-delivery rejections. Diagnostic clarity issue, not a defect.

## Related notes

- [[Options Scanner]]
- [[delivery]]
- [[Opportunity Lifecycle]]
- [[../04 Bugs/Missing Discord Alerts]]
