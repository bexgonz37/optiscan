/**
 * prod-diag-fetch.mjs — read AUTHENTICATED production diagnostics without ever
 * revealing the token.
 *
 * The token is read from the environment (SCAN_API_TOKEN) and sent as the
 * x-scan-token header. It is never printed, logged, or written to disk, and it
 * is never accepted as a CLI argument (argv leaks into shell history and `ps`).
 *
 * Owner usage — injects the production environment locally, read-only:
 *   railway run -- node scripts/prod-diag-fetch.mjs <path> [morePaths...]
 *
 * Example:
 *   railway run -- node scripts/prod-diag-fetch.mjs /api/diagnostics/content-delivery
 *
 * Every request is a GET. This script issues no provider calls of its own; it
 * only reads endpoints the app already exposes.
 */
const BASE = process.env.OPTISCAN_BASE_URL || "https://optiscan-production.up.railway.app";
const TOKEN = process.env.SCAN_API_TOKEN || "";

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error("usage: railway run -- node scripts/prod-diag-fetch.mjs <path> [more...]");
  process.exit(2);
}
if (!TOKEN) {
  console.error("SCAN_API_TOKEN is not present in this environment.");
  console.error("Run through `railway run` so the production variables are injected.");
  process.exit(3);
}

for (const p of paths) {
  const url = `${BASE}${p.startsWith("/") ? p : `/${p}`}`;
  try {
    const res = await fetch(url, {
      headers: { "x-scan-token": TOKEN, accept: "application/json" },
      signal: AbortSignal.timeout(Number(process.env.DIAG_TIMEOUT_MS ?? 45_000)),
    });
    const body = await res.text();
    // Defence in depth: never echo the secret even if an endpoint reflects it.
    const safe = TOKEN ? body.split(TOKEN).join("[REDACTED]") : body;
    console.log(`\n===== ${p} — HTTP ${res.status} =====`);
    console.log(safe.length > 200_000 ? `${safe.slice(0, 200_000)}\n…[truncated]` : safe);
  } catch (err) {
    console.log(`\n===== ${p} — REQUEST FAILED =====`);
    console.log(String(err?.message ?? err));
  }
}
