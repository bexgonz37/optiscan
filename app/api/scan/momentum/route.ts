import { NextResponse } from "next/server";
import { runScan } from "@/lib/scan-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const scan = await runScan();
    const { unusual, ...rest } = scan;
    void unusual;
    return NextResponse.json({ ...rest, signals: scan.momentum });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "scan failed", signals: [] },
      { status: 500 },
    );
  }
}
