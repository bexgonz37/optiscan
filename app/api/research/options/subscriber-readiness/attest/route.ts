import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Owner action: set or clear one of the non-measurable readiness attestations (billing flows tested,
 * legal checklist complete, no unresolved Critical issues). Persisted with who + when. This only
 * records the owner's sign-off; readiness is recomputed on the next evaluation — it does not itself
 * flip readiness, enable billing, or change anything operational.
 */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const body = (await req.json().catch(() => ({}))) as { key?: string; attested?: boolean; attestedBy?: string; note?: string };
    if (!body?.key || typeof body.attested !== "boolean") {
      return NextResponse.json({ ok: false, error: "body requires { key, attested:boolean, attestedBy? }" }, { status: 400 });
    }
    const { getDb } = await import("@/lib/db");
    const { setReadinessAttestationOnDb } = await import("@/lib/research/subscriber-readiness-notifier");
    const res = setReadinessAttestationOnDb(getDb(), body.key, body.attested, {
      attestedBy: body.attestedBy ?? null,
      note: body.note ?? null,
    });
    return NextResponse.json({ ...res }, { status: res.ok ? 200 : 400, headers: { "content-type": "application/json" } });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
