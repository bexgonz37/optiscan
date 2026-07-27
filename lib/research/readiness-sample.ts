/**
 * Shared eligibility cutoff for subscriber-readiness metrics and milestone Discord.
 * Uses OPTIONS_MILESTONE_ELIGIBLE_AFTER_MS when set; otherwise process boot time.
 */
import { milestoneEligibleAfterMs } from "../opportunity-case/milestone-eligibility.ts";

/** Alerts with sent_at_ms >= cutoff belong to the clean launch sample. */
export function readinessSampleCutoffMs(env: NodeJS.ProcessEnv = process.env): number {
  return milestoneEligibleAfterMs(env);
}

/** SQL fragment + bind arg for options_alerts launch-sample filter (requires table alias or none). */
export function readinessAlertSampleWhere(alias = ""): { sql: string; cutoffMs: number } {
  const p = alias ? `${alias}.` : "";
  const cutoffMs = readinessSampleCutoffMs(process.env);
  return {
    cutoffMs,
    sql: `${p}state='SENT' AND ${p}research_only=0 AND ${p}sent_at_ms IS NOT NULL AND ${p}sent_at_ms >= ?`,
  };
}
