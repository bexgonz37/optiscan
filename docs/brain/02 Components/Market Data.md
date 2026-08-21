# Market Data

Status: ACTIVE

## Purpose

Provide trustworthy equities and options data for scanning, grading, research, and alert delivery.

## Rules

- Never fabricate data.
- Reject stale or wrong-session evidence.
- Require exact OCC matching for options-performance claims.

## Provider truth (verified 2026-08-21)

The caps are OURS, not the provider's. `POLYGON_DAILY_CALL_CAP` 200,000 and
`POLYGON_MINUTE_CALL_CAP` 280 are self-imposed; the capability probe observed no
provider-side rate limit at all, which makes our caps load-bearing rather than advisory.
Historical underlying minute aggregates are `AVAILABLE_PROVEN` and `INTEGRATED`, confirmed
to 2023-07-31, at one request per symbol per 30-day chunk. So breadth is not gated on
entitlement or on money — it is gated on disk.

What can NEVER be reconstructed historically, and must therefore stay missing rather than
be modelled: **Greeks and implied volatility** (snapshot-only, no historical mode),
**open interest** (a daily settlement figure with no intraday history on this plan), and
**a whole option chain as of a past instant** (no such endpoint — a past chain must be
rebuilt contract by contract, which is why the per-run and per-symbol caps exist).
**Sector and market cap have no source anywhere in the system**: `market-context.ts` takes
`sector` as an input nobody supplies and records it in `missing` rather than inventing it.

## Ingestion is bounded by its terminal states, not by its gate

The session gate (a REFUSAL during RTH, not a throttle), the request accountant and the
per-run wall clock all bound a SINGLE pass. What bounds the lane across passes is whether a
finished job stays finished. Two of the three runners did not enforce that and re-bought
settled data on every beat — 14,239 runs / 7,363 requests on 78 quote windows, and 6,944
requests writing 6,013,016 contract-reference rows over 27,000 distinct contracts. Fixed
2026-08-21 by making the runner's verdict a status (`EXHAUSTED` alongside `COMPLETE`) that
every consumer reads through `isTerminalIngestStatus()`. See
[[Research Graph and Loop]].
