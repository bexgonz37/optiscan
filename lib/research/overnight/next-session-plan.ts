/**
 * Deterministic overnight / next-session research recommendations.
 * Never claims option prices are executable.
 */
import { tradingDay } from "../../trading-session.ts";
import { loadNextSessionContextOnDb } from "../watchlist/market-context-snapshot.ts";
import { vwapCompleteness, type VwapCompleteness } from "../watchlist/vwap-evidence.ts";

export type OvernightBias = "bullish" | "bearish" | "neutral";
export type PreferredMoneyness = "ATM" | "ITM" | "OTM" | "ATM or 1 strike ITM";

export interface OvernightRecommendation {
  symbol: string;
  bias: OvernightBias;
  setupFamily: string;
  triggerLevel: number | null;
  invalidationLevel: number | null;
  preferredDteRange: string;
  preferredMoneyness: PreferredMoneyness;
  contractSelectionGuidance: string;
  confidence: number;
  supportingEvidence: string[];
  mainRisk: string;
  verifyContractAfterOpen: true;
  quoteContext: "STALE_PRIOR_SESSION";
  executable: false;
  rank: number;
  priorContractContext: string | null;
  status?: WatchlistRowStatus;
  planStatus?: PlanStatus;
  thesisScore?: number | null;
  openReadinessScore?: number | null;
  triggerText?: string | null;
  invalidationText?: string | null;
  thesis?: string | null;
  catalyst?: string | null;
  sourceTimestampMs?: number | null;
  sourceFreshness?: string;
  /** What today's session did, signed. Separate from tomorrow's trigger. */
  sessionSummary?: string | null;
  /** Where price closed relative to VWAP — why a green day can still be bearish. */
  vwapPosition?: string | null;
  rankingReason?: string | null;
  diagnosticReason?: string | null;
}

export interface OvernightPlan {
  tradingDay: string;
  builtAtMs: number;
  planVersion: string;
  recommendations: OvernightRecommendation[];
  needsMoreData: OvernightRecommendation[];
  omitted: OvernightRecommendation[];
  /** Why the plan looks the way it does — surfaced so an empty plan is explainable. */
  evidenceCompleteness?: {
    candidatesConsidered: number;
    vwap: VwapCompleteness;
    marketContext: {
      available: boolean;
      quality: string;
      broadDirection: string;
      relativeStrength: string;
    };
    blockers: string[];
  };
  marketContext: {
    spyNote: string;
    qqqNote: string;
    newsNote: string;
  };
}

export type PlanStatus = "QUALIFIED_PLAN" | "PARTIAL_PLAN" | "GENERIC_FALLBACK" | "INSUFFICIENT_DATA";

export type WatchlistVersionKind =
  | "next_session_watchlist"
  | "premarket_watchlist_update"
  | "market_open_revalidation"
  | "watchlist_delta";

export type WatchlistRowStatus =
  | "WATCH"
  | "ALMOST READY"
  | "VERIFY AT OPEN"
  | "REMOVED"
  | "INVALIDATED";

export interface NormalizedWatchlistRow {
  rank: number;
  symbol: string;
  direction: "CALL" | "PUT";
  setupFamily: string;
  trigger: string;
  invalidation: string;
  confidenceBand: "LOW" | "MEDIUM" | "HIGH";
  catalyst: string;
  status: WatchlistRowStatus;
  preferredDte: string;
  preferredMoneyness: PreferredMoneyness;
}

export interface WatchlistVersionResult {
  versionId: string;
  payloadHash: string;
  changed: boolean;
  reasons: string[];
}

type PlanDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => unknown;
};

function hasTable(db: PlanDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

/** Column presence, so a pre-migration DB degrades instead of throwing. */
function hasColumn(db: PlanDb, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return rows.some((r) => String(r.name) === column);
  } catch {
    return false;
  }
}

/** Ensure overnight_watchlist exists (idempotent). */
export function ensureOvernightWatchlistSchema(db: PlanDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS overnight_watchlist (
      trading_day TEXT NOT NULL,
      symbol TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      rank INTEGER NOT NULL,
      plan_version TEXT NOT NULL,
      built_at_ms INTEGER NOT NULL,
      PRIMARY KEY (trading_day, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_overnight_watchlist_day ON overnight_watchlist(trading_day, rank);
    -- Full plan payload, including the withheld rows and evidence diagnostics, so a
    -- READ-ONLY GET can explain an empty plan without rebuilding it.
    CREATE TABLE IF NOT EXISTS overnight_plan_snapshots (
      trading_day TEXT PRIMARY KEY,
      plan_version TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      built_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watchlist_versions (
      version_id TEXT PRIMARY KEY,
      trading_day TEXT NOT NULL,
      kind TEXT NOT NULL,
      built_at_ms INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,
      source_window TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'BUILT',
      sent_at_ms INTEGER,
      failure_reason TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watchlist_versions_day_kind ON watchlist_versions(trading_day, kind, built_at_ms);
    CREATE TABLE IF NOT EXISTS watchlist_version_symbols (
      version_id TEXT NOT NULL,
      trading_day TEXT NOT NULL,
      kind TEXT NOT NULL,
      rank INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      setup_family TEXT,
      trigger TEXT,
      invalidation TEXT,
      confidence_band TEXT,
      catalyst TEXT,
      status TEXT,
      preferred_dte TEXT,
      preferred_moneyness TEXT,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (version_id, symbol)
    );
  `);
}

type AlertStructureRow = {
  ticker: string; direction: string | null; option_side: string | null; alert_type: string | null;
  price_at_alert: number | null; vwap_at_alert: number | null; signal_score: number | null;
  capture_confidence: number | null; relative_volume: number | null; percent_move_at_alert: number | null;
  catalyst_summary: string | null; catalyst_type: string | null; public_explanation: string | null;
  alert_time: string; trading_day: string; created_at: string;
  vwap_evidence_state: string | null; vwap_freshness: string | null; vwap_session: string | null;
};

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function parseTimestamp(value: string | null | undefined): number | null {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : null;
}

function latestAlertStructures(db: PlanDb): AlertStructureRow[] {
  if (!hasTable(db, "alerts")) return [];
  try {
    // VWAP provenance columns are additive; a pre-migration DB selects NULL for
    // them so an unlabelled VWAP is never silently promoted to live evidence.
    const evidenceCols = hasColumn(db, "alerts", "vwap_evidence_state")
      ? "vwap_evidence_state, vwap_freshness, vwap_session"
      : "NULL AS vwap_evidence_state, NULL AS vwap_freshness, NULL AS vwap_session";
    const rows = db.prepare(`
      SELECT ticker, direction, option_side, alert_type, price_at_alert, vwap_at_alert,
             signal_score, capture_confidence, relative_volume, percent_move_at_alert,
             catalyst_summary, catalyst_type, public_explanation, alert_time, trading_day, created_at,
             ${evidenceCols}
      FROM alerts
      WHERE asset_class = 'options'
        AND ticker IS NOT NULL
        AND alert_time IS NOT NULL
      ORDER BY alert_time DESC
      LIMIT 200
    `).all() as AlertStructureRow[];
    const bySymbol = new Map<string, AlertStructureRow>();
    for (const row of rows) {
      const symbol = String(row.ticker ?? "").toUpperCase();
      if (!symbol || bySymbol.has(symbol)) continue;
      bySymbol.set(symbol, row);
    }
    return [...bySymbol.values()];
  } catch {
    return [];
  }
}

const UNAVAILABLE_CONTEXT = {
  spyNote: "Market context unavailable",
  qqqNote: "Market context unavailable",
  available: false,
  broadDirection: "UNAVAILABLE",
  relativeStrength: "UNAVAILABLE",
  quality: "UNAVAILABLE",
} as const;

export interface PlanMarketContext {
  spyNote: string;
  qqqNote: string;
  available: boolean;
  broadDirection: string;
  relativeStrength: string;
  quality: string;
}

/** Directional states that count as REAL context. UNKNOWN/UNAVAILABLE never do. */
const REAL_TREND_STATES = new Set(["BULLISH", "BEARISH", "NEUTRAL", "MIXED", "UP", "DOWN", "FLAT"]);

function isRealTrend(value: unknown): boolean {
  return REAL_TREND_STATES.has(String(value ?? "").toUpperCase());
}

/**
 * Market context for planning. Prefers the deterministic next-session snapshot
 * (available overnight); falls back to the live context engine's last snapshot.
 *
 * A persisted "UNKNOWN" trend is NOT context — it is the absence of context — so
 * it can never satisfy the evidence gate.
 */
function latestMarketContext(db: PlanDb): PlanMarketContext {
  const nextSession = loadNextSessionContextOnDb(db as any);
  if (nextSession) {
    return {
      spyNote: nextSession.spyNote,
      qqqNote: nextSession.qqqNote,
      available: nextSession.usableForPlanning,
      broadDirection: nextSession.broadDirection,
      relativeStrength: nextSession.relativeStrength,
      quality: nextSession.quality,
    };
  }
  if (!hasTable(db, "market_context_snapshots")) return { ...UNAVAILABLE_CONTEXT };
  try {
    const row = db.prepare(`
      SELECT spy_trend, qqq_trend, freshness, created_at_ms
      FROM market_context_snapshots ORDER BY created_at_ms DESC LIMIT 1
    `).get() as { spy_trend?: string | null; qqq_trend?: string | null; freshness?: string | null } | undefined;
    const spyReal = isRealTrend(row?.spy_trend);
    const qqqReal = isRealTrend(row?.qqq_trend);
    if (!spyReal && !qqqReal) return { ...UNAVAILABLE_CONTEXT };
    return {
      spyNote: spyReal ? `SPY trend: ${row?.spy_trend}` : "SPY context unavailable",
      qqqNote: qqqReal ? `QQQ trend: ${row?.qqq_trend}` : "QQQ context unavailable",
      available: spyReal && qqqReal,
      broadDirection: spyReal && qqqReal && row?.spy_trend === row?.qqq_trend
        ? String(row?.spy_trend).toUpperCase()
        : spyReal && qqqReal ? "MIXED" : "UNAVAILABLE",
      relativeStrength: "UNAVAILABLE",
      quality: spyReal && qqqReal ? "COMPLETE" : "PARTIAL",
    };
  } catch {
    return { ...UNAVAILABLE_CONTEXT };
  }
}

/**
 * What the session actually did, in signed terms.
 *
 * The word MUST follow the sign of the move, never the trade direction. A name
 * can close UP on the day and still be a bearish setup because it sits below
 * VWAP — SPCX did exactly that on 2026-07-30 (+0.61%, price 113.09 vs VWAP
 * 115.90) and the old code called it a "0.6% prior-session decline" because it
 * took the bearish branch and discarded the sign with Math.abs().
 */
function sessionMoveSentence(row: AlertStructureRow): string | null {
  const move = numberOrNull(row.percent_move_at_alert);
  const rvol = numberOrNull(row.relative_volume);
  if (move == null) return null;
  const magnitude = Math.abs(move).toFixed(1);
  const verb = move > 0 ? "rose" : move < 0 ? "fell" : "finished flat";
  const head = move === 0
    ? "Price finished the session flat"
    : `Price ${verb} ${magnitude}% on the session`;
  return rvol == null ? `${head}.` : `${head} on ${rvol.toFixed(1)}x relative volume.`;
}

/** Where price sat relative to VWAP — the reason a green day can still be bearish. */
function vwapPositionSentence(price: number | null, vwap: number | null, vwapLabel: string): string | null {
  if (price == null || vwap == null || vwap <= 0) return null;
  const deltaPct = ((price - vwap) / vwap) * 100;
  if (Math.abs(deltaPct) < 0.05) return `It closed right at ${vwapLabel} ${money(vwap)}.`;
  return deltaPct > 0
    ? `It closed ${deltaPct.toFixed(1)}% above ${vwapLabel} ${money(vwap)}.`
    : `It closed ${Math.abs(deltaPct).toFixed(1)}% below ${vwapLabel} ${money(vwap)}.`;
}

function plainThesis(row: AlertStructureRow, _bullish: boolean): string | null {
  const explanation = String(row.public_explanation ?? "").replace(/\s+/g, " ").trim();
  if (explanation) {
    const sentence = explanation.split(/(?<=[.!?])\s+/)[0]?.trim();
    if (sentence && sentence.length >= 24) return sentence;
  }
  return sessionMoveSentence(row);
}

function planFromAlert(db: PlanDb, row: AlertStructureRow, indexContextAvailable: boolean): OvernightRecommendation {
  const symbol = String(row.ticker).toUpperCase();
  const bearish = String(row.direction ?? row.option_side ?? "").toLowerCase().includes("bear");
  const bullish = !bearish;
  const price = numberOrNull(row.price_at_alert);
  const vwap = numberOrNull(row.vwap_at_alert);
  const sourceTimestampMs = parseTimestamp(row.alert_time) ?? parseTimestamp(row.created_at);
  const thesis = plainThesis(row, bullish);
  const score = numberOrNull(row.signal_score) ?? numberOrNull(row.capture_confidence);
  // A stored VWAP is only a usable reference when its provenance says so. Rows
  // captured before the provenance migration carry no state and are accepted as a
  // prior-session reference (their value is real; only its label is unknown).
  const vwapState = String(row.vwap_evidence_state ?? "").toUpperCase();
  const vwapUsable = vwap != null && vwap > 0 && vwapState !== "UNAVAILABLE";
  const vwapLabel = vwapState === "LIVE"
    ? "session VWAP"
    : vwapState === "PRIOR_SESSION" || vwapState === "STALE" || vwapState === ""
      ? "prior-session VWAP"
      : "VWAP";
  const missing: string[] = [];
  if (!price || price <= 0) missing.push("prior-session price");
  if (!vwapUsable) missing.push("prior-session VWAP");
  if (!sourceTimestampMs) missing.push("source timestamp");
  if (!thesis) missing.push("plain-English thesis");
  if (score == null) missing.push("signal score");

  const direction = bullish ? "bullish" : "bearish";
  // "Hold above X and reclaim it" was self-contradictory. Which instruction
  // applies depends on where price actually closed relative to the level, so
  // decide from the evidence instead of from the direction alone.
  const above = price != null && vwapUsable ? price > (vwap as number) : null;
  const triggerText = price == null ? null : bullish
    ? (above === false
      ? `Reclaim ${money(price)} after the open and hold above it.`
      : `Hold above ${money(price)} after the open.`)
    : (above === true
      ? `Lose ${money(price)} after the open and fail to reclaim it.`
      : `Stay below ${money(price)} after the open.`);
  const invalidationText = !vwapUsable ? null : bullish
    ? `Loses ${vwapLabel} near ${money(vwap as number)} and cannot reclaim it.`
    : `Reclaims ${vwapLabel} near ${money(vwap as number)} and holds above it.`;
  const triggerLevel = price;
  const invalidationLevel = vwapUsable ? vwap : null;
  const status: PlanStatus = missing.length === 0 && indexContextAvailable
    ? "QUALIFIED_PLAN"
    : missing.length === 0 ? "PARTIAL_PLAN"
    : "INSUFFICIENT_DATA";
  const thesisScore = score == null ? null : Math.max(0, Math.min(100, Math.round(score)));
  const levelClarity = price != null && vwapUsable ? 25 : 0;
  const volumeScore = Math.min(15, Math.max(0, (numberOrNull(row.relative_volume) ?? 0) * 5));
  const openReadinessScore = status === "QUALIFIED_PLAN" && thesisScore != null
    ? Math.round(Math.min(100, thesisScore * 0.55 + levelClarity + volumeScore + 5))
    : null;
  const catalyst = String(row.catalyst_summary ?? "").trim() || "No confirmed catalyst";
  return {
    symbol, bias: direction, setupFamily: String(row.alert_type ?? "prior_session_structure"),
    triggerLevel, invalidationLevel, preferredDteRange: "1-5 DTE", preferredMoneyness: "ATM or 1 strike ITM",
    contractSelectionGuidance: "Verify exact contract after options open", confidence: thesisScore ?? 0,
    supportingEvidence: [
      `Prior-session alert recorded ${row.alert_time}`,
      price != null ? `Prior close reference ${money(price)}` : "Prior close unavailable",
      vwapUsable ? `${vwapLabel} reference ${money(vwap as number)} (${row.vwap_freshness ?? "provenance unrecorded"})` : "VWAP unavailable",
    ],
    mainRisk: "A premarket gap can invalidate the prior-session structure before the options market opens.",
    verifyContractAfterOpen: true, quoteContext: "STALE_PRIOR_SESSION", executable: false, rank: 0,
    priorContractContext: priorContract(db, symbol), status: "WATCH", planStatus: status,
    thesisScore, openReadinessScore, triggerText, invalidationText, thesis, catalyst, sourceTimestampMs,
    sourceFreshness: sourceTimestampMs ? "Prior-session reference" : "Unavailable",
    sessionSummary: sessionMoveSentence(row),
    vwapPosition: vwapPositionSentence(price, vwapUsable ? (vwap as number) : null, vwapLabel),
    rankingReason: thesisScore == null ? null : `Thesis ${thesisScore}/100; levels ${price != null && vwapUsable ? "clear" : "incomplete"}; ${indexContextAvailable ? "market context aligned" : "market context unavailable"}.`,
    diagnosticReason: missing.length ? `Missing ${missing.join(", ")}.` : indexContextAvailable ? null : "Market context unavailable.",
  };
}

function priorContract(db: PlanDb, symbol: string): string | null {
  try {
    if (!hasTable(db, "options_alerts")) return null;
    const row = db.prepare(
      `SELECT option_symbol FROM options_alerts WHERE symbol = ? AND option_symbol IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    ).get(symbol) as { option_symbol?: string } | undefined;
    return row?.option_symbol ? String(row.option_symbol) : null;
  } catch {
    return null;
  }
}

/**
 * Build next-session plan from permitted historical / closed-session data.
 */
export function buildNextSessionPlan(db: PlanDb, nowMs: number = Date.now()): OvernightPlan {
  const day = tradingDay(nowMs);
  // There is deliberately NO generic fallback. A symbol reaches the published plan only by
  // carrying real prior-session evidence; when nothing qualifies, the plan is empty.
  const marketContext = latestMarketContext(db);
  const structures = latestAlertStructures(db);
  const plans = structures.map((row) => planFromAlert(db, row, marketContext.available));

  return {
    tradingDay: day,
    builtAtMs: nowMs,
    planVersion: `overnight-v2-${day}`,
    recommendations: plans
      .filter((row) => row.planStatus === "QUALIFIED_PLAN")
      .sort((a, b) => (b.openReadinessScore ?? -1) - (a.openReadinessScore ?? -1) || (b.thesisScore ?? -1) - (a.thesisScore ?? -1))
      .slice(0, 5)
      .map((row, index) => ({ ...row, rank: index + 1 })),
    needsMoreData: plans
      .filter((row) => row.planStatus === "PARTIAL_PLAN" || row.planStatus === "INSUFFICIENT_DATA"),
    omitted: [],
    evidenceCompleteness: {
      candidatesConsidered: structures.length,
      vwap: vwapCompleteness(structures as any),
      marketContext: {
        available: marketContext.available,
        quality: marketContext.quality,
        broadDirection: marketContext.broadDirection,
        relativeStrength: marketContext.relativeStrength,
      },
      blockers: [
        ...(structures.length === 0 ? ["No prior-session options alerts to plan from."] : []),
        ...(vwapCompleteness(structures as any).usableForWatchlist === 0 && structures.length > 0
          ? ["No candidate carries a usable VWAP reference."]
          : []),
        ...(marketContext.available ? [] : ["Persisted SPY/QQQ market context is not usable for planning."]),
      ],
    },
    marketContext: {
      spyNote: marketContext.spyNote,
      qqqNote: marketContext.qqqNote,
      newsNote: "No confirmed catalyst",
    },
  };
}

export function persistOvernightPlan(db: PlanDb, plan: OvernightPlan): void {
  ensureOvernightWatchlistSchema(db);
  // A clean empty plan must clear an older published version; otherwise stale
  // placeholder rows can survive after the evidence gate correctly rejects them.
  db.prepare(`DELETE FROM overnight_watchlist WHERE trading_day = ?`).run(plan.tradingDay);
  db.prepare(`
    INSERT INTO overnight_plan_snapshots (trading_day, plan_version, payload_json, built_at_ms)
    VALUES (?,?,?,?)
    ON CONFLICT(trading_day) DO UPDATE SET
      plan_version = excluded.plan_version,
      payload_json = excluded.payload_json,
      built_at_ms = excluded.built_at_ms
  `).run(plan.tradingDay, plan.planVersion, JSON.stringify(plan), plan.builtAtMs);
  for (const r of plan.recommendations) {
    db.prepare(`
      INSERT INTO overnight_watchlist (trading_day, symbol, payload_json, rank, plan_version, built_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(trading_day, symbol) DO UPDATE SET
        payload_json = excluded.payload_json,
        rank = excluded.rank,
        plan_version = excluded.plan_version,
        built_at_ms = excluded.built_at_ms
    `).run(plan.tradingDay, r.symbol, JSON.stringify(r), r.rank, plan.planVersion, plan.builtAtMs);
  }
}

export function loadOvernightPlan(db: PlanDb, day?: string): OvernightPlan | null {
  ensureOvernightWatchlistSchema(db);
  const trading = day ?? tradingDay();
  // Prefer the full persisted snapshot: it carries the withheld rows and the
  // evidence diagnostics that explain a zero-row plan.
  try {
    const snap = db.prepare(
      `SELECT payload_json FROM overnight_plan_snapshots WHERE trading_day = ?`,
    ).get(trading) as { payload_json?: string } | undefined;
    if (snap?.payload_json) return JSON.parse(snap.payload_json) as OvernightPlan;
  } catch { /* fall through to per-row reconstruction */ }
  const rows = db.prepare(
    `SELECT payload_json, rank, plan_version, built_at_ms FROM overnight_watchlist WHERE trading_day = ? ORDER BY rank ASC`,
  ).all(trading) as { payload_json: string; rank: number; plan_version: string; built_at_ms: number }[];
  if (!rows.length) return null;
  const recommendations = rows.map((r) => JSON.parse(r.payload_json) as OvernightRecommendation);
  return {
    tradingDay: trading,
    builtAtMs: rows[0]?.built_at_ms ?? Date.now(),
    planVersion: rows[0]?.plan_version ?? `overnight-v1-${trading}`,
    recommendations,
    needsMoreData: [],
    omitted: [],
    marketContext: {
      spyNote: "loaded from overnight_watchlist",
      qqqNote: "loaded from overnight_watchlist",
      newsNote: "News/earnings: UNAVAILABLE unless separately sourced — never invented",
    },
  };
}

/** Detect meaningful plan change for evening Discord delta. */
export function overnightPlanDelta(
  prev: OvernightPlan | null,
  next: OvernightPlan,
): { changed: boolean; reasons: string[] } {
  if (!prev) return { changed: true, reasons: ["initial plan"] };
  const reasons: string[] = [];
  const prevSyms = new Set(prev.recommendations.map((r) => r.symbol));
  const nextSyms = new Set(next.recommendations.map((r) => r.symbol));
  for (const s of nextSyms) if (!prevSyms.has(s)) reasons.push(`added ${s}`);
  for (const s of prevSyms) if (!nextSyms.has(s)) reasons.push(`removed ${s}`);
  for (const n of next.recommendations) {
    const p = prev.recommendations.find((x) => x.symbol === n.symbol);
    if (!p) continue;
    if (p.bias !== n.bias) reasons.push(`${n.symbol} bias ${p.bias}→${n.bias}`);
    if (p.triggerLevel != null && n.triggerLevel != null && Math.abs(p.triggerLevel - n.triggerLevel) / Math.max(1, Math.abs(p.triggerLevel)) > 0.01) {
      reasons.push(`${n.symbol} trigger moved`);
    }
  }
  return { changed: reasons.length > 0, reasons };
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function confidenceBand(confidence: number): "LOW" | "MEDIUM" | "HIGH" {
  if (confidence >= 80) return "HIGH";
  if (confidence >= 60) return "MEDIUM";
  return "LOW";
}

export function normalizeWatchlistPlan(plan: OvernightPlan): NormalizedWatchlistRow[] {
  return plan.recommendations.map((r) => ({
    rank: r.rank,
    symbol: r.symbol.toUpperCase(),
    direction: r.bias === "bearish" ? "PUT" : "CALL",
    setupFamily: r.setupFamily,
    trigger: r.triggerText ?? (r.triggerLevel == null ? "Unavailable" : String(r.triggerLevel)),
    invalidation: r.invalidationText ?? (r.invalidationLevel == null ? "Unavailable" : String(r.invalidationLevel)),
    confidenceBand: confidenceBand(r.confidence),
    catalyst: plan.marketContext.newsNote || "not stored",
    status: r.status ?? "WATCH",
    preferredDte: r.preferredDteRange,
    preferredMoneyness: r.preferredMoneyness,
  }));
}

function stableRows(rows: NormalizedWatchlistRow[]): NormalizedWatchlistRow[] {
  return rows
    .map((r) => ({ ...r }))
    .sort((a, b) => a.rank - b.rank || a.symbol.localeCompare(b.symbol));
}

function materialChangeReasons(prev: NormalizedWatchlistRow[] | null, next: NormalizedWatchlistRow[]): string[] {
  if (!prev) return ["initial watchlist version"];
  const reasons: string[] = [];
  const prevBySymbol = new Map(prev.map((r) => [r.symbol, r]));
  const nextBySymbol = new Map(next.map((r) => [r.symbol, r]));
  for (const s of nextBySymbol.keys()) if (!prevBySymbol.has(s)) reasons.push(`symbol added ${s}`);
  for (const s of prevBySymbol.keys()) if (!nextBySymbol.has(s)) reasons.push(`symbol removed ${s}`);
  for (const [symbol, n] of nextBySymbol.entries()) {
    const p = prevBySymbol.get(symbol);
    if (!p) continue;
    if (p.direction !== n.direction) reasons.push(`${symbol} direction ${p.direction}->${n.direction}`);
    if (Math.abs(p.rank - n.rank) >= 2) reasons.push(`${symbol} rank ${p.rank}->${n.rank}`);
    if (p.confidenceBand !== n.confidenceBand) reasons.push(`${symbol} confidence ${p.confidenceBand}->${n.confidenceBand}`);
    if (p.catalyst !== n.catalyst) reasons.push(`${symbol} catalyst changed`);
    if (p.status !== n.status) reasons.push(`${symbol} status ${p.status}->${n.status}`);
    if (p.status !== "ALMOST READY" && n.status === "ALMOST READY") reasons.push(`${symbol} almost ready`);
    if (p.status !== "INVALIDATED" && n.status === "INVALIDATED") reasons.push(`${symbol} invalidated`);
    if (p.trigger !== n.trigger && p.trigger !== "VERIFY AT OPEN" && n.trigger !== "VERIFY AT OPEN") reasons.push(`${symbol} trigger changed`);
    if (p.invalidation !== n.invalidation && p.invalidation !== "VERIFY AT OPEN" && n.invalidation !== "VERIFY AT OPEN") reasons.push(`${symbol} invalidation changed`);
  }
  return reasons;
}

function latestRowsForComparison(db: PlanDb, tradingDay: string, kind: WatchlistVersionKind, compareAnyKind: boolean): NormalizedWatchlistRow[] | null {
  ensureOvernightWatchlistSchema(db);
  const where = compareAnyKind ? "trading_day=?" : "trading_day=? AND kind=?";
  const args = compareAnyKind ? [tradingDay] : [tradingDay, kind];
  const version = db.prepare(
    `SELECT version_id FROM watchlist_versions WHERE ${where} ORDER BY built_at_ms DESC LIMIT 1`,
  ).get(...args) as { version_id?: string } | undefined;
  if (!version?.version_id) return null;
  const rows = db.prepare(
    `SELECT payload_json FROM watchlist_version_symbols WHERE version_id=? ORDER BY rank ASC`,
  ).all(version.version_id) as { payload_json: string }[];
  return rows.map((r) => JSON.parse(r.payload_json) as NormalizedWatchlistRow);
}

export function persistWatchlistVersionOnDb(
  db: PlanDb,
  plan: OvernightPlan,
  opts: { kind: WatchlistVersionKind; sourceWindow: string; compareAnyKind?: boolean },
): WatchlistVersionResult {
  ensureOvernightWatchlistSchema(db);
  const rows = stableRows(normalizeWatchlistPlan(plan));
  const payload = {
    tradingDay: plan.tradingDay,
    kind: opts.kind,
    sourceWindow: opts.sourceWindow,
    marketContext: plan.marketContext,
    rows,
  };
  const payloadHash = djb2(JSON.stringify(payload));
  const versionId = `wl_${plan.tradingDay}_${opts.kind}_${payloadHash}`.replace(/[^A-Za-z0-9_]/g, "_");
  const prevRows = latestRowsForComparison(db, plan.tradingDay, opts.kind, Boolean(opts.compareAnyKind));
  const reasons = materialChangeReasons(prevRows, rows);
  const changed = reasons.length > 0;
  db.prepare(
    `INSERT OR IGNORE INTO watchlist_versions
      (version_id, trading_day, kind, built_at_ms, payload_hash, source_window, payload_json, status, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(versionId, plan.tradingDay, opts.kind, plan.builtAtMs, payloadHash, opts.sourceWindow, JSON.stringify(payload), "BUILT", plan.builtAtMs, plan.builtAtMs);
  const insertSymbol = db.prepare(
    `INSERT OR IGNORE INTO watchlist_version_symbols
      (version_id, trading_day, kind, rank, symbol, direction, setup_family, trigger, invalidation,
       confidence_band, catalyst, status, preferred_dte, preferred_moneyness, payload_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows) {
    insertSymbol.run(
      versionId,
      plan.tradingDay,
      opts.kind,
      r.rank,
      r.symbol,
      r.direction,
      r.setupFamily,
      r.trigger,
      r.invalidation,
      r.confidenceBand,
      r.catalyst,
      r.status,
      r.preferredDte,
      r.preferredMoneyness,
      JSON.stringify(r),
    );
  }
  return { versionId, payloadHash, changed, reasons };
}

export function markWatchlistVersionOnDb(
  db: PlanDb,
  versionId: string,
  status: "SENT" | "SUPPRESSED_UNCHANGED" | "SKIPPED_NO_WEBHOOK" | "FAILED",
  nowMs: number,
  failureReason: string | null = null,
): void {
  ensureOvernightWatchlistSchema(db);
  db.prepare(
    `UPDATE watchlist_versions
       SET status=?, sent_at_ms=CASE WHEN ?='SENT' THEN ? ELSE sent_at_ms END,
           failure_reason=?, updated_at_ms=?
     WHERE version_id=?`,
  ).run(status, status, nowMs, failureReason, nowMs, versionId);
}
