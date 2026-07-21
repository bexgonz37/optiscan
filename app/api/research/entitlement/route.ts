import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/research/entitlement — token-gated, secret-safe probe of the Polygon reference
 * endpoints needed for a survivorship-free point-in-time universe. The API key is sent ONLY
 * in the Authorization header (never a URL/query) and is NEVER included in the response.
 */
async function probe(base: string, key: string, path: string, params: Record<string, string>) {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${key}` } });
    let body: any = null;
    try { body = await res.json(); } catch { /* non-json */ }
    return {
      endpoint: path,
      params: Object.keys(params).join(","),
      httpStatus: res.status,
      entitlementAvailable: res.status === 200,
      resultsCount: Array.isArray(body?.results) ? body.results.length : body?.results ? 1 : 0,
      pagination: Boolean(body?.next_url),
      historicalDateFilterHonored: "date" in params ? res.status === 200 : null,
      note: res.status === 401 || res.status === 403 ? "not entitled/authorized" : res.status === 200 ? "ok" : `status ${res.status}`,
    };
  } catch (e: any) {
    return { endpoint: path, params: Object.keys(params).join(","), httpStatus: null, entitlementAvailable: false, resultsCount: 0, pagination: false, historicalDateFilterHonored: null, note: `request error: ${String(e?.message ?? e).slice(0, 80)}` };
  }
}

export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  const { getPolygonKey, hasPolygon } = await import("@/lib/polygon-provider");
  if (!hasPolygon()) return NextResponse.json({ ok: false, error: "no provider key configured (POLYGON_API_KEY / MASSIVE_API_KEY)" }, { status: 400 });
  const key = getPolygonKey();
  const base = process.env.POLYGON_API_URL || "https://api.polygon.io";
  const checks = await Promise.all([
    probe(base, key, "/v3/reference/tickers", { active: "false", limit: "1" }),          // inactive / delisted
    probe(base, key, "/v3/reference/tickers", { date: "2022-01-03", limit: "1" }),        // date-effective (point-in-time)
    probe(base, key, "/v3/reference/splits", { limit: "1" }),                             // splits
    probe(base, key, "/v3/reference/dividends", { limit: "1" }),                          // dividends
  ]);
  const pointInTimeUniverseSufficient = checks[0].entitlementAvailable && checks[1].entitlementAvailable;
  return NextResponse.json({
    ok: true, provider: "polygon", secretsPrinted: false, checks,
    pointInTimeUniverseSufficient,
    fallback: pointInTimeUniverseSufficient
      ? "provider point-in-time universe is usable (survivorship-free)"
      : "provider point-in-time NOT verified — supply a user-dated universe file (symbol, active_from, active_to, security_id); a current-symbol replay is EXPLORATORY ONLY and INVALID for the Phase-D GO verdict",
  });
}
