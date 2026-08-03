/**
 * Quant Lab — comprehensive realized-outcome snapshot for options research.
 * Lanes never blend: delivered / 0DTE research / shadow / research-only stay separate.
 */
import { buildShadowSoakAggregate } from "./shadow-outcomes.ts";
import {
  verifyOpportunity, compareParity, isQuotable,
  OFFICIAL_STATUS, VERIFICATION_CONTRACT_VERSION, GRADING_VERSION, DATA_QUALITY_VERSION,
  type CanonicalVerification, type VerificationStatus,
} from "./verification-contract.ts";
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
    byLinkage: Record<string, number>;
    /** A GATE, not a label: parity, sample, verified fraction and mark quality must all pass. */
    quotable: boolean;
    quotableBlockers: string[];
    contractVersion: string;
    gradingVersion: string;
    dataQualityVersion: string;
    note: string;
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
 * Verification per paper row, using the CANONICAL contract and the SAME
 * evidence paper-chain uses — including the options_alerts delivery proof.
 *
 * Checkpoint 2 shipped an approximation here that could not see delivery proof.
 * It classified 276 of 357 rows verified while paper-chain classified 82 of
 * 553, and because it checked FEWER facts it was more permissive, not
 * stricter, despite the comment claiming otherwise. Official performance was
 * quoted from it. This replaces that approximation with the real join, and the
 * decision itself now lives in verification-contract.ts so there is exactly one
 * implementation to disagree with.
 */
function verificationByTradeId(db: QuantDb): Map<number, CanonicalVerification> {
  const out = new Map<number, CanonicalVerification>();
  if (!hasTable(db, "options_paper_trades")) return out;
  const cols = tableCols(db, "options_paper_trades");
  if (!cols.has("id")) return out;

  const has = (c: string) => cols.has(c);
  const rows = db.prepare(`
    SELECT id,
           ${has("alert_id") ? "alert_id" : "NULL AS alert_id"},
           ${has("option_symbol") ? "option_symbol" : "NULL AS option_symbol"},
           ${has("entry_fill") ? "entry_fill" : "NULL AS entry_fill"},
           ${has("exit_fill") ? "exit_fill" : "NULL AS exit_fill"},
           ${has("exit_at_ms") ? "exit_at_ms" : "NULL AS exit_at_ms"},
           ${has("status") ? "status" : "NULL AS status"},
           ${has("return_pct") ? "return_pct" : "NULL AS return_pct"}
      FROM options_paper_trades
  `).all() as Record<string, unknown>[];

  const perAlert = new Map<string, number>();
  for (const r of rows) {
    const a = r.alert_id == null ? null : String(r.alert_id);
    if (a) perAlert.set(a, (perAlert.get(a) ?? 0) + 1);
  }

  // ── THE JOIN. Delivery proof lives on options_alerts and nowhere else. ──
  const alerts = new Map<string, Record<string, unknown>>();
  const alertsAvailable = hasTable(db, "options_alerts");
  if (alertsAvailable) {
    const ac = tableCols(db, "options_alerts");
    const a = (c: string) => (ac.has(c) ? c : `NULL AS ${c}`);
    try {
      for (const r of db.prepare(`
        SELECT alert_id, ${a("state")}, ${a("research_only")}, ${a("paper_linked")},
               ${a("discord_message_id")}, ${a("opportunity_case_id")}, ${a("option_symbol")}
          FROM options_alerts
      `).all() as Record<string, unknown>[]) {
        if (r.alert_id != null) alerts.set(String(r.alert_id), r);
      }
    } catch { /* absent columns are handled as unknown facts below */ }
  }

  // Marks, needed for grading-mark validity and exit corroboration.
  const marksByTrade = new Map<number, Array<Record<string, unknown>>>();
  if (hasTable(db, "options_paper_marks")) {
    try {
      for (const m of db.prepare(
        "SELECT trade_id, bid, ask, exit_fill, mark_at_ms FROM options_paper_marks",
      ).all() as Record<string, unknown>[]) {
        const id = Number(m.trade_id);
        if (!Number.isFinite(id)) continue;
        const list = marksByTrade.get(id) ?? [];
        list.push(m);
        marksByTrade.set(id, list);
      }
    } catch { /* marks optional */ }
  }

  const fin = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  for (const r of rows) {
    const id = Number(r.id);
    if (!Number.isFinite(id)) continue;
    const alertId = r.alert_id == null ? null : String(r.alert_id);
    const alert = alertId ? alerts.get(alertId) ?? null : null;
    const status = r.status == null ? null : String(r.status);
    const entry = fin(r.entry_fill);
    const exit = fin(r.exit_fill);
    const exitAt = fin(r.exit_at_ms);
    const marks = marksByTrade.get(id) ?? [];

    const gradingMarkValid = marks.some((m) => {
      const b = fin(m.bid), a = fin(m.ask);
      return b != null && b > 0 && a != null && a >= b && fin(m.exit_fill) != null;
    });
    // Exit corroboration: a mark near the exit instant carrying the exit fill.
    const exitMarkMatched = status !== "EXITED"
      ? true
      : marks.some((m) => {
        const mAt = fin(m.mark_at_ms), mExit = fin(m.exit_fill);
        return mAt != null && mExit != null && exitAt != null && exit != null
          && Math.abs(mAt - exitAt) <= 120_000 && Math.abs(mExit - exit) <= 0.01;
      });

    const paperOcc = r.option_symbol == null ? null : String(r.option_symbol).toUpperCase();
    const alertOcc = alert?.option_symbol == null ? null : String(alert.option_symbol).toUpperCase();

    out.set(id, verifyOpportunity({
      // When options_alerts is absent entirely the provenance is UNKNOWABLE, so
      // alertPresent stays null (LEGACY_UNLINKABLE) rather than false.
      alertPresent: !alertsAvailable ? null : Boolean(alert),
      alertSentToSubscriber: alert ? (String(alert.state ?? "") === "SENT" && Number(alert.research_only ?? 0) === 0) : null,
      discordMessageIdPresent: alert ? Boolean(alert.discord_message_id) : null,
      opportunityCasePresent: alert ? Boolean(alert.opportunity_case_id) : null,
      alertPaperLinked: alert ? Number(alert.paper_linked ?? 0) === 1 : null,
      paperMirrorPresent: true, // the row IS the paper mirror
      paperRowCount: alertId ? perAlert.get(alertId) ?? 1 : 1,
      entryFillValid: entry != null && entry > 0,
      exitFillValid: status === "EXITED" ? exit != null && exit > 0 : true,
      exitMarkMatched,
      gradingMarkValid,
      // Identity is proven only when both sides are known and equal.
      occMatches: paperOcc && alertOcc ? paperOcc === alertOcc : (alert ? null : null),
      sessionValid: null, // not derivable here; stays UNKNOWN, never assumed valid
      returnComputable: fin(r.return_pct) != null,
      auditOnly: alertId ? false : true,
    }));
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
    raw = raw.filter((r) => verification.get(Number(r.id))?.verificationStatus === OFFICIAL_STATUS);
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
  const deliveredLinkage: Record<string, number> = {};
  try {
    const ids = db.prepare(
      `SELECT id FROM options_paper_trades WHERE status='EXITED' AND return_pct IS NOT NULL${
        tableCols(db, "options_paper_trades").has("paper_kind") ? " AND paper_kind='DELIVERED_ALERT_PAPER'" : ""}`,
    ).all() as Record<string, unknown>[];
    for (const r of ids) {
      const v = verificationMap.get(Number(r.id)) ?? null;
      const s = v?.verificationStatus ?? "EXCLUDED_OTHER";
      deliveredVerification[s] = (deliveredVerification[s] ?? 0) + 1;
      const lk = v?.linkage ?? "LEGACY_UNLINKABLE";
      deliveredLinkage[lk] = (deliveredLinkage[lk] ?? 0) + 1;
    }
  } catch { /* census is diagnostic only */ }
  const deliveredTotal = Object.values(deliveredVerification).reduce((a, b) => a + b, 0);
  const deliveredVerified = deliveredVerification.VERIFIED_GRADED ?? 0;
  // Quotability is a GATE, not a label: parity, sample size, verified fraction
  // and independent mark coverage must all pass. Independent mark rate is not
  // computed here, so it is reported unknown and therefore blocks — which is
  // the correct conservative default.
  const quotableCheck = isQuotable({
    parityStatus: "NOT_COMPARABLE",
    verifiedCount: deliveredVerified,
    verifiedFraction: deliveredTotal > 0 ? deliveredVerified / deliveredTotal : null,
    independentMarkRate: null,
  });
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
      byLinkage: deliveredLinkage,
      quotable: quotableCheck.quotable,
      quotableBlockers: quotableCheck.blockers,
      contractVersion: VERIFICATION_CONTRACT_VERSION,
      gradingVersion: GRADING_VERSION,
      dataQualityVersion: DATA_QUALITY_VERSION,
      note: "Official metrics count VERIFIED_GRADED only, decided by the shared verification-contract that paper-chain uses too — not by a local approximation. Excluded rows remain visible here and in the delivered_unverified lane; they are never deleted and never blended into official performance.",
    },
  };
}
