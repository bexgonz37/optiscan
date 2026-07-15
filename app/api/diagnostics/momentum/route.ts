import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/momentum — recent momentum-callout diagnostics + the
 * deterministic summary (earliness + directional-safety counts). Read-only; the
 * direction_json on each row carries the exact evidence (baseline, session return,
 * 5/10/30/60s returns, velocity/accel sign+value, intended direction, delivery
 * status + quote age, final channel/result, suppression reason). No AI, no secrets.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { listMomentumDiagnostics, summarizeMomentumDiagnostics } = await import("@/lib/momentum-diagnostics");
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit") ?? 300)));
  const rows = listMomentumDiagnostics(limit);
  return NextResponse.json({
    ok: true,
    summary: summarizeMomentumDiagnostics(rows),
    rows: rows.map((r) => ({
      ...r,
      direction: r.directionJson ? safeParse(r.directionJson) : null,
    })),
  });
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
