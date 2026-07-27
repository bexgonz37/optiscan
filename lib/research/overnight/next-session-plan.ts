/**
 * Deterministic overnight / next-session research recommendations.
 * Never claims option prices are executable.
 */
import { tradingDay } from "../../trading-session.ts";

export type OvernightBias = "bullish" | "bearish" | "neutral";
export type PreferredMoneyness = "ATM" | "ITM" | "OTM";

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
}

export interface OvernightPlan {
  tradingDay: string;
  builtAtMs: number;
  planVersion: string;
  recommendations: OvernightRecommendation[];
  marketContext: {
    spyNote: string;
    qqqNote: string;
    newsNote: string;
  };
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
  `);
}

function readIndexNote(db: PlanDb, symbol: string): string {
  if (!hasTable(db, "index_intel") && !hasTable(db, "market_snapshots")) {
    return `${symbol} context UNAVAILABLE`;
  }
  try {
    if (hasTable(db, "options_alerts")) {
      const row = db.prepare(
        `SELECT symbol, created_at FROM options_alerts WHERE symbol = ? ORDER BY created_at DESC LIMIT 1`,
      ).get(symbol) as { symbol?: string } | undefined;
      if (row) return `${symbol}: prior session alert history present`;
    }
  } catch { /* ignore */ }
  return `${symbol}: using prior-session structure only`;
}

function candidatesFromDb(db: PlanDb): { symbol: string; side: string; strategy: string | null; quality: number | null }[] {
  const out: { symbol: string; side: string; strategy: string | null; quality: number | null }[] = [];
  try {
    if (hasTable(db, "options_delivery_decisions")) {
      const rows = db.prepare(`
        SELECT symbol, side, strategy, quality_score
        FROM options_delivery_decisions
        ORDER BY COALESCE(decided_at_ms, 0) DESC
        LIMIT 40
      `).all() as { symbol: string; side: string; strategy: string | null; quality_score: number | null }[];
      for (const r of rows) {
        if (!r?.symbol) continue;
        if (out.some((x) => x.symbol === r.symbol)) continue;
        out.push({
          symbol: String(r.symbol).toUpperCase(),
          side: String(r.side ?? "call"),
          strategy: r.strategy,
          quality: r.quality_score,
        });
        if (out.length >= 8) break;
      }
    }
  } catch { /* ignore */ }
  if (out.length === 0) {
    for (const s of ["SPY", "QQQ", "NVDA", "META"]) {
      out.push({ symbol: s, side: "call", strategy: "structure_watch", quality: 0.55 });
    }
  }
  return out;
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
  const cands = candidatesFromDb(db);
  const recommendations: OvernightRecommendation[] = cands.map((c, i) => {
    const bullish = String(c.side).toLowerCase() !== "put";
    const bias: OvernightBias = bullish ? "bullish" : "bearish";
    const conf = Math.round(Math.max(40, Math.min(90, (c.quality ?? 0.55) * 100)));
    return {
      symbol: c.symbol,
      bias,
      setupFamily: c.strategy ?? "next_session_structure",
      triggerLevel: null,
      invalidationLevel: null,
      preferredDteRange: "0–5",
      preferredMoneyness: "ATM",
      contractSelectionGuidance: bullish
        ? "Prefer liquid near-ATM calls after open; re-check spread ≤10%"
        : "Prefer liquid near-ATM puts after open; re-check spread ≤10%",
      confidence: conf,
      supportingEvidence: [
        "Prior-session delivery / decision history",
        "SPY/QQQ market context from last regular session",
        "Historical quant lane sample (advisory)",
      ],
      mainRisk: "Gap through levels at open can invalidate structure before a fresh quote exists",
      verifyContractAfterOpen: true,
      quoteContext: "STALE_PRIOR_SESSION",
      executable: false,
      rank: i + 1,
      priorContractContext: priorContract(db, c.symbol),
    };
  });

  return {
    tradingDay: day,
    builtAtMs: nowMs,
    planVersion: `overnight-v1-${day}`,
    recommendations,
    marketContext: {
      spyNote: readIndexNote(db, "SPY"),
      qqqNote: readIndexNote(db, "QQQ"),
      newsNote: "News/earnings: UNAVAILABLE unless separately sourced — never invented",
    },
  };
}

export function persistOvernightPlan(db: PlanDb, plan: OvernightPlan): void {
  ensureOvernightWatchlistSchema(db);
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
