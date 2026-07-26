import { NextResponse } from "next/server";
import { handleStripeWebhookEvent, verifyStripeWebhookSignature } from "@/lib/billing/stripe-client";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  ensureServerBoot();
  const secret = String(process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!verifyStripeWebhookSignature(raw, sig, secret)) {
    return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 400 });
  }
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const { getDb } = await import("@/lib/db");
  const result = await handleStripeWebhookEvent(getDb(), event);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
