import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Evidence-only Tier-1 options rejection diagnostic (read-only, token-gated). Runs the exact
 * enrichment path per Tier-1 symbol and reports bars/features/strategy scoring/rejection reasons.
 * Creates NO candidate, paper trade, or Discord message. Never fabricates a candidate.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { buildLiveOptionsDeps } = await import("@/lib/research/options/live-deps");
  const { optionsTier1Diagnostic } = await import("@/lib/research/options/diagnostic");
  const live = buildLiveOptionsDeps();
  const diagnostic = await optionsTier1Diagnostic({
    getUnderlyingBatch: async (syms) => {
      const m = await live.getUnderlyingBatch(syms);
      const out = new Map<string, { price: number | null; dayDollarVolume: number | null }>();
      for (const [k, v] of m) out.set(k, { price: v.price, dayDollarVolume: v.dayDollarVolume });
      return out;
    },
    getBars: (sym) => (live.getBars ? live.getBars(sym) : Promise.resolve([])),
    levelContext: live.levelContext, now: live.now, session: live.session,
  }, process.env);
  return NextResponse.json({ ok: true, diagnostic });
}
