/**
 * terminal-view.ts — PURE presentation helpers for the Trading Terminal page.
 * No I/O, no fetch, no @/-alias imports (so it is unit-testable under bare node
 * and free of side effects). It only formats + classifies data the existing APIs
 * already return; it never fabricates values (missing → "N/A") and changes NO
 * scanner / paper / AI / Discord / provider logic.
 */
import { formatExpiryLabel, formatStrikeLabel } from "./callouts/option-line.ts";

export type StatusState = "LIVE" | "DEGRADED" | "BLOCKED" | "STALE" | "OFFLINE" | "OFF";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** N/A-safe number formatting. */
export function fmtNum(v: unknown, digits = 2): string {
  return isNum(v) ? Number(v).toFixed(digits) : "N/A";
}
export function fmtPct(v: unknown, digits = 2): string {
  return isNum(v) ? `${Number(v) >= 0 ? "" : ""}${Number(v).toFixed(digits)}%` : "N/A";
}
export function fmtUsd(v: unknown, digits = 2): string {
  return isNum(v) ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}` : "N/A";
}
/** Compact volume: 1_200_000 → "1.2M". */
export function fmtVol(v: unknown): string {
  if (!isNum(v)) return "N/A";
  const n = Number(v);
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** The EXACT canonical Discord one-line, e.g. "$AAPL 17 JUL 26 $322.5 CALL $1.70". */
export function terminalContractLine(a: {
  ticker?: string | null;
  strike?: number | null;
  side?: string | null;
  expiration?: string | null;
  price?: number | null;
}): string | null {
  const exp = formatExpiryLabel(a.expiration);
  const strike = formatStrikeLabel(a.strike ?? null);
  if (!a.ticker || !exp || !strike || !a.side) return null;
  const side = String(a.side).toUpperCase().startsWith("P") ? "PUT" : "CALL";
  const price = isNum(a.price) && Number(a.price) > 0 ? ` $${Number(a.price).toFixed(2)}` : "";
  return `$${String(a.ticker).toUpperCase()} ${exp} $${strike} ${side}${price}`;
}

/** Semantic color token (maps to CSS classes) for a momentum classification. */
export function classificationTone(cls: string | null | undefined): "pos" | "info" | "warn" | "neg" | "muted" {
  switch (String(cls ?? "").toUpperCase()) {
    case "FRESH_ACCELERATION": return "pos";
    case "EARLY_CONTINUATION":
    case "CONTINUATION": return "info";
    case "SLOW_GRINDER": return "warn";
    case "LATE_EXHAUSTION": return "neg";
    case "NOISY_ILLIQUID_SPIKE": return "muted";
    default: return "muted";
  }
}

/** Sign tone for a numeric value (green/red/neutral). */
export function signTone(v: unknown): "pos" | "neg" | "muted" {
  if (!isNum(v)) return "muted";
  return Number(v) > 0 ? "pos" : Number(v) < 0 ? "neg" : "muted";
}

/** A readiness channel → a compact terminal state word. */
export function readinessState(ch: { ready?: boolean; blockedBy?: string[] } | null | undefined): StatusState {
  if (!ch) return "OFFLINE";
  if (ch.ready) return "LIVE";
  return "BLOCKED";
}

/**
 * A running/last-cycle heartbeat → LIVE / STALE / OFFLINE. `staleMs` is how old
 * the last successful cycle may be before it reads STALE.
 */
export function heartbeatState(running: boolean | undefined, lastAtMs: number | null | undefined, nowMs: number, staleMs = 120_000): StatusState {
  if (!running) return "OFFLINE";
  if (!isNum(lastAtMs)) return "STALE";
  return nowMs - Number(lastAtMs) <= staleMs ? "LIVE" : "STALE";
}

export interface StatusIndicator { label: string; value: string; state: StatusState }

/**
 * Build the top status-bar indicators from the shapes the existing endpoints
 * already return (runtime/status readiness + funnel + healthz). Defensive: any
 * missing field reads OFFLINE/N/A rather than throwing.
 */
export function deriveStatusIndicators(input: {
  session?: string | null;
  etTime?: string | null;
  deploySha?: string | null;
  providerHealthy?: boolean | null;
  scannerRunning?: boolean | null;
  lastScanAtMs?: number | null;
  supervisorRunning?: boolean | null;
  lastOptionsAtMs?: number | null;
  stockReady?: { ready?: boolean; blockedBy?: string[] } | null;
  optionsReady?: { ready?: boolean; blockedBy?: string[] } | null;
  paperEnabled?: boolean | null;
  aiEnabled?: boolean | null;
  nowMs?: number;
}): StatusIndicator[] {
  const now = input.nowMs ?? Date.now();
  return [
    { label: "SESSION", value: (input.session ?? "N/A").toUpperCase(), state: input.session ? "LIVE" : "OFFLINE" },
    { label: "ET", value: input.etTime ?? "N/A", state: input.etTime ? "LIVE" : "STALE" },
    { label: "SHA", value: input.deploySha ? String(input.deploySha).slice(0, 7) : "N/A", state: input.deploySha ? "LIVE" : "OFFLINE" },
    { label: "PROVIDER", value: input.providerHealthy ? "OK" : "DEGRADED", state: input.providerHealthy ? "LIVE" : "DEGRADED" },
    { label: "SCANNER", value: statusWord(heartbeatState(!!input.scannerRunning, input.lastScanAtMs, now)), state: heartbeatState(!!input.scannerRunning, input.lastScanAtMs, now) },
    { label: "OPTIONS", value: statusWord(heartbeatState(!!input.supervisorRunning, input.lastOptionsAtMs, now)), state: heartbeatState(!!input.supervisorRunning, input.lastOptionsAtMs, now) },
    { label: "DISCORD·STK", value: statusWord(readinessState(input.stockReady)), state: readinessState(input.stockReady) },
    { label: "DISCORD·OPT", value: statusWord(readinessState(input.optionsReady)), state: readinessState(input.optionsReady) },
    { label: "PAPER", value: input.paperEnabled ? "ON" : "OFF", state: input.paperEnabled ? "LIVE" : "OFF" },
    { label: "AI", value: input.aiEnabled ? "ON" : "OFF", state: input.aiEnabled ? "LIVE" : "OFF" },
  ];
}

function statusWord(s: StatusState): string { return s; }

// ── Movers table: deterministic sort + filter (pure) ─────────────────────────

export interface MoverFilter {
  search?: string;
  classification?: string;  // "" = all
  actionable?: "all" | "actionable" | "rejected";
}

export function filterMovers<T extends { symbol?: string; classification?: string | null; stockPolicyOk?: boolean }>(
  rows: T[], f: MoverFilter,
): T[] {
  const q = String(f.search ?? "").trim().toUpperCase();
  return rows.filter((r) => {
    if (q && !String(r.symbol ?? "").toUpperCase().includes(q)) return false;
    if (f.classification && String(r.classification ?? "") !== f.classification) return false;
    if (f.actionable === "actionable" && r.stockPolicyOk !== true) return false;
    if (f.actionable === "rejected" && r.stockPolicyOk === true) return false;
    return true;
  });
}

/** Stable sort by a numeric-or-string key; nullish always sorts last. */
export function sortRows<T extends Record<string, any>>(rows: T[], key: string, dir: "asc" | "desc"): T[] {
  const mul = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a?.[key]; const bv = b?.[key];
    const an = av == null || av === ""; const bn = bv == null || bv === "";
    if (an && bn) return 0;
    if (an) return 1;   // nulls last regardless of dir
    if (bn) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * mul;
    return String(av).localeCompare(String(bv)) * mul;
  });
}

// ── Paper portfolios: normalize the 3 accounts for tabbed display ────────────

export interface PaperPortfolioView {
  name: string;
  key: "PRIMARY" | "CHALLENGE" | "STOCK_DAY_TRADER";
  equity: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  openPositions: number | null;
  enabled: boolean;
}

export function paperPortfolios(data: any): PaperPortfolioView[] {
  const primary: PaperPortfolioView = {
    name: "Primary", key: "PRIMARY", enabled: true,
    equity: data?.account?.equity ?? null,
    realizedPnl: data?.summary?.totalPnlDollars ?? data?.account?.realizedPnl ?? null,
    unrealizedPnl: data?.summary?.unrealizedPnlDollars ?? null,
    openPositions: Array.isArray(data?.trades) ? data.trades.filter((t: any) => t?.status === "ENTERED").length : null,
  };
  const c = data?.challenge ?? null;
  const challenge: PaperPortfolioView = {
    name: "Aggressive Challenge", key: "CHALLENGE", enabled: !!c?.enabled,
    equity: c?.equity ?? null, realizedPnl: c?.realizedPnl ?? null,
    unrealizedPnl: c?.unrealizedPnl ?? null, openPositions: c?.openPositions ?? null,
  };
  const sd = data?.stockDayTrader ?? data?.stockDay ?? null;
  const stockDay: PaperPortfolioView = {
    name: "Stock Day Trader", key: "STOCK_DAY_TRADER", enabled: !!sd,
    equity: sd?.equity ?? null, realizedPnl: sd?.realizedPnl ?? null,
    unrealizedPnl: sd?.unrealizedPnl ?? null, openPositions: sd?.openPositions ?? null,
  };
  return [primary, challenge, stockDay];
}
