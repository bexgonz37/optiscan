/**
 * asymmetry-budget.ts — strict cost controls for the ONLY AI call the
 * High-Asymmetry system makes.
 *
 * THE DETERMINISTIC SYSTEM DOES NOT DEPEND ON THIS FILE. Capture, state
 * transitions, paper entry, marks, exits, grading, and the Quant review all run
 * to completion with this module absent, disabled, over budget, or throwing.
 * The only thing any failure here can remove is an optional prose paragraph.
 *
 * The shape of the spend is the point:
 *
 *   ONE call per trading session, maximum. Not one per candidate, quote, mark,
 *   transition, or paper-trade update — those are all deterministic and never
 *   reach a model. A session with 400 candidates costs exactly the same as a
 *   session with 4.
 *
 *   CACHED by (trading date, review version). A redeploy, a duplicate hourly
 *   tick, or a manual re-run reuses the stored summary and spends nothing.
 *
 *   BOUNDED by configurable daily and monthly limits. At the limit the status
 *   is AI_BUDGET_BLOCKED and deterministic processing continues untouched.
 *
 * Nothing here buys credits, enables auto-reload, or raises its own limit.
 */

type BudgetDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
  exec: (sql: string) => unknown;
};

export const AI_ENABLED_ENV = "HIGH_ASYMMETRY_AI_ENABLED";

export type AiBudgetStatus =
  | "ALLOWED"
  | "AI_BUDGET_BLOCKED"
  | "AI_DISABLED"
  | "CACHED";

export interface AiBudgetConfig {
  enabled: boolean;
  /** Calls permitted per trading session. One is the intended value. */
  dailyLimit: number;
  monthlyLimit: number;
  /** ESTIMATED prices, configurable. Used for reporting only — never billing. */
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export const DEFAULT_AI_BUDGET: Readonly<AiBudgetConfig> = Object.freeze({
  enabled: true,
  dailyLimit: 1,
  monthlyLimit: 25,
  inputUsdPerMillionTokens: 3,
  outputUsdPerMillionTokens: 15,
});

export function resolveAiBudgetConfig(env: NodeJS.ProcessEnv = process.env): AiBudgetConfig {
  const n = (raw: string | undefined, dflt: number, lo: number, hi: number): number => {
    const x = Number(raw);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
  };
  return {
    // Explicitly "0" disables. An unset variable keeps the documented default.
    enabled: env[AI_ENABLED_ENV] === undefined ? DEFAULT_AI_BUDGET.enabled : env[AI_ENABLED_ENV] === "1",
    dailyLimit: Math.floor(n(env.HIGH_ASYMMETRY_AI_DAILY_LIMIT, DEFAULT_AI_BUDGET.dailyLimit, 0, 20)),
    monthlyLimit: Math.floor(n(env.HIGH_ASYMMETRY_AI_MONTHLY_LIMIT, DEFAULT_AI_BUDGET.monthlyLimit, 0, 500)),
    inputUsdPerMillionTokens: n(env.HIGH_ASYMMETRY_AI_INPUT_USD_PER_MTOK, DEFAULT_AI_BUDGET.inputUsdPerMillionTokens, 0, 1000),
    outputUsdPerMillionTokens: n(env.HIGH_ASYMMETRY_AI_OUTPUT_USD_PER_MTOK, DEFAULT_AI_BUDGET.outputUsdPerMillionTokens, 0, 1000),
  };
}

/** Idempotent, additive schema. Safe to call on every access. */
export function ensureAiBudgetSchema(db: BudgetDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS asymmetry_ai_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_date TEXT NOT NULL,
      month_key TEXT NOT NULL,
      review_version TEXT NOT NULL,
      called_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      est_input_tokens INTEGER NOT NULL DEFAULT 0,
      est_output_tokens INTEGER NOT NULL DEFAULT 0,
      est_cost_usd REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_asym_ai_ledger_day ON asymmetry_ai_ledger(session_date);
    CREATE INDEX IF NOT EXISTS idx_asym_ai_ledger_month ON asymmetry_ai_ledger(month_key);

    CREATE TABLE IF NOT EXISTS asymmetry_ai_cache (
      session_date TEXT NOT NULL,
      review_version TEXT NOT NULL,
      built_at_ms INTEGER NOT NULL,
      summary TEXT NOT NULL,
      PRIMARY KEY (session_date, review_version)
    );
  `);
}

/** YYYY-MM from a trading date. Used as the monthly bucket. */
export function monthKey(sessionDate: string): string {
  return String(sessionDate).slice(0, 7);
}

export interface AiBudgetUsage {
  callsToday: number;
  callsThisMonth: number;
  estTokensThisMonth: number;
  estCostUsdThisMonth: number;
  remainingToday: number;
  remainingThisMonth: number;
  dailyLimit: number;
  monthlyLimit: number;
}

/** Current usage against the configured limits. Read-only; never throws. */
export function readAiBudgetUsage(db: BudgetDb, sessionDate: string, cfg: AiBudgetConfig = resolveAiBudgetConfig()): AiBudgetUsage {
  const empty: AiBudgetUsage = {
    callsToday: 0, callsThisMonth: 0, estTokensThisMonth: 0, estCostUsdThisMonth: 0,
    remainingToday: cfg.dailyLimit, remainingThisMonth: cfg.monthlyLimit,
    dailyLimit: cfg.dailyLimit, monthlyLimit: cfg.monthlyLimit,
  };
  try {
    // Only calls that actually reached the model count against the budget.
    const day = db.prepare(
      "SELECT COUNT(*) n FROM asymmetry_ai_ledger WHERE session_date=? AND status='CALLED'",
    ).get(sessionDate) as any;
    const month = db.prepare(`
      SELECT COUNT(*) n, COALESCE(SUM(est_input_tokens + est_output_tokens),0) t, COALESCE(SUM(est_cost_usd),0) c
        FROM asymmetry_ai_ledger WHERE month_key=? AND status='CALLED'
    `).get(monthKey(sessionDate)) as any;
    const callsToday = Number(day?.n ?? 0);
    const callsThisMonth = Number(month?.n ?? 0);
    return {
      callsToday,
      callsThisMonth,
      estTokensThisMonth: Number(month?.t ?? 0),
      estCostUsdThisMonth: round4(Number(month?.c ?? 0)),
      remainingToday: Math.max(0, cfg.dailyLimit - callsToday),
      remainingThisMonth: Math.max(0, cfg.monthlyLimit - callsThisMonth),
      dailyLimit: cfg.dailyLimit,
      monthlyLimit: cfg.monthlyLimit,
    };
  } catch {
    return empty;
  }
}

export interface AiBudgetDecision {
  status: AiBudgetStatus;
  reason: string | null;
  /** A previously stored summary for this exact (date, version). */
  cachedSummary: string | null;
  usage: AiBudgetUsage;
}

/**
 * May the one advisory call be made?
 *
 * Order matters: DISABLED, then CACHE, then budget. Checking the cache before
 * the budget is deliberate — reusing a stored summary costs nothing, so a
 * session that is over budget should still be able to return the answer it
 * already paid for.
 */
export function checkAiBudget(
  db: BudgetDb,
  sessionDate: string,
  reviewVersion: string,
  cfg: AiBudgetConfig = resolveAiBudgetConfig(),
): AiBudgetDecision {
  let usage = { ...DEFAULT_USAGE, dailyLimit: cfg.dailyLimit, monthlyLimit: cfg.monthlyLimit,
    remainingToday: cfg.dailyLimit, remainingThisMonth: cfg.monthlyLimit };
  try {
    ensureAiBudgetSchema(db);
    usage = readAiBudgetUsage(db, sessionDate, cfg);

    if (!cfg.enabled) {
      return { status: "AI_DISABLED", reason: `${AI_ENABLED_ENV} is not enabled`, cachedSummary: null, usage };
    }
    const cached = readAiCache(db, sessionDate, reviewVersion);
    if (cached != null) {
      return { status: "CACHED", reason: "a summary already exists for this date and review version", cachedSummary: cached, usage };
    }
    if (usage.remainingToday <= 0) {
      return {
        status: "AI_BUDGET_BLOCKED",
        reason: `daily limit reached (${usage.callsToday}/${cfg.dailyLimit})`,
        cachedSummary: null, usage,
      };
    }
    if (usage.remainingThisMonth <= 0) {
      return {
        status: "AI_BUDGET_BLOCKED",
        reason: `monthly limit reached (${usage.callsThisMonth}/${cfg.monthlyLimit})`,
        cachedSummary: null, usage,
      };
    }
    return { status: "ALLOWED", reason: null, cachedSummary: null, usage };
  } catch (err: any) {
    // A budget-check fault must not spend money and must not block anything.
    return {
      status: "AI_BUDGET_BLOCKED",
      reason: `budget check unavailable: ${String(err?.message ?? err)}`,
      cachedSummary: null, usage,
    };
  }
}

export function readAiCache(db: BudgetDb, sessionDate: string, reviewVersion: string): string | null {
  try {
    const row = db.prepare(
      "SELECT summary FROM asymmetry_ai_cache WHERE session_date=? AND review_version=?",
    ).get(sessionDate, reviewVersion) as any;
    return row?.summary == null ? null : String(row.summary);
  } catch {
    return null;
  }
}

export function writeAiCache(db: BudgetDb, i: {
  sessionDate: string; reviewVersion: string; summary: string; nowMs: number;
}): boolean {
  try {
    ensureAiBudgetSchema(db);
    db.prepare(`
      INSERT INTO asymmetry_ai_cache (session_date, review_version, built_at_ms, summary)
      VALUES (?,?,?,?)
      ON CONFLICT(session_date, review_version) DO UPDATE SET
        built_at_ms=excluded.built_at_ms, summary=excluded.summary
    `).run(i.sessionDate, i.reviewVersion, i.nowMs, i.summary);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record one budget event. `status` is CALLED only when a request actually
 * reached the model — blocked, cached, and failed events are recorded for
 * visibility but do not consume budget.
 */
export function recordAiCallOnDb(db: BudgetDb, i: {
  sessionDate: string; reviewVersion: string; nowMs: number;
  status: "CALLED" | "BLOCKED" | "CACHED" | "FAILED" | "DISABLED";
  estInputTokens?: number; estOutputTokens?: number;
  cfg?: AiBudgetConfig;
}): boolean {
  try {
    ensureAiBudgetSchema(db);
    const cfg = i.cfg ?? resolveAiBudgetConfig();
    const inTok = Math.max(0, Math.round(i.estInputTokens ?? 0));
    const outTok = Math.max(0, Math.round(i.estOutputTokens ?? 0));
    const cost = i.status === "CALLED"
      ? round4((inTok / 1_000_000) * cfg.inputUsdPerMillionTokens + (outTok / 1_000_000) * cfg.outputUsdPerMillionTokens)
      : 0;
    db.prepare(`
      INSERT INTO asymmetry_ai_ledger
        (session_date, month_key, review_version, called_at_ms, status, est_input_tokens, est_output_tokens, est_cost_usd)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(i.sessionDate, monthKey(i.sessionDate), i.reviewVersion, i.nowMs, i.status, inTok, outTok, cost);
    return true;
  } catch {
    return false;
  }
}

/**
 * Token estimate from character count. Deliberately a rough 4-chars-per-token
 * heuristic and labelled ESTIMATED everywhere it surfaces: the provider does
 * not return usage through the advisory layer, and inventing a precise-looking
 * number would be worse than an openly approximate one.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(String(text ?? "").length / 4);
}

const DEFAULT_USAGE: AiBudgetUsage = {
  callsToday: 0, callsThisMonth: 0, estTokensThisMonth: 0, estCostUsdThisMonth: 0,
  remainingToday: 0, remainingThisMonth: 0, dailyLimit: 0, monthlyLimit: 0,
};
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
