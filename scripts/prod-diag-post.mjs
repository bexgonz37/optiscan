/**
 * prod-diag-post.mjs — invoke an AUTHENTICATED production endpoint that WRITES,
 * without ever revealing the token.
 *
 * This is a deliberate sibling of `prod-diag-fetch.mjs` rather than a flag on it.
 * That script's contract is "every request is a GET", and a `--post` flag would turn
 * a read-only tool into one whose safety depends on remembering not to pass an
 * argument. Anything that mutates production is invoked by a script whose NAME says so.
 *
 * The token is read from the environment (SCAN_API_TOKEN) and sent as the x-scan-token
 * header. It is never printed, logged, written to disk, or accepted as a CLI argument
 * (argv leaks into shell history and `ps`).
 *
 * Owner usage — injects the production environment locally:
 *   railway run -- node scripts/prod-diag-post.mjs <path> [morePaths...]
 *
 * Sends no request body: the endpoints this drives take their parameters in the query
 * string, and a body would be one more thing to get wrong against production.
 */
const BASE = process.env.OPTISCAN_BASE_URL || "https://optiscan-production.up.railway.app";
const TOKEN = process.env.SCAN_API_TOKEN || "";

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error("usage: railway run -- node scripts/prod-diag-post.mjs <path> [more...]");
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
      method: "POST",
      headers: { "x-scan-token": TOKEN, accept: "application/json" },
      signal: AbortSignal.timeout(Number(process.env.DIAG_TIMEOUT_MS ?? 120_000)),
    });
    const body = await res.text();
    // Defence in depth: never echo the secret even if an endpoint reflects it.
    const safe = TOKEN ? body.split(TOKEN).join("[REDACTED]") : body;
    console.log(`\n===== POST ${p} — HTTP ${res.status} =====`);
    console.log(safe.length > 200_000 ? `${safe.slice(0, 200_000)}\n…[truncated]` : safe);
  } catch (err) {
    console.log(`\n===== POST ${p} — REQUEST FAILED =====`);
    console.log(String(err?.message ?? err));
  }
}
