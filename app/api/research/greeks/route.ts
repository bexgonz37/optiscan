import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";
import { bsGreeks, impliedVol, timeToExpiryYears } from "@/lib/greeks";
import { closeToCloseRv, ivPremium, ivPremiumRiskLabel, parkinsonRv } from "@/lib/realized-vol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/research/greeks?side=call&S=100&K=100&dte=0&price=1.25&iv=0.4
 * Diagnostic calculator — does not change live delivery.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const side = (url.searchParams.get("side") === "put" ? "put" : "call") as "call" | "put";
    const S = Number(url.searchParams.get("S"));
    const K = Number(url.searchParams.get("K"));
    const dte = Number(url.searchParams.get("dte") ?? 0);
    const price = Number(url.searchParams.get("price"));
    const ivIn = url.searchParams.get("iv") != null ? Number(url.searchParams.get("iv")) : null;
    const r = Number(url.searchParams.get("r") ?? 0.05);
    const nowMs = Date.now();
    const T = timeToExpiryYears({ nowMs, dte });
    const iv = ivIn != null && Number.isFinite(ivIn)
      ? ivIn
      : (Number.isFinite(price) ? impliedVol(side, S, K, T, r, price) : null);
    const greeks = iv != null && Number.isFinite(S) && Number.isFinite(K)
      ? bsGreeks(side, S, K, T, r, iv)
      : null;
    return NextResponse.json({
      ok: true,
      T,
      iv,
      greeks,
      note: "0DTE uses minute-accurate T to 16:00 ET — integer dte=0 alone is not used as T=0.",
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

/** POST body: { bars: [{o,h,l,c}], contractIv?: number } → RV + IV premium */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const body = await req.json().catch(() => ({}));
    const bars = Array.isArray(body?.bars) ? body.bars : [];
    const contractIv = body?.contractIv != null ? Number(body.contractIv) : null;
    const park = parkinsonRv(bars);
    const c2c = closeToCloseRv(bars);
    const rv = park ?? c2c;
    const premium = ivPremium(contractIv, rv);
    return NextResponse.json({
      ok: true,
      parkinsonRv: park,
      closeToCloseRv: c2c,
      realizedVol: rv,
      ivPremium: premium,
      ivPremiumRisk: ivPremiumRiskLabel(premium),
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
