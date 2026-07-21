# EARNINGS_PROVIDER_AUDIT

## Finding: NO authoritative earnings-calendar feed is wired server-side
- `lib/catalysts.js` only classifies news HEADLINES for an "earnings" keyword — it is NOT a calendar
  and provides NO confirmed date/time/session.
- `lib/polygon-provider.js` has NO earnings endpoint. Polygon's Stocks plans expose
  `/vX/reference/financials` (filing financials), NOT a forward earnings-date calendar on standard tiers.
- The Robinhood MCP `get_earnings_calendar` / `get_earnings_results` exist but are CLIENT tools, not a
  server-side library the scanner process can call.

## Consequence
The earnings discovery CLASSIFIER (`lib/research/discovery/earnings.ts`) is built and tested
(categories, confirmed-vs-estimated, STALE-DATE rejection), but it is **inert until a real calendar
provider supplies rows**. It must NOT infer/fabricate a date when unconfirmed.

## Options for a real feed (pick one; entitlement/cost required)
1. **Polygon** — confirm whether the account's plan includes an earnings/benzinga-style calendar
   add-on; if yes, add a `fetchEarningsCalendar` adapter with `{symbol, expectedAt, session,
   confirmed, provenance, lastUpdated}`.
2. **Nasdaq/Zacks/Benzinga/FMP** — dedicated earnings-calendar APIs (paid) with confirmed vs estimated
   flags and BMO/AMC session.
3. **Finnhub / Alpha Vantage** — earnings calendar endpoints (tiered).

Required fields to wire into `earnings_shadow`: symbol, confirmed|estimated, date, BMO/AMC/unknown,
provenance, last-updated timestamp, stale-data status, gap, relative volume, options availability,
eligibility/rejection reason. Flag: `EARNINGS_DISCOVERY_ENABLED` (OFF; requires the provider entitlement).
