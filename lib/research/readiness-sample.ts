/**
 * Subscriber-readiness launch sample — independent from milestone Discord eligibility.
 * Uses SUBSCRIBER_READINESS_ELIGIBLE_AFTER_MS (private-live remediation deploy timestamp).
 * Milestone cutoff (OPTIONS_MILESTONE_ELIGIBLE_AFTER_MS) is a separate concern.
 */
type SampleDb = {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
};

let defaultEligibleAfterMs: number | null = null;

export function resetReadinessEligibleDefaultForTests(ms: number | null): void {
  defaultEligibleAfterMs = ms;
}

/** Confirmed private-live remediation deploy timestamp (ms). */
export function readinessSampleCutoffMs(env: NodeJS.ProcessEnv = process.env): number {
  const dedicated = String(env.SUBSCRIBER_READINESS_ELIGIBLE_AFTER_MS ?? "").trim();
  if (dedicated) {
    const n = Number(dedicated);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Same remediation deploy timestamp already set for milestone spam prevention — use only when dedicated var unset.
  const milestoneFallback = String(env.OPTIONS_MILESTONE_ELIGIBLE_AFTER_MS ?? "").trim();
  if (milestoneFallback) {
    const n = Number(milestoneFallback);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (defaultEligibleAfterMs == null) defaultEligibleAfterMs = Date.now();
  return defaultEligibleAfterMs;
}

/** Which env var supplied the cutoff (for dashboard transparency). */
export function readinessSampleCutoffSource(env: NodeJS.ProcessEnv = process.env): string {
  const dedicated = String(env.SUBSCRIBER_READINESS_ELIGIBLE_AFTER_MS ?? "").trim();
  if (dedicated && Number.isFinite(Number(dedicated)) && Number(dedicated) > 0) {
    return "SUBSCRIBER_READINESS_ELIGIBLE_AFTER_MS";
  }
  const milestoneFallback = String(env.OPTIONS_MILESTONE_ELIGIBLE_AFTER_MS ?? "").trim();
  if (milestoneFallback && Number.isFinite(Number(milestoneFallback)) && Number(milestoneFallback) > 0) {
    return "OPTIONS_MILESTONE_ELIGIBLE_AFTER_MS_fallback";
  }
  return "process_boot_default";
}

/**
 * Strict eligibility for paid-readiness gates — one row per actual independent Discord delivery.
 * Historical pre-cutoff rows are excluded; research/shadow/replay paths are excluded.
 */
export function readinessEligibleAlertWhere(alias = "a"): { sql: string; cutoffMs: number } {
  const p = `${alias}.`;
  const cutoffMs = readinessSampleCutoffMs(process.env);
  const sql = [
    `${p}state='SENT'`,
    `${p}research_only=0`,
    `${p}sent_at_ms IS NOT NULL AND ${p}sent_at_ms >= ?`,
    `${p}created_at_ms >= ?`,
    `${p}discord_message_id IS NOT NULL AND TRIM(${p}discord_message_id) <> ''`,
    `${p}paper_linked=1`,
    `${p}opportunity_case_id IS NOT NULL`,
    `${p}entry_mid IS NOT NULL`,
    `EXISTS (SELECT 1 FROM options_paper_trades p WHERE p.alert_id=${p}alert_id AND p.paper_kind='DELIVERED_ALERT_PAPER')`,
    `(SELECT COUNT(*) FROM options_paper_trades p2 WHERE p2.alert_id=${p}alert_id AND p2.paper_kind='DELIVERED_ALERT_PAPER') = 1`,
    // Defense in depth: Aggressive 0DTE Research ledger must never enter readiness.
    `NOT EXISTS (SELECT 1 FROM options_paper_trades pz WHERE pz.alert_id=${p}alert_id AND pz.paper_kind='ZERO_DTE_RESEARCH_PAPER')`,
    `NOT EXISTS (SELECT 1 FROM opportunity_cases oc WHERE oc.opportunity_id=${p}opportunity_case_id AND oc.source_path IN ('shadow','research_only'))`,
  ].join(" AND ");
  return { sql, cutoffMs };
}

/** Bind args for readinessEligibleAlertWhere (sent_at_ms and created_at_ms both use cutoff). */
export function readinessEligibleArgs(cutoffMs: number): number[] {
  return [cutoffMs, cutoffMs];
}

/** Looser sent filter for historical audit comparisons only. */
export function readinessSentAlertWhere(alias = "a"): { sql: string; cutoffMs: number } {
  const p = `${alias}.`;
  const cutoffMs = readinessSampleCutoffMs(process.env);
  return {
    cutoffMs,
    sql: `${p}state='SENT' AND ${p}research_only=0 AND ${p}sent_at_ms IS NOT NULL AND ${p}sent_at_ms >= ?`,
  };
}

export interface DuplicateClassification {
  /** Extra SENT rows per fingerprint across all history (audit only). */
  fingerprintExtrasAllTime: number;
  /** Extra eligible rows per fingerprint post-cutoff (safety gate). */
  actualDuplicateDeliveriesPostCutoff: number;
  /** SENT rows post-cutoff lacking discord_message_id (pre-lifecycle / incomplete). */
  sentWithoutDiscordPostCutoff: number;
  /** Suppressed duplicate openings before delivery (runtime counter). */
  suppressedBeforeDelivery: number;
}

export interface PaperRowClassification {
  launchSampleUnhealthy: number;
  historicalUnhealthy: number;
  launchSampleHealthy: number;
  byCause: Record<string, number>;
}

export function classifyReadinessDuplicatesOnDb(db: SampleDb, env: NodeJS.ProcessEnv = process.env): DuplicateClassification {
  const cutoffMs = readinessSampleCutoffMs(env);
  const out: DuplicateClassification = {
    fingerprintExtrasAllTime: 0,
    actualDuplicateDeliveriesPostCutoff: 0,
    sentWithoutDiscordPostCutoff: 0,
    suppressedBeforeDelivery: 0,
  };
  try {
    out.fingerprintExtrasAllTime = Number((db.prepare(
      `SELECT COALESCE(SUM(dupes),0) n FROM (
         SELECT COUNT(*) - 1 AS dupes FROM options_alerts
          WHERE state='SENT' AND research_only=0
          GROUP BY COALESCE(opportunity_fingerprint, candidate_symbol || '|' || side || '|' || strategy || '|' || option_symbol)
         HAVING COUNT(*) > 1
       )`,
    ).get() as { n?: number })?.n ?? 0);
  } catch { /* optional */ }

  const { sql: eligSql } = readinessEligibleAlertWhere("a");
  try {
    out.actualDuplicateDeliveriesPostCutoff = Number((db.prepare(
      `SELECT COALESCE(SUM(dupes),0) n FROM (
         SELECT COUNT(*) - 1 AS dupes FROM options_alerts a WHERE ${eligSql}
          GROUP BY COALESCE(a.opportunity_fingerprint, a.candidate_symbol || '|' || a.side || '|' || a.strategy || '|' || a.option_symbol)
         HAVING COUNT(*) > 1
       )`,
    ).get(...readinessEligibleArgs(cutoffMs)) as { n?: number })?.n ?? 0);
  } catch { /* optional */ }

  try {
    out.sentWithoutDiscordPostCutoff = Number((db.prepare(
      `SELECT COUNT(*) n FROM options_alerts
        WHERE state='SENT' AND research_only=0 AND sent_at_ms >= ?
          AND (discord_message_id IS NULL OR TRIM(discord_message_id) = '')`,
    ).get(cutoffMs) as { n?: number })?.n ?? 0);
  } catch { /* optional */ }

  try {
    const row = db.prepare("SELECT value FROM options_runtime WHERE key='lifecycle.duplicateOpeningAlertsSuppressed'").get() as { value?: string } | undefined;
    const v = row?.value ? JSON.parse(row.value) : 0;
    out.suppressedBeforeDelivery = Number.isFinite(Number(v)) ? Number(v) : 0;
  } catch { /* optional */ }

  return out;
}

export function classifyHistoricalPaperRowsOnDb(db: SampleDb, env: NodeJS.ProcessEnv = process.env): PaperRowClassification {
  const cutoffMs = readinessSampleCutoffMs(env);
  const out: PaperRowClassification = {
    launchSampleUnhealthy: 0,
    historicalUnhealthy: 0,
    launchSampleHealthy: 0,
    byCause: {},
  };
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_alerts'").get()) return out;

  const bump = (k: string) => { out.byCause[k] = (out.byCause[k] ?? 0) + 1; };

  let rows: Record<string, unknown>[] = [];
  try {
    rows = db.prepare(
      `SELECT a.alert_id, a.sent_at_ms, a.discord_message_id, a.opportunity_case_id, a.paper_linked,
              p.id AS paper_id, p.status AS paper_status, p.paper_kind
         FROM options_alerts a
         LEFT JOIN options_paper_trades p ON p.alert_id = a.alert_id AND p.paper_kind = 'DELIVERED_ALERT_PAPER'
        WHERE a.state='SENT' AND a.research_only=0`,
    ).all() as Record<string, unknown>[];
  } catch { return out; }

  for (const r of rows) {
    const sentAt = Number(r.sent_at_ms ?? 0);
    const postCutoff = sentAt >= cutoffMs;
    let cause: string | null = null;
    if (Number(r.paper_linked) !== 1 || !r.paper_id) cause = "missing_mirror";
    else if (!r.opportunity_case_id) cause = "missing_case";
    else if (!r.discord_message_id) cause = "missing_discord_message_id";
    else if (r.paper_status === "ENTERED" && sentAt > 0 && Date.now() - sentAt > 48 * 3600_000) cause = "stuck_open";
    if (!cause) {
      if (postCutoff) out.launchSampleHealthy += 1;
      continue;
    }
    if (postCutoff) out.launchSampleUnhealthy += 1;
    else out.historicalUnhealthy += 1;
    bump(cause);
  }
  return out;
}
