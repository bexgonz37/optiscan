/**
 * Risk + day-cap gates for Aggressive 0DTE Research (paper-only).
 */

import type { ZeroDteResearchConfig } from "./config.ts";

export interface RiskDb {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
}

export interface RiskSnapshot {
  equityUsd: number;
  openCount: number;
  openRiskUsd: number;
  openExposureUsd: number;
  tradesToday: number;
  spyToday: number;
  qqqToday: number;
  symbolToday: number;
}

function dayStartEtMs(nowMs: number): number {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
  // Approximate ET midnight as UTC offset lookup via Date parse of noon then back — use 04:00 UTC as ET midnight EST proxy.
  // Prefer: construct from parts.
  const [y, m, d] = date.split("-").map(Number);
  // ET midnight ≈ previous day 05:00 UTC during EDT, 04:00 during EST — use Date with explicit offset via locale.
  const probe = new Date(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T12:00:00-04:00`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).formatToParts(probe);
  const hourEt = Number(parts.find((p) => p.type === "hour")?.value ?? 12);
  return probe.getTime() - hourEt * 3600_000;
}

export function readRiskSnapshot(
  db: RiskDb,
  symbol: string,
  equityUsd: number,
  nowMs: number,
): RiskSnapshot {
  const since = dayStartEtMs(nowMs);
  const open = db.prepare(
    `SELECT COUNT(*) n,
            COALESCE(SUM(account_risk_usd),0) risk,
            COALESCE(SUM(entry_fill * 100),0) exposure
       FROM options_paper_trades
      WHERE paper_kind='ZERO_DTE_RESEARCH_PAPER' AND status='ENTERED'`,
  ).get() as { n?: number; risk?: number; exposure?: number };
  const today = db.prepare(
    `SELECT COUNT(*) n FROM options_paper_trades
      WHERE paper_kind='ZERO_DTE_RESEARCH_PAPER' AND entered_at_ms >= ?`,
  ).get(since) as { n?: number };
  const spy = db.prepare(
    `SELECT COUNT(*) n FROM options_paper_trades
      WHERE paper_kind='ZERO_DTE_RESEARCH_PAPER' AND entered_at_ms >= ?
        AND option_symbol LIKE 'O:SPY%'`,
  ).get(since) as { n?: number };
  const qqq = db.prepare(
    `SELECT COUNT(*) n FROM options_paper_trades
      WHERE paper_kind='ZERO_DTE_RESEARCH_PAPER' AND entered_at_ms >= ?
        AND option_symbol LIKE 'O:QQQ%'`,
  ).get(since) as { n?: number };
  const sym = symbol.toUpperCase();
  const perSym = db.prepare(
    `SELECT COUNT(*) n FROM options_paper_trades
      WHERE paper_kind='ZERO_DTE_RESEARCH_PAPER' AND entered_at_ms >= ?
        AND option_symbol LIKE ?`,
  ).get(since, `O:${sym}%`) as { n?: number };
  return {
    equityUsd,
    openCount: Number(open?.n ?? 0),
    openRiskUsd: Number(open?.risk ?? 0),
    openExposureUsd: Number(open?.exposure ?? 0),
    tradesToday: Number(today?.n ?? 0),
    spyToday: Number(spy?.n ?? 0),
    qqqToday: Number(qqq?.n ?? 0),
    symbolToday: Number(perSym?.n ?? 0),
  };
}

export function proposeRiskUsd(equityUsd: number, cfg: ZeroDteResearchConfig): number {
  return +((equityUsd * cfg.riskPct) / 100).toFixed(2);
}

export function canOpenZeroDteResearch(
  snap: RiskSnapshot,
  symbol: string,
  proposedRiskUsd: number,
  proposedExposureUsd: number,
  cfg: ZeroDteResearchConfig,
): { ok: boolean; reason: string | null } {
  if (snap.openCount >= cfg.maxOpenTrades) return { ok: false, reason: "max_open_trades" };
  if (snap.tradesToday >= cfg.maxTradesPerDay) return { ok: false, reason: "max_trades_per_day" };
  if (snap.symbolToday >= cfg.maxPerSymbol) return { ok: false, reason: "max_per_symbol" };
  const s = symbol.toUpperCase();
  if (s === "SPY" && snap.spyToday >= cfg.maxSpyPerDay) return { ok: false, reason: "max_spy_per_day" };
  if (s === "QQQ" && snap.qqqToday >= cfg.maxQqqPerDay) return { ok: false, reason: "max_qqq_per_day" };
  const maxOpenRisk = (snap.equityUsd * cfg.maxOpenRiskPct) / 100;
  if (snap.openRiskUsd + proposedRiskUsd > maxOpenRisk) return { ok: false, reason: "max_open_risk" };
  const maxExposure = (snap.equityUsd * cfg.maxExposurePct) / 100;
  if (snap.openExposureUsd + proposedExposureUsd > maxExposure) return { ok: false, reason: "max_exposure" };
  if (proposedRiskUsd <= 0) return { ok: false, reason: "invalid_risk" };
  return { ok: true, reason: null };
}

export function fingerprintTaken(db: RiskDb, fingerprint: string): boolean {
  return Boolean(
    db.prepare(
      `SELECT 1 FROM options_paper_trades WHERE paper_kind='ZERO_DTE_RESEARCH_PAPER' AND fingerprint=? LIMIT 1`,
    ).get(fingerprint),
  );
}
