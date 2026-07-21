# OPTIONS_LATENCY_AND_FRESHNESS

## Freshness / late-alert prevention (`lib/research/options/callout.ts`)
Immediately before a (would-be) delivery, `evaluateCallout`:
- verifies the latest option bid/ask and quote age (`realOptionEntryEligible`);
- recalculates spread; rejects zero-bid / wide / stale / illiquid contracts;
- rechecks the underlying vs the observed price and enforces the STRATEGY-SPECIFIC chase limit
  (`checkEntryFreshness`, using each strategy's `chaseLimitPct` + `freshnessMaxMs`).
If the entry is already gone → state `TOO_LATE`, NO public message, reason recorded.

## Timestamps captured (options_candidates + latency_json)
candidate observation, strategy selected, chain fetch start/end, contract selection, gate completion,
freshness check, Discord request start/end. Populate `latency_json` at each stage; the Options report
exposes detection→callout time and the fraction of the move completed at callout.

## Note
The underlying-price entry zone is separate from the OPTION premium band; only the underlying chase +
age gate freshness (the option premium band is display-only). No production latency is claimed here —
measure it once the flags are enabled (read-only report + stored timestamps).
