/**
 * advisory-chat-sources.ts — assembles the canonical sources the chat may cite.
 *
 * The chat NEVER queries arbitrary raw tables. It reads:
 *  - the canonical findings report (same builder as GET /api/ai/findings/latest)
 *  - the shadow exit-policy report from the paper chain diagnostic
 *  - the Watchlist evidence-gate diagnostics from the persisted plan
 *
 * All three already exist as canonical, deterministic surfaces; this module only
 * reshapes them. It performs reads only.
 */
import type { CanonicalFindingsReport } from "./findings-report.ts";
import type { SupplementalEvidence } from "./advisory-chat-evidence.ts";

type SourceDb = any;

/** Build the canonical findings report from stored AI + diagnostic rows. */
export function loadCanonicalReport(db: SourceDb): CanonicalFindingsReport {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { listReportsOnDb, listProposalsOnDb, recentJobFailuresOnDb } = require("@/lib/ai/store");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { momentumDiagnosticsForDay } = require("@/lib/momentum-diagnostics");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildCanonicalFindingsReport, linkedReadyToSentOnDb } = require("@/lib/ai/findings-report");
  const nightlyReports = listReportsOnDb(db, "nightly", 30);
  const weeklyReports = listReportsOnDb(db, "weekly", 20);
  const latest = nightlyReports[0] ?? null;
  const latestMomentumDiagnostics = latest?.periodKey
    ? momentumDiagnosticsForDay(latest.periodKey, db, 1000)
    : [];
  const linkedReadyToSent = latest
    ? linkedReadyToSentOnDb(db, latest.periodStartMs, latest.periodEndMs ?? latest.createdAtMs)
    : undefined;
  return buildCanonicalFindingsReport({
    nightlyReports,
    weeklyReports,
    proposals: listProposalsOnDb(db, 100),
    jobFailures: recentJobFailuresOnDb(db, 20),
    latestMomentumDiagnostics,
    linkedReadyToSent,
  });
}

/** Exit-policy + Watchlist evidence. Any unavailable source stays null. */
export function loadSupplementalEvidence(db: SourceDb, env: NodeJS.ProcessEnv = process.env): SupplementalEvidence {
  const out: SupplementalEvidence = { exitPolicy: null, watchlist: null };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildPaperChainDiagnostic } = require("@/lib/research/options/paper-chain");
    // Full history: the exit-policy sample must not be truncated by a display limit.
    const chain = buildPaperChainDiagnostic(db, env, 1);
    const r = chain?.exitPolicyResearch;
    if (r) {
      out.exitPolicy = {
        minimumSupportedSample: Number(r.minimumSupportedSample ?? 30),
        bestSupportedPolicy: r.bestSupportedPolicy ?? null,
        profitableThenLostCount: Number(r.profitableThenLostCount ?? 0),
        profitableTradeCount: Number(r.profitableTradeCount ?? 0),
        policies: (r.policies ?? []).map((p: any) => ({
          policy: String(p.policy),
          sampleSize: Number(p.sampleSize ?? 0),
          winRatePct: p.winRatePct ?? null,
          averageReturnPct: p.averageReturnPct ?? null,
          totalPnlUsd: Number(p.totalPnlUsd ?? 0),
          supported: Boolean(p.supported),
        })),
      };
    }
  } catch { /* exit research unavailable ⇒ the chat simply cannot cite it */ }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadOvernightPlan } = require("@/lib/research/overnight/next-session-plan");
    const plan = loadOvernightPlan(db);
    if (plan) {
      const ec = plan.evidenceCompleteness ?? null;
      out.watchlist = {
        publishedCount: plan.recommendations?.length ?? 0,
        candidatesConsidered: ec?.candidatesConsidered ?? 0,
        vwapUsable: ec?.vwap?.usableForWatchlist ?? 0,
        vwapUnavailable: ec?.vwap?.unavailable ?? 0,
        marketContextAvailable: Boolean(ec?.marketContext?.available),
        blockers: ec?.blockers ?? [],
      };
    }
  } catch { /* no persisted plan ⇒ no Watchlist claims */ }

  return out;
}
