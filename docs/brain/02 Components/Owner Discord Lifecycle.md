# Owner Discord Lifecycle

Status: LIVE_AND_VERIFIED (repaired 2026-08-20)

## Purpose

The end-to-end path an OWNER callout takes, from the ACTIONABLE decision to the nightly
recap line that reports it. This note exists because the path crosses four dynamic module
boundaries that a static import graph cannot follow, and every one of them was a place a
previous audit lost the trail.

## The traced path

```
decideDeliveryBatch                          lib/research/options/delivery-decision.ts
  |
  |-- side === "put"  -> evaluateBearishAuthority
  |     -> maybeSendBearishOwnerReview        (UPSTREAM of the quality/floor/late-phase bars)
  |
  |-- !readiness.allowed -> maybeSendReadinessGatedOwnerOpening
  |                                           (DOWNSTREAM of every delivery bar)
  v
classifyOwnerOpening                          lib/notifications/owner-opening-class.ts
  -> ACTIONABLE | WATCH
  v
sendOwnerPrivateOpening                       lib/research/options/delivery-decision.ts
  |-- claimOpportunityOpenOnDb                lib/opportunity-case/live.ts       (case oc_B)
  |-- [dyn] await import owner-research-notify.ts
  |     -> sendOwnerResearchNotify
  |          |-- WATCH + OWNER_WATCH_DISCORD_SUPPRESSED=1
  |          |     -> [dyn] require alert-store.ts -> createDiscordDelivery(SUPPRESSED)
  |          |-- otherwise
  |                -> [dyn] await import notifications.ts -> sendTrackedDiscord
  |                     -> createDiscordDelivery(PENDING) -> postToDiscord -> SENT | FAILED
  |-- markOwnerActionableOpeningDeliveredOnDb  (writes oc.discord.messageId; NOT delivery truth)
  |-- openOwnerValidationPaperOnDb             (mirror; feature_snapshot_json.opportunityCaseId)
  |-- recordPreMoveAlertOnDb / recordPreMoveV2AlertOnDb
  v
gradeOpenOptionPositionsOnDb                   lib/research/options/grade.ts
  |-- validateLifecycleQuote                   (timestamp rules; unchanged)
  |-- decideOptionExit                         (target_hit | stop_hit | time_stop | expiration)
  |-- OWNER branch:
  |     resolveOwnerLifecycleIdentity
  |       -> feature_snapshot_json.opportunityCaseId
  |       -> ownerOpeningWasSentOnDb           lib/notifications/owner-delivery-truth.ts
  |            -> discord_deliveries.status = 'SENT'   <-- THE authorisation
  |     maybeDeliverOpportunityClosedDiscord
  |       -> formatOpportunityClosedUpdate     (TARGET 1 HIT / CLOSED | STOPPED / CLOSED | ...)
  |       -> [dyn] require notifications.ts -> postToDiscord (reply to opening message id)
  v
runNightlyResearchOnDb                         lib/research/options/nightly-research.ts
  -> buildOwnerDeliveryReconciliationOnDb      lib/research/options/owner-delivery-reconciliation.ts
       |-- loadOwnerDeliveryLedgerOnDb          (DELIVERED TO YOU / NOT SENT)
       |-- buildOwnerLearningReportOnDb         (INTERNAL / PAPER)
  -> formatNightlyResearchSections
  -> [dyn] require in lib/ai/recap.ts -> buildNightlyRecapMessage -> recap webhook
```

## Dynamic boundaries Graphify cannot resolve

Graphify builds its edges from static imports. Every edge below is a `require()` or
`await import()` evaluated at call time, so it is **absent from the graph** and a
`graphify path` query across it returns nothing. They are listed here so the next audit
does not conclude the path ends where the graph does.

| From | To | Form |
|---|---|---|
| `delivery-decision.ts:sendOwnerPrivateOpening` | `notifications/owner-research-notify.ts` | `await import("../../notifications/owner-research-notify.ts")` |
| `owner-research-notify.ts:postOwner` | `notifications.ts` (`sendTrackedDiscord`) | `await import("../notifications.ts")` |
| `owner-research-notify.ts:recordSuppressedOwnerNotify` | `alert-store.ts` (`createDiscordDelivery`) | `require("../alert-store.ts")` |
| `grade.ts:sendLifecycleDiscordUpdate` | `notifications.ts` (`postToDiscord`) | `require("@/lib/notifications")` |
| `delivery.ts` | `notifications.ts` (`postToDiscord`) | `require("@/lib/notifications")` |
| `delivery.ts` | `notifications/owner-intraday-mirror.ts` | `require("@/lib/notifications/owner-intraday-mirror")` |
| `ai/recap.ts` | `nightly-research.ts` (`formatNightlyResearchSections`) | `require("@/lib/research/options/nightly-research")` |
| `ai/recap.ts` | `notifications.ts` | `require("@/lib/notifications")` |
| `scheduler.ts` | `notifications/owner-research-notify.ts` | `require(...)` |

One edge on this path is deliberately **static**:
`grade.ts -> notifications/owner-delivery-truth.ts`. It is the gate that decides whether a
lifecycle message may be sent at all, and a dynamic require would fail open in exactly the
environments (tests, any non-Next runtime) where the guard most needs to be provable.

## Delivery truth

`discord_deliveries.status = 'SENT'` is the only evidence that the owner received a message.
Each of the following exists for a SUPPRESSED opening as well and is therefore **not**
evidence of delivery:

- the `OWNER_VALIDATION_PAPER` mirror — written after the send result, without reading it;
- the opportunity case — `markOwnerActionableOpeningDeliveredOnDb` runs on suppression too,
  because the suppression path reports `sent: true` so the opening claim is not released;
- `owner_research_notify_log` — an idempotency ledger, written on suppression;
- PRE_MOVE / research observation rows.

## The two identities of one owner callout

Unchanged from `owner-mirror-identity.ts`, restated because the lifecycle path uses both:

- **claim case** `oc_B` — minted at delivery; owns the Discord delivery row, the frozen
  trade, `oc.discord.messageId`, and the paper mirror. This is the id on
  `discord_deliveries.opportunity_case_id` and inside
  `options_paper_trades.feature_snapshot_json.opportunityCaseId`.
- **pending audit case** `oc_A` — written by the scanner adapter; owns the PRE_MOVE
  observation. Derived, never stored: `preMoveCaseIdForFingerprint(fingerprint)`.

No owner callout writes an `options_alerts` row, so `alert_id` is null on every owner case
and every owner mirror. Any consumer resolving owner evidence through `alert_id` returns the
empty set, which reads exactly like "the owner made no trades".

## Known limitations

- **Owner opportunity cases are not closed by the grader.** `closeOpportunityOnDb` releases
  the thesis claim and writes a reopen cooldown, which changes *when the next owner callout
  for the same thesis may fire*. That is delivery-cadence behaviour and was out of scope for
  the 2026-08-20 repair. Consequence: an owner case's `lifecycle_status` stays `CREATED`
  after its mirror exits, and its thesis stays claimed.
- **No intermediate milestone updates on the owner lane.** Only the close is delivered.
  `isMilestoneDiscordEligibleOnDb` remains `DELIVERED_ALERT_PAPER`-only by design.
- **A suppressed opening still marks the case `OWNER_ACTIONABLE_DELIVERED`.** Deliberate —
  changing it would release the opening claim and destroy owner-mirror linkage and
  PRE_MOVE_V2 capture. The delivery ledger is the authority instead.

## Related notes

- [[Discord Alerts]]
- [[Opportunity Lifecycle]]
- [[delivery]]
- [[../04 Bugs/Missing Discord Alerts]]
