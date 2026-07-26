/**

 * Paid beta launch gate metrics — owner-only readiness checklist.

 */

import { subscriberDiscordOwnershipSummary } from "../subscriber-discord-owner.ts";

import { quotaPolicySnapshot } from "../quota-policy.ts";

import { subscriberOpsSummary, type BillingDb } from "../billing/subscribers-store.ts";



function hasTable(db: BillingDb, name: string): boolean {

  try {

    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

  } catch {

    return false;

  }

}



export interface PaidBetaReadinessReport {

  generatedAtMs: number;

  launchRecommended: boolean;

  blockers: string[];

  metrics: Record<string, number | boolean | string | null>;

  checklist: Array<{ id: string; label: string; passed: boolean; detail: string }>;

}



export function buildPaidBetaReadinessReport(db: BillingDb, env: NodeJS.ProcessEnv = process.env): PaidBetaReadinessReport {

  const blockers: string[] = [];

  const ownership = subscriberDiscordOwnershipSummary(env);

  const quota = quotaPolicySnapshot(env);

  const subs = subscriberOpsSummary(db);



  let deliveredSent = 0;

  let milestoneDelivered = 0;

  let ambiguousOpens = 0;

  let distinctTradingDays = 0;



  if (hasTable(db, "options_alerts")) {

    deliveredSent = Number(

      (db.prepare(`SELECT COUNT(*) n FROM options_alerts WHERE state='SENT'`).get() as { n: number })?.n ?? 0,

    );

    distinctTradingDays = Number(

      (db.prepare(`SELECT COUNT(DISTINCT date(sent_at_ms/1000,'unixepoch')) n FROM options_alerts WHERE state='SENT'`).get() as { n: number })?.n ?? 0,

    );

  }

  if (hasTable(db, "opportunity_milestones")) {

    milestoneDelivered = Number(

      (db.prepare(`SELECT COUNT(*) n FROM opportunity_milestones WHERE event_type='RETURN_MILESTONE' AND delivered_at_ms IS NOT NULL`).get() as { n: number })?.n ?? 0,

    );

  }

  if (hasTable(db, "discord_send_attempts")) {

    ambiguousOpens = Number(

      (db.prepare(`SELECT COUNT(*) n FROM discord_send_attempts WHERE ambiguous=1`).get() as { n: number })?.n ?? 0,

    );

  }

  let earlyTimelySent = 0;
  let lateChasedSent = 0;
  let sessionGuardBlocks = 0;
  if (hasTable(db, "options_alerts")) {
    earlyTimelySent = Number(
      (db.prepare(`SELECT COUNT(*) n FROM options_alerts WHERE state='SENT' AND entry_quality_verdict IN ('EARLY','TIMELY','ALLOW')`).get() as { n: number })?.n ?? 0,
    );
    lateChasedSent = Number(
      (db.prepare(`SELECT COUNT(*) n FROM options_alerts WHERE state='SENT' AND entry_quality_verdict IN ('LATE','CHASED')`).get() as { n: number })?.n ?? 0,
    );
  }
  if (hasTable(db, "options_shadow_decisions")) {
    sessionGuardBlocks = Number(
      (db.prepare(`SELECT COUNT(*) n FROM options_shadow_decisions WHERE would_send=0 AND reasons_json LIKE '%session guard%'`).get() as { n: number })?.n ?? 0,
    );
  }
  const earlyTimelyRate = deliveredSent > 0 ? earlyTimelySent / deliveredSent : null;
  const lateChasedRate = deliveredSent > 0 ? lateChasedSent / deliveredSent : null;



  const checklist = [

    {

      id: "ownership_independent",

      label: "Independent options owns subscriber Discord",

      passed: ownership.independentOwns && ownership.supervisorOptionsBlocked,

      detail: `owner=${ownership.owner}`,

    },

    {

      id: "token_configured",

      label: "SCAN_API_TOKEN configured in production",

      passed: Boolean(String(env.SCAN_API_TOKEN ?? "").trim()),

      detail: env.SCAN_API_TOKEN ? "set" : "missing",

    },

    {

      id: "delivered_sample",

      label: "≥ 20 delivered SENT alerts (soak target)",

      passed: deliveredSent >= 20,

      detail: `${deliveredSent}/20`,

    },

    {

      id: "milestone_sample",

      label: "≥ 5 milestone Discord updates",

      passed: milestoneDelivered >= 5,

      detail: `${milestoneDelivered}/5`,

    },

    {

      id: "trading_days",

      label: "≥ 10 distinct trading days with SENT alerts",

      passed: distinctTradingDays >= 10,

      detail: `${distinctTradingDays}/10`,

    },

    {

      id: "kill_switch_off",

      label: "OPTIONS_CALLOUTS_KILL is off",

      passed: env.OPTIONS_CALLOUTS_KILL !== "1",

      detail: env.OPTIONS_CALLOUTS_KILL === "1" ? "engaged" : "off",

    },

    {

      id: "quota_not_silent",

      label: "Quota policy exposes operator warnings",

      passed: Boolean(quota.operatorWarning) || quota.quotaMode === "ok",

      detail: quota.quotaMode ?? "unknown",

    },

    {

      id: "billing_configured",

      label: "Stripe billing env configured (when taking money)",

      passed: env.BILLING_ENABLED !== "1" || Boolean(String(env.STRIPE_SECRET_KEY ?? "").trim() && String(env.STRIPE_WEBHOOK_SECRET ?? "").trim()),

      detail: env.BILLING_ENABLED === "1" ? "billing on" : "billing off (pre-launch ok)",

    },

    {

      id: "early_timely_rate",

      label: "Early + Timely rate ≥ 50% of SENT alerts",

      passed: earlyTimelyRate == null ? false : earlyTimelyRate >= 0.5,

      detail: earlyTimelyRate == null ? "no SENT alerts" : `${Math.round(earlyTimelyRate * 100)}% (${earlyTimelySent}/${deliveredSent})`,

    },

    {

      id: "late_chased_rate",

      label: "Late + Chased rate ≤ 20% of SENT alerts",

      passed: lateChasedRate == null ? true : lateChasedRate <= 0.2,

      detail: lateChasedRate == null ? "no SENT alerts" : `${Math.round(lateChasedRate * 100)}% (${lateChasedSent}/${deliveredSent})`,

    },

    {

      id: "gates_configured",

      label: "Entry-quality + session guards configured for private path",

      passed: env.ENTRY_QUALITY_GATE != null && env.MARKET_SESSION_GUARD != null,

      detail: `entry=${env.ENTRY_QUALITY_GATE ?? "unset"}, session=${env.MARKET_SESSION_GUARD ?? "unset"}`,

    },

  ];



  for (const c of checklist) {

    if (!c.passed && ["ownership_independent", "token_configured", "kill_switch_off"].includes(c.id)) {

      blockers.push(`${c.label}: ${c.detail}`);

    }

  }



  const launchRecommended = blockers.length === 0 && deliveredSent >= 20 && milestoneDelivered >= 5 && distinctTradingDays >= 10;



  return {

    generatedAtMs: Date.now(),

    launchRecommended,

    blockers,

    metrics: {

      deliveredSent,

      milestoneDelivered,

      ambiguousOpens,

      distinctTradingDays,

      subscriberActive: subs.active,

      subscriberPastDue: subs.pastDue,

      roleSyncErrors24h: subs.recentRoleSyncErrors,

      discoveryPaused: quota.discoveryPaused,

      quotaMode: quota.quotaMode,

      earlyTimelySent,

      lateChasedSent,

      earlyTimelyRate,

      lateChasedRate,

      sessionGuardBlocks,

      entryQualityGate: env.ENTRY_QUALITY_GATE ?? null,

      marketSessionGuard: env.MARKET_SESSION_GUARD ?? null,

    },

    checklist,

  };

}

