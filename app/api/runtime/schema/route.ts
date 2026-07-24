import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Auth-gated schema readiness for production diagnostics (no secrets). */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { getDb, repairAndInspectSchemaReadiness } = await import("@/lib/db");
    const db = getDb();
    const schema = repairAndInspectSchemaReadiness(db, process.env);
    return NextResponse.json(
      { ok: schema.ok, schema },
      { status: schema.ok ? 200 : 503, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    const { inspectPartialDatabaseState } = await import("@/lib/db-schema-readiness");
    const partial = inspectPartialDatabaseState(process.env);
    partial.error = String((err as Error)?.message ?? err).slice(0, 240);
    return NextResponse.json(
      { ok: false, schema: partial },
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
}
