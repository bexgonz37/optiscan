# Options Scanner

Status: ACTIVE — the PRIMARY OptiScan product.

## Purpose

Find and evaluate options opportunities using deterministic market-data, strategy,
contract-selection, and delivery rules.

## The shape of the funnel

```
FULL OPTIONS UNIVERSE (~1,600 eligible)
  → CHEAP AWARENESS            all of it, every cycle, zero marginal provider cost
  → PRE-SCORE / RANK           acceleration-weighted, leverage-normalised
  → DEEP PROMOTION             bounded; ceiling 25 for the first rollout
  → OPTIONABILITY              a proven negative can skip the spend
  → CHAIN ADMISSION            which of the survivors the budget serves (default-inactive)
  → CHAIN → CONTRACT → EPISODE → ACTIONABILITY → DELIVERY → TRACK → LABEL
```

Two numbers that were conflated for a long time and must never be again:

- **CHEAP AWARENESS** is how many symbols the scanner can SEE. It is the whole eligible
  universe, every cycle, and it costs nothing extra because the whole-market snapshot was
  already bought.
- **DEEP PROMOTION** is how many it can afford to SPEND on. `25` is this number, and only
  this number. Reporting it as coverage is what let a 1.6%-visibility architecture look
  healthy for a full session.

## What happens to what it did NOT look at

Skips are recorded — with pre-score, rank, band and the universe size they were ranked
within, so a rank means something later. Bounded by transition de-duplication, a per-cycle
cap and 30-day retention.

The record is UNDERLYING-ONLY by construction. `options_missed_opportunities` has no column
for an OCC, a strike, an expiration, a premium or a return, so nothing downstream can invent
an option outcome for a contract that was never selected.

## Shadow science

Six measurements run beside live candidates and decide nothing:
`STAGE15_CHAIN_GATE_V1`, `OPTIONS_FEATURE_SEMANTICS_V2`, `DIRECTION_AWARE_LATE_PHASE_V1`,
`BEARISH_SIGNAL_DEDUPE`, `TIE_DIAGNOSTICS`, `RVOL`.

The isolation rule has two halves and they are not the same rule. The MEASUREMENT modules
have no production importer at all. The OBSERVER has exactly one production-importable
export, `observeLiveShadow`, and it returns `void` — a caller cannot branch on what it is not
given. Both halves are tested.

Shadow evidence never closes into live authority automatically.

## Related notes

- [[Market Data]]
- [[Discord Alerts]]
- [[Opportunity Lifecycle]]
- [[Research Graph and Loop]]
- [[High-Asymmetry Radar]]
- [[delivery]]
