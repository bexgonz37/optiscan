import { NextResponse } from "next/server";
import { scanSymbol } from "@/lib/scan-core";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { withProviderConsumer } from "@/lib/provider-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  return withProviderConsumer("dashboard_api", () => scanSymbolInner(req, params));
}

async function scanSymbolInner(
  req: Request,
  params: Promise<{ symbol: string }>,
) {
  if (!checkApiToken(req)) return unauthorized();
  const { symbol } = await params;
  try {
    const detail = await scanSymbol(symbol);
    return NextResponse.json(detail);
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "symbol scan failed" },
      { status: 500 },
    );
  }
}
