import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/improvement — controlled code-improvement agent status (Phase 9).
 * Reports the agent state, absolute prohibitions, disposition counts, and the
 * immutable proposal ledger. `?audit=1` runs one repo audit that records
 * test-coverage proposals from real facts (no code is edited, branched, merged,
 * or pushed). Read-only otherwise.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();

  let audited = false;
  let status;
  if (new URL(req.url).searchParams.get("audit") === "1") {
    const { runImprovementAudit } = await import("@/lib/improvement/runtime");
    status = runImprovementAudit();
    audited = true;
  } else {
    const { improvementStatus } = await import("@/lib/improvement-store");
    status = improvementStatus();
  }

  return NextResponse.json({
    ok: true,
    audited,
    status,
    disclaimer: "The improvement agent only records immutable, classified proposals. It never edits code or trading rules, never force-pushes, never self-approves high-risk changes, and never enables bearish actionability or live execution. Branch protection on `main` must be configured manually in GitHub.",
  });
}
