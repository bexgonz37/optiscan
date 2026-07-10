import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ alertId: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  const { alertId } = await ctx.params;
  const id = Number(alertId);
  if (!Number.isFinite(id)) return NextResponse.json({ ok: false, error: "invalid alert id" }, { status: 400 });
  const { scoreAlert } = await import("@/lib/quant");
  const score = scoreAlert(id);
  if (!score) return NextResponse.json({ ok: false, error: "alert not found" }, { status: 404 });
  return NextResponse.json({ ok: true, score });
}

