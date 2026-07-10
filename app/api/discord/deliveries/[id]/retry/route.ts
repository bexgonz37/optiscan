import { NextRequest, NextResponse } from "next/server";
import { retryDiscordDelivery } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const result = await retryDiscordDelivery(id);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
