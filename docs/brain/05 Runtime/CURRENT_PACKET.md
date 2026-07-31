# Current Task Packet

Task ID: high-asymmetry-first-live-session-observation

## Active position

- Branch: `feature/high-asymmetry-radar`, merged with `origin/main`
- `origin/main` before this work: `49b2174`
- Merged and deployed commit: **`cdfcfc7`** (deployment `5686432103`, success)
- Production verified inert on 2026-07-31

## Completed — production hardening (already live on main)

| Commit | Concern | Status |
| --- | --- | --- |
| `08bb849` | Browser connection-pool exhaustion (poll guard) | LIVE_AND_VERIFIED |
| `0b67ba8` | `/api/now` alert-lookup indexes (14s → 2.5s p95 3.06s) | LIVE_AND_VERIFIED |
| `cb89c03` | Discord panel authenticated reads | LIVE_AND_VERIFIED |
| `be68a12` | Watchlist copy signed-move fix | DEPLOYED_UNPROVEN |

All four survived the merge, verified by grep for their distinguishing symbols.

## Completed — High-Asymmetry runtime graph

Every node has a real caller or scheduler. All five tables have both a writer
and a reader. Off by default at every stage.

| Feature | Status |
| --- | --- |
| Live call site in `options/loop.ts` | BUILT_DISABLED |
| Shadow-case persistence (5 additive tables) | BUILT_DISABLED |
| Transition runner + scheduler (`asymmetryTransitions`, 60s) | BUILT_DISABLED |
| Owner-private notifier wiring | BUILT_DISABLED |
| Forward marks + scheduler (`asymmetryMarks`, 60s due-work) | BUILT_DISABLED |
| Outcome aggregation | BUILT_DISABLED |
| EOD Quant review (`asymmetryEod`, hourly) | BUILT_DISABLED |
| AI advisory (injected, post-persistence) | BUILT_DISABLED |
| Private diagnostics route | BUILT_DISABLED |
| Verified quote provider | BUILT_DISABLED |
| Merged to main and deployed | LIVE_AND_VERIFIED |
| Flags activated in production | LIVE_AND_VERIFIED |
| Runners executing (ran: true) | LIVE_AND_VERIFIED |
| Executed against a live CANDIDATE | MISSING — market closed since activation |
| Asymmetry tables on the production volume | MISSING until the first enabled write |
| Subscriber SEND authority | MISSING (permanently, by design) |

## Feature flags — ALL THREE NOW SET BY THE OWNER

- `HIGH_ASYMMETRY_CAPTURE_ENABLED` — **enabled**
- `HIGH_ASYMMETRY_PRIVATE_ENABLED` — **enabled**
- `HIGH_ASYMMETRY_PRIVATE_WEBHOOK` — **configured**

Verified by PRESENCE only; the webhook value has never been displayed,
retrieved, or logged. The collision guard reports `refusedReason: null`, so the
configured webhook is not the alerts, watchlist, recap, or generic webhook.

I did not set these. No other Railway variable was changed;
`DISCORD_WEBHOOK_RECAP` remains unconfigured.

## What remains unproven

- **The radar has never executed against a live candidate. Zero cases exist.**
- The quote provider is verified at the INTERFACE level — the export exists,
  arity is 2, `providerTimestamp` is mapped to the field `validateMark` reads,
  and `PROVIDER_ERROR` is distinct from `NO_QUOTE` — but it has never been
  called against the live chain. Whether `fetchOptionChain` returns a contract
  whose `optionSymbol` matches a stored OCC exactly is untested in production.
  If it does not, marks record `NO_QUOTE`: safe, but zero graded outcomes.
- Graphify cannot prove the three scheduler → runner edges. The scheduler uses
  dynamic `require()` (26 of them, the convention for every job in that file),
  which the AST extractor cannot resolve; the pre-existing
  `watchlistPlanningJob` shows the identical artefact. Those edges are proven by
  source and tests instead, not by a multi-hop Graphify path.

## Exact next bounded checkpoint

Observe one live session with the radar DISABLED, then decide on activation.

ACTIVATION IS DONE. Verified at `cdfcfc7`, pre-activation:
- all three scheduler jobs ran and declined with the exact flag reason, errors []
- diagnostics 200, zero cases, `canSendSubscriber false`, no webhook exposed
- Discord byte-identical to baseline (sent24h 2, same lastSentAt); nothing sent
- scanner `running: true`; all seven routes 200

Activation verified after the variables were set. Market has been CLOSED
throughout (activated ~00:50 ET Friday; next open 09:30 ET), so nothing has been
captured.

**Next: observe the first live session (Friday 2026-07-31, 09:30–16:00 ET).**
Watch, in order:
1. `activeCases` becomes non-zero — proves the live call site fires.
2. The five tables get created on the first write.
3. `markRejections` — the single most important unknown. If it fills with
   `NO_QUOTE`, the OCC returned by `fetchOptionChain` does not match the stored
   OCC and forward marking is inert. `PROVIDER_ERROR` instead means an outage.
4. `recentTransitions` and `notifiedCount` — the first owner-private message.
5. After 20:15 ET, the EOD review persists with `aiStatus: OK`.

Do not tune any threshold during the first session.

## Stop conditions

- do not set any Railway variable without explicit owner approval
- do not enable capture or private notification as part of verification
- do not send any Discord test message
- do not touch trading gates, ranking, or subscriber delivery
- do not stage Obsidian line-ending noise, `graph.json`, `workspace.json`,
  `graphify-out/`, or unrelated files
- do not describe the radar as active: it is built and disabled, and has never
  observed a live candidate

## Relevant notes

- [[../02 Components/High-Asymmetry Radar]]
- [[../02 Components/safety]]
- [[../02 Components/deployment]]
- [[../02 Components/Discord Alerts]]
