# Missing Discord Alerts

Status: TRACK WHEN ACTIVE

## Problem

Expected Discord alerts do not appear or cannot be verified.

## Investigation path

1. Verify market session and scanner cycle.
2. Check candidate and contract selection.
3. Check delivery decision and suppression reason.
4. Verify Discord configuration and delivery response.
5. Verify paper linkage and opportunity lifecycle.
6. Use Graphify before broad source searching.

## 2026-08-20: owner callouts silenced by a mis-scoped suppression flag

`sendOwnerPrivateOpening` tagged EVERY owner opening `researchObservation: true`, so
`OWNER_WATCH_DISCORD_SUPPRESSED=1` suppressed genuine ACTIONABLE callouts alongside WATCH
observations. Every owner opening from 2026-08-19T15:31Z onward was SUPPRESSED — ten on
2026-08-20, zero SENT. Fixed by `lib/notifications/owner-opening-class.ts`.

Graphify note: the owner Discord path crosses nine dynamic `require()` / `await import()`
boundaries that the static graph does not contain. They are enumerated in
[[../02 Components/Owner Discord Lifecycle]]; a `graphify path` query across any of them
returns nothing, which is a gap in the graph and not an absence of the edge.

## Related notes

- [[../02 Components/Owner Discord Lifecycle]]
- [[../02 Components/Discord Alerts]]
- [[../02 Components/delivery]]
- [[../02 Components/Options Scanner]]
