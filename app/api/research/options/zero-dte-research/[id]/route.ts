import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/research/options/zero-dte-research/[id] — single 0DTE research trade dossier. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  try {
    const { id: idRaw } = await ctx.params;
    const id = Number(idRaw);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildZeroDteTradeDetail } = require("@/lib/research/options/zero-dte-research");
    const detail = buildZeroDteTradeDetail(getDb(), id);
    if (!detail.ok) {
      return NextResponse.json(
        { ok: false, error: detail.error ?? "not_found" },
        { status: detail.error === "invalid_id" ? 400 : 404 },
      );
    }
    return NextResponse.json({ ok: true, trade: detail.trade });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}
