/**
 * prod-diag-save.mjs — read AUTHENTICATED production diagnostics into a local file
 * so large responses can be analysed without truncation, and without ever revealing
 * the token.
 *
 * Why this exists alongside prod-diag-fetch.mjs: that script prints bodies to stdout
 * and truncates at 200 KB. Endpoints like /api/opportunity-cases exceed that, so the
 * evidence needed for an audit is silently cut off. This variant streams each response
 * to disk and prints only a summary.
 *
 * The token is read from the environment (SCAN_API_TOKEN) and sent as the x-scan-token
 * header. It is never printed, never logged, never written to disk, and never accepted
 * as a CLI argument (argv leaks into shell history and `ps`).
 *
 * Owner usage — injects the production environment locally, read-only:
 *   railway run -- node scripts/prod-diag-save.mjs <outFile> <path> [morePaths...]
 *
 * Every request is a GET. This script issues no provider calls of its own and performs
 * no database mutations; it only reads endpoints the app already exposes.
 *
 * Output shape: a single JSON object written to <outFile>, keyed by request path:
 *   { "<path>": { "status": 200, "ok": true, "json": <parsed>, "text": <raw if unparsable> } }
 *
 * Exits nonzero on authentication or request failure (2 usage, 3 missing token,
 * 4 any request failed or returned a non-2xx status).
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.OPTISCAN_BASE_URL || "https://optiscan-production.up.railway.app";
const TOKEN = process.env.SCAN_API_TOKEN || "";

const [outFile, ...paths] = process.argv.slice(2);
if (!outFile || !paths.length) {
  console.error("usage: railway run -- node scripts/prod-diag-save.mjs <outFile> <path> [more...]");
  process.exit(2);
}
if (!TOKEN) {
  console.error("SCAN_API_TOKEN is not present in this environment.");
  console.error("Run through `railway run` so the production variables are injected.");
  process.exit(3);
}

/** Strip the secret from any value that might reflect it back. */
const redact = (s) => (TOKEN ? String(s).split(TOKEN).join("[REDACTED]") : String(s));

const results = {};
let failed = 0;

for (const p of paths) {
  const url = `${BASE}${p.startsWith("/") ? p : `/${p}`}`;
  try {
    const res = await fetch(url, {
      headers: { "x-scan-token": TOKEN, accept: "application/json" },
      signal: AbortSignal.timeout(Number(process.env.DIAG_TIMEOUT_MS ?? 120_000)),
    });
    const body = redact(await res.text());
    let json = null;
    try { json = JSON.parse(body); } catch { /* preserve raw below */ }
    results[p] = json ? { status: res.status, ok: res.ok, json } : { status: res.status, ok: res.ok, text: body };
    if (!res.ok) failed++;
    console.log(`${res.ok ? "ok  " : "FAIL"} HTTP ${res.status}  ${p}  (${body.length} bytes, ${json ? "json" : "raw"})`);
  } catch (err) {
    failed++;
    results[p] = { status: null, ok: false, error: redact(err?.message ?? err) };
    console.log(`FAIL ---       ${p}  ${redact(err?.message ?? err)}`);
  }
}

fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
console.log(`\nwrote ${outFile}`);

if (failed) {
  console.error(`${failed} request(s) failed or returned a non-2xx status.`);
  process.exit(4);
}
