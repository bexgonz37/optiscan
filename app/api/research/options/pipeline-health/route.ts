import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Auth-gated operational diagnostics: why did no alerts arrive? */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const { buildWhyNoAlertsDiagnostic, sanitizeDiagnosticForResponse } = await import("@/lib/research/options/pipeline-diagnostics");
    const db = getDb();
    const diagnostic = sanitizeDiagnosticForResponse(buildWhyNoAlertsDiagnostic(db, process.env));
    return NextResponse.json(
      { ok: true, diagnostic },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
