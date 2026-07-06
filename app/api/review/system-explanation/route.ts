import { NextResponse } from "next/server";
import { SYSTEM_EXPLANATION } from "@/lib/system-explanation";

export const runtime = "nodejs";

/** GET /api/review/system-explanation — how the scanner works, in JSON. */
export async function GET() {
  return NextResponse.json({ ok: true, ...SYSTEM_EXPLANATION });
}
