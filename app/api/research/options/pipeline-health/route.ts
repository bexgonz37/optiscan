import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Auth-gated operational diagnostics: why did no alerts arrive? */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { getDb } = await import("@/lib/db");
  const { buildWhyNoAlertsDiagnostic, sanitizeDiagnosticForResponse } = await import("@/lib/research/options/pipeline-diagnostics");
  const db = getDb();
  const diagnostic = sanitizeDiagnosticForResponse(buildWhyNoAlertsDiagnostic(db, process.env));
  return NextResponse.json({ ok: true, diagnostic });
}
