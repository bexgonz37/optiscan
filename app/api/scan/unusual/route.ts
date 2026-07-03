import { NextResponse } from "next/server";
import { runScan } from "@/lib/scan-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const scan = await runScan();
    const { momentum, ...rest } = scan;
    void momentum;
    return NextResponse.json({ ...rest, signals: scan.unusual });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "scan failed", signals: [] },
      { status: 500 },
    );
  }
}
