/**
 * B4 surface labeling and disabled-gate responses.
 * V2 APIs must never silently fall back to legacy paper data.
 */

export const BROKER_V2_SURFACE_LABEL = "Research / Brokerage V2 — Not Yet Authoritative";

export function brokerV2DisabledPayload() {
  return {
    // ok:true — request succeeded; enabled:false — V2 data intentionally withheld (no legacy mix).
    ok: true as const,
    enabled: false as const,
    code: "paper_broker_v2_disabled" as const,
    label: BROKER_V2_SURFACE_LABEL,
    authoritative: false as const,
    error:
      "PAPER_BROKER_V2_ENABLED=0 — Brokerage V2 APIs are disabled. Legacy paper remains authoritative. No V2/legacy data mix.",
  };
}
