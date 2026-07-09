import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH /api/paper/trades/[id] — {action: "cancel" | "close"} */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { id } = await ctx.params;
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = body?.action === "close" ? "close" : body?.action === "cancel" ? "cancel" : null;
  if (!action) return NextResponse.json({ ok: false, note: "action must be 'cancel' or 'close'" }, { status: 400 });
  const { manualAction } = await import("@/lib/paper-engine");
  const result = manualAction(Number(id), action);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
