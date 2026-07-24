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
    const { resolveDbLocation } = await import("@/lib/db-schema-readiness");
    return NextResponse.json(
      {
        ok: false,
        schema: {
          ok: false,
          missing: [],
          present: [],
          repaired: [],
          db: resolveDbLocation(process.env),
          error: String((err as Error)?.message ?? err).slice(0, 240),
        },
      },
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
}
