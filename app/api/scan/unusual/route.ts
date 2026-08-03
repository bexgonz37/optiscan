import { NextResponse } from "next/server";
import { runScan } from "@/lib/scan-core";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { withProviderConsumer } from "@/lib/provider-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // An operator- or browser-triggered scan, distinct from the scheduled scanner
  // loop. Same code, different owner — and only the loop holds the scanner reserve.
  return withProviderConsumer("dashboard_api", () => unusualInner(req));
}

async function unusualInner(req: Request) {
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
