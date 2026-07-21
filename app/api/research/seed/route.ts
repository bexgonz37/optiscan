import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bounded, token-gated episode-seed admin job (Analog Engine, Phase D).
 *   GET  — read-only status: episode/label counts, duplicate check, tier/liquidity
 *          distribution sanity, recent seed runs. Never seeds.
 *   POST — start a BOUNDED seed. Defaults to dryRun (estimate only) unless `dryRun:false`
 *          is explicit. Requires HISTORICAL_REPLAY_ENABLED + EPISODE_CAPTURE_ENABLED (the
 *          driver enforces this) and honors EPISODE_SEED_KILL. A survivorship-biased
 *          universe is flagged EXPLORATORY and cannot ever issue a GO verdict.
 * No secrets in any response.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const has = (t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
  const n = (sql: string, ...a: any[]) => Number((db.prepare(sql).get(...a) as any)?.n ?? 0);
  const grp = (sql: string) => Object.fromEntries((db.prepare(sql).all() as any[]).map((r) => [r.k ?? "null", r.c]));
  const seed = {
    episodes: has("setup_episodes") ? n("SELECT COUNT(*) n FROM setup_episodes") : 0,
    labels: has("episode_labels") ? n("SELECT COUNT(*) n FROM episode_labels") : 0,
    duplicateEpisodeKeys: has("setup_episodes") ? n("SELECT COUNT(*) n FROM (SELECT episode_key FROM setup_episodes GROUP BY episode_key HAVING COUNT(*)>1)") : 0,
    modeledLabelShare: has("episode_labels") ? n("SELECT COUNT(*) n FROM episode_labels WHERE outcome_kind='MODELED_OPTION'") : 0,
    byLiquidity: has("setup_episodes") ? grp("SELECT liquidity_tier k, COUNT(*) c FROM setup_episodes GROUP BY liquidity_tier") : {},
    byDirection: has("setup_episodes") ? grp("SELECT direction k, COUNT(*) c FROM setup_episodes GROUP BY direction") : {},
    recentRuns: has("replay_runs") ? db.prepare("SELECT run_id, status, provider_calls AS provider_calls_succeeded, provider_calls_attempted, symbols_with_data, error, provider_limitations, per_symbol_json, updated_at_ms FROM replay_runs WHERE asset_class='stock' ORDER BY created_at_ms DESC LIMIT 5").all() : [],
  };
  return NextResponse.json({ ok: true, seed });
}

export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const { symbols, from, to } = body;
  if (!Array.isArray(symbols) || symbols.length === 0 || !from || !to) {
    return NextResponse.json({ ok: false, error: "symbols[] (array), from and to (YYYY-MM-DD) are required" }, { status: 400 });
  }
  const source = body.source === "provider_pit" ? "provider_pit" : body.source === "user_dated_file" ? "user_dated_file" : "current_symbols";
  const { classifyUniverse } = await import("@/lib/research/episode/universe");
  const cls = classifyUniverse(source, symbols, { providerPitAvailable: body.providerPitAvailable === true, dated: body.dated !== false });
  const dryRun = body.dryRun !== false; // SAFE DEFAULT: dry-run unless explicitly dryRun:false
  const diagnostic = body.diagnostic === true; // bounded one-symbol probe (no writes)
  const eligibility = cls.validForVerdict ? "survivorship-free — eligible for a GO verdict" : "EXPLORATORY ONLY — a survivorship-biased/undated universe can NEVER issue GO";

  // Dry-run and the one-symbol diagnostic are fast and stay synchronous.
  if (dryRun || diagnostic) {
    const { runReplaySeed } = await import("@/lib/research/episode/seed");
    const result = await runReplaySeed({
      symbols, from, to, timespan: body.timespan, dryRun, diagnostic,
      maxSymbols: body.maxSymbols, providerCallBudget: body.providerCallBudget, rateLimitMs: body.rateLimitMs,
      universeSource: cls.source, survivorshipBias: cls.survivorshipBias,
    }, process.env);
    return NextResponse.json({
      ok: true, universe: cls, dryRun, diagnostic,
      runStatus: result.status, runOk: result.ok, providerCallsAttempted: result.providerCallsAttempted, providerCallsSucceeded: result.providerCallsSucceeded, result,
      verdictEligibility: eligibility,
    });
  }

  // A real seed is a BACKGROUND JOB. The web process ONLY inserts a QUEUED row and ensures the
  // out-of-process worker is alive — it performs NO replay work, so this returns immediately and
  // the API event loop is never blocked by seeding. The worker (separate process) picks the job up.
  const { getDb } = await import("@/lib/db");
  const { createSeedRun } = await import("@/lib/research/episode/seed-jobs");
  const { ensureSeedWorker } = await import("@/lib/research/episode/seed-worker-manager");
  const created = createSeedRun(getDb(), {
    symbols, from, to, timespan: body.timespan, maxSymbols: body.maxSymbols,
    providerCallBudget: body.providerCallBudget, rateLimitMs: body.rateLimitMs,
    universeSource: cls.source, survivorshipBias: cls.survivorshipBias,
  }, process.env);
  if (created.status === "SKIPPED" || !created.runId) {
    return NextResponse.json({ ok: false, universe: cls, error: created.reason ?? "seed not started", verdictEligibility: eligibility }, { status: 400 });
  }
  ensureSeedWorker(process.env); // start the worker process if not already running (no inline work)
  return NextResponse.json({
    ok: true, universe: cls, runId: created.runId, status: created.existing ? created.status : "QUEUED",
    existing: created.existing, statusUrl: `/api/research/seed/${created.runId}`,
    message: created.existing ? "an identical run is already in progress — returning it" : "seed queued; a background worker will process it. Poll statusUrl for progress",
    verdictEligibility: eligibility,
  });
}
