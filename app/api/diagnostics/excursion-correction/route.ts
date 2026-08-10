import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";
import { deploymentShaAttribution } from "@/lib/build-info";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/diagnostics/excursion-correction — reconcile every stored excursion against the
 * marks its own frozen contract actually printed, and record what was found.
 *
 * GET  is a DRY RUN. It computes every correction and the identical census and writes
 *      nothing, so the pass can be read before it is applied.
 * POST APPLIES the pass, writing only to `opportunity_excursion_corrections`.
 *
 * The verb split is deliberate. A GET that mutated the audit record would make the audit
 * itself a side effect of reading it, and the one guarantee this pass offers — that it
 * can never make the history it is auditing worse — would depend on nobody curling it.
 *
 *   ?scope=delivered|all   delivered is the default: the scanner creates thousands of
 *                          undelivered candidate cases a day and none of them ever
 *                          carried a number to a reader
 *   ?limit=N               cap (default 500, max 5000)
 *   ?verbose=1             include per-case rows, not just the census
 *
 * Never edits `opportunity_cases`. The original `summary.maxReturnPct` survives verbatim
 * so a figure that was once published stays visible beside the record that condemns it.
 * Reads persisted evidence only: no provider call, no quota spend, no send authority.
 */

function parseScope(url: URL): "delivered" | "all" {
  return url.searchParams.get("scope") === "all" ? "all" : "delivered";
}

function parseLimit(url: URL): number {
  return Math.max(1, Math.min(5000, Number(url.searchParams.get("limit") ?? 500)));
}

async function runPass(req: Request, dryRun: boolean) {
  const url = new URL(req.url);
  const { getDb } = await import("@/lib/db");
  const { runExcursionCorrectionPassOnDb } = await import("@/lib/opportunity-case/excursion");

  const sha = deploymentShaAttribution();
  const db = getDb() as any;
  const result = runExcursionCorrectionPassOnDb(db, {
    nowMs: Date.now(),
    // A SHA is never fabricated. When the process cannot name its own commit the
    // correction records that absence rather than an invented identity.
    sha: sha.sha,
    scope: parseScope(url),
    limit: parseLimit(url),
    dryRun,
  });

  const verbose = url.searchParams.get("verbose") === "1";
  return NextResponse.json({
    ok: true,
    mode: dryRun ? "DRY_RUN" : "APPLIED",
    scope: { population: parseScope(url), limit: parseLimit(url) },
    shaAttribution: sha,
    census: result.census,
    correctionCensus: result.correctionCensus,
    recorded: result.recorded,
    rows: verbose ? result.rows : undefined,
    corrections: verbose ? result.corrections : undefined,
    note:
      "VERIFIED_EXCURSION is the ONLY state that permits a numeric peak. A correction with a null "
      + "correctedMaxReturnPct means the stored value is known to be wrong and the right one is NOT "
      + "known — consumers must render it unavailable, never fall back to the original. "
      + "opportunity_cases is never edited by this pass.",
  });
}

export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    return await runPass(req, true);
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    return await runPass(req, false);
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
