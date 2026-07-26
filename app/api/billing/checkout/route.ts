import { NextResponse } from "next/server";
import { createCheckoutSession } from "@/lib/billing/stripe-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public checkout redirect — no app data exposed. */
export async function POST() {
  const result = await createCheckoutSession();
  if (!result.ok || !result.url) {
    return NextResponse.json({ ok: false, error: result.error ?? "checkout unavailable" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, url: result.url });
}
