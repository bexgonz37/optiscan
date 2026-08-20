#!/usr/bin/env node
/**
 * episode-v2-clock-baseline.mjs — READ-ONLY EpisodeV2 timestamp snapshot.
 *
 *   node scripts/episode-v2-clock-baseline.mjs
 *   node scripts/episode-v2-clock-baseline.mjs --json
 *   BASE_URL=... node scripts/episode-v2-clock-baseline.mjs
 *
 * One GET against the system overview. It writes nothing, sends no Discord,
 * spends no provider or AI budget, and cannot change a trade.
 *
 * It exists because the EpisodeV2 build counters are PROCESS-LIFETIME: a deploy
 * restarts the process and zeroes them. Anything not captured before the restart
 * is gone. So the pre-deploy snapshot has to be taken deliberately, after the
 * regular session closes and before the new build goes out.
 *
 * The `timestampSemantics` block only exists on builds that carry the four-clock
 * instrumentation; on the pre-deploy build it is absent, and that absence is
 * itself the baseline fact.
 */
import { readFileSync } from "node:fs";

const BASE = String(process.env.BASE_URL ?? "https://optiscan-production.up.railway.app").replace(/\/$/, "");
const JSON_OUT = process.argv.includes("--json");

/** Token from the environment, else the local .env.local. Never printed or logged. */
function resolveToken() {
  const fromEnv = String(process.env.SCAN_API_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    return (env.match(/^SCAN_API_TOKEN=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  } catch {
    return "";
  }
}
const TOKEN = resolveToken();

const n = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const pct = (a, b) => (n(a) == null || !n(b) ? null : +((Number(a) / Number(b)) * 100).toFixed(2));

const res = await fetch(`${BASE}/api/system/overview`, {
  headers: { "x-scan-token": TOKEN, accept: "application/json" },
});
if (!res.ok) {
  console.error(`overview ${res.status}`);
  process.exit(1);
}
const body = await res.json();
// The overview nests it under the independent-options lane; the flatter shapes
// are accepted too so the script keeps working if that response is reorganized.
const ep = body.independent_options?.setupEpisodeV2
  ?? body.setupEpisodeV2
  ?? body.data?.setupEpisodeV2
  ?? null;
if (!ep) {
  console.error("no setupEpisodeV2 block in overview response");
  process.exit(1);
}
const rt = ep.runtime ?? {};
const diag = ep.timestampDiagnostic ?? {};

const snapshot = {
  capturedAtMs: Date.now(),
  capturedAtIso: new Date().toISOString(),
  base: BASE,
  deployedSha: body.deployedSha ?? body.sha ?? body.productionSha ?? body.model?.sha ?? null,
  marketSession: body.market_session ?? null,
  tradingDay: body.trading_day ?? null,
  status: ep.status ?? null,
  evidenceState: ep.evidenceState ?? null,

  // ── The six the deployment rule requires ──────────────────────────────────
  buildAttempts: n(rt.buildAttempts),
  buildSuccesses: n(rt.buildSuccesses),
  zoneAFutureTimestampRejections: n(rt.buildRejectionsByClass?.ZONE_A_FUTURE_TIMESTAMP),
  episodeCount: n(ep.episodeCount),
  labelCount: n(ep.labelCount),
  timestampRejectionRatePct: pct(rt.buildRejectionsByClass?.ZONE_A_FUTURE_TIMESTAMP, rt.buildAttempts),

  // ── Supporting context, so the number can be interpreted later ────────────
  buildRejectionsTotal: n(rt.buildRejectionsTotal),
  buildRejectionsByClass: rt.buildRejectionsByClass ?? null,
  persistenceSuccesses: n(rt.persistenceSuccesses),
  persistenceFailures: n(rt.persistenceFailures),
  firstBuildAttemptAtMs: n(rt.firstBuildAttemptAtMs),   // absent pre-deploy, by design
  lastBuildAttemptAtMs: n(rt.lastBuildAttemptAtMs),
  actionCount: n(ep.actionCount),

  // Historical SQL aggregate over persisted observations. Survives restart, so
  // it is the one figure here that is directly comparable across deploys.
  historicalObservations: {
    totalRows: n(diag.totalRows),
    quoteNewerThanObserved: n(diag.quoteNewerThanObserved),
    quoteEqualToObserved: n(diag.quoteEqualToObserved),
    quoteOlderThanObserved: n(diag.quoteOlderThanObserved),
    newerThanObservationPct: n(diag.newerThanObservationPct),
    reconciles: diag.reconciles ?? null,
    todayBySessionDate: (diag.breakdowns?.bySessionDate ?? []).slice(0, 3),
  },

  // Present only once the four-clock build is live. Absent here IS the baseline.
  fourClockInstrumentationPresent: ep.timestampSemantics != null,
  timestampSemantics: ep.timestampSemantics ?? null,
};

if (JSON_OUT) {
  console.log(JSON.stringify(snapshot, null, 2));
} else {
  const row = (k, v) => console.log(`  ${k.padEnd(34)} ${v ?? "—"}`);
  console.log(`\nEPISODE V2 CLOCK BASELINE  ·  ${snapshot.capturedAtIso}`);
  console.log(`${BASE}  ·  deployed ${String(snapshot.deployedSha ?? "unknown").slice(0, 7)}\n`);
  console.log("PROCESS-LIFETIME (reset by the next deploy)");
  row("buildAttempts", snapshot.buildAttempts);
  row("buildSuccesses", snapshot.buildSuccesses);
  row("ZONE_A_FUTURE_TIMESTAMP", snapshot.zoneAFutureTimestampRejections);
  row("timestamp rejection rate", snapshot.timestampRejectionRatePct == null ? null : `${snapshot.timestampRejectionRatePct}%`);
  row("buildRejectionsTotal", snapshot.buildRejectionsTotal);
  row("firstBuildAttemptAtMs", snapshot.firstBuildAttemptAtMs);
  console.log("\nDURABLE (survives restart)");
  row("episodeCount", snapshot.episodeCount);
  row("labelCount", snapshot.labelCount);
  row("actionCount", snapshot.actionCount);
  const h = snapshot.historicalObservations;
  row("observations totalRows", h.totalRows);
  row("quote newer than observed", `${h.quoteNewerThanObserved} (${h.newerThanObservationPct}%)`);
  row("quote equal / older", `${h.quoteEqualToObserved} / ${h.quoteOlderThanObserved}`);
  console.log("\nFOUR-CLOCK INSTRUMENTATION");
  row("present", snapshot.fourClockInstrumentationPresent ? "YES" : "NO (pre-deploy baseline)");
  if (snapshot.timestampSemantics) {
    const ts = snapshot.timestampSemantics;
    row("validatorChanged", String(ts.validatorChanged));
    row("attempts classified", `${ts.attemptsClassified}/${ts.buildAttempts} reconciles=${ts.reconcilesWithBuildAttempts}`);
    for (const [k, v] of Object.entries(ts.timestampRelation ?? {})) row(`  ${k}`, v);
    const r = ts.zoneAFutureTimestampRejections ?? {};
    console.log("\n  Of ZONE_A_FUTURE_TIMESTAMP rejections:");
    row("  betweenObservationAndDecision", r.betweenObservationAndDecisionCount);
    row("  afterDecision", r.afterDecisionCount);
    row("  beforeOrAtObservationStart", r.beforeOrAtObservationStartCount);
    row("  insufficient", r.insufficientCount);
  }
  console.log("");
}
