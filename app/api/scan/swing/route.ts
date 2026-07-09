import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/scan/swing[?force=1] — 1–4 week candidates (cached 15 min). */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const force = new URL(req.url).searchParams.get("force") === "1";
  const { runSwingScan } = await import("@/lib/swing-scan");
  const result = await runSwingScan(force);
  return NextResponse.json(result, { status: result.ok ? 200 : 429 });
}
