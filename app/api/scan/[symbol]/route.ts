import { NextResponse } from "next/server";
import { scanSymbol } from "@/lib/scan-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
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
