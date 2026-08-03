import { NextResponse } from "next/server";
import { runScan } from "@/lib/scan-core";
import { loopState } from "@/lib/scanner-loop";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { withProviderConsumer } from "@/lib/provider-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/scanner/live — the every-second loop's in-memory movers (rates,
 * acceleration, HOD/LOD, direction) plus the slower full-scan payload. The
 * loop data updates every SCANNER_LOOP_MS without any extra API cost here. */
export async function GET(req: Request) {
  // An operator- or browser-triggered scan, distinct from the scheduled scanner
  // loop. Same code, different owner — and only the loop holds the scanner reserve.
  return withProviderConsumer("dashboard_api", () => scannerLiveInner(req));
}

async function scannerLiveInner(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  try {
    const q = new URL(req.url).searchParams;
    const realtime = loopState();
    if (q.get("realtimeOnly") === "1") return NextResponse.json({ ok: true, realtime });
    const maxAge = Number(q.get("maxAge"));
    const scan = await runScan(Number.isFinite(maxAge) ? maxAge : undefined);
    return NextResponse.json({ ok: true, realtime, ...scan });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "scan failed" }, { status: 500 });
  }
}
