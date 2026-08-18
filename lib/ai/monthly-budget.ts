/**
 * ai/monthly-budget.ts — the ONE authority on how much OptiScan's runtime AI has
 * spent this calendar month, and whether the next call may be made.
 *
 * WHY THIS EXISTS
 *
 * There were two AI cost ledgers and neither knew about the other. `ai_job_runs`
 * recorded the nightly/weekly/research jobs against a dollar limit;
 * `asymmetry_ai_ledger` recorded the High-Asymmetry review against a CALL-COUNT
 * limit (25/month) and contributed nothing to the dollar figure. Two more paths —
 * Ask OptiScan (`ai/advisory-chat.ts`) and the social recap rewriter
 * (`research/social/weekly-recap-ai.ts`) — called the provider with no ledger and
 * no gate at all, on the Sonnet-tier model.
 *
 * Every one of those surfaces reported a budget that was "enforced". The number
 * they reported was simply not the number being spent. Measured in production on
 * 2026-08-18: ai_job_runs said $1.0195 for 2026-08, the asymmetry ledger held
 * another $0.2005, and the two uncounted paths held an unknown amount — three
 * different answers to one question, none of them the total.
 *
 * So spend is read as a SUM ACROSS LEDGERS, and the gate is applied at the single
 * provider chokepoint rather than at each call site, because a call site that
 * forgets to check is exactly the defect this module exists to make impossible.
 *
 * FAIL-CLOSED. If the primary ledger cannot be read, we cannot prove we are under
 * the cap, so the answer is BUDGET_EXHAUSTED. A budget check that fails open is
 * not a budget.
 *
 * WHAT THIS MODULE MAY NEVER DO: raise a cap, buy credits, or gate anything
 * deterministic. Scanner, callouts, paper/shadow tracking, milestones, grading,
 * probabilities, experiment scoreboards and Discord trading alerts do not read
 * this file and must keep running with it exhausted, absent, or throwing.
 *
 * *OnDb cores take a handle so the pure test path never imports server SQLite.
 */
import { AI_MONTHLY_HARD_CAP_USD, type AiConfig } from "./config.ts";
import { monthKey, type DbLike } from "./store.ts";

export { AI_MONTHLY_HARD_CAP_USD };

/** Status recorded against a call the budget refused. Persisted verbatim. */
export const BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED";

/**
 * A ledger this module sums. `required` ledgers are part of the core schema — a read
 * failure there is a fault and fails closed. An optional ledger is created lazily by
 * the subsystem that owns it, so "no such table" honestly means "nothing spent".
 */
interface LedgerSource {
  id: string;
  sql: string;
  required: boolean;
  /** Human note for the diagnostic surface, so an absent ledger is never a silent zero. */
  owner: string;
}

const LEDGERS: readonly LedgerSource[] = Object.freeze([
  {
    id: "ai_job_runs",
    owner: "nightly / weekly / research analysis / metered explanation / content wording",
    required: true,
    sql: "SELECT COALESCE(SUM(estimated_cost_usd),0) AS s FROM ai_job_runs WHERE month_key=?",
  },
  {
    id: "asymmetry_ai_ledger",
    owner: "High-Asymmetry session review (one call per session)",
    required: false,
    sql: "SELECT COALESCE(SUM(est_cost_usd),0) AS s FROM asymmetry_ai_ledger WHERE month_key=? AND status='CALLED'",
  },
]);

export interface CombinedMonthlySpend {
  monthKey: string;
  /** Sum across every ledger that answered. */
  totalUsd: number;
  byLedger: Record<string, number>;
  /** Ledgers that could not be read. A REQUIRED entry here means the total is unproven. */
  unavailable: Array<{ id: string; required: boolean; reason: string }>;
  /** False when a required ledger did not answer — the total may understate real spend. */
  complete: boolean;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Combined estimated USD spend for a month, across every AI ledger.
 *
 * Both failed and successful provider attempts count: a call that burned input tokens
 * and then failed validation cost real money, and 11 of 31 recorded August runs were
 * VALIDATION_FAILED. Excluding them would have under-reported the month by exactly the
 * spend that most needs watching.
 */
export function combinedMonthlySpendUsdOnDb(db: DbLike, mk: string = monthKey()): CombinedMonthlySpend {
  const byLedger: Record<string, number> = {};
  const unavailable: CombinedMonthlySpend["unavailable"] = [];
  let totalUsd = 0;
  let complete = true;

  for (const ledger of LEDGERS) {
    try {
      const row = db.prepare(ledger.sql).get(mk) as any;
      const usd = Math.max(0, Number(row?.s ?? 0) || 0);
      byLedger[ledger.id] = round6(usd);
      totalUsd += usd;
    } catch (err: any) {
      unavailable.push({ id: ledger.id, required: ledger.required, reason: String(err?.message ?? err).slice(0, 200) });
      if (ledger.required) complete = false;
    }
  }

  return { monthKey: mk, totalUsd: round6(totalUsd), byLedger, unavailable, complete };
}

export type BudgetGateStatus = "ALLOWED" | typeof BUDGET_EXHAUSTED;

export interface CombinedBudgetGate {
  allowed: boolean;
  status: BudgetGateStatus;
  /** Why a call was refused. Null when allowed. */
  reason: string | null;
  monthKey: string;
  /** Combined spend already recorded this month. */
  spendUsd: number;
  /** The most the call being considered could cost, reserved before it is made. */
  reserveUsd: number;
  projectedUsd: number;
  /** Effective limit: the configured hard limit, never above the absolute cap. */
  hardLimitUsd: number;
  /** The ceiling no configuration can raise. */
  absoluteCapUsd: number;
  softLimitUsd: number;
  atSoftLimit: boolean;
  remainingUsd: number;
  byLedger: Record<string, number>;
  spendComplete: boolean;
}

/**
 * May the next AI call be made?
 *
 * TRUE PRE-FLIGHT. `reserveUsd` is the MAXIMUM the pending call could cost given its token
 * ceilings (see `maxJobCostUsd`), so the call is refused BEFORE it can carry the month past
 * the cap — never after. A post-hoc "already over" check permits exactly one call over the
 * limit, and one Sonnet call with a 60k-token context is not a rounding error.
 *
 * A hard limit of 0 means no AI spend is permitted at all, and is a legitimate configuration.
 */
export function combinedCostGateOnDb(
  db: DbLike,
  cfg: AiConfig,
  nowMs: number = Date.now(),
  reserveUsd: number = 0,
): CombinedBudgetGate {
  const mk = monthKey(nowMs);
  const spend = combinedMonthlySpendUsdOnDb(db, mk);
  const hardLimitUsd = Math.min(Number(cfg.monthlyHardLimitUsd ?? AI_MONTHLY_HARD_CAP_USD), AI_MONTHLY_HARD_CAP_USD);
  const softLimitUsd = Math.min(Number(cfg.monthlySoftLimitUsd ?? hardLimitUsd), hardLimitUsd);
  const reserve = Math.max(0, Number(reserveUsd) || 0);
  const projectedUsd = round6(spend.totalUsd + reserve);

  // A required ledger that would not answer means spend is UNPROVEN, not zero.
  if (!spend.complete) {
    return {
      allowed: false,
      status: BUDGET_EXHAUSTED,
      reason:
        "combined AI spend could not be read (" +
        spend.unavailable.filter((u) => u.required).map((u) => u.id).join(", ") +
        "), so staying under the cap cannot be proven",
      monthKey: mk,
      spendUsd: spend.totalUsd,
      reserveUsd: reserve,
      projectedUsd,
      hardLimitUsd,
      absoluteCapUsd: AI_MONTHLY_HARD_CAP_USD,
      softLimitUsd,
      atSoftLimit: true,
      remainingUsd: 0,
      byLedger: spend.byLedger,
      spendComplete: false,
    };
  }

  // `>=` and not `>`: reaching the limit exhausts it. With reserve 0 this is the
  // read-only "are we already out" question; with a reservation it is the pre-flight one.
  // A hard limit of 0 therefore blocks everything, which is the intended meaning of 0.
  const blocked = projectedUsd >= hardLimitUsd;

  return {
    allowed: !blocked,
    status: blocked ? BUDGET_EXHAUSTED : "ALLOWED",
    reason: blocked
      ? `monthly AI budget exhausted: $${spend.totalUsd.toFixed(4)} spent + $${reserve.toFixed(4)} reserved ` +
        `would reach the $${hardLimitUsd.toFixed(2)} hard limit for ${mk}`
      : null,
    monthKey: mk,
    spendUsd: spend.totalUsd,
    reserveUsd: reserve,
    projectedUsd,
    hardLimitUsd,
    absoluteCapUsd: AI_MONTHLY_HARD_CAP_USD,
    softLimitUsd,
    atSoftLimit: spend.totalUsd >= softLimitUsd,
    remainingUsd: round6(Math.max(0, hardLimitUsd - spend.totalUsd)),
    byLedger: spend.byLedger,
    spendComplete: true,
  };
}

/**
 * The owner-facing budget report. Deliberately states what the budget does NOT gate,
 * because the question this answers in practice is "did the research stop because the
 * money ran out" — and the answer must always be no.
 */
export interface AiBudgetReport extends CombinedBudgetGate {
  /** What keeps running with the budget exhausted. */
  unaffectedByBudget: readonly string[];
  note: string;
}

export const DETERMINISTIC_REGARDLESS_OF_BUDGET: readonly string[] = Object.freeze([
  "live options scanner",
  "owner callouts / Discord trading alerts",
  "paper + shadow tracking",
  "lifecycle milestones and grading",
  "deterministic nightly + weekly research",
  "probabilities and statistics",
  "experiment scoreboards",
  "deterministic content templates",
]);

export function aiBudgetReportOnDb(db: DbLike, cfg: AiConfig, nowMs: number = Date.now()): AiBudgetReport {
  const gate = combinedCostGateOnDb(db, cfg, nowMs, 0);
  return {
    ...gate,
    unaffectedByBudget: DETERMINISTIC_REGARDLESS_OF_BUDGET,
    note:
      "Combined across every AI ledger. When exhausted, AI narration and proposals record " +
      `${BUDGET_EXHAUSTED} and skip; no trading or research statistic depends on model availability.`,
  };
}
