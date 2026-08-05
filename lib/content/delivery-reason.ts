/**
 * delivery-reason.ts — the reason a content draft reached its delivery status,
 * and whether that reason is terminal.
 *
 * ## The defect this exists to fix
 *
 * `deliverDrafts` chose a persisted status from one boolean:
 *
 *     const nextStatus = res.ok ? "SENT" : res.suppressed ? "SUPPRESSED" : "FAILED";
 *
 * `postToDiscord` sets `suppressed: true` for SIX different guard verdicts, and
 * three of them are TRANSIENT:
 *
 * | guard reason      | meaning                                   | transient? |
 * |-------------------|-------------------------------------------|------------|
 * | `duplicate`       | this exact bundle already delivered       | no         |
 * | `retry_exhausted` | 3 attempts spent                          | no         |
 * | `disabled`        | recap kill switch is off RIGHT NOW        | **yes**    |
 * | `rate_limited`    | channel budget spent for THIS window      | **yes**    |
 * | `in_flight`       | another worker holds the claim            | **yes**    |
 * | `retry_backoff`   | waiting out a backoff that WILL expire    | **yes**    |
 *
 * Collapsing all six into `SUPPRESSED` is not merely lossy. `SUPPRESSED` is not
 * in `RETRYABLE_DELIVERY_STATES`, so the draft leaves the recovery pool for
 * good. A draft blocked because the channel was momentarily busy was **deleted
 * from the backlog as though it had been consciously rejected.**
 *
 * The recap guard allows `MAX_POSTS = 2` per `WINDOW_MS = 10 min`. The
 * `contentDrafts` job runs every 3 minutes and attempts one bundle per run —
 * about 3.3 attempts per window against a budget of 2. So roughly **40% of
 * every sweep was being permanently discarded**, which is why
 * SKIPPED_NO_WEBHOOK fell by 3 while SENT stayed flat and SUPPRESSED rose by 3.
 *
 * A transient refusal must return the draft to the queue. That is the whole
 * point of this module: the RETRYABILITY is derived from the reason, and the
 * status is derived from the retryability — never from a boolean that cannot
 * tell a closed door from a locked one.
 *
 * Nothing here loosens the dedup guard. `duplicate` stays terminal.
 */

export type DeliveryReasonCode =
  | "SENT"
  | "SUPPRESSED_DUPLICATE"
  | "SUPPRESSED_RATE_LIMIT"
  | "SUPPRESSED_IN_FLIGHT"
  | "SUPPRESSED_RETRY_BACKOFF"
  | "SUPPRESSED_RETRY_EXHAUSTED"
  | "SUPPRESSED_PERSISTENCE_FAILED"
  | "SUPPRESSED_STALE_RESEARCH"
  | "DISABLED_BY_KILL_SWITCH"
  | "SKIPPED_NO_WEBHOOK"
  | "FAILED_DISCORD_REJECTED"
  | "FAILED_NETWORK"
  | "FAILED_TIMEOUT"
  | "FAILED_INVALID_PAYLOAD"
  | "FAILED_CONFIGURATION"
  | "FAILED_UNKNOWN";

/** The persisted `discord_delivery_status`. Only these four are ever written. */
export type DeliveryStatus = "SENT" | "PENDING" | "FAILED" | "SUPPRESSED";

export interface DeliveryReason {
  code: DeliveryReasonCode;
  /** Terminal reasons leave the recovery pool. Transient ones return to it. */
  retryable: boolean;
  status: DeliveryStatus;
  /** Owner-safe sentence. Never contains a URL, token, or header. */
  explanation: string;
}

/**
 * Secrets must not reach the drafts table. A webhook URL carries its token in
 * the path, so any `discord.com/api/webhooks/...` substring is a credential.
 */
export function redactForPersistence(text: string | null | undefined): string | null {
  if (text == null) return null;
  const s = String(text);
  if (!s.trim()) return null;
  return s
    .replace(/https?:\/\/\S*discord(?:app)?\.com\/api\/webhooks\/\S*/gi, "[redacted-webhook]")
    .replace(/https?:\/\/\S+/g, "[redacted-url]")
    // An Authorization header carries its scheme AND its value, so redacting
    // only the next token would leave the secret behind. Take the rest of the
    // line — over-redacting a detail string is the safe direction to err.
    .replace(/\bauthorization\b\s*[:=]?.*/gi, "[redacted-credential]")
    .replace(/\bbearer\b\s+\S+/gi, "[redacted-credential]")
    .replace(/\b(?:token|secret|api[_-]?key|apikey)\b\s*[:=]\s*\S+/gi, "[redacted-credential]")
    .slice(0, 300);
}

const BY_CODE: Record<DeliveryReasonCode, Omit<DeliveryReason, "code" | "explanation">> = {
  SENT: { retryable: false, status: "SENT" },
  // Terminal — a real duplicate, or the attempt budget is genuinely spent.
  SUPPRESSED_DUPLICATE: { retryable: false, status: "SUPPRESSED" },
  SUPPRESSED_RETRY_EXHAUSTED: { retryable: false, status: "SUPPRESSED" },
  // Transient — the bundle was never judged on its merits, so it goes back.
  SUPPRESSED_RATE_LIMIT: { retryable: true, status: "PENDING" },
  SUPPRESSED_IN_FLIGHT: { retryable: true, status: "PENDING" },
  SUPPRESSED_RETRY_BACKOFF: { retryable: true, status: "PENDING" },
  SUPPRESSED_PERSISTENCE_FAILED: { retryable: true, status: "PENDING" },
  SUPPRESSED_STALE_RESEARCH: { retryable: false, status: "SUPPRESSED" },
  // The owner can turn the kill switch back on; the draft must survive that.
  DISABLED_BY_KILL_SWITCH: { retryable: true, status: "SKIPPED_NO_WEBHOOK" as DeliveryStatus },
  SKIPPED_NO_WEBHOOK: { retryable: true, status: "SKIPPED_NO_WEBHOOK" as DeliveryStatus },
  // Transport problems are retryable; a payload Discord will never accept is not.
  FAILED_DISCORD_REJECTED: { retryable: false, status: "FAILED" },
  FAILED_INVALID_PAYLOAD: { retryable: false, status: "FAILED" },
  FAILED_NETWORK: { retryable: true, status: "FAILED" },
  FAILED_TIMEOUT: { retryable: true, status: "FAILED" },
  FAILED_CONFIGURATION: { retryable: true, status: "FAILED" },
  FAILED_UNKNOWN: { retryable: true, status: "FAILED" },
};

const EXPLANATION: Record<DeliveryReasonCode, string> = {
  SENT: "Delivered to the recap channel.",
  SUPPRESSED_DUPLICATE: "This exact bundle was already delivered. Not sent again.",
  SUPPRESSED_RETRY_EXHAUSTED: "Delivery failed on every permitted attempt. Not retried further.",
  SUPPRESSED_RATE_LIMIT: "The recap channel's post budget for this window was spent. Queued for a later sweep.",
  SUPPRESSED_IN_FLIGHT: "Another worker holds the delivery claim. Queued for a later sweep.",
  SUPPRESSED_RETRY_BACKOFF: "Waiting out a delivery backoff. Queued for a later sweep.",
  SUPPRESSED_PERSISTENCE_FAILED: "The delivery claim could not be recorded, so no send was attempted. Queued for a later sweep.",
  SUPPRESSED_STALE_RESEARCH: "The draft remains archived in the app, but its live-looking research window has passed. Not sent to Discord.",
  DISABLED_BY_KILL_SWITCH: "DISCORD_RECAP_ENABLED is off. Held until the owner turns it back on.",
  SKIPPED_NO_WEBHOOK: "No recap webhook is configured. Held until one exists.",
  FAILED_DISCORD_REJECTED: "Discord rejected the message. Not retried without repair.",
  FAILED_INVALID_PAYLOAD: "The message was malformed. Not retried without repair.",
  FAILED_NETWORK: "The network call to Discord failed. Will be retried.",
  FAILED_TIMEOUT: "The call to Discord timed out. Will be retried.",
  FAILED_CONFIGURATION: "Delivery is misconfigured. Will be retried once corrected.",
  FAILED_UNKNOWN: "Delivery failed for an unrecognized reason. Will be retried.",
};

export function describeReason(code: DeliveryReasonCode): DeliveryReason {
  return { code, ...BY_CODE[code], explanation: EXPLANATION[code] };
}

/** Guard verdicts from `claimRecapDelivery`, mapped to explicit codes. */
const GUARD_REASON_TO_CODE: Record<string, DeliveryReasonCode> = {
  duplicate: "SUPPRESSED_DUPLICATE",
  rate_limited: "SUPPRESSED_RATE_LIMIT",
  in_flight: "SUPPRESSED_IN_FLIGHT",
  retry_backoff: "SUPPRESSED_RETRY_BACKOFF",
  retry_exhausted: "SUPPRESSED_RETRY_EXHAUSTED",
  disabled: "DISABLED_BY_KILL_SWITCH",
  recap_claim_persistence_failed: "SUPPRESSED_PERSISTENCE_FAILED",
};

/**
 * Classify one delivery attempt.
 *
 * `defaultSend` composes the guard verdict into `error` as
 * `"recap suppressed: <reason>"`. That string was the ONLY carrier of the
 * verdict and it was being discarded, which is how a rate limit became
 * indistinguishable from a duplicate.
 */
export function classifyDeliveryResult(res: {
  ok?: boolean;
  suppressed?: boolean;
  error?: string | null;
  messageId?: string | null;
}): DeliveryReason {
  if (res.ok) return describeReason("SENT");

  const raw = String(res.error ?? "");

  if (res.suppressed) {
    const m = /recap suppressed:\s*([a-z_]+)/i.exec(raw);
    const code = m ? GUARD_REASON_TO_CODE[m[1].toLowerCase()] : undefined;
    // An unrecognized suppression is treated as TRANSIENT on purpose. Dropping a
    // truthful draft is worse than delivering it one sweep late, and a new guard
    // verdict must not silently inherit "terminal".
    return describeReason(code ?? "SUPPRESSED_RATE_LIMIT");
  }

  if (/not configured|configuration/i.test(raw)) return describeReason("FAILED_CONFIGURATION");
  if (/timeout|timed out|abort/i.test(raw)) return describeReason("FAILED_TIMEOUT");
  // 4xx is Discord refusing this payload; 5xx is Discord being unavailable.
  if (/discord\s+4\d\d/i.test(raw)) return describeReason("FAILED_DISCORD_REJECTED");
  if (/discord\s+5\d\d/i.test(raw)) return describeReason("FAILED_NETWORK");
  if (/invalid|malformed|payload/i.test(raw)) return describeReason("FAILED_INVALID_PAYLOAD");
  if (/fetch|network|econn|enotfound|socket/i.test(raw)) return describeReason("FAILED_NETWORK");
  return describeReason("FAILED_UNKNOWN");
}
