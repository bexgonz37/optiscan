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
import {
  reconcileTradeIdentityOnDb,
  type IdentityDefect,
  type IdentityVerdict,
} from "../opportunity-case/trade-identity.ts";

export type ContentResultType =
  | "UNREALIZED_CURRENT_RETURN"
  | "REALIZED_CLOSED_RETURN"
  | "MAX_FAVORABLE_EXCURSION"
  | "HISTORICAL_RECAP"
  | "NON_ACTIONABLE_RESEARCH"
  /** Trade identity could not be proven — no numeric performance claim may be made. */
  | "CONTENT_PERFORMANCE_UNVERIFIED";

/** Categories whose copy quotes a peak/MFE rather than a realized or current return. */
export const MFE_CATEGORIES = new Set(["NEW_HIGH", "CLOSED_WINNER", "WHY_THIS_WORKED"]);

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
  /** Trade-identity verdict, when one was required. */
  identityVerdict?: IdentityVerdict | null;
  identityDefects?: IdentityDefect[];
  /** The frozen contract's own best mark — the only defensible MFE for this case. */
  verifiedMaxReturnPct?: number | null;
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
  const fail = (
    reason: string,
    resultType: ContentResultType = "NON_ACTIONABLE_RESEARCH",
    extra: Partial<ContentClaimCheck> = {},
  ): ContentClaimCheck => ({
    ok: false, reason, alertId: null, claim: null, resultType, claimPacketId: null, ...extra,
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

  // Trade identity is the last gate before a number becomes public copy. A SENT alert
  // with a price-matched mirror was never enough: a case keeps re-selecting preferred
  // contracts while it lives, and the peak stored on the case can describe a strike
  // and expiration the subscriber was never given. Prove it or say nothing.
  const identity = reconcileTradeIdentityOnDb(db as any, String(opportunityCaseId));
  const identityExtra = {
    identityVerdict: identity.verdict as IdentityVerdict,
    identityDefects: identity.defects,
    verifiedMaxReturnPct: identity.frozenContractBestMarkPct,
  };
  if (identity.verdict !== "SAME_OCC_VERIFIED") {
    return fail(
      `trade identity ${identity.verdict}: ${identity.reasons.join("; ") || "not provable"}`,
      "CONTENT_PERFORMANCE_UNVERIFIED",
      identityExtra,
    );
  }

  // A category whose copy quotes a peak needs that peak to be an observation on the
  // frozen contract, not the running maximum the summary happened to accumulate.
  if (MFE_CATEGORIES.has(category) && identity.maxReturnReproducibleOnFrozen === false) {
    return fail(
      `stated peak is not supported by marks on ${identity.frozenOptionSymbol}`,
      "CONTENT_PERFORMANCE_UNVERIFIED",
      identityExtra,
    );
  }

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
    ...identityExtra,
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
    case "CONTENT_PERFORMANCE_UNVERIFIED":
      return "Performance unverified — trade identity could not be proven on one contract";
  }
}
