/**
 * asymmetry-private-send.ts — the actual owner-private Discord transport.
 *
 * It lives OUTSIDE lib/research/asymmetry deliberately. The radar's boundary
 * test asserts that no file under that directory contains a network call at
 * all, and keeping that rule absolute is worth more than the convenience of
 * co-locating the sender with its caller. The scheduler injects this into the
 * transition sweep; no research module imports it.
 *
 * THIS FILE EXISTS BECAUSE OF A REAL DEFECT. `notifyPrivateAsymmetry` takes an
 * optional injected `send`, and the scheduler never injected one — so every
 * private notification returned NOT_CONFIGURED ("no sender injected") while the
 * diagnostics reported `enabled: true, webhookConfigured: true`. The radar
 * looked healthy and could not have delivered a single message.
 *
 * The existing `postToDiscord` could not be reused: it resolves a webhook KIND
 * from a fixed list (options/stocks/watchlist/recap/default), and the private
 * research webhook is a standalone URL that is deliberately none of those.
 * Routing research through a registered kind is exactly what must not happen.
 *
 * The URL is received as an argument, used once, and never logged, returned,
 * stored, or included in an error message. Failures report status codes only.
 */

export interface WebhookSendResult {
  ok: boolean;
  reason?: string;
  messageId?: string | null;
  acceptedAtMs?: number | null;
}

const SEND_TIMEOUT_MS = 10_000;

/**
 * POST one plain-content message to an owner-private webhook. Never throws.
 *
 * `flags: 4096` is not used and no mention payload is attached: this is a
 * research channel, and a research message must never ping anyone.
 */
export async function sendAsymmetryWebhook(webhook: string, content: string): Promise<WebhookSendResult> {
  if (!webhook || !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(webhook)) {
    // Refuse anything that is not a Discord webhook URL rather than posting
    // owner research to an arbitrary host.
    return { ok: false, reason: "not a Discord webhook URL" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const target = new URL(webhook);
    target.searchParams.set("wait", "true");
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: String(content ?? "").slice(0, 1900),
        // No role or user mentions may be resolved from research content.
        allowed_mentions: { parse: [] },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Status only. The response body can echo the webhook token.
      return { ok: false, reason: `discord http ${res.status}` };
    }
    let messageId: string | null = null;
    try {
      const body = await res.json() as { id?: unknown };
      messageId = body?.id == null ? null : String(body.id);
    } catch { /* Discord acceptance still counts when the response body is absent. */ }
    return { ok: true, messageId, acceptedAtMs: Date.now() };
  } catch (err: any) {
    const message = String(err?.message ?? err);
    // Defence in depth: a fetch error can embed the request URL.
    return { ok: false, reason: message.includes("webhooks/") ? "send failed" : message.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}
