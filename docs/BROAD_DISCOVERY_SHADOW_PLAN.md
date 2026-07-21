# BROAD_DISCOVERY_SHADOW_PLAN

Shadow-mode broad candidate discovery. **Flag: `BROAD_DISCOVERY_SHADOW_ENABLED` (default OFF).**
Records candidates + rejection reasons; sends **no** Discord alerts and changes **no** thresholds.

## Ingest (merge by symbol, source-attributed) — `lib/research/discovery/discover.ts`
Sources (typed `DiscoverySource`): `market_snapshot`, `gainers`, `losers`, `gap`, `rel_volume`,
`vol_expansion`, `unusual_options` (when entitled), `news`, `earnings`, `sector_sympathy`,
`new_listing`, `accel`. `mergeAndGate` unions sources per symbol, keeps the freshest observation, and
ranks by change%. `summarize` gives counts by source and by exclusion.

## Strict exclusion gates — `lib/research/discovery/eligibility.ts`
A candidate is `eligible` only if it clears EVERY hard gate; otherwise it is recorded with its
`exclusions[]`:
- security type / symbol-shape: OTC, warrant, right, unit, preferred (`security_type_*`,
  `warrant_shape`, `symbol_suffix_derivative`)
- `halted`
- price outside `[DISCOVERY_MIN_PRICE=1, DISCOVERY_MAX_PRICE=2000]` (`price_too_low/high`)
- underlying `$`-volume < `DISCOVERY_MIN_DOLLAR_VOL=5,000,000` (`insufficient_dollar_volume`)
- stale underlying print > `DISCOVERY_MAX_STALE_MS=60,000` (`stale_underlying`)
- options gates run **only when chain data is supplied** (entitlement): `zero_bid_contract`,
  `extreme_option_spread` (> `DISCOVERY_MAX_OPT_SPREAD_PCT=15`), `stale_option_chain`
  (> `DISCOVERY_MAX_CHAIN_STALE_MS=120,000`). Absent chain ⇒ options gates skipped and flagged, never
  fabricated.

## Storage — `discovery_shadow` (additive, repeat-safe)
`persistDiscoveryShadowOnDb` writes one row per merged candidate (sources, price, change%, rel-vol,
$-vol, eligible, exclusions, options_checked, observed_at_ms). `recordDiscoveryShadow` is the live
hook — a HARD no-op unless the flag is set.

## What it is NOT
Not wired into the live scanner loop, not an alert source, not a threshold input. It is a measurement
substrate: run it in parallel, then compare its eligible set against what the live scanner found
(earliness / lane comparison). Enable ONLY for data collection.
