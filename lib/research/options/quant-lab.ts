/**
 * Quant Lab — comprehensive realized-outcome snapshot for options research.
 * Lanes never blend: delivered / 0DTE research / shadow / research-only stay separate.
 */
import { buildShadowSoakAggregate } from "./shadow-outcomes.ts";
import { timeBucketEt } from "./zero-dte-research/families.ts";

export type QuantLabConfidence = "LOW" | "MEDIUM" | "HIGH";

export type QuantLabLaneKey =
  /** OFFICIAL. Verified rows only — the only lane performance may be quoted from. */
  | "delivered"
  /** The pre-verification population, kept visible so exclusions stay inspectable. */
  | "delivered_unverified"
  | "blocked"
  | "shadow_would_send"
  | "zero_dte_research"
  | "research_only"
  | "all_paper";

export interface QuantLabSegment {
  key: string;
  n: number;
  winRate: number | null;
  expectancy: number | null;
  avgReturn: number | null;
  medianReturn: number | null;
  profitFactor: number | null;
  mfe: number | null;
  mae: number | null;
}

export interface QuantLabMetrics {
  winRate: number | null;
  medianReturn: number | null;
  meanReturn: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  mfe: number | null;
  mae: number | null;
  captureEfficiency: number | null;
  t1HitRate: number | null;
  t2HitRate: number | null;
  stopRate: number | null;
  detectionToDiscordLatencyMs: number | null;
  preMovePercentage: number | null;
  largeWinnersBlocked: number | null;
  severeLossesPrevented: number | null;
}

export interface QuantLabBreakdowns {
  strategyFamily: QuantLabSegment[];
  symbol: QuantLabSegment[];
  spyVsQqq: QuantLabSegment[];
  callsVsPuts: QuantLabSegment[];
  dte: QuantLabSegment[];
  zeroDteOnly: QuantLabSegment[];
  timeOfDay: QuantLabSegment[];
  marketRegime: QuantLabSegment[];
  contractMoneyness: QuantLabSegment[];
  deltaBand: QuantLabSegment[];
  exitPolicyVersion: QuantLabSegment[];
  qualityScoreBand: QuantLabSegment[];
}

export interface QuantLabReport {
  sampleSize: number;
  dataLane: QuantLabLaneKey | string;
  timeWindow: "all_exited";
  resultKind: "realized";
  confidence: QuantLabConfidence;
  completenessPct: number;
  metrics: QuantLabMetrics;
  breakdowns: QuantLabBreakdowns;
  insufficientEvidence: boolean;
  metadataCompleteness: Record<
    "mfeMae" | "moneyness" | "deltaBand" | "marketRegime" | "exitPolicy" | "qualityScore",
    number
  >;
}

export interface QuantLabSnapshot extends QuantLabReport {
  generatedAtMs: number;
  lanes: Record<QuantLabLaneKey, QuantLabReport>;
  /** Verification census for the official lane. Excluded rows stay visible. */
  verification: {
    officialLane: string; officialStatus: string;
    deliveredTotal: number; deliveredVerified: number; deliveredExcluded: number;
    verifiedFraction: number | null;
    byStatus: Record<string, number>;
    quotable: boolean; approximation: string; note: string;
  };
}

type QuantDb = {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
};

const MIN_SAMPLE = 5;

type TradeRow = {
  return_pct: number;
  mfe_pct: number | null;
  mae_pct: number | null;
  exit_reason: string | null;
  strategy: string | null;
  strategy_family: string | null;
  option_symbol: string | null;
  side: string | null;
  dte: number | null;
  time_bucket: string | null;
  entered_at_ms: number | null;
  market_regime: string | null;
  contract_moneyness: string | null;
  delta_band: string | null;
  exit_policy_version: string | null;
  feature_snapshot_json: string | null;
  paper_kind: string | null;
  t1_hit?: number | null;
  t2_hit?: number | null;
  stop_hit?: number | null;
};

function hasTable(db: QuantDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function tableCols(db: QuantDb, table: string): Set<string> {
  try {
    return new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => String(c.name)),
    );
  } catch {
    return new Set();
  }
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function round4(n: number | null): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 10000;
}

function profitFactor(wins: number[], losses: number[]): number | null {
  const w = wins.reduce((a, b) => a + b, 0);
  const l = Math.abs(losses.reduce((a, b) => a + b, 0));
  if (l === 0) return wins.length ? null : null;
  return w / l;
}

function confidenceFor(n: number, completenessPct: number): QuantLabConfidence {
  if (n >= 30 && completenessPct >= 80) return "HIGH";
  if (n >= MIN_SAMPLE && completenessPct >= 50) return "MEDIUM";
  return "LOW";
}

function emptyMetrics(): QuantLabMetrics {
  return {
    winRate: null,
    medianReturn: null,
    meanReturn: null,
    expectancy: null,
    profitFactor: null,
    mfe: null,
    mae: null,
    captureEfficiency: null,
    t1HitRate: null,
    t2HitRate: null,
    stopRate: null,
    detectionToDiscordLatencyMs: null,
    preMovePercentage: null,
    largeWinnersBlocked: null,
    severeLossesPrevented: null,
  };
}

function emptyBreakdowns(): QuantLabBreakdowns {
  return {
    strategyFamily: [],
    symbol: [],
    spyVsQqq: [],
    callsVsPuts: [],
    dte: [],
    zeroDteOnly: [],
    timeOfDay: [],
    marketRegime: [],
    contractMoneyness: [],
    deltaBand: [],
    exitPolicyVersion: [],
    qualityScoreBand: [],
  };
}

function emptyReport(dataLane: QuantLabLaneKey | string): QuantLabReport {
  return {
    sampleSize: 0,
    dataLane,
    timeWindow: "all_exited",
    resultKind: "realized",
    confidence: "LOW",
    completenessPct: 0,
    metrics: emptyMetrics(),
    breakdowns: emptyBreakdowns(),
    insufficientEvidence: true,
    metadataCompleteness: {
      mfeMae: 0,
      moneyness: 0,
      deltaBand: 0,
      marketRegime: 0,
      exitPolicy: 0,
      qualityScore: 0,
    },
  };
}

/** Parse OCC root from Polygon-style `O:SPY250124C00590000` or bare OCC. */
export function parseOccRoot(optionSymbol: string | null | undefined): string {
  const raw = String(optionSymbol ?? "").trim();
  if (!raw) return "unknown";
  const m = /^(?:O:)?([A-Z]{1,6})/i.exec(raw.replace(/\s+/g, ""));
  return m?.[1]?.toUpperCase() ?? "unknown";
}

function qualityScoreBand(score: number | null): string | null {
  if (score == null || !Number.isFinite(score)) return null;
  if (score < 0.55) return "<0.55";
  if (score < 0.7) return "0.55-0.7";
  if (score < 0.85) return "0.7-0.85";
  return ">=0.85";
}

function parseFeatureSnapshot(json: string | null | undefined): {
  qualityScore: number | null;
  preMovePercentage: number | null;
} {
  if (!json) return { qualityScore: null, preMovePercentage: null };
  try {
    const o = typeof json === "string" ? JSON.parse(json) : json;
    if (!o || typeof o !== "object") return { qualityScore: null, preMovePercentage: null };
    const qRaw =
      (o as any).qualityScore ??
      (o as any).quality_score ??
      (o as any).quality ??
      null;
    const q = qRaw != null && Number.isFinite(Number(qRaw)) ? Number(qRaw) : null;
    // Normalize 0..10 scores to 0..1 for banding
    const qualityScore = q != null && q > 1.5 ? q / 10 : q;
    const pRaw =
      (o as any).preMovePercentage ??
      (o as any).pre_move_pct ??
      (o as any).pre_move_percentage ??
      (o as any).underlying_pre_move_60m_pct ??
      (o as any).underlying_pre_move_pct ??
      (o as any).option_pre_move_30m_pct ??
      null;
    const preMovePercentage = pRaw != null && Number.isFinite(Number(pRaw)) ? Number(pRaw) : null;
    return { qualityScore, preMovePercentage };
  } catch {
    return { qualityScore: null, preMovePercentage: null };
  }
}

function segmentFromReturns(
  key: string,
  rows: TradeRow[],
): QuantLabSegment {
  const returns = rows.map((r) => Number(r.return_pct)).filter(Number.isFinite);
  const wins = returns.filter((x) => x > 0);
  const losses = returns.filter((x) => x <= 0);
  const mfe = avg(rows.map((r) => r.mfe_pct).filter((x): x is number => x != null && Number.isFinite(x)));
  const mae = avg(rows.map((r) => r.mae_pct).filter((x): x is number => x != null && Number.isFinite(x)));
  const n = returns.length;
  return {
    key,
    n,
    winRate: n ? wins.length / n : null,
    expectancy: round4(avg(returns)),
    avgReturn: round4(avg(returns)),
    medianReturn: round4(median(returns)),
    profitFactor: round4(profitFactor(wins, losses)),
    mfe: round4(mfe),
    mae: round4(mae),
  };
}

function groupSegments(rows: TradeRow[], keyFn: (r: TradeRow) => string): QuantLabSegment[] {
  const by = new Map<string, TradeRow[]>();
  for (const r of rows) {
    const k = keyFn(r) || "unknown";
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(r);
  }
  return [...by.entries()]
    .map(([k, rs]) => segmentFromReturns(k, rs))
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

function buildBreakdowns(rows: TradeRow[]): QuantLabBreakdowns {
  return {
    strategyFamily: groupSegments(rows, (r) => String(r.strategy_family ?? r.strategy ?? "unknown")),
    symbol: groupSegments(rows, (r) => parseOccRoot(r.option_symbol)),
    spyVsQqq: groupSegments(rows, (r) => {
      const root = parseOccRoot(r.option_symbol);
      if (root === "SPY") return "SPY";
      if (root === "QQQ") return "QQQ";
      return "other";
    }),
    callsVsPuts: groupSegments(rows, (r) => {
      const s = String(r.side ?? "").toLowerCase();
      if (s === "call" || s === "c") return "call";
      if (s === "put" || s === "p") return "put";
      return "unknown";
    }),
    dte: groupSegments(rows, (r) => (r.dte == null || !Number.isFinite(Number(r.dte)) ? "unknown" : String(Math.round(Number(r.dte))))),
    zeroDteOnly: groupSegments(
      rows.filter((r) => Number(r.dte) === 0),
      () => "dte=0",
    ),
    timeOfDay: groupSegments(rows, (r) => {
      if (r.time_bucket) return String(r.time_bucket);
      if (r.entered_at_ms != null && Number.isFinite(Number(r.entered_at_ms))) {
        return timeBucketEt(Number(r.entered_at_ms));
      }
      return "unknown";
    }),
    marketRegime: groupSegments(rows, (r) => String(r.market_regime ?? "unknown")),
    contractMoneyness: groupSegments(rows, (r) => String(r.contract_moneyness ?? "unknown")),
    deltaBand: groupSegments(rows, (r) => String(r.delta_band ?? "unknown")),
    exitPolicyVersion: groupSegments(rows, (r) => String(r.exit_policy_version ?? "unknown")),
    qualityScoreBand: groupSegments(rows, (r) => {
      const { qualityScore } = parseFeatureSnapshot(r.feature_snapshot_json);
      return qualityScoreBand(qualityScore) ?? "unknown";
    }),
  };
}

function metricsFromRows(
  rows: TradeRow[],
  extras: Partial<QuantLabMetrics> = {},
): {
  metrics: QuantLabMetrics;
  completenessPct: number;
  confidence: QuantLabConfidence;
  metadataCompleteness: QuantLabReport["metadataCompleteness"];
} {
  const returns = rows.map((r) => Number(r.return_pct)).filter(Number.isFinite);
  const wins = returns.filter((x) => x > 0);
  const losses = returns.filter((x) => x <= 0);
  const graded = returns.length;
  const pct = (count: number) => graded ? Math.round((count / graded) * 1000) / 10 : 0;
  const present = (value: unknown) => value != null && String(value).trim() !== "" && String(value).toLowerCase() !== "unknown";
  const metadataCompleteness: QuantLabReport["metadataCompleteness"] = {
    mfeMae: pct(rows.filter((r) => r.mfe_pct != null && r.mae_pct != null).length),
    moneyness: pct(rows.filter((r) => present(r.contract_moneyness)).length),
    deltaBand: pct(rows.filter((r) => present(r.delta_band)).length),
    marketRegime: pct(rows.filter((r) => present(r.market_regime)).length),
    exitPolicy: pct(rows.filter((r) => present(r.exit_policy_version)).length),
    qualityScore: pct(rows.filter((r) => parseFeatureSnapshot(r.feature_snapshot_json).qualityScore != null).length),
  };
  const completenessPct = Math.round(
    Object.values(metadataCompleteness).reduce((sum, value) => sum + value, 0)
      / Object.keys(metadataCompleteness).length
      * 10,
  ) / 10;

  const mfeVals = rows.map((r) => r.mfe_pct).filter((x): x is number => x != null && Number.isFinite(x));
  const maeVals = rows.map((r) => r.mae_pct).filter((x): x is number => x != null && Number.isFinite(x));
  const mfe = avg(mfeVals);
  const mae = avg(maeVals);

  const captureXs: number[] = [];
  for (const r of rows) {
    const ret = Number(r.return_pct);
    const m = r.mfe_pct;
    if (!Number.isFinite(ret) || m == null || !Number.isFinite(m) || m <= 0) continue;
    captureXs.push(ret / m);
  }

  let t1HitRate: number | null = null;
  let t2HitRate: number | null = null;
  let stopRate: number | null = null;
  if (graded) {
    const hasHitCols = rows.some((r) => r.t1_hit != null || r.t2_hit != null || r.stop_hit != null);
    if (hasHitCols) {
      t1HitRate = rows.filter((r) => r.t1_hit === 1).length / graded;
      t2HitRate = rows.filter((r) => r.t2_hit === 1).length / graded;
      stopRate = rows.filter((r) => r.stop_hit === 1).length / graded;
    } else {
      const t1 = rows.filter((r) => r.exit_reason === "target_hit" || /t1|target_1/i.test(String(r.exit_reason ?? ""))).length;
      const t2 = rows.filter((r) => /t2|second/i.test(String(r.exit_reason ?? ""))).length;
      const stop = rows.filter((r) => r.exit_reason === "stop_hit" || /stop/i.test(String(r.exit_reason ?? ""))).length;
      t1HitRate = t1 / graded;
      t2HitRate = t2 / graded;
      stopRate = stop / graded;
    }
  }

  const preMoves = rows
    .map((r) => parseFeatureSnapshot(r.feature_snapshot_json).preMovePercentage)
    .filter((x): x is number => x != null && Number.isFinite(x));

  const meanReturn = avg(returns);
  return {
    completenessPct,
    confidence: confidenceFor(graded, completenessPct),
    metadataCompleteness,
    metrics: {
      winRate: graded ? wins.length / graded : null,
      medianReturn: round4(median(returns)),
      meanReturn: round4(meanReturn),
      expectancy: round4(meanReturn),
      profitFactor: round4(profitFactor(wins, losses)),
      mfe: round4(mfe),
      mae: round4(mae),
      captureEfficiency: round4(avg(captureXs)),
      t1HitRate: round4(t1HitRate),
      t2HitRate: round4(t2HitRate),
      stopRate: round4(stopRate),
      detectionToDiscordLatencyMs: extras.detectionToDiscordLatencyMs ?? null,
      preMovePercentage: extras.preMovePercentage !== undefined
        ? extras.preMovePercentage
        : round4(avg(preMoves)),
      largeWinnersBlocked: extras.largeWinnersBlocked ?? null,
      severeLossesPrevented: extras.severeLossesPrevented ?? null,
    },
  };
}

function reportFromRows(
  rows: TradeRow[],
  dataLane: QuantLabLaneKey | string,
  extras: Partial<QuantLabMetrics> = {},
): QuantLabReport {
  if (!rows.length) {
    const empty = emptyReport(dataLane);
    empty.metrics = { ...empty.metrics, ...extras };
    return empty;
  }
  const { metrics, completenessPct, confidence, metadataCompleteness } = metricsFromRows(rows, extras);
  return {
    sampleSize: rows.length,
    dataLane,
    timeWindow: "all_exited",
    resultKind: "realized",
    confidence,
    completenessPct,
    metrics,
    breakdowns: buildBreakdowns(rows),
    insufficientEvidence: rows.length < MIN_SAMPLE,
    metadataCompleteness,
  };
}

/**
 * Verification status per paper row, derived deterministically from columns
 * this module can see.
 *
 * WHY THIS IS HERE. paper-chain rejected 471 of 553 rows while this module
 * selected `status='EXITED' AND return_pct IS NOT NULL` with no verification at
 * all — so the headline performance number was computed over a population that
 * the verifier had already thrown out. Two verifiers is one too many.
 *
 * This is a CONSERVATIVE APPROXIMATION of paper-chain's predicate, built only
 * from `options_paper_trades` plus `options_paper_marks`. It cannot see Discord
 * delivery proof, so it can only ever be STRICTER-or-equal on the fields it
 * does check, and it labels itself as an approximation rather than claiming
 * parity it has not got.
 */
function verificationByTradeId(db: QuantDb): Map<number, string> {
  const out = new Map<number, string>();
  if (!hasTable(db, "options_paper_trades")) return out;
  const cols = tableCols(db, "options_paper_trades");
  if (!cols.has("id")) return out;

  const has = (c: string) => cols.has(c);
  const rows = db.prepare(`
    SELECT id,
           ${has("alert_id") ? "alert_id" : "NULL AS alert_id"},
           ${has("entry_fill") ? "entry_fill" : "NULL AS entry_fill"},
           ${has("exit_fill") ? "exit_fill" : "NULL AS exit_fill"},
           ${has("status") ? "status" : "NULL AS status"},
           ${has("return_pct") ? "return_pct" : "NULL AS return_pct"}
      FROM options_paper_trades
  `).all() as Record<string, unknown>[];

  // Duplicate detection: more than one paper position for the same alert.
  const perAlert = new Map<string, number>();
  for (const r of rows) {
    const a = r.alert_id == null ? null : String(r.alert_id);
    if (a) perAlert.set(a, (perAlert.get(a) ?? 0) + 1);
  }

  const markedTradeIds = new Set<number>();
  if (hasTable(db, "options_paper_marks")) {
    try {
      for (const m of db.prepare("SELECT DISTINCT trade_id FROM options_paper_marks").all() as Record<string, unknown>[]) {
        const id = Number(m.trade_id);
        if (Number.isFinite(id)) markedTradeIds.add(id);
      }
    } catch { /* marks are optional; absence is handled below */ }
  }

  for (const r of rows) {
    const id = Number(r.id);
    if (!Number.isFinite(id)) continue;
    const alertId = r.alert_id == null ? null : String(r.alert_id);
    const entry = Number(r.entry_fill);
    const exit = Number(r.exit_fill);
    const status = r.status == null ? null : String(r.status);
    const ret = Number(r.return_pct);

    // Worst-cause-first, matching lib/research/options/trade-verification.ts.
    let v: string;
    if (!alertId) v = "AUDIT_ONLY";
    else if ((perAlert.get(alertId) ?? 0) > 1) v = "DUPLICATE";
    else if (!Number.isFinite(entry) || entry <= 0) v = "UNVERIFIED_ENTRY";
    else if (!markedTradeIds.has(id)) v = "INVALID_OR_STALE_MARK";
    else if (status === "EXITED" && (!Number.isFinite(exit) || exit <= 0)) v = "UNVERIFIED_EXIT";
    else if (!Number.isFinite(ret)) v = "UNGRADEABLE";
    else v = "VERIFIED_GRADED";
    out.set(id, v);
  }
  return out;
}

function loadPaperRows(db: QuantDb, kinds: string[] | null, opts: { verifiedOnly?: boolean } = {}): TradeRow[] {
  if (!hasTable(db, "options_paper_trades")) return [];
  const cols = tableCols(db, "options_paper_trades");
  if (!cols.has("return_pct") || !cols.has("status")) return [];

  const want = (name: string) => (cols.has(name) ? name : `NULL AS ${name}`);
  const sql = `
    SELECT
      ${want("id")},
      return_pct,
      ${want("mfe_pct")},
      ${want("mae_pct")},
      ${want("exit_reason")},
      ${want("strategy")},
      ${want("strategy_family")},
      ${want("option_symbol")},
      ${want("side")},
      ${want("dte")},
      ${want("time_bucket")},
      ${want("entered_at_ms")},
      ${want("market_regime")},
      ${want("contract_moneyness")},
      ${want("delta_band")},
      ${want("exit_policy_version")},
      ${want("feature_snapshot_json")},
      ${want("paper_kind")}
    FROM options_paper_trades
    WHERE status='EXITED' AND return_pct IS NOT NULL
    ${kinds?.length ? `AND paper_kind IN (${kinds.map(() => "?").join(",")})` : ""}
  `;
  let raw = (kinds?.length ? db.prepare(sql).all(...kinds) : db.prepare(sql).all()) as Record<string, unknown>[];

  // OFFICIAL METRICS SEE VERIFIED ROWS ONLY. Excluded rows stay visible through
  // the verification breakdown; they simply never enter win rate, expectancy,
  // median return, profit factor, MFE, MAE or milestone rates.
  if (opts.verifiedOnly) {
    const verification = verificationByTradeId(db);
    raw = raw.filter((r) => verification.get(Number(r.id)) === "VERIFIED_GRADED");
  }

  return raw.map((r) => ({
    return_pct: Number(r.return_pct),
    mfe_pct: r.mfe_pct == null ? null : Number(r.mfe_pct),
    mae_pct: r.mae_pct == null ? null : Number(r.mae_pct),
    exit_reason: r.exit_reason == null ? null : String(r.exit_reason),
    strategy: r.strategy == null ? null : String(r.strategy),
    strategy_family: r.strategy_family == null ? null : String(r.strategy_family),
    option_symbol: r.option_symbol == null ? null : String(r.option_symbol),
    side: r.side == null ? null : String(r.side),
    dte: r.dte == null ? null : Number(r.dte),
    time_bucket: r.time_bucket == null ? null : String(r.time_bucket),
    entered_at_ms: r.entered_at_ms == null ? null : Number(r.entered_at_ms),
    market_regime: r.market_regime == null ? null : String(r.market_regime),
    contract_moneyness: r.contract_moneyness == null ? null : String(r.contract_moneyness),
    delta_band: r.delta_band == null ? null : String(r.delta_band),
    exit_policy_version: r.exit_policy_version == null ? null : String(r.exit_policy_version),
    feature_snapshot_json: r.feature_snapshot_json == null ? null : String(r.feature_snapshot_json),
    paper_kind: r.paper_kind == null ? null : String(r.paper_kind),
  })).filter((r) => Number.isFinite(r.return_pct));
}

function loadShadowRows(db: QuantDb, wouldSend: boolean): TradeRow[] {
  if (!hasTable(db, "options_shadow_outcomes")) return [];
  const cols = tableCols(db, "options_shadow_outcomes");
  if (!cols.has("return_60m")) return [];
  const want = (name: string, as?: string) =>
    cols.has(name) ? (as ? `${name} AS ${as}` : name) : `NULL AS ${as ?? name}`;
  const rows = db.prepare(
    `SELECT
      return_60m AS return_pct,
      ${want("mfe_pct")},
      ${want("mae_pct")},
      ${want("t1_hit")},
      ${want("t2_hit")},
      ${want("stop_hit")},
      ${want("strategy")},
      ${want("option_symbol")},
      ${want("candidate_symbol")},
      ${want("side")},
      ${want("dte_at_decision", "dte")},
      ${want("quality_score")}
     FROM options_shadow_outcomes
     WHERE would_send=? AND path IN ('proposed','independent') AND return_60m IS NOT NULL`,
  ).all(wouldSend ? 1 : 0) as Record<string, unknown>[];

  return rows.map((r) => {
    const q = r.quality_score == null ? null : Number(r.quality_score);
    const feature = q != null && Number.isFinite(q)
      ? JSON.stringify({ qualityScore: q > 1.5 ? q / 10 : q })
      : null;
    const opt = r.option_symbol != null ? String(r.option_symbol) : null;
    const cand = r.candidate_symbol != null ? String(r.candidate_symbol) : null;
    return {
      return_pct: Number(r.return_pct),
      mfe_pct: r.mfe_pct == null ? null : Number(r.mfe_pct),
      mae_pct: r.mae_pct == null ? null : Number(r.mae_pct),
      exit_reason: null,
      strategy: r.strategy == null ? null : String(r.strategy),
      strategy_family: r.strategy == null ? null : String(r.strategy),
      option_symbol: opt ?? (cand ? `O:${cand}` : null),
      side: r.side == null ? null : String(r.side),
      dte: r.dte == null ? null : Number(r.dte),
      time_bucket: null,
      entered_at_ms: null,
      market_regime: null,
      contract_moneyness: null,
      delta_band: null,
      exit_policy_version: null,
      feature_snapshot_json: feature,
      paper_kind: null,
      t1_hit: r.t1_hit == null ? null : Number(r.t1_hit),
      t2_hit: r.t2_hit == null ? null : Number(r.t2_hit),
      stop_hit: r.stop_hit == null ? null : Number(r.stop_hit),
    };
  }).filter((r) => Number.isFinite(r.return_pct));
}

function detectionToDiscordLatencyMs(db: QuantDb): number | null {
  if (!hasTable(db, "options_alerts")) return null;
  const cols = tableCols(db, "options_alerts");
  if (!cols.has("created_at_ms") || !cols.has("sent_at_ms")) return null;
  try {
    const rows = db.prepare(
      `SELECT created_at_ms, sent_at_ms FROM options_alerts
       WHERE state='SENT' AND created_at_ms IS NOT NULL AND sent_at_ms IS NOT NULL
         AND sent_at_ms >= created_at_ms`,
    ).all() as { created_at_ms: number; sent_at_ms: number }[];
    const xs = rows
      .map((r) => Number(r.sent_at_ms) - Number(r.created_at_ms))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (!xs.length) return null;
    return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  } catch {
    return null;
  }
}

/**
 * Build a full Quant Lab snapshot from SQLite (getDb-compatible prepare/get/all).
 * Never fabricates metrics — missing values are null. Lanes never blend.
 */
export function buildQuantLabSnapshot(
  db: QuantDb,
  env: NodeJS.ProcessEnv = process.env,
): QuantLabSnapshot {
  const latency = detectionToDiscordLatencyMs(db);

  let largeWinnersBlocked: number | null = null;
  let severeLossesPrevented: number | null = null;
  try {
    if (hasTable(db, "options_shadow_outcomes") || hasTable(db, "options_shadow_decisions")) {
      const agg = buildShadowSoakAggregate(db as any, env, 14);
      largeWinnersBlocked = Number.isFinite(agg.largeWinnersBlocked) ? agg.largeWinnersBlocked : null;
      severeLossesPrevented = Number.isFinite(agg.severeLossesPrevented) ? agg.severeLossesPrevented : null;
    }
  } catch {
    /* optional */
  }

  // `delivered` is the OFFICIAL lane and is verified-only from here on.
  // `delivered_unverified` keeps the old, contaminated population visible so
  // the difference between the two is inspectable rather than lost.
  const deliveredRows = loadPaperRows(db, ["DELIVERED_ALERT_PAPER"], { verifiedOnly: true });
  const deliveredAllRows = loadPaperRows(db, ["DELIVERED_ALERT_PAPER"]);
  const zeroDteRows = loadPaperRows(db, ["ZERO_DTE_RESEARCH_PAPER"]);
  const researchOnlyRows = loadPaperRows(db, ["RESEARCH_ONLY_PAPER"]);
  const allPaperRows = [...deliveredAllRows, ...zeroDteRows, ...researchOnlyRows];

  // Exclusion census over the delivered lane, by cause.
  const verificationMap = verificationByTradeId(db);
  const deliveredVerification: Record<string, number> = {};
  try {
    const ids = db.prepare(
      `SELECT id FROM options_paper_trades WHERE status='EXITED' AND return_pct IS NOT NULL${
        tableCols(db, "options_paper_trades").has("paper_kind") ? " AND paper_kind='DELIVERED_ALERT_PAPER'" : ""}`,
    ).all() as Record<string, unknown>[];
    for (const r of ids) {
      const s = verificationMap.get(Number(r.id)) ?? "EXCLUDED_OTHER";
      deliveredVerification[s] = (deliveredVerification[s] ?? 0) + 1;
    }
  } catch { /* census is diagnostic only */ }
  const deliveredTotal = Object.values(deliveredVerification).reduce((a, b) => a + b, 0);
  const deliveredVerified = deliveredVerification.VERIFIED_GRADED ?? 0;
  const blockedRows = loadShadowRows(db, false);
  const wouldSendRows = loadShadowRows(db, true);

  const shadowExtras: Partial<QuantLabMetrics> = {
    largeWinnersBlocked,
    severeLossesPrevented,
  };
  const deliveredExtras: Partial<QuantLabMetrics> = {
    detectionToDiscordLatencyMs: latency,
    largeWinnersBlocked,
    severeLossesPrevented,
  };

  const lanes: Record<QuantLabLaneKey, QuantLabReport> = {
    delivered: reportFromRows(deliveredRows, "delivered", deliveredExtras),
    delivered_unverified: reportFromRows(deliveredAllRows, "delivered_unverified", deliveredExtras),
    blocked: reportFromRows(blockedRows, "blocked", shadowExtras),
    shadow_would_send: reportFromRows(wouldSendRows, "shadow_would_send"),
    zero_dte_research: reportFromRows(zeroDteRows, "zero_dte_research"),
    research_only: reportFromRows(researchOnlyRows, "research_only"),
    all_paper: reportFromRows(allPaperRows, "all_paper", {
      detectionToDiscordLatencyMs: latency,
      largeWinnersBlocked,
      severeLossesPrevented,
    }),
  };

  const top = lanes.delivered;
  return {
    generatedAtMs: Date.now(),
    sampleSize: top.sampleSize,
    dataLane: top.dataLane,
    timeWindow: "all_exited",
    resultKind: "realized",
    confidence: top.confidence,
    completenessPct: top.completenessPct,
    metrics: top.metrics,
    breakdowns: top.breakdowns,
    insufficientEvidence: top.insufficientEvidence,
    metadataCompleteness: top.metadataCompleteness,
    lanes,
    verification: {
      officialLane: "delivered",
      officialStatus: "VERIFIED_GRADED",
      deliveredTotal,
      deliveredVerified,
      deliveredExcluded: deliveredTotal - deliveredVerified,
      verifiedFraction: deliveredTotal > 0 ? Math.round((deliveredVerified / deliveredTotal) * 10_000) / 10_000 : null,
      byStatus: deliveredVerification,
      quotable: deliveredTotal > 0 && deliveredVerified >= 30 && deliveredVerified / deliveredTotal >= 0.8,
      approximation: "Derived from options_paper_trades + options_paper_marks. It cannot see Discord delivery proof, so it is stricter-or-equal to paper-chain on the fields it checks and is NOT claimed to be identical.",
      note: "Official metrics count VERIFIED_GRADED only. Excluded rows remain visible here and in the delivered_unverified lane; they are never deleted and never blended into official performance.",
    },
  };
}
