/**
 * callouts/material-hash.ts — deterministic "material state" hash for a callout
 * (live runtime wiring). PURE. Two callouts with the same hash represent the same
 * actionable content, so an unchanged callout is never re-sent after a restart or
 * a scanner retry. Only decision-relevant fields are hashed — NOT the timestamp or
 * minor score jitter — so insignificant movement does not churn the hash.
 */
import { createHash } from "node:crypto";
import type { Callout } from "./callout.ts";

/** Round a probability into coarse buckets so tiny changes do not churn the hash. */
function probBucket(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "none";
  return String(Math.round(p * 20) / 20); // 5% buckets
}

export function materialStateHash(c: Callout): string {
  const parts = [
    `key=${c.key}`,
    `status=${c.status}`,
    `actionable=${c.actionable ? 1 : 0}`,
    `model=${c.modelState}`,
    `prob=${probBucket(c.probability)}`,
    `sym=${c.contract?.optionSymbol ?? "-"}`,
    `strike=${c.contract?.strike ?? "-"}`,
    `exp=${c.contract?.expiration ?? "-"}`,
    `dte=${c.contract?.dte ?? "-"}`,
    `block=${c.primaryBlockingReason ?? "-"}`,
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}
