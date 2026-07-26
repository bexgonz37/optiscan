/**
 * Milestone Discord eligibility — prevents historical case spam after deploy.
 */
type EligDb = {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown };
};

function hasTable(db: EligDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

let defaultEligibleAfterMs: number | null = null;

export function milestoneEligibleAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.OPTIONS_MILESTONE_ELIGIBLE_AFTER_MS ?? "").trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (defaultEligibleAfterMs == null) defaultEligibleAfterMs = Date.now();
  return defaultEligibleAfterMs;
}

export function resetMilestoneEligibleDefaultForTests(ms: number | null): void {
  defaultEligibleAfterMs = ms;
}

export function isMilestoneDiscordEligibleOnDb(
  db: EligDb,
  input: {
    alertId?: string | null;
    opportunityCaseId?: string | null;
    paperKind?: string | null;
    nowMs?: number;
  },
  env: NodeJS.ProcessEnv = process.env,
): { eligible: boolean; reason: string | null } {
  if (env.OPTIONS_MILESTONE_DISCORD_ENABLED === "0") {
    return { eligible: false, reason: "milestone_discord_disabled" };
  }
  if (input.paperKind && input.paperKind !== "DELIVERED_ALERT_PAPER") {
    return { eligible: false, reason: "not_delivered_alert_paper" };
  }
  const cutoff = milestoneEligibleAfterMs(env);
  const nowMs = input.nowMs ?? Date.now();

  if (input.alertId && hasTable(db, "options_alerts")) {
    const alert = db.prepare("SELECT state, paper_linked, discord_message_id, sent_at_ms, research_only FROM options_alerts WHERE alert_id=?")
      .get(input.alertId) as {
      state?: string;
      paper_linked?: number;
      discord_message_id?: string | null;
      sent_at_ms?: number | null;
      research_only?: number;
    } | undefined;
    if (!alert || alert.state !== "SENT" || Number(alert.research_only) === 1) {
      return { eligible: false, reason: "alert_not_sent_delivered" };
    }
    if (Number(alert.paper_linked) !== 1) {
      return { eligible: false, reason: "paper_not_linked" };
    }
    if (!alert.discord_message_id) {
      return { eligible: false, reason: "missing_opening_discord_message_id" };
    }
    const sentAt = Number(alert.sent_at_ms ?? 0);
    if (sentAt < cutoff) return { eligible: false, reason: "historical_alert_before_cutoff" };
  }

  if (input.opportunityCaseId && hasTable(db, "opportunity_cases")) {
    const oc = db.prepare(
      "SELECT detected_at_ms, opening_delivered_at_ms, delivery_decision, source_path FROM opportunity_cases WHERE opportunity_id=?",
    ).get(input.opportunityCaseId) as {
      detected_at_ms?: number;
      opening_delivered_at_ms?: number | null;
      delivery_decision?: string;
      source_path?: string;
    } | undefined;
    if (!oc) return { eligible: false, reason: "case_not_found" };
    if (oc.delivery_decision !== "DELIVERED") {
      return { eligible: false, reason: "case_not_delivered" };
    }
    const openedAt = Number(oc.opening_delivered_at_ms ?? oc.detected_at_ms ?? 0);
    if (openedAt < cutoff) return { eligible: false, reason: "historical_case_before_cutoff" };
    if (oc.source_path === "shadow" || oc.source_path === "research_only") {
      return { eligible: false, reason: "non_live_source_path" };
    }
  }

  return { eligible: true, reason: null };
}
