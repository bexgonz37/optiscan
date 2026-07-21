# OPTIONS_SESSION_BEHAVIOR

Separate cadences per session (Tier-1: `OPTIONS_TIER1_INTERVAL_MS` / `OPTIONS_TIER1_PREMARKET_MS` /
`OPTIONS_TIER1_AFTERHOURS_MS`; Tier-2 analogues). Tier-1 keeps monitoring premarket + after-hours
underlying movement.

## Options-market-hours rule
Listed options are not executable outside normal options hours, so:
- premarket/after-hours underlying data may create FORMING candidates (recorded in `options_candidates`);
- a REAL_OPTION_PAPER entry is created ONLY during the regular session (`input.session==='regular'`)
  and only with a FRESH executable quote (`quoteAgeMs` gate) — never from a stale prior-session option
  quote;
- setups seen pre/after-hours are recorded and may become eligible at the open.

Regular-stock momentum paper (the Stock Momentum Radar) is entirely separate and unchanged.
