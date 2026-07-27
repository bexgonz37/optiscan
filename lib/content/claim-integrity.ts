/**
 * Claim integrity for Content Event Engine performance drafts.
 * Reuses the subscriber claim path — only SENT independent alerts with a linked
 * DELIVERED_ALERT_PAPER mirror and matching frozen entry may power performance copy.
 * Shadow / research / undelivered / ambiguous sources are hard-blocked.
 */
import {
  buildSubscriberClaimPacket,
  type SubscriberClaimPacket,
} from "../research/options/subscriber-claims.ts";

export type ContentResultType =
  | "UNREALIZED_CURRENT_RETURN"
  | "REALIZED_CLOSED_RETURN"
  | "MAX_FAVORABLE_EXCURSION"
  | "HISTORICAL_RECAP"
  | "NON_ACTIONABLE_RESEARCH";

export const PERFORMANCE_CATEGORIES = new Set([
  "RETURN_MILESTONE",
  "NEW_HIGH",
  "CLOSED_WINNER",
  "CLOSED_LOSER",
  "WHY_THIS_WORKED",
  "WHY_THIS_FAILED",
]);

export const SAFE_CATEGORIES = new Set([
  "JUST_ENTERED_RADAR",
  "HIGH_CONVICTION",
  "CONVICTION_INCREASED",
  "THESIS_WEAKENED",
  "NEXT_SESSION_WATCH",
  "EDUCATIONAL_BREAKDOWN",
  "MARKET_OBSERVATION",
]);

export function isPerformanceCategory(category: string): boolean {
  return PERFORMANCE_CATEGORIES.has(category);
}

export function isSafeCategory(category: string): boolean {
  return SAFE_CATEGORIES.has(category);
}

interface ClaimDb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[] };
}

function hasTable(db: ClaimDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

export interface ContentClaimCheck {
  ok: boolean;
  reason: string | null;
  alertId: string | null;
  claim: SubscriberClaimPacket | null;
  resultType: ContentResultType;
  claimPacketId: string | null;
}

/**
 * Resolve the SENT alert for an opportunity case and verify the subscriber claim packet.
 * Returns ok=false for shadow/research/undelivered/missing-entry sources.
 */
export function verifyContentClaimForCase(
  db: ClaimDb,
  opportunityCaseId: string | null | undefined,
  category: string,
): ContentClaimCheck {
  const fail = (reason: string, resultType: ContentResultType = "NON_ACTIONABLE_RESEARCH"): ContentClaimCheck => ({
    ok: false, reason, alertId: null, claim: null, resultType, claimPacketId: null,
  });

  if (!isPerformanceCategory(category)) {
    return {
      ok: true,
      reason: null,
      alertId: null,
      claim: null,
      resultType: "NON_ACTIONABLE_RESEARCH",
      claimPacketId: null,
    };
  }

  if (!opportunityCaseId) return fail("missing opportunity_case_id for performance category");
  if (!hasTable(db, "options_alerts")) return fail("options_alerts table missing");

  const alert = db.prepare(
    `SELECT alert_id, state, discord_message_id FROM options_alerts
     WHERE opportunity_case_id=? AND state='SENT'
     ORDER BY sent_at_ms DESC LIMIT 1`,
  ).get(String(opportunityCaseId)) as { alert_id?: string; state?: string; discord_message_id?: string } | undefined;

  if (!alert?.alert_id) return fail("no SENT alert linked to opportunity case");
  if (!alert.discord_message_id) return fail("SENT alert missing discord_message_id");

  const claim = buildSubscriberClaimPacket(db, String(alert.alert_id));
  if (!claim.ok) return fail(claim.reason ?? "claim packet failed", "NON_ACTIONABLE_RESEARCH");

  let resultType: ContentResultType = "UNREALIZED_CURRENT_RETURN";
  if (category === "CLOSED_WINNER" || category === "CLOSED_LOSER" || category === "WHY_THIS_WORKED" || category === "WHY_THIS_FAILED") {
    resultType = "REALIZED_CLOSED_RETURN";
  } else if (category === "NEW_HIGH") {
    resultType = "MAX_FAVORABLE_EXCURSION";
  } else if (category === "RETURN_MILESTONE") {
    resultType = claim.status === "EXITED" ? "REALIZED_CLOSED_RETURN" : "UNREALIZED_CURRENT_RETURN";
  }

  return {
    ok: true,
    reason: null,
    alertId: String(alert.alert_id),
    claim,
    resultType,
    claimPacketId: `claim_${alert.alert_id}`,
  };
}

/** MFE must never be described as a realized subscriber return. */
export function mfeDisclaimer(pct: number | null | undefined): string {
  const n = pct != null && Number.isFinite(pct) ? `${pct > 0 ? "+" : ""}${Number.isInteger(pct) ? pct : pct.toFixed(1)}%` : "X%";
  return `The contract reached a maximum favorable move of ${n}. This is not the same as a realized subscriber return.`;
}

export function resultTypeLabel(t: ContentResultType): string {
  switch (t) {
    case "UNREALIZED_CURRENT_RETURN": return "Unrealized current return vs frozen Discord entry";
    case "REALIZED_CLOSED_RETURN": return "Realized closed return vs frozen Discord entry";
    case "MAX_FAVORABLE_EXCURSION": return "Maximum favorable excursion (MFE) — not a realized return";
    case "HISTORICAL_RECAP": return "Historical recap";
    case "NON_ACTIONABLE_RESEARCH": return "Non-actionable research / observation";
  }
}
