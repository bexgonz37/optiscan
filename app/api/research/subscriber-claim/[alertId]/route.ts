import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { buildSubscriberClaimPacket } from "@/lib/research/options/subscriber-claims";
import { labelCurrentReturn, labelMfe, labelRealizedReturn } from "@/lib/research/options/return-vocabulary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Auth-gated verifiable claim packet for a delivered Discord alert. */
export async function GET(req: Request, ctx: { params: Promise<{ alertId: string }> }) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  const { alertId } = await ctx.params;
  try {
    const { getDb } = await import("@/lib/db");
    const packet = buildSubscriberClaimPacket(getDb(), alertId);
    return NextResponse.json({
      ok: packet.ok,
      packet,
      labels: {
        current: labelCurrentReturn(packet.currentReturnPct),
        realized: labelRealizedReturn(packet.realizedReturnPct),
        mfe: labelMfe(packet.mfePct),
      },
    });
  } catch (err: unknown) {
    return NextResponse.json({ ok: false, error: String((err as Error)?.message ?? err) }, { status: 500 });
  }
}
