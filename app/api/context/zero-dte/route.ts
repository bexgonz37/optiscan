import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { resolveZeroDteStripSymbols, fetchStripContext } from "@/lib/zero-dte-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/context/zero-dte — ATM IV context for up to 6 strip symbols (cached). */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  const url = new URL(req.url);
  const chart = url.searchParams.get("chart");
  const symbolsParam = url.searchParams.get("symbols");
  const override = symbolsParam
    ? symbolsParam.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
    : null;

  try {
    const symbols = resolveZeroDteStripSymbols({ chartSymbol: chart, override });
    const ctx = await fetchStripContext(symbols);
    return NextResponse.json({ ok: true, ...ctx });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "context failed" }, { status: 500 });
  }
}
