# MISSED_OPTIONS_OPPORTUNITIES

Method for quantifying opportunities the current options path MISSED (candidates that ran but were
never surfaced). Requires the shadow layers enabled for data collection (flags OFF by default); with
no shadow sample yet, this is COLLECTING_DATA.

## What to compare (three lanes, section E of the plan)
1. baseline live options path (momentum-trigger + 0DTE chain);
2. broad-discovery-only (independent earnings + options-activity discovery, shadow);
3. broad + analog shadow evidence.

## Signals of a miss (from shadow tables once enabled)
- `discovery_shadow` eligible names with strong early signals that never produced an alert;
- `options_activity_shadow` abnormal (abstain=0) names not in the baseline options universe;
- `earnings_shadow` post-earnings/gap names not surfaced;
- earliness (`lib/research/shadow/earliness.ts`): fraction-of-move-complete at (would-be) detection,
  time lead before first expansion, price improvement vs a momentum-only baseline.

## Status
COLLECTING_DATA — no forward shadow sample yet. Enable `BROAD_DISCOVERY_SHADOW_ENABLED` /
`OPTIONS_ACTIVITY_DISCOVERY_ENABLED` (data collection only) to populate. No superiority is claimed
until forward evidence proves it.
