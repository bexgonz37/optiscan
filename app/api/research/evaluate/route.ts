import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase-D real-data evaluation (Analog Engine). Token-gated.
 *   POST — run the walk-forward, purged, out-of-sample analog-vs-baselines evaluation over the
 *          seeded library and write the GO/REMEDIATE/STOP report. A survivorship-biased or
 *          insufficient dataset can never GO (report.ts enforces).
 *   GET  — the latest report.
 * Read-only of provider (no provider calls); no live execution.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const has = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analog_eval_reports'").get());
  const row = has ? db.prepare("SELECT report_json FROM analog_eval_reports ORDER BY created_at_ms DESC LIMIT 1").get() as any : null;
  return NextResponse.json({ ok: true, latest: row ? JSON.parse(row.report_json) : null });
}

export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const { getDb } = await import("@/lib/db");
  const { runPhaseDEvalOnDb } = await import("@/lib/research/analog/evaluate");
  const report = runPhaseDEvalOnDb(getDb(), {
    horizon: body.horizon, folds: body.folds, embargoMs: body.embargoMs, minEpisodes: body.minEpisodes, iters: body.iters, config: body.config,
  });
  return NextResponse.json({ ok: true, verdict: report.verdict, verdictReason: report.verdictReason, report });
}
