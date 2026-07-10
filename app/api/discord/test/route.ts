import { NextRequest, NextResponse } from "next/server";
import { sendDiscordTest } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let kind: "options" | "stocks" = "options";
  try {
    const body = await req.json();
    if (body?.kind === "stocks") kind = "stocks";
  } catch { /* default options */ }
  const result = await sendDiscordTest(kind);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
