import { NextResponse } from "next/server";
import { providerStatus } from "@/lib/scan-core";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureServerBoot();
  const status = providerStatus();
  return NextResponse.json({
    ok: true,
    ...status,
    time: new Date().toISOString(),
  });
}
