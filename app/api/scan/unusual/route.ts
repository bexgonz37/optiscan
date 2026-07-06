import { NextResponse } from "next/server";
import { runScan } from "@/lib/scan-core";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const maxAge = Number(new URL(req.url).searchParams.get("maxAge"));
    const scan = await runScan(Number.isFinite(maxAge) ? maxAge : undefined);
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
