/**
 * planner.ts — decide WHAT to ingest, in what order.
 *
 * The failure this exists to prevent is the obvious one: starting with "every contract
 * for every symbol for years" spends a month of provider budget on windows no study will
 * ever open, and produces a store that is enormous and useless.
 *
 * The plan is EVIDENCE-CENTRED. OptiScan already knows which moments mattered — it has
 * thousands of opportunity cases with exact timestamps, symbols and frozen OCCs. Those
 * are the windows where a historical answer changes a decision, so they are ingested
 * first, and everything else is explicitly later.
 *
 *   Priority 1  windows around real opportunity cases (the frozen OCC and its underlying)
 *   Priority 2  missed-opportunity timestamps
 *   Priority 3  index / high-liquidity symbols, for regime reconstruction
 *
 * Underlying context is deliberately allowed to be BROADER than option-contract
 * ingestion: bars are one request per symbol per month, while per-OCC NBBO is one
 * request per contract per window. Treating them as equally expensive would either
 * starve regime reconstruction or bankrupt the contract lane.
 *
 * Pure: reads the DB, issues no provider request, writes nothing.
 */
import type { StoreDb, Timeframe } from "./store.ts";

export const PLANNER_VERSION = "HIST_PLAN_V1" as const;

const MIN = 60_000;
const DAY = 86_400_000;

export interface OptionWindow {
  occ: string;
  underlying: string;
  fromMs: number;
  toMs: number;
  /** Why this window is worth its provider calls. */
  reason: string;
  priority: 1 | 2 | 3;
  /** The event instant the window is centred on. */
  anchorMs: number;
}

export interface UnderlyingWindow {
  symbol: string;
  timeframe: Timeframe;
  fromMs: number;
  toMs: number;
  reason: string;
  priority: 1 | 2 | 3;
}

export interface BackfillPlan {
  version: typeof PLANNER_VERSION;
  optionWindows: OptionWindow[];
  underlyingWindows: UnderlyingWindow[];
  contractReferenceTargets: Array<{ underlying: string; expirationFrom: string; expirationTo: string; priority: 1 | 2 | 3 }>;
  /** Upper bound on provider requests if the whole plan were executed. */
  estimatedRequests: number;
  note: string;
}

/**
 * How much time around an event is worth storing.
 *
 * PRE is long enough to reconstruct the setup as it formed — compression, volume
 * acceleration and session-to-date extremes all need bars from the open, not from five
 * minutes before the alert. POST is long enough for the milestones the winner engine
 * asks about to actually land.
 */
export const WINDOW_DEFAULTS = {
  preEventMs: 180 * MIN,
  postEventMs: 240 * MIN,
  /** Underlying bars: whole sessions, so session-to-date maths is not truncated. */
  underlyingPadMs: 2 * DAY,
} as const;

function hasTable(db: StoreDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get?.(name));
  } catch {
    return false;
  }
}

const num = (v: unknown): number | null => {
  const x = Number(v);
  return v == null || v === "" || !Number.isFinite(x) ? null : x;
};

/** UTC day string for a provider expiration-range query. */
function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

interface CaseAnchor {
  opportunityCaseId: string;
  symbol: string;
  occ: string | null;
  atMs: number;
  delivered: boolean;
}

/**
 * Opportunity cases worth reconstructing, newest first.
 *
 * Delivered cases come first because they are the ones that carried a number to a
 * reader; an undelivered candidate is still useful as a control, which is why the
 * scope can widen, but it is not what the first budget should buy.
 */
function loadCaseAnchors(
  db: StoreDb,
  opts: { sinceMs?: number | null; limit: number; scope: "delivered" | "all" },
): CaseAnchor[] {
  if (!hasTable(db, "opportunity_cases")) return [];
  const where: string[] = [];
  const params: any[] = [];
  if (opts.scope === "delivered") where.push("delivery_decision='delivered'");
  if (opts.sinceMs != null) { where.push("detected_at_ms >= ?"); params.push(opts.sinceMs); }
  try {
    const rows = (db.prepare(
      `SELECT opportunity_id, underlying_symbol, detected_at_ms, case_json, delivery_decision
         FROM opportunity_cases
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY detected_at_ms DESC LIMIT ?`,
    ).all?.(...params, opts.limit) ?? []) as any[];
    const out: CaseAnchor[] = [];
    for (const r of rows) {
      const atMs = num(r.detected_at_ms);
      const symbol = r.underlying_symbol == null ? null : String(r.underlying_symbol).toUpperCase();
      if (atMs == null || !symbol) continue;
      let occ: string | null = null;
      try {
        const c = JSON.parse(String(r.case_json ?? "{}"));
        const raw = c?.selectedContract?.optionSymbol;
        occ = raw ? String(raw).toUpperCase() : null;
      } catch { occ = null; }
      out.push({
        opportunityCaseId: String(r.opportunity_id),
        symbol, occ, atMs,
        delivered: String(r.delivery_decision ?? "") === "delivered",
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Windows already finished, so the plan does not re-buy them.
 *
 * Finished is BOTH terminal statuses. EXHAUSTED means the span was examined and the
 * provider had nothing more — planning it again buys the same empty page — so it has to be
 * excluded here exactly as COMPLETE is. Leaving it out would move the spend loop from the
 * repair into the planner rather than ending it.
 */
function completedOptionWindows(db: StoreDb): Set<string> {
  const done = new Set<string>();
  if (!hasTable(db, "historical_ingestion_progress")) return done;
  try {
    const rows = (db.prepare(
      `SELECT subject, timeframe FROM historical_ingestion_progress
        WHERE dataset='option_quotes' AND status IN ('COMPLETE','EXHAUSTED')`,
    ).all?.() ?? []) as any[];
    for (const r of rows) done.add(`${String(r.subject).toUpperCase()}|${String(r.timeframe ?? "")}`);
  } catch { /* an unreadable progress table plans everything, which is safe */ }
  return done;
}

export interface PlanOptions {
  nowMs: number;
  /** Cap on option windows; each is roughly one provider request. */
  maxOptionWindows?: number;
  maxUnderlyingSymbols?: number;
  /** How far back to look for anchors. */
  lookbackMs?: number;
  scope?: "delivered" | "all";
  /** Index/liquid symbols for regime reconstruction. */
  indexSymbols?: readonly string[];
  preEventMs?: number;
  postEventMs?: number;
}

/**
 * Build the plan.
 *
 * Every window carries the reason it exists, so a later reader can tell an
 * evidence-centred fetch from a speculative one — and so an expensive plan can be
 * audited before it is executed rather than after the budget is gone.
 */
export function buildBackfillPlan(db: StoreDb, opts: PlanOptions): BackfillPlan {
  const maxOption = Math.max(0, Math.min(2000, opts.maxOptionWindows ?? 25));
  const maxSymbols = Math.max(0, Math.min(200, opts.maxUnderlyingSymbols ?? 15));
  const lookbackMs = opts.lookbackMs ?? 45 * DAY;
  const pre = opts.preEventMs ?? WINDOW_DEFAULTS.preEventMs;
  const post = opts.postEventMs ?? WINDOW_DEFAULTS.postEventMs;
  const indexSymbols = opts.indexSymbols ?? ["SPY", "QQQ", "IWM"];

  const anchors = loadCaseAnchors(db, {
    sinceMs: opts.nowMs - lookbackMs,
    limit: Math.max(maxOption * 4, 200),
    scope: opts.scope ?? "delivered",
  });
  const alreadyDone = completedOptionWindows(db);

  // ── Priority 1: exact contracts around real cases ──────────────────────────
  const optionWindows: OptionWindow[] = [];
  const seenOcc = new Set<string>();
  for (const a of anchors) {
    if (optionWindows.length >= maxOption) break;
    if (!a.occ) continue;
    // One window per OCC. A contract alerted twice does not need its quotes twice, and
    // de-duplicating here is far cheaper than discovering it after the requests.
    if (seenOcc.has(a.occ)) continue;
    const fromMs = a.atMs - pre;
    const toMs = a.atMs + post;
    if (alreadyDone.has(`${a.occ}|${fromMs}..${toMs}`)) continue;
    seenOcc.add(a.occ);
    optionWindows.push({
      occ: a.occ,
      underlying: a.symbol,
      fromMs, toMs,
      anchorMs: a.atMs,
      reason: `opportunity case ${a.opportunityCaseId}${a.delivered ? " (delivered)" : ""}`,
      priority: 1,
    });
  }

  // ── Underlying: the anchors' symbols, then the index set ───────────────────
  const underlyingWindows: UnderlyingWindow[] = [];
  const seenSym = new Set<string>();
  const pushSymbol = (symbol: string, priority: 1 | 2 | 3, reason: string, fromMs: number, toMs: number) => {
    const key = symbol.toUpperCase();
    if (seenSym.has(key) || underlyingWindows.length >= maxSymbols) return;
    seenSym.add(key);
    underlyingWindows.push({ symbol: key, timeframe: "1m", fromMs, toMs, reason, priority });
  };

  for (const a of anchors) {
    if (underlyingWindows.length >= maxSymbols) break;
    pushSymbol(
      a.symbol, 1, `underlying for opportunity cases (${a.symbol})`,
      a.atMs - WINDOW_DEFAULTS.underlyingPadMs, a.atMs + WINDOW_DEFAULTS.underlyingPadMs,
    );
  }
  // Priority 3, but ALWAYS present: regime reconstruction is what makes every cohort
  // stratification possible, and it is cheap — one request per symbol per month.
  const idxFrom = opts.nowMs - lookbackMs;
  for (const s of indexSymbols) {
    pushSymbol(s, 3, "index context for regime reconstruction", idxFrom, opts.nowMs);
  }

  // ── Contract reference for the anchors' underlyings ────────────────────────
  const refTargets: BackfillPlan["contractReferenceTargets"] = [];
  const seenRef = new Set<string>();
  for (const w of optionWindows) {
    if (seenRef.has(w.underlying)) continue;
    seenRef.add(w.underlying);
    refTargets.push({
      underlying: w.underlying,
      // Expirations plausibly reachable from the anchor: a contract alerted on day D
      // expires within weeks, not years.
      expirationFrom: dayOf(w.anchorMs - 7 * DAY),
      expirationTo: dayOf(w.anchorMs + 120 * DAY),
      priority: 1,
    });
  }

  const estimatedRequests = optionWindows.length + refTargets.length + underlyingWindows.length * 2;

  return {
    version: PLANNER_VERSION,
    optionWindows,
    underlyingWindows,
    contractReferenceTargets: refTargets,
    estimatedRequests,
    note:
      "Evidence-centred. Option windows are anchored on real opportunity cases, because those are "
      + "the moments where a historical answer changes a decision. Underlying context is allowed to "
      + "be broader than contract ingestion: bars cost one request per symbol per month, per-OCC "
      + "NBBO costs one per contract per window, and pricing them the same would either starve "
      + "regime reconstruction or bankrupt the contract lane. Windows already COMPLETE are excluded.",
  };
}
