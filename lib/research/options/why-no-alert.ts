/**
 * Deterministic "Why didn't this ticker alert?" explanation.
 * Reads candidates, delivery decisions, suppressions, and active Opportunity Cases.
 */
import {
  findActiveOpportunityByFingerprintOnDb,
  loadCaseJsonOnDb,
  recentSuppressionsOnDb,
} from "../../opportunity-case/live.ts";
import { buildOpportunityIdentity, opportunityFingerprint } from "../../opportunity-case/identity.ts";

interface WhyDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
  };
}

function hasTable(db: WhyDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

export interface RuleCheck {
  rule: string;
  passed: boolean;
  detail: string;
  threshold?: number | null;
  observed?: number | null;
}

export interface TickerAlertExplanation {
  symbol: string;
  generatedAtMs: number;
  decision: "ALERTED" | "SUPPRESSED_DUPLICATE" | "REJECTED" | "NOT_OBSERVED" | "READY_NOT_DELIVERED";
  summary: string;
  strategyEvaluated: string | null;
  rulesPassed: RuleCheck[];
  rulesFailed: RuleCheck[];
  closestThresholdMissed: { rule: string; observed: number | null; threshold: number | null; gap: number | null } | null;
  suppressedAsDuplicate: boolean;
  activeOpportunity: {
    opportunityCaseId: string;
    fingerprint: string;
    lifecycleStatus: string;
    latestReturnPercent: number | null;
    nextUndeliveredMilestone: number | null;
  } | null;
  recentCandidate: Record<string, unknown> | null;
  recentDeliveryDecision: Record<string, unknown> | null;
  recentSuppression: Record<string, unknown> | null;
}

export function explainTickerAlertDecision(
  db: WhyDb | null,
  symbol: string,
  nowMs = Date.now(),
  lookbackMs = 86_400_000,
): TickerAlertExplanation {
  const sym = symbol.toUpperCase();
  const base: TickerAlertExplanation = {
    symbol: sym,
    generatedAtMs: nowMs,
    decision: "NOT_OBSERVED",
    summary: `No recent options candidates for ${sym}`,
    strategyEvaluated: null,
    rulesPassed: [],
    rulesFailed: [],
    closestThresholdMissed: null,
    suppressedAsDuplicate: false,
    activeOpportunity: null,
    recentCandidate: null,
    recentDeliveryDecision: null,
    recentSuppression: null,
  };
  if (!db) return base;
  const since = nowMs - lookbackMs;

  let cand: any = null;
  if (hasTable(db, "options_candidates")) {
    cand = db.prepare(
      `SELECT symbol, selected_strategy, direction, side, score, state, why, option_symbol, research_only, created_at_ms
       FROM options_candidates WHERE symbol=? AND created_at_ms >= ? ORDER BY created_at_ms DESC LIMIT 1`,
    ).get(sym, since);
  }
  if (!cand) return base;
  base.recentCandidate = { ...cand };
  base.strategyEvaluated = cand.selected_strategy ?? null;

  const rulesPassed: RuleCheck[] = [];
  const rulesFailed: RuleCheck[] = [];
  if (cand.state === "READY") rulesPassed.push({ rule: "callout_ready", passed: true, detail: "Candidate reached READY" });
  else rulesFailed.push({ rule: "callout_ready", passed: false, detail: String(cand.why ?? cand.state ?? "rejected") });
  if (Number(cand.research_only) === 1) {
    rulesFailed.push({ rule: "actionable_side", passed: false, detail: "Candidate is marked research-only" });
  } else if (cand.side === "put") {
    rulesPassed.push({ rule: "actionable_side", passed: true, detail: "PUT direction is eligible when bearish authority and all delivery gates pass" });
  } else {
    rulesPassed.push({ rule: "actionable_side", passed: true, detail: "Call side actionable" });
  }

  let decisionRow: any = null;
  if (hasTable(db, "options_delivery_decisions")) {
    decisionRow = db.prepare(
      `SELECT symbol, strategy, outcome, reason, quality, threshold, final_delivery_outcome, final_delivery_reason, delivery_sent, created_at_ms
       FROM options_delivery_decisions WHERE symbol=? AND created_at_ms >= ? ORDER BY created_at_ms DESC LIMIT 1`,
    ).get(sym, since);
  }
  if (decisionRow) {
    base.recentDeliveryDecision = { ...decisionRow };
    if (decisionRow.quality != null && decisionRow.threshold != null) {
      const q = Number(decisionRow.quality);
      const t = Number(decisionRow.threshold);
      const check: RuleCheck = {
        rule: "subscriber_quality_bar",
        passed: q >= t,
        detail: `quality ${q} vs bar ${t}`,
        threshold: t,
        observed: q,
      };
      (check.passed ? rulesPassed : rulesFailed).push(check);
      if (!check.passed) {
        base.closestThresholdMissed = { rule: "subscriber_quality_bar", observed: q, threshold: t, gap: +(t - q).toFixed(4) };
      }
    }
    if (String(decisionRow.final_delivery_reason ?? "").includes("duplicate")
      || String(decisionRow.reason ?? "").includes("duplicate")
      || String(decisionRow.final_delivery_reason ?? "") === "matching_active_opportunity") {
      base.suppressedAsDuplicate = true;
    }
    if (Number(decisionRow.delivery_sent) === 1 || decisionRow.final_delivery_outcome === "DELIVERED") {
      base.decision = "ALERTED";
      base.summary = `${sym} delivered via ${decisionRow.strategy}`;
    } else if (base.suppressedAsDuplicate) {
      base.decision = "SUPPRESSED_DUPLICATE";
      base.summary = `${sym} suppressed as duplicate of an active opportunity`;
    } else if (cand.state === "READY") {
      base.decision = "READY_NOT_DELIVERED";
      base.summary = `${sym} was READY but not delivered: ${decisionRow.final_delivery_reason ?? decisionRow.reason}`;
    } else {
      base.decision = "REJECTED";
      base.summary = `${sym} rejected: ${cand.why ?? decisionRow.reason}`;
    }
  } else if (cand.state === "READY") {
    base.decision = "READY_NOT_DELIVERED";
    base.summary = `${sym} READY with no delivery-decision row in lookback`;
  } else {
    base.decision = "REJECTED";
    base.summary = `${sym} did not reach READY: ${cand.why ?? cand.state}`;
  }

  const suppressions = recentSuppressionsOnDb(db as any, 50).filter((s) => String(s.symbol).toUpperCase() === sym);
  if (suppressions[0]) {
    base.recentSuppression = suppressions[0];
    base.suppressedAsDuplicate = true;
    if (base.decision !== "ALERTED") {
      base.decision = "SUPPRESSED_DUPLICATE";
      base.summary = `${sym} suppressed: ${suppressions[0].reason}`;
    }
  }

  // Active opportunity lookup when we know enough contract fields from the latest alert/candidate.
  try {
    let strike: number | null = null;
    let expiration: string | null = null;
    let side: "call" | "put" = cand.side === "put" ? "put" : "call";
    let strategy = String(cand.selected_strategy ?? "");
    if (hasTable(db, "options_alerts")) {
      const a = db.prepare(
        `SELECT strategy, side, option_symbol, opportunity_case_id, opportunity_fingerprint, state
         FROM options_alerts WHERE candidate_symbol=? ORDER BY created_at_ms DESC LIMIT 1`,
      ).get(sym) as any;
      if (a?.opportunity_case_id) {
        const oc = loadCaseJsonOnDb(db as any, String(a.opportunity_case_id));
        if (oc?.summary) {
          base.activeOpportunity = {
            opportunityCaseId: String(a.opportunity_case_id),
            fingerprint: String(a.opportunity_fingerprint ?? oc.opportunityFingerprint ?? ""),
            lifecycleStatus: String(oc.lifecycleStatus ?? oc.summary.currentStatus),
            latestReturnPercent: oc.summary.currentReturnPct,
            nextUndeliveredMilestone: oc.summary.nextUndeliveredReturnMilestone,
          };
        }
      }
      if (a?.strategy) strategy = String(a.strategy);
      if (a?.side) side = a.side === "put" ? "put" : "call";
    }
    // Best-effort fingerprint from candidate option symbol is not always parseable; skip if incomplete.
    if (!base.activeOpportunity && strategy && hasTable(db, "opportunity_active_index")) {
      const act = db.prepare(
        `SELECT opportunity_case_id, opportunity_fingerprint, lifecycle_status FROM opportunity_active_index WHERE symbol=? ORDER BY opened_at_ms DESC LIMIT 1`,
      ).get(sym) as any;
      if (act?.opportunity_case_id) {
        const oc = loadCaseJsonOnDb(db as any, String(act.opportunity_case_id));
        base.activeOpportunity = {
          opportunityCaseId: String(act.opportunity_case_id),
          fingerprint: String(act.opportunity_fingerprint ?? ""),
          lifecycleStatus: String(act.lifecycle_status),
          latestReturnPercent: oc?.summary?.currentReturnPct ?? null,
          nextUndeliveredMilestone: oc?.summary?.nextUndeliveredReturnMilestone ?? null,
        };
        if (base.decision !== "ALERTED") {
          base.suppressedAsDuplicate = true;
          base.decision = "SUPPRESSED_DUPLICATE";
          base.summary = `${sym} has an active Opportunity Case (${base.activeOpportunity.lifecycleStatus})`;
        }
      }
    }
    void strike; void expiration; void findActiveOpportunityByFingerprintOnDb; void opportunityFingerprint; void buildOpportunityIdentity; void side;
  } catch { /* isolated */ }

  base.rulesPassed = rulesPassed;
  base.rulesFailed = rulesFailed;
  return base;
}
