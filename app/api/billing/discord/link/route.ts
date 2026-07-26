import { NextRequest, NextResponse } from "next/server";
import { linkDiscordAfterCheckout } from "@/lib/billing/stripe-client";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public narrow endpoint: link Discord user id to Stripe customer after checkout. */
export async function POST(req: NextRequest) {
  ensureServerBoot();
  let body: { stripeCustomerId?: string; discordUserId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const stripeCustomerId = String(body.stripeCustomerId ?? "").trim();
  const discordUserId = String(body.discordUserId ?? "").trim();
  if (!stripeCustomerId || !discordUserId) {
    return NextResponse.json({ ok: false, error: "stripeCustomerId and discordUserId required" }, { status: 400 });
  }
  const { getDb } = await import("@/lib/db");
  const result = await linkDiscordAfterCheckout(getDb(), stripeCustomerId, discordUserId);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
