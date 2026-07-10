import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const { runBacktest } = await import("@/lib/quant");
  const result = runBacktest(body ?? {});
  return NextResponse.json({
    ok: true,
    result,
    disclaimer: "This is historical/statistical analysis, not financial advice.",
  });
}

