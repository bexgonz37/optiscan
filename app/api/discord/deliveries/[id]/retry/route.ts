import { NextRequest, NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { retryDiscordDelivery } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const result = await retryDiscordDelivery(id);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
