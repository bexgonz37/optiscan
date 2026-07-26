/**
 * Stripe Checkout + webhook handling without adding stripe npm dependency.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { billingEnabled } from "@/lib/billing/entitlements.ts";
import {
  linkDiscordUserOnDb,
  recordSubscriptionEventOnDb,
  upsertSubscriberOnDb,
  type BillingDb,
} from "@/lib/billing/subscribers-store.ts";
import { syncDiscordSubscriberRole } from "@/lib/billing/discord-role-sync.ts";

const STRIPE_API = "https://api.stripe.com/v1";

function stripeKey(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.STRIPE_SECRET_KEY ?? "").trim();
}

export async function createCheckoutSession(env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!billingEnabled(env)) return { ok: false, error: "BILLING_ENABLED!=1 or STRIPE_SECRET_KEY missing" };
  const key = stripeKey(env);
  const priceId = String(env.STRIPE_PRICE_ID_DISCORD_MONTHLY ?? "").trim();
  const successUrl = String(env.PUBLIC_SUBSCRIBE_SUCCESS_URL ?? env.PUBLIC_APP_URL ?? "").trim();
  const cancelUrl = String(env.PUBLIC_SUBSCRIBE_CANCEL_URL ?? env.PUBLIC_APP_URL ?? "").trim();
  if (!priceId || !successUrl) return { ok: false, error: "STRIPE_PRICE_ID_DISCORD_MONTHLY or PUBLIC_SUBSCRIBE_SUCCESS_URL missing" };

  const body = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: `${successUrl}${successUrl.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl || successUrl,
    "subscription_data[metadata][product]": "discord_monthly",
  });
  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as { url?: string; error?: { message?: string } };
  if (!res.ok) return { ok: false, error: json.error?.message ?? `Stripe ${res.status}` };
  return { ok: true, url: json.url };
}

export function verifyStripeWebhookSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k, v];
    }),
  );
  const ts = parts.t;
  const v1 = parts.v1;
  if (!ts || !v1) return false;
  const payload = `${ts}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  try {
    const a = Buffer.from(v1);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const GRACE_MS = 3 * 24 * 3600_000;

export async function handleStripeWebhookEvent(
  db: BillingDb,
  event: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; error?: string }> {
  const type = String(event.type ?? "");
  const data = (event.data as { object?: Record<string, unknown> })?.object ?? {};
  const eventId = String(event.id ?? "");

  try {
    if (type === "checkout.session.completed") {
      const customerId = String(data.customer ?? "");
      const subscriptionId = String(data.subscription ?? "");
      const email = data.customer_details && typeof data.customer_details === "object"
        ? String((data.customer_details as { email?: string }).email ?? "")
        : null;
      upsertSubscriberOnDb(db, {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId || null,
        email,
        status: "active",
        planId: "discord_monthly",
      });
    } else if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
      const customerId = String(data.customer ?? "");
      const statusRaw = String(data.status ?? "canceled");
      const status =
        statusRaw === "active" || statusRaw === "trialing"
          ? (statusRaw as "active" | "trialing")
          : statusRaw === "past_due"
            ? "past_due"
            : "canceled";
      const periodEnd = data.current_period_end != null ? Number(data.current_period_end) * 1000 : null;
      const sub = upsertSubscriberOnDb(db, {
        stripeCustomerId: customerId,
        stripeSubscriptionId: String(data.id ?? ""),
        status,
        currentPeriodEndMs: periodEnd,
        graceUntilMs: status === "past_due" ? Date.now() + GRACE_MS : null,
      });
      if (sub?.discordUserId) {
        if (status === "active" || status === "trialing") {
          await syncDiscordSubscriberRole(sub.discordUserId, "grant", env, db);
        } else if (status === "canceled" || (status === "past_due" && sub.graceUntilMs != null && Date.now() > sub.graceUntilMs)) {
          await syncDiscordSubscriberRole(sub.discordUserId, "revoke", env, db);
        }
      }
    } else if (type === "charge.refunded") {
      const customerId = String(data.customer ?? "");
      const sub = upsertSubscriberOnDb(db, { stripeCustomerId: customerId, status: "refunded" });
      if (sub?.discordUserId) await syncDiscordSubscriberRole(sub.discordUserId, "revoke", env, db);
    }
    recordSubscriptionEventOnDb(db, eventId, type, JSON.stringify(event), true, null);
    return { ok: true };
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e);
    recordSubscriptionEventOnDb(db, eventId, type, JSON.stringify(event), false, msg);
    return { ok: false, error: msg };
  }
}

export function linkDiscordAfterCheckout(
  db: BillingDb,
  stripeCustomerId: string,
  discordUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; error?: string }> {
  const linked = linkDiscordUserOnDb(db, stripeCustomerId, discordUserId);
  if (!linked) return Promise.resolve({ ok: false, error: "subscriber not found for customer" });
  return syncDiscordSubscriberRole(discordUserId, "grant", env, db).then((r) =>
    r.ok ? { ok: true } : { ok: false, error: r.reason ?? "role sync failed" },
  );
}
