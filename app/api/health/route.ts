import { NextResponse } from "next/server";
import { providerStatus } from "@/lib/scan-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = providerStatus();
  return NextResponse.json({
    ok: true,
    ...status,
    time: new Date().toISOString(),
  });
}
