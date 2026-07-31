/**
 * massive-capability-probe.mjs — read-only entitlement probe. ONE request per
 * endpoint. Records HTTP status, result count, and a response sample.
 *
 * This script is the EVIDENCE behind
 * lib/research/asymmetry/historical/capability-matrix.ts. Re-run it to
 * re-verify those claims rather than trusting them; if an endpoint's answer
 * changes, the matrix row is stale and must be corrected, not worked around.
 *
 * Cost: ~15 requests. No writes, no repo state changes, no Discord.
 *
 * Usage: node scripts/massive-capability-probe.mjs [.env.local] [YYYY-MM-DD]
 */
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(process.argv[2] || ".env.local", "utf8")
    .split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const KEY = env.POLYGON_API_KEY || env.MASSIVE_API_KEY;
const BASE = "https://api.polygon.io";
if (!KEY) { console.error("no key"); process.exit(1); }

// A liquid, definitely-existing NVDA contract in the recent past.
const UNDER = "NVDA";
const DAY = process.argv[3] || "2026-07-30";

async function probe(label, path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("apiKey", KEY);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
    const results = body?.results;
    const n = Array.isArray(results) ? results.length : results ? 1 : 0;
    const first = Array.isArray(results) ? results[0] : results;
    console.log(JSON.stringify({
      label, status: res.status, ms: Date.now() - t0,
      ok: res.ok, count: n,
      next_url: Boolean(body?.next_url),
      message: body?.message ?? body?.error ?? null,
      sampleKeys: first && typeof first === "object" ? Object.keys(first).slice(0, 25) : null,
      sample: first && typeof first === "object" ? JSON.stringify(first).slice(0, 420) : null,
    }));
    return body;
  } catch (e) {
    console.log(JSON.stringify({ label, status: "EXC", error: String(e?.message || e) }));
    return null;
  }
}

// 0. Live chain snapshot — used today by fetchOptionChain. Also gives us a real OCC.
const chain = await probe("v3_snapshot_options_chain", `/v3/snapshot/options/${UNDER}`, {
  limit: 20, contract_type: "call",
});
const occ = chain?.results?.find((r) => r?.details?.ticker)?.details?.ticker
  || `O:NVDA260807C00190000`;
console.log("### probing exact OCC:", occ, "on day", DAY);

await probe("v3_snapshot_single_contract", `/v3/snapshot/options/${UNDER}/${occ}`);
await probe("hist_option_aggs_1m", `/v2/aggs/ticker/${occ}/range/1/minute/${DAY}/${DAY}`, { adjusted: "true", sort: "asc", limit: 5 });
await probe("hist_option_aggs_day", `/v2/aggs/ticker/${occ}/range/1/day/2026-07-01/${DAY}`, { adjusted: "true", sort: "asc", limit: 5 });
await probe("hist_option_quotes_nbbo", `/v3/quotes/${occ}`, { "timestamp.gte": `${DAY}T13:35:00Z`, limit: 5, order: "asc" });
await probe("hist_option_trades", `/v3/trades/${occ}`, { "timestamp.gte": `${DAY}T13:35:00Z`, limit: 5, order: "asc" });
await probe("last_option_quote", `/v2/last/nbbo/${occ}`);
await probe("option_daily_open_close", `/v1/open-close/${occ}/${DAY}`, { adjusted: "true" });
await probe("hist_stock_quotes_nbbo", `/v3/quotes/${UNDER}`, { "timestamp.gte": `${DAY}T13:35:00Z`, limit: 5, order: "asc" });
await probe("hist_stock_trades", `/v3/trades/${UNDER}`, { "timestamp.gte": `${DAY}T13:35:00Z`, limit: 5, order: "asc" });
await probe("hist_stock_aggs_1m", `/v2/aggs/ticker/${UNDER}/range/1/minute/${DAY}/${DAY}`, { adjusted: "true", sort: "asc", limit: 5 });
await probe("stock_snapshot", `/v2/snapshot/locale/us/markets/stocks/tickers/${UNDER}`);
await probe("options_contracts_reference", `/v3/reference/options/contracts`, { underlying_ticker: UNDER, limit: 5 });
await probe("options_contracts_asof", `/v3/reference/options/contracts`, { underlying_ticker: UNDER, as_of: DAY, limit: 5, expired: "true" });
await probe("market_status", `/v1/marketstatus/now`);
