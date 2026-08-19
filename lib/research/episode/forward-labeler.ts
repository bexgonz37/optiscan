/**
 * Phase 2A automatic forward labels for SetupEpisodeV2.
 *
 * Slow path only. This module reads evidence already persisted in SQLite and
 * issues exactly ZERO provider requests. Zone A is never updated. Labels are
 * deterministic, versioned, append-only, exact-OCC fenced, and written only
 * after a horizon plus an evidence-arrival grace period has matured.
 */
import { createHash } from "node:crypto";
import { marketSession, tradingDay } from "../../trading-session.ts";
import { regularCloseMs } from "../../market-session-guard.ts";
import {
  appendEpisodeActionOnDb,
  appendOutcomeLabelV2OnDb,
  type CompetingEventOrder,
  type OutcomeHorizonV2,
  type OutcomeLabelV2,
} from "./v2.ts";

export const FORWARD_LABEL_VERSION = "FORWARD_LABEL_V1" as const;
export const FORWARD_EVIDENCE_VERSION = "PERSISTED_EVIDENCE_V1" as const;
export const FORWARD_ENTRY_CONVENTION = "BUY_AT_ASK_EXIT_AT_FUTURE_BID" as const;
export const FORWARD_HORIZONS: readonly OutcomeHorizonV2[] = Object.freeze(["5m", "15m", "30m", "60m", "session"]);

const HORIZON_MS: Record<Exclude<OutcomeHorizonV2, "session">, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "60m": 60 * 60_000,
};

type Db = {
  prepare: (sql: string) => {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run: (...a: any[]) => { changes: number };
  };
};

export interface ForwardLabelConfig {
  batchLimit: number;
  maxRunMs: number;
  evidenceGraceMs: number;
  maxQuoteAgeMs: number;
  maxOptionGapMs: number;
  maxUnderlyingGapMs: number;
  endpointToleranceMs: number;
  maxQuotesPerSource: number;
}

function clamp(v: string | undefined, d: number, lo: number, hi: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : d;
}

export function forwardLabelConfig(env: NodeJS.ProcessEnv = process.env): ForwardLabelConfig {
  return {
    batchLimit: clamp(env.FORWARD_LABEL_BATCH_LIMIT, 10, 1, 100),
    maxRunMs: clamp(env.FORWARD_LABEL_MAX_RUN_MS, 8_000, 500, 30_000),
    evidenceGraceMs: clamp(env.FORWARD_LABEL_EVIDENCE_GRACE_MS, 120_000, 30_000, 15 * 60_000),
    maxQuoteAgeMs: clamp(env.FORWARD_LABEL_MAX_QUOTE_AGE_MS, 60_000, 5_000, 5 * 60_000),
    maxOptionGapMs: clamp(env.FORWARD_LABEL_MAX_OPTION_GAP_MS, 5 * 60_000, 30_000, 15 * 60_000),
    maxUnderlyingGapMs: clamp(env.FORWARD_LABEL_MAX_UNDERLYING_GAP_MS, 2 * 60_000, 60_000, 15 * 60_000),
    endpointToleranceMs: clamp(env.FORWARD_LABEL_ENDPOINT_TOLERANCE_MS, 90_000, 15_000, 5 * 60_000),
    maxQuotesPerSource: clamp(env.FORWARD_LABEL_MAX_QUOTES_PER_SOURCE, 25_000, 500, 100_000),
  };
}

interface EpisodeRow {
  episode_key: string;
  symbol: string;
  t0_ms: number;
  trading_day: string;
  session: string;
  direction: string | null;
  population: string | null;
  selected_strategy: string | null;
  selection_strength: number | null;
  selected_occ: string | null;
  entry_convention: string | null;
  config_digest: string;
  production_sha: string | null;
  opportunity_case_id: string | null;
  thesis_fingerprint: string | null;
  zone_a_json: string | null;
}

type QuotePoint = {
  atMs: number;
  bid: number | null;
  ask: number | null;
  quoteAgeMs: number | null;
  source: string;
};

export type UnderlyingBarPoint = {
  atMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  source: string;
  quality: string;
};

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function upper(v: unknown): string | null {
  const s = String(v ?? "").trim().toUpperCase();
  return s || null;
}

function hasTable(db: Db, table: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
  catch { return false; }
}

function parseJson<T>(raw: unknown, fallback: T): T {
  try { return raw == null ? fallback : JSON.parse(String(raw)) as T; }
  catch { return fallback; }
}

function evidenceValue(zone: any, group: string, key: string): unknown {
  return zone?.[group]?.[key]?.value ?? null;
}

function entryEvidence(ep: EpisodeRow): {
  eligible: boolean; occ: string | null; ask: number | null; bid: number | null;
  quoteAtMs: number | null; quoteAgeMs: number | null; spreadPct: number | null;
  stopPrice: number | null; reason: string | null;
} {
  const zone = parseJson<any>(ep.zone_a_json, {});
  const occ = upper(evidenceValue(zone, "option", "occ") ?? ep.selected_occ);
  const ask = num(evidenceValue(zone, "option", "ask"));
  const bid = num(evidenceValue(zone, "option", "bid"));
  const quoteAtMs = num(evidenceValue(zone, "option", "quoteTimestamp"));
  const quoteAgeMs = num(evidenceValue(zone, "option", "quoteAgeMs"));
  const spreadPct = num(evidenceValue(zone, "option", "spreadPct"));
  const executable = evidenceValue(zone, "option", "executableAtT0") === true;
  const snap = evidenceValue(zone, "optiscan", "sharedFeatureSnapshot") as any;
  const stopPrice = num(snap?.targetStop ?? snap?.target_stop ?? snap?.stopPrice ?? snap?.stop ?? null);
  if (!occ) return { eligible: false, occ, ask, bid, quoteAtMs, quoteAgeMs, spreadPct, stopPrice, reason: "NO_OCC" };
  if (ep.entry_convention !== FORWARD_ENTRY_CONVENTION) {
    return { eligible: false, occ, ask, bid, quoteAtMs, quoteAgeMs, spreadPct, stopPrice, reason: "NO_CONTEMPORANEOUS_EXECUTABLE_QUOTE" };
  }
  if (!executable || ask == null || ask <= 0 || bid == null || bid <= 0 || ask <= bid || quoteAtMs == null || quoteAgeMs == null || quoteAgeMs > 60_000) {
    return { eligible: false, occ, ask, bid, quoteAtMs, quoteAgeMs, spreadPct, stopPrice, reason: "NO_CONTEMPORANEOUS_EXECUTABLE_QUOTE" };
  }
  return { eligible: true, occ, ask, bid, quoteAtMs, quoteAgeMs, spreadPct, stopPrice, reason: null };
}

function underlyingEntry(ep: EpisodeRow): number | null {
  return num(evidenceValue(parseJson<any>(ep.zone_a_json, {}), "underlying", "price"));
}

export function horizonEndAtMs(ep: Pick<EpisodeRow, "t0_ms" | "trading_day">, horizon: OutcomeHorizonV2, env: NodeJS.ProcessEnv = process.env): number {
  return horizon === "session" ? regularCloseMs(ep.trading_day, env) : ep.t0_ms + HORIZON_MS[horizon];
}

export function horizonMatured(ep: Pick<EpisodeRow, "t0_ms" | "trading_day">, horizon: OutcomeHorizonV2, nowMs: number, cfg: ForwardLabelConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return nowMs >= horizonEndAtMs(ep, horizon, env) + cfg.evidenceGraceMs;
}

function round(n: number): number { return Math.round(n * 10_000) / 10_000; }
function ret(exit: number, entry: number): number { return round(((exit - entry) / entry) * 100); }
function directionReturn(price: number, entry: number, bearish: boolean): number {
  return round(((bearish ? entry - price : price - entry) / entry) * 100);
}

export function competingOrder(firstAt: number | null, secondAt: number | null, sameBar = false): CompetingEventOrder {
  if (firstAt == null && secondAt == null) return "NEITHER";
  if (firstAt != null && secondAt == null) return "FIRST_EVENT";
  if (firstAt == null && secondAt != null) return "SECOND_EVENT";
  if (firstAt === secondAt) return sameBar ? "AMBIGUOUS_INTRABAR" : "AMBIGUOUS";
  return (firstAt as number) < (secondAt as number) ? "FIRST_EVENT" : "SECOND_EVENT";
}

function legacyBefore(order: CompetingEventOrder): boolean | null {
  return order === "FIRST_EVENT" ? true : order === "SECOND_EVENT" ? false : null;
}

function largestGap(times: number[], startMs: number, endMs: number): number | null {
  if (!times.length) return null;
  let largest = Math.max(0, times[0] - startMs);
  for (let i = 1; i < times.length; i++) largest = Math.max(largest, times[i] - times[i - 1]);
  return Math.max(largest, Math.max(0, endMs - times[times.length - 1]));
}

function labelId(ep: EpisodeRow, kind: OutcomeLabelV2["labelKind"], horizon: OutcomeHorizonV2): string {
  const material = `${ep.episode_key}|${kind}|${horizon}|${FORWARD_LABEL_VERSION}|${ep.config_digest}`;
  return `lbl2_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

function emptyLabel(ep: EpisodeRow, kind: OutcomeLabelV2["labelKind"], horizon: OutcomeHorizonV2, endMs: number, nowMs: number, reason: string, extra: Partial<OutcomeLabelV2> = {}): OutcomeLabelV2 {
  const entry = entryEvidence(ep);
  return {
    labelId: labelId(ep, kind, horizon), episodeKey: ep.episode_key, labelKind: kind, horizon,
    exactOcc: kind === "EXACT_OPTION_EXECUTABLE_LABEL" ? entry.occ : null,
    entryConvention: kind === "EXACT_OPTION_EXECUTABLE_LABEL" ? FORWARD_ENTRY_CONVENTION : null,
    terminalReturnPct: null, mfePct: null, maePct: null,
    hit10: null, hit25: null, hit50: null, hit100: null, hit200: null,
    hitNeg10: null, hitNeg20: null, hitStop: null,
    timeTo10Ms: null, timeTo25Ms: null, timeTo50Ms: null, timeTo100Ms: null, timeTo200Ms: null,
    timeToNeg10Ms: null, timeToNeg20Ms: null, timeToStopMs: null, timeToMfeMs: null, timeToMaeMs: null,
    plus10BeforeNeg10: null, plus25BeforeNeg20: null, plus50BeforeStop: null,
    stopBeforePlus25: null, plus100BeforeStop: null,
    plus10VsNeg10Order: "UNKNOWN", plus25VsNeg20Order: "UNKNOWN",
    plus50VsStopOrder: "NOT_APPLICABLE", stopVsPlus25Order: "NOT_APPLICABLE", plus100VsStopOrder: "NOT_APPLICABLE",
    coverage: "INSUFFICIENT", censored: true, missingReason: reason,
    quoteCount: 0, firstEvidenceAtMs: null, lastEvidenceAtMs: null,
    requestedEndAtMs: endMs, evidenceCoverageMs: null, largestGapMs: null,
    entryPrice: kind === "EXACT_OPTION_EXECUTABLE_LABEL" ? entry.ask : underlyingEntry(ep),
    entryQuoteAtMs: kind === "EXACT_OPTION_EXECUTABLE_LABEL" ? entry.quoteAtMs : ep.t0_ms,
    entryQuoteAgeMs: kind === "EXACT_OPTION_EXECUTABLE_LABEL" ? entry.quoteAgeMs : 0,
    entrySpreadPct: kind === "EXACT_OPTION_EXECUTABLE_LABEL" ? entry.spreadPct : null,
    exitPrice: null, evidenceSource: "PERSISTED_SQLITE_EVIDENCE", evidenceVersion: FORWARD_EVIDENCE_VERSION,
    productionSha: ep.production_sha, evidenceQuality: "NONE", intrabarStatus: "NOT_APPLICABLE",
    labelVersion: FORWARD_LABEL_VERSION, labelAsOfMs: nowMs, configDigest: ep.config_digest,
    ...extra,
  };
}

export function evaluateOptionPath(input: {
  episode: EpisodeRow; horizon: OutcomeHorizonV2; endMs: number; nowMs: number;
  points: QuotePoint[]; providerAdmissionConstrained?: boolean; truncated?: boolean;
  config: ForwardLabelConfig;
}): OutcomeLabelV2 {
  const { episode: ep, endMs, nowMs, config: cfg } = input;
  const entry = entryEvidence(ep);
  if (!entry.eligible || entry.ask == null) return emptyLabel(ep, "EXACT_OPTION_EXECUTABLE_LABEL", input.horizon, endMs, nowMs, entry.reason ?? "NO_CONTEMPORANEOUS_EXECUTABLE_QUOTE");
  const rejected = input.points.filter((p) => {
    const bid = num(p.bid), ask = num(p.ask);
    return bid == null || bid < 0 || ask == null || ask <= 0 || ask < bid
      || (p.quoteAgeMs != null && p.quoteAgeMs > cfg.maxQuoteAgeMs);
  }).length;
  const usable = input.points
    // A point after the requested horizon cannot prove a threshold was reached
    // inside that horizon. Endpoint tolerance is backward-looking only.
    .filter((p) => p.atMs > ep.t0_ms && p.atMs <= endMs)
    .filter((p) => {
      const bid = num(p.bid), ask = num(p.ask);
      return bid != null && bid >= 0 && ask != null && ask > 0 && ask >= bid
        && (p.quoteAgeMs == null || p.quoteAgeMs <= cfg.maxQuoteAgeMs);
    })
    .sort((a, b) => a.atMs - b.atMs);
  if (!usable.length) {
    const reason = input.providerAdmissionConstrained ? "PROVIDER_ADMISSION_CONSTRAINED"
      : rejected ? "INVALID_OR_CROSSED_NBBO" : "NO_FUTURE_QUOTE";
    return emptyLabel(ep, "EXACT_OPTION_EXECUTABLE_LABEL", input.horizon, endMs, nowMs, reason);
  }
  const times = usable.map((p) => p.atMs);
  const gap = largestGap(times, ep.t0_ms, endMs);
  const endpointReached = usable[usable.length - 1].atMs >= endMs - cfg.endpointToleranceMs;
  if (input.truncated || !endpointReached || (gap != null && gap > cfg.maxOptionGapMs)) {
    return emptyLabel(ep, "EXACT_OPTION_EXECUTABLE_LABEL", input.horizon, endMs, nowMs,
      input.truncated ? "QUOTE_PATH_TRUNCATED" : "QUOTE_PATH_INADEQUATE", {
        coverage: "CENSORED",
        quoteCount: usable.length, firstEvidenceAtMs: times[0], lastEvidenceAtMs: times[times.length - 1],
        evidenceCoverageMs: times[times.length - 1] - times[0], largestGapMs: gap,
        evidenceQuality: "CENSORED_PATH", evidenceSource: [...new Set(usable.map((p) => p.source))].sort().join("+"),
      });
  }
  const path = usable.map((p) => ({ atMs: p.atMs, bid: Number(p.bid), returnPct: ret(Number(p.bid), entry.ask as number) }));
  const returns = path.map((p) => p.returnPct);
  const mfe = Math.max(...returns), mae = Math.min(...returns);
  const firstAt = (test: (r: number) => boolean): number | null => path.find((p) => test(p.returnPct))?.atMs ?? null;
  const at10 = firstAt((r) => r >= 10), at25 = firstAt((r) => r >= 25), at50 = firstAt((r) => r >= 50);
  const at100 = firstAt((r) => r >= 100), at200 = firstAt((r) => r >= 200);
  const atNeg10 = firstAt((r) => r <= -10), atNeg20 = firstAt((r) => r <= -20);
  const atStop = entry.stopPrice != null && entry.stopPrice >= 0 ? path.find((p) => p.bid <= (entry.stopPrice as number))?.atMs ?? null : null;
  const order10 = competingOrder(at10, atNeg10), order25 = competingOrder(at25, atNeg20);
  const order50Stop = entry.stopPrice == null ? "NOT_APPLICABLE" : competingOrder(at50, atStop);
  const orderStop25 = entry.stopPrice == null ? "NOT_APPLICABLE" : competingOrder(atStop, at25);
  const order100Stop = entry.stopPrice == null ? "NOT_APPLICABLE" : competingOrder(at100, atStop);
  const firstMfe = path.find((p) => p.returnPct === mfe)?.atMs ?? null;
  const firstMae = path.find((p) => p.returnPct === mae)?.atMs ?? null;
  const final = path[path.length - 1];
  return {
    ...emptyLabel(ep, "EXACT_OPTION_EXECUTABLE_LABEL", input.horizon, endMs, nowMs, "", {}),
    terminalReturnPct: final.returnPct, mfePct: mfe, maePct: mae,
    hit10: at10 != null, hit25: at25 != null, hit50: at50 != null, hit100: at100 != null, hit200: at200 != null,
    hitNeg10: atNeg10 != null, hitNeg20: atNeg20 != null, hitStop: entry.stopPrice == null ? null : atStop != null,
    timeTo10Ms: at10 == null ? null : at10 - ep.t0_ms, timeTo25Ms: at25 == null ? null : at25 - ep.t0_ms,
    timeTo50Ms: at50 == null ? null : at50 - ep.t0_ms, timeTo100Ms: at100 == null ? null : at100 - ep.t0_ms,
    timeTo200Ms: at200 == null ? null : at200 - ep.t0_ms,
    timeToNeg10Ms: atNeg10 == null ? null : atNeg10 - ep.t0_ms, timeToNeg20Ms: atNeg20 == null ? null : atNeg20 - ep.t0_ms,
    timeToStopMs: atStop == null ? null : atStop - ep.t0_ms,
    timeToMfeMs: firstMfe == null ? null : firstMfe - ep.t0_ms, timeToMaeMs: firstMae == null ? null : firstMae - ep.t0_ms,
    plus10BeforeNeg10: legacyBefore(order10), plus25BeforeNeg20: legacyBefore(order25),
    plus50BeforeStop: legacyBefore(order50Stop), stopBeforePlus25: legacyBefore(orderStop25), plus100BeforeStop: legacyBefore(order100Stop),
    plus10VsNeg10Order: order10, plus25VsNeg20Order: order25,
    plus50VsStopOrder: order50Stop, stopVsPlus25Order: orderStop25, plus100VsStopOrder: order100Stop,
    coverage: "COMPLETE", censored: false, missingReason: null, quoteCount: path.length,
    firstEvidenceAtMs: times[0], lastEvidenceAtMs: times[times.length - 1],
    evidenceCoverageMs: times[times.length - 1] - times[0], largestGapMs: gap,
    exitPrice: final.bid, evidenceSource: [...new Set(usable.map((p) => p.source))].sort().join("+"),
    evidenceQuality: "EXACT_OCC_EXECUTABLE_PATH", intrabarStatus: "ORDERED",
  };
}

export function evaluateUnderlyingPath(input: {
  episode: EpisodeRow; horizon: OutcomeHorizonV2; endMs: number; nowMs: number;
  bars: UnderlyingBarPoint[]; config: ForwardLabelConfig;
}): OutcomeLabelV2 {
  const { episode: ep, endMs, nowMs, config: cfg } = input;
  const entry = underlyingEntry(ep);
  if (entry == null || entry <= 0) return emptyLabel(ep, "UNDERLYING_LABEL", input.horizon, endMs, nowMs, "NO_T0_UNDERLYING_PRICE");
  const bars = input.bars
    .filter((b) => b.atMs > ep.t0_ms && b.atMs <= endMs)
    .filter((b) => [b.open,b.high,b.low,b.close].every((v) => Number.isFinite(v) && v > 0)
      && b.high >= Math.max(b.open,b.close,b.low) && b.low <= Math.min(b.open,b.close,b.high))
    .sort((a, b) => a.atMs - b.atMs);
  if (!bars.length) return emptyLabel(ep, "UNDERLYING_LABEL", input.horizon, endMs, nowMs, "NO_FUTURE_UNDERLYING_BARS");
  const times = bars.map((b) => b.atMs);
  const gap = largestGap(times, ep.t0_ms, Math.max(ep.t0_ms, endMs - 60_000));
  const endpointReached = bars[bars.length - 1].atMs + 60_000 >= endMs - cfg.endpointToleranceMs;
  if (!endpointReached || (gap != null && gap > cfg.maxUnderlyingGapMs)) {
    return emptyLabel(ep, "UNDERLYING_LABEL", input.horizon, endMs, nowMs, "UNDERLYING_PATH_INADEQUATE", {
      coverage: "CENSORED",
      quoteCount: bars.length, firstEvidenceAtMs: times[0], lastEvidenceAtMs: times[times.length - 1],
      evidenceCoverageMs: times[times.length - 1] - times[0], largestGapMs: gap,
      evidenceQuality: "CENSORED_PATH", intrabarStatus: "NOT_APPLICABLE",
      evidenceSource: [...new Set(bars.map((b) => b.source))].sort().join("+"),
    });
  }
  const bearish = String(ep.direction ?? "").toLowerCase() === "bearish";
  const favorable = (b: UnderlyingBarPoint) => directionReturn(bearish ? b.low : b.high, entry, bearish);
  const adverse = (b: UnderlyingBarPoint) => directionReturn(bearish ? b.high : b.low, entry, bearish);
  const terminal = directionReturn(bars[bars.length - 1].close, entry, bearish);
  const mfe = Math.max(...bars.map(favorable)), mae = Math.min(...bars.map(adverse));
  const firstFav = (pct: number) => bars.find((b) => favorable(b) >= pct)?.atMs ?? null;
  const firstAdv = (pct: number) => bars.find((b) => adverse(b) <= pct)?.atMs ?? null;
  const at10 = firstFav(10), at25 = firstFav(25), at50 = firstFav(50), at100 = firstFav(100), at200 = firstFav(200);
  const atNeg10 = firstAdv(-10), atNeg20 = firstAdv(-20);
  const order10 = competingOrder(at10, atNeg10, at10 != null && at10 === atNeg10);
  const order25 = competingOrder(at25, atNeg20, at25 != null && at25 === atNeg20);
  const firstMfe = bars.find((b) => favorable(b) === mfe)?.atMs ?? null;
  const firstMae = bars.find((b) => adverse(b) === mae)?.atMs ?? null;
  const ambiguous = [order10,order25].includes("AMBIGUOUS_INTRABAR");
  return {
    ...emptyLabel(ep, "UNDERLYING_LABEL", input.horizon, endMs, nowMs, "", {}),
    terminalReturnPct: terminal, mfePct: mfe, maePct: mae,
    hit10: at10 != null, hit25: at25 != null, hit50: at50 != null, hit100: at100 != null, hit200: at200 != null,
    hitNeg10: atNeg10 != null, hitNeg20: atNeg20 != null, hitStop: null,
    timeTo10Ms: at10 == null ? null : at10 - ep.t0_ms, timeTo25Ms: at25 == null ? null : at25 - ep.t0_ms,
    timeTo50Ms: at50 == null ? null : at50 - ep.t0_ms, timeTo100Ms: at100 == null ? null : at100 - ep.t0_ms,
    timeTo200Ms: at200 == null ? null : at200 - ep.t0_ms,
    timeToNeg10Ms: atNeg10 == null ? null : atNeg10 - ep.t0_ms, timeToNeg20Ms: atNeg20 == null ? null : atNeg20 - ep.t0_ms,
    timeToStopMs: null, timeToMfeMs: firstMfe == null ? null : firstMfe - ep.t0_ms,
    timeToMaeMs: firstMae == null ? null : firstMae - ep.t0_ms,
    plus10BeforeNeg10: legacyBefore(order10), plus25BeforeNeg20: legacyBefore(order25),
    plus50BeforeStop: null, stopBeforePlus25: null, plus100BeforeStop: null,
    plus10VsNeg10Order: order10, plus25VsNeg20Order: order25,
    plus50VsStopOrder: "NOT_APPLICABLE", stopVsPlus25Order: "NOT_APPLICABLE", plus100VsStopOrder: "NOT_APPLICABLE",
    coverage: "COMPLETE", censored: false, missingReason: null, quoteCount: bars.length,
    firstEvidenceAtMs: times[0], lastEvidenceAtMs: times[times.length - 1],
    evidenceCoverageMs: times[times.length - 1] - times[0], largestGapMs: gap,
    exitPrice: bars[bars.length - 1].close,
    evidenceSource: [...new Set(bars.map((b) => b.source))].sort().join("+"),
    evidenceQuality: bars.some((b) => b.quality !== "OK") ? "UNDERLYING_OHLC_PARTIAL" : "UNDERLYING_OHLC_COMPLETE",
    intrabarStatus: ambiguous ? "AMBIGUOUS_INTRABAR" : "ORDERED",
  };
}

function loadUnderlyingBars(db: Db, ep: EpisodeRow, endMs: number): UnderlyingBarPoint[] {
  if (!hasTable(db, "historical_underlying_bars")) return [];
  try {
    return db.prepare(
      `SELECT ts_ms,open,high,low,close,source,quality FROM historical_underlying_bars
       WHERE symbol=? AND timeframe='1m' AND ts_ms>? AND ts_ms<=? ORDER BY ts_ms ASC LIMIT 5000`,
    ).all(ep.symbol, ep.t0_ms, endMs).map((r) => ({
      atMs: Number(r.ts_ms), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
      source: String(r.source ?? "historical_underlying_bars"), quality: String(r.quality ?? "PARTIAL"),
    }));
  } catch { return []; }
}

function loadOptionPath(db: Db, ep: EpisodeRow, endMs: number, cfg: ForwardLabelConfig): {
  points: QuotePoint[]; providerAdmissionConstrained: boolean; truncated: boolean;
} {
  const entry = entryEvidence(ep);
  if (!entry.occ) return { points: [], providerAdmissionConstrained: false, truncated: false };
  const occ = entry.occ;
  const rows: QuotePoint[] = [];
  let truncated = false;
  const take = (sourceRows: any[], source: string, map: (r: any) => QuotePoint) => {
    if (sourceRows.length > cfg.maxQuotesPerSource) truncated = true;
    for (const r of sourceRows.slice(0, cfg.maxQuotesPerSource)) rows.push({ ...map(r), source });
  };
  try {
    if (hasTable(db, "historical_option_quotes")) take(db.prepare(
      `SELECT ts_ms,bid,ask FROM historical_option_quotes WHERE occ=? AND ts_ms>? AND ts_ms<=?
       ORDER BY ts_ms ASC LIMIT ?`,
    ).all(occ, ep.t0_ms, endMs + cfg.endpointToleranceMs, cfg.maxQuotesPerSource + 1), "historical_option_quotes", (r) => ({ atMs: Number(r.ts_ms), bid: num(r.bid), ask: num(r.ask), quoteAgeMs: 0, source: "" }));
  } catch { /* optional source */ }
  try {
    if (hasTable(db, "options_paper_marks")) take(db.prepare(
      `SELECT mark_at_ms,bid,ask,quote_age_ms FROM options_paper_marks WHERE option_symbol=? AND mark_at_ms>? AND mark_at_ms<=?
       ORDER BY mark_at_ms ASC LIMIT ?`,
    ).all(occ, ep.t0_ms, endMs + cfg.endpointToleranceMs, cfg.maxQuotesPerSource + 1), "options_paper_marks", (r) => ({ atMs: Number(r.mark_at_ms), bid: num(r.bid), ask: num(r.ask), quoteAgeMs: num(r.quote_age_ms), source: "" }));
  } catch { /* optional source */ }
  try {
    if (hasTable(db, "asymmetry_marks")) take(db.prepare(
      `SELECT marked_at_ms,bid,ask,quote_age_ms FROM asymmetry_marks WHERE option_symbol=? AND rejected_reason IS NULL
       AND marked_at_ms>? AND marked_at_ms<=? ORDER BY marked_at_ms ASC LIMIT ?`,
    ).all(occ, ep.t0_ms, endMs + cfg.endpointToleranceMs, cfg.maxQuotesPerSource + 1), "asymmetry_marks", (r) => ({ atMs: Number(r.marked_at_ms), bid: num(r.bid), ask: num(r.ask), quoteAgeMs: num(r.quote_age_ms), source: "" }));
  } catch { /* optional source */ }
  try {
    if (hasTable(db, "asymmetry_paper_marks")) take(db.prepare(
      `SELECT marked_at_ms,bid,ask,quote_age_ms FROM asymmetry_paper_marks WHERE position_fingerprint IN
       (SELECT position_fingerprint FROM asymmetry_paper_positions WHERE option_symbol=?) AND rejected_reason IS NULL
       AND marked_at_ms>? AND marked_at_ms<=? ORDER BY marked_at_ms ASC LIMIT ?`,
    ).all(occ, ep.t0_ms, endMs + cfg.endpointToleranceMs, cfg.maxQuotesPerSource + 1), "asymmetry_paper_marks", (r) => ({ atMs: Number(r.marked_at_ms), bid: num(r.bid), ask: num(r.ask), quoteAgeMs: num(r.quote_age_ms), source: "" }));
  } catch { /* optional source */ }
  let providerAdmissionConstrained = false;
  try {
    if (hasTable(db, "asymmetry_marks")) providerAdmissionConstrained = Boolean(db.prepare(
      `SELECT 1 FROM asymmetry_marks WHERE option_symbol=? AND rejected_reason='PROVIDER_BUDGET'
       AND marked_at_ms>? AND marked_at_ms<=? LIMIT 1`,
    ).get(occ, ep.t0_ms, endMs + cfg.endpointToleranceMs));
  } catch { /* optional */ }
  const priority: Record<string, number> = { historical_option_quotes: 4, asymmetry_marks: 3, asymmetry_paper_marks: 2, options_paper_marks: 1 };
  const deduped = new Map<number, QuotePoint>();
  for (const p of rows) {
    const existing = deduped.get(p.atMs);
    if (!existing || (priority[p.source] ?? 0) > (priority[existing.source] ?? 0)) deduped.set(p.atMs, p);
  }
  return { points: [...deduped.values()].sort((a,b) => a.atMs-b.atMs), providerAdmissionConstrained, truncated };
}

function existingLabels(db: Db, episodeKey: string): Set<string> {
  try {
    return new Set(db.prepare(
      "SELECT label_kind,horizon FROM episode_outcome_labels_v2 WHERE episode_key=? AND label_version=?",
    ).all(episodeKey, FORWARD_LABEL_VERSION).map((r) => `${r.label_kind}|${r.horizon}`));
  } catch { return new Set(); }
}

function dueEpisodes(db: Db, nowMs: number, cfg: ForwardLabelConfig, env: NodeJS.ProcessEnv): EpisodeRow[] {
  const conditions: string[] = [];
  const args: any[] = [];
  for (const h of ["5m","15m","30m","60m"] as const) {
    conditions.push(`(e.t0_ms<=? AND (
      NOT EXISTS (SELECT 1 FROM episode_outcome_labels_v2 l WHERE l.episode_key=e.episode_key AND l.label_kind='UNDERLYING_LABEL' AND l.horizon='${h}' AND l.label_version=?)
      OR (e.selected_occ IS NOT NULL AND e.entry_convention=? AND NOT EXISTS
        (SELECT 1 FROM episode_outcome_labels_v2 l WHERE l.episode_key=e.episode_key AND l.label_kind='EXACT_OPTION_EXECUTABLE_LABEL' AND l.horizon='${h}' AND l.label_version=?))
    ))`);
    args.push(nowMs - HORIZON_MS[h] - cfg.evidenceGraceMs, FORWARD_LABEL_VERSION, FORWARD_ENTRY_CONVENTION, FORWARD_LABEL_VERSION);
  }
  const day = tradingDay(nowMs);
  const sessionDue = nowMs >= regularCloseMs(day, env) + cfg.evidenceGraceMs;
  conditions.push(`((e.trading_day<? OR (e.trading_day=? AND ?=1)) AND (
    NOT EXISTS (SELECT 1 FROM episode_outcome_labels_v2 l WHERE l.episode_key=e.episode_key AND l.label_kind='UNDERLYING_LABEL' AND l.horizon='session' AND l.label_version=?)
    OR (e.selected_occ IS NOT NULL AND e.entry_convention=? AND NOT EXISTS
      (SELECT 1 FROM episode_outcome_labels_v2 l WHERE l.episode_key=e.episode_key AND l.label_kind='EXACT_OPTION_EXECUTABLE_LABEL' AND l.horizon='session' AND l.label_version=?))
  ))`);
  args.push(day, day, sessionDue ? 1 : 0, FORWARD_LABEL_VERSION, FORWARD_ENTRY_CONVENTION, FORWARD_LABEL_VERSION, cfg.batchLimit);
  try {
    return db.prepare(
      `SELECT episode_key,symbol,t0_ms,trading_day,session,direction,population,selected_strategy,selection_strength,
              selected_occ,entry_convention,config_digest,production_sha,opportunity_case_id,thesis_fingerprint,zone_a_json
       FROM setup_episodes e WHERE e.episode_version=2 AND (${conditions.join(" OR ")})
       ORDER BY e.t0_ms ASC LIMIT ?`,
    ).all(...args) as EpisodeRow[];
  } catch { return []; }
}

function reconcileOwnerPaperOnDb(db: Db, ep: EpisodeRow, nowMs: number): void {
  if (!ep.selected_occ || !hasTable(db, "options_paper_trades")) return;
  try {
    const rows = db.prepare(
      `SELECT id,feature_snapshot_json,thesis_fingerprint,entered_at_ms FROM options_paper_trades
       WHERE option_symbol=? AND paper_kind='OWNER_VALIDATION_PAPER' AND entered_at_ms>=? AND entered_at_ms<=?
       ORDER BY entered_at_ms ASC LIMIT 20`,
    ).all(ep.selected_occ, ep.t0_ms - 5 * 60_000, ep.t0_ms + 30 * 60_000);
    for (const row of rows) {
      const snap = parseJson<any>(row.feature_snapshot_json, {});
      const caseId = String(snap?.opportunityCaseId ?? snap?.opportunity_case_id ?? "");
      const thesis = String(row.thesis_fingerprint ?? "");
      if ((ep.opportunity_case_id && caseId === ep.opportunity_case_id) || (ep.thesis_fingerprint && thesis === ep.thesis_fingerprint)) {
        appendEpisodeActionOnDb(db as any, {
          episodeKey: ep.episode_key, kind: "OWNER_PAPER", actionRef: `options_paper_trades:${row.id}`,
          occurredAtMs: Number(row.entered_at_ms), exactOcc: ep.selected_occ,
          entryConvention: "ACTUAL_PAPER_FROZEN_POLICY", defensibleEntry: true,
          metadata: { paperKind: "OWNER_VALIDATION_PAPER" },
        }, nowMs);
      }
    }
  } catch { /* reconciliation is additive evidence only */ }
}

export interface ForwardLabelWorkerResult {
  runId: string; startedAtMs: number; finishedAtMs: number; runtimeMs: number;
  status: "COMPLETE" | "PARTIAL_TIMEOUT" | "ERROR";
  batchLimit: number; episodesExamined: number; labelsAttempted: number; labelsInserted: number;
  underlyingInserted: number; exactOptionInserted: number; providerCalls: 0;
  timedOut: boolean; dbBusyErrors: number; datasetVersion: string | null; note: string;
}

export async function runForwardLabelWorkerOnDb(
  db: Db,
  opts: { nowMs?: number; env?: NodeJS.ProcessEnv; config?: Partial<ForwardLabelConfig>; clock?: () => number } = {},
): Promise<ForwardLabelWorkerResult> {
  const env = opts.env ?? process.env;
  const nowMs = opts.nowMs ?? Date.now();
  const clock = opts.clock ?? Date.now;
  const cfg = { ...forwardLabelConfig(env), ...(opts.config ?? {}) };
  const startedAtMs = clock();
  const runId = `flw_${nowMs}_${createHash("sha256").update(`${nowMs}|${process.pid}`).digest("hex").slice(0,12)}`;
  const result: ForwardLabelWorkerResult = {
    runId, startedAtMs, finishedAtMs: startedAtMs, runtimeMs: 0, status: "COMPLETE",
    batchLimit: cfg.batchLimit, episodesExamined: 0, labelsAttempted: 0, labelsInserted: 0,
    underlyingInserted: 0, exactOptionInserted: 0, providerCalls: 0,
    timedOut: false, dbBusyErrors: 0, datasetVersion: null, note: "",
  };
  try {
    for (const ep of dueEpisodes(db, nowMs, cfg, env)) {
      if (clock() - startedAtMs >= cfg.maxRunMs) { result.timedOut = true; break; }
      result.episodesExamined += 1;
      reconcileOwnerPaperOnDb(db, ep, nowMs);
      const existing = existingLabels(db, ep.episode_key);
      for (const horizon of FORWARD_HORIZONS) {
        if (!horizonMatured(ep, horizon, nowMs, cfg, env)) continue;
        const endMs = horizonEndAtMs(ep, horizon, env);
        const underlyingKey = `UNDERLYING_LABEL|${horizon}`;
        if (!existing.has(underlyingKey)) {
          result.labelsAttempted += 1;
          const label = evaluateUnderlyingPath({ episode: ep, horizon, endMs, nowMs, bars: loadUnderlyingBars(db, ep, endMs), config: cfg });
          const write = appendOutcomeLabelV2OnDb(db as any, ep.t0_ms, label, nowMs);
          if (write.inserted) { result.labelsInserted += 1; result.underlyingInserted += 1; }
          else if (!write.ok && /busy|locked/i.test(String(write.reason))) result.dbBusyErrors += 1;
        }
        const optionKey = `EXACT_OPTION_EXECUTABLE_LABEL|${horizon}`;
        if (ep.selected_occ && ep.entry_convention === FORWARD_ENTRY_CONVENTION && !existing.has(optionKey)) {
          result.labelsAttempted += 1;
          const path = loadOptionPath(db, ep, endMs, cfg);
          const label = evaluateOptionPath({ episode: ep, horizon, endMs, nowMs, config: cfg, ...path });
          const write = appendOutcomeLabelV2OnDb(db as any, ep.t0_ms, label, nowMs);
          if (write.inserted) { result.labelsInserted += 1; result.exactOptionInserted += 1; }
          else if (!write.ok && /busy|locked/i.test(String(write.reason))) result.dbBusyErrors += 1;
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    result.timedOut ||= clock() - startedAtMs >= cfg.maxRunMs;
    const ds = buildDatasetVersionOnDb(db, nowMs);
    result.datasetVersion = ds.datasetVersion;
    const coverage = buildCoverageReportOnDb(db, tradingDay(nowMs), nowMs, cfg, env, ds.datasetVersion);
    persistCoverageSnapshotOnDb(db, coverage, nowMs);
    if (marketSession(nowMs) !== "regular" && clock() - startedAtMs < cfg.maxRunMs - 500) {
      refreshNextHistoricalInventoryDatasetOnDb(db, nowMs);
    }
    result.status = result.timedOut ? "PARTIAL_TIMEOUT" : "COMPLETE";
    result.note = result.timedOut
      ? "bounded deadline reached; backlog remains resumable and no label was duplicated"
      : "matured work processed from persisted evidence; zero provider requests";
  } catch (err: any) {
    result.status = "ERROR";
    result.note = String(err?.message ?? err).slice(0, 300);
    if (/busy|locked/i.test(result.note)) result.dbBusyErrors += 1;
  }
  result.finishedAtMs = clock();
  result.runtimeMs = Math.max(0, result.finishedAtMs - startedAtMs);
  try {
    db.prepare(
      `INSERT OR IGNORE INTO forward_label_worker_runs
       (run_id,started_at_ms,finished_at_ms,status,batch_limit,episodes_examined,labels_attempted,labels_inserted,
        underlying_inserted,exact_option_inserted,provider_calls,timed_out,db_busy_errors,dataset_version,note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(result.runId,result.startedAtMs,result.finishedAtMs,result.status,result.batchLimit,result.episodesExamined,
      result.labelsAttempted,result.labelsInserted,result.underlyingInserted,result.exactOptionInserted,0,
      result.timedOut?1:0,result.dbBusyErrors,result.datasetVersion,result.note);
    db.prepare(`DELETE FROM forward_label_worker_runs WHERE run_id IN
      (SELECT run_id FROM forward_label_worker_runs ORDER BY finished_at_ms DESC LIMIT -1 OFFSET 1000)`).run();
  } catch { /* health persistence must not change labels */ }
  return result;
}

function hashJson(v: unknown): string { return createHash("sha256").update(JSON.stringify(v)).digest("hex"); }

function xorDigestHex(a: string, b: string): string {
  const left = Buffer.from(a.padStart(64, "0"), "hex");
  const right = Buffer.from(b.padStart(64, "0"), "hex");
  const out = Buffer.alloc(32);
  for (let i = 0; i < out.length; i++) out[i] = left[i] ^ right[i];
  return out.toString("hex");
}

function sortedSetJson(raw: unknown, additions: unknown[]): string {
  const values = new Set<string>(parseJson<string[]>(raw, []).map(String));
  for (const value of additions) {
    const normalized = String(value ?? "").trim();
    if (normalized) values.add(normalized);
  }
  return JSON.stringify([...values].sort());
}

export function buildDatasetVersionOnDb(db: Db, nowMs: number): { datasetVersion: string | null; snapshot: Record<string, unknown> } {
  try {
    // Register at most 1,000 previously unseen immutable labels per beat. The
    // XOR of SHA-256 membership hashes is order-independent, so a restart or a
    // different batch boundary produces the same final dataset identity.
    db.prepare("BEGIN IMMEDIATE").run();
    const current = db.prepare(
      "SELECT * FROM forward_label_dataset_state WHERE label_version=?",
    ).get(FORWARD_LABEL_VERSION) ?? {
      xor_digest: "0".repeat(64), label_count: 0, episode_count: 0,
      date_from: null, date_to: null, feature_versions_json: "[]",
      config_digests_json: "[]", populations_json: "[]",
    };
    const pending = db.prepare(
      `SELECT l.label_id,l.episode_key,l.label_kind,l.horizon,
              e.trading_day,e.feature_version,e.config_digest,e.population
       FROM episode_outcome_labels_v2 l
       JOIN setup_episodes e ON e.episode_key=l.episode_key AND e.episode_version=2
       LEFT JOIN forward_label_dataset_members m ON m.label_id=l.label_id
       WHERE l.label_version=? AND m.label_id IS NULL
       ORDER BY l.label_id ASC LIMIT 1001`,
    ).all(FORWARD_LABEL_VERSION);
    let xorDigest = String(current.xor_digest ?? "0".repeat(64));
    let labelCount = Number(current.label_count ?? 0);
    let episodeCount = Number(current.episode_count ?? 0);
    let dateFrom = current.date_from == null ? null : String(current.date_from);
    let dateTo = current.date_to == null ? null : String(current.date_to);
    let featureVersionsJson = String(current.feature_versions_json ?? "[]");
    let configDigestsJson = String(current.config_digests_json ?? "[]");
    let populationsJson = String(current.populations_json ?? "[]");
    for (const row of pending.slice(0, 1000)) {
      const membershipDigest = createHash("sha256").update(
        `${row.label_id}|${row.episode_key}|${row.label_kind}|${row.horizon}|${FORWARD_LABEL_VERSION}`,
      ).digest("hex");
      const member = db.prepare(
        `INSERT OR IGNORE INTO forward_label_dataset_members
         (label_id,label_version,episode_key,membership_digest,registered_at_ms) VALUES (?,?,?,?,?)`,
      ).run(row.label_id, FORWARD_LABEL_VERSION, row.episode_key, membershipDigest, nowMs);
      if (!member.changes) continue;
      xorDigest = xorDigestHex(xorDigest, membershipDigest);
      labelCount += 1;
      const ep = db.prepare(
        `INSERT OR IGNORE INTO forward_label_dataset_episodes
         (label_version,episode_key,trading_day,feature_version,config_digest,population,registered_at_ms)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(FORWARD_LABEL_VERSION,row.episode_key,row.trading_day,row.feature_version,row.config_digest,row.population,nowMs);
      if (ep.changes) {
        episodeCount += 1;
        const day = String(row.trading_day);
        dateFrom = dateFrom == null || day < dateFrom ? day : dateFrom;
        dateTo = dateTo == null || day > dateTo ? day : dateTo;
        featureVersionsJson = sortedSetJson(featureVersionsJson, [row.feature_version]);
        configDigestsJson = sortedSetJson(configDigestsJson, [row.config_digest]);
        populationsJson = sortedSetJson(populationsJson, [row.population]);
      }
    }
    db.prepare(
      `INSERT INTO forward_label_dataset_state
       (label_version,xor_digest,label_count,episode_count,date_from,date_to,feature_versions_json,
        config_digests_json,populations_json,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(label_version) DO UPDATE SET xor_digest=excluded.xor_digest,label_count=excluded.label_count,
        episode_count=excluded.episode_count,date_from=excluded.date_from,date_to=excluded.date_to,
        feature_versions_json=excluded.feature_versions_json,config_digests_json=excluded.config_digests_json,
        populations_json=excluded.populations_json,updated_at_ms=excluded.updated_at_ms`,
    ).run(FORWARD_LABEL_VERSION,xorDigest,labelCount,episodeCount,dateFrom,dateTo,featureVersionsJson,
      configDigestsJson,populationsJson,nowMs);
    db.prepare("COMMIT").run();
    if (pending.length > 1000) {
      return { datasetVersion: null, snapshot: {
        status: "CATCHING_UP", labelVersion: FORWARD_LABEL_VERSION,
        registeredLabelCount: labelCount, registrationBatchLimit: 1000,
      } };
    }
    const snapshot = {
      episodeSchemaVersion: 2,
      featureVersions: parseJson<string[]>(featureVersionsJson, []),
      labelVersion: FORWARD_LABEL_VERSION,
      entryExitConvention: FORWARD_ENTRY_CONVENTION,
      sourcePopulations: parseJson<string[]>(populationsJson, []),
      configDigestBoundaries: parseJson<string[]>(configDigestsJson, []),
      dateRange: { from: dateFrom, to: dateTo },
      evidenceFilters: {
        exactOccRequired: true, contemporaneousAskRequired: true, futureBidRequired: true,
        midpointExecutableReturnForbidden: true, unknownRemainsNull: true,
      },
      labelCount,
      episodeCount,
      rowsDigest: xorDigest,
      digestAlgorithm: "XOR_SHA256_IMMUTABLE_MEMBERSHIP_V1",
    };
    const datasetVersion = `fds_${hashJson(snapshot).slice(0,24)}`;
    db.prepare(
      `INSERT OR IGNORE INTO forward_label_dataset_versions
       (dataset_version,label_version,episode_count,label_count,date_from,date_to,rows_digest,snapshot_json,created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(datasetVersion,FORWARD_LABEL_VERSION,snapshot.episodeCount,snapshot.labelCount,
      snapshot.dateRange.from,snapshot.dateRange.to,snapshot.rowsDigest,JSON.stringify(snapshot),nowMs);
    return { datasetVersion, snapshot };
  } catch {
    try { db.prepare("ROLLBACK").run(); } catch { /* no active transaction */ }
    return { datasetVersion: null, snapshot: { labelVersion: FORWARD_LABEL_VERSION, status: "UNAVAILABLE" } };
  }
}

type Bucket = { total: number; eligible: number; complete: number; censored: number; unknown: number };
function addBucket(map: Map<string,Bucket>, key: string, eligible: boolean, complete: boolean, censored: boolean) {
  const b = map.get(key) ?? { total: 0, eligible: 0, complete: 0, censored: 0, unknown: 0 };
  b.total += 1; if (eligible) b.eligible += 1; if (complete) b.complete += 1;
  if (censored) b.censored += 1; if (!complete) b.unknown += 1; map.set(key,b);
}

function labelBucket(label: any, kind: "underlying" | "option"): string {
  if (!label) return "WORKER_PENDING";
  if (label.coverage === "COMPLETE") return "COMPLETE";
  const r = String(label.missing_reason ?? "OTHER_EXPLICIT_REASON");
  if (r === "PROVIDER_ADMISSION_CONSTRAINED") return r;
  if (r.includes("PATH") || r.includes("TRUNCATED")) return kind === "option" ? "QUOTE_PATH_INADEQUATE" : "UNDERLYING_PATH_INADEQUATE";
  if (r === "NO_FUTURE_QUOTE") return r;
  if (r === "NO_FUTURE_UNDERLYING_BARS") return "INSUFFICIENT_FUTURE_EVIDENCE";
  return "OTHER_EXPLICIT_REASON";
}

export function buildCoverageReportOnDb(db: Db, cohortDate: string, nowMs: number, cfg: ForwardLabelConfig, env: NodeJS.ProcessEnv, datasetVersion: string | null): Record<string, any> {
  const episodes = (db.prepare(
    `SELECT episode_key,symbol,t0_ms,trading_day,session,direction,population,selected_strategy,selection_strength,
            selected_occ,entry_convention,config_digest,production_sha,opportunity_case_id,thesis_fingerprint,zone_a_json
     FROM setup_episodes WHERE episode_version=2 AND trading_day=? ORDER BY t0_ms ASC`,
  ).all(cohortDate) ?? []) as EpisodeRow[];
  const labels = episodes.length ? db.prepare(
    `SELECT l.episode_key,l.label_kind,l.horizon,l.coverage,l.censored,l.missing_reason
     FROM episode_outcome_labels_v2 l JOIN setup_episodes e ON e.episode_key=l.episode_key
     WHERE l.label_version=? AND e.episode_version=2 AND e.trading_day=?`,
  ).all(FORWARD_LABEL_VERSION,cohortDate) : [];
  const byLabel = new Map(labels.map((l) => [`${l.episode_key}|${l.label_kind}|${l.horizon}`,l]));
  const actionRows = episodes.length ? db.prepare(
    `SELECT a.episode_key,a.action_kind FROM episode_actions a
     JOIN setup_episodes e ON e.episode_key=a.episode_key
     WHERE e.episode_version=2 AND e.trading_day=?`,
  ).all(cohortDate) : [];
  const actions = new Map<string,Set<string>>();
  for (const a of actionRows) { const s=actions.get(String(a.episode_key))??new Set<string>(); s.add(String(a.action_kind)); actions.set(String(a.episode_key),s); }
  const movers = new Set<string>();
  if (hasTable(db,"market_mover_observations")) {
    try { for (const r of db.prepare("SELECT symbol FROM market_mover_observations WHERE session_date=? AND ever_extreme=1").all(cohortDate)) movers.add(String(r.symbol)); } catch { /* optional */ }
  }
  const underBuckets: Record<string,number> = {};
  const exactBuckets: Record<string,number> = {};
  const dims: Record<string,Map<string,Bucket>> = Object.fromEntries([
    "population","side","dteBucket","strategy","discoveryStage","selectionStrengthBucket",
    "liquidityEvidenceTier","session","symbol","moverClass","actionKind",
  ].map((d) => [d,new Map<string,Bucket>()]));
  let matureEpisodes=0,matureUnits=0,underComplete=0,exactEligible=0,exactComplete=0,censored=0,unknown=0;
  const populations: Record<string,number> = {}, symbols=new Set<string>(), sessions=new Set<string>();
  for (const ep of episodes) {
    populations[ep.population ?? "UNKNOWN"]=(populations[ep.population ?? "UNKNOWN"]??0)+1; symbols.add(ep.symbol); sessions.add(ep.trading_day);
    const matured = FORWARD_HORIZONS.filter((h) => horizonMatured(ep,h,nowMs,cfg,env));
    if (matured.length) matureEpisodes += 1;
    const zone=parseJson<any>(ep.zone_a_json,{}), entry=entryEvidence(ep);
    const side=String(evidenceValue(zone,"option","side")??(ep.direction==="bearish"?"put":"call")).toUpperCase();
    const dte=num(evidenceValue(zone,"option","dte"));
    const dteBucket=dte==null?"MISSING":dte===0?"0DTE":dte<=7?"1-7DTE":dte<=30?"8-30DTE":"31+DTE";
    const discovery=String(evidenceValue(zone,"optiscan","discoveryStage")??"MISSING");
    const strength=ep.selection_strength==null?"MISSING":ep.selection_strength>=.8?"VERY_STRONG":ep.selection_strength>=.65?"STRONG":ep.selection_strength>=.5?"MODERATE":"WEAK";
    const spread=num(evidenceValue(zone,"option","spreadPct"));
    const liquidity=spread==null?"MISSING":spread<=5?"TIGHT":spread<=12?"MODERATE":"WIDE";
    const dimValues: Record<string,string[]> = {
      population:[ep.population??"UNKNOWN"],side:[side],dteBucket:[dteBucket],strategy:[ep.selected_strategy??"NONE"],
      discoveryStage:[discovery],selectionStrengthBucket:[strength],liquidityEvidenceTier:[liquidity],
      session:[ep.session],symbol:[ep.symbol],moverClass:[movers.has(ep.symbol)?"EXTREME_MOVER":"REGULAR_SCANNER_POPULATION"],
      actionKind:[...(actions.get(ep.episode_key)??new Set(["OBSERVATION"]))],
    };
    for (const h of matured) {
      matureUnits += 1;
      const ul=byLabel.get(`${ep.episode_key}|UNDERLYING_LABEL|${h}`);
      const ub=underlyingEntry(ep)==null?"NO_T0_UNDERLYING_PRICE":labelBucket(ul,"underlying");
      underBuckets[ub]=(underBuckets[ub]??0)+1; if(ub==="COMPLETE")underComplete+=1;
      const ol=byLabel.get(`${ep.episode_key}|EXACT_OPTION_EXECUTABLE_LABEL|${h}`);
      const ob=!entry.occ?"NO_OCC":!entry.eligible?"NO_CONTEMPORANEOUS_EXECUTABLE_QUOTE":labelBucket(ol,"option");
      exactBuckets[ob]=(exactBuckets[ob]??0)+1;
      if(entry.eligible)exactEligible+=1; if(ob==="COMPLETE")exactComplete+=1;
      if((ul&&Number(ul.censored)===1)||(ol&&Number(ol.censored)===1))censored+=1;
      if(ub!=="COMPLETE"||ob!=="COMPLETE")unknown+=1;
      for(const [dimension,values] of Object.entries(dimValues)) for(const value of values) addBucket(dims[dimension],value,entry.eligible,ob==="COMPLETE",Boolean(ol&&Number(ol.censored)===1));
    }
  }
  const dimOut=Object.fromEntries(Object.entries(dims).map(([k,m])=>[k,[...m.entries()].map(([value,b])=>({value,...b,coveragePct:b.eligible?round((b.complete/b.eligible)*100):null})).sort((a,b)=>b.total-a.total).slice(0,100)]));
  const sum=(o:Record<string,number>)=>Object.values(o).reduce((a,b)=>a+b,0);
  return {
    version:"FORWARD_COVERAGE_V1",cohortDate,measuredAtMs:nowMs,datasetVersion,
    episodes:{created:episodes.length,mature:matureEpisodes,symbols:symbols.size,sessions:sessions.size,populations},
    horizonUnits:{mature:matureUnits,horizons:[...FORWARD_HORIZONS]},
    underlying:{eligible:matureUnits,labelsComplete:underComplete,buckets:underBuckets,reconciles:sum(underBuckets)===matureUnits},
    exactOption:{eligible:exactEligible,labelsComplete:exactComplete,coveragePct:exactEligible?round((exactComplete/exactEligible)*100):null,buckets:exactBuckets,reconciles:sum(exactBuckets)===matureUnits},
    censored,unknown,selectionBias:dimOut,
    provider:{callsIssued:0,capsChanged:false,admissionLane:null},
    authority:{changesLiveCallouts:false,phase2bProbabilities:false},
  };
}

function persistCoverageSnapshotOnDb(db: Db, report: Record<string,any>, nowMs: number): void {
  try {
    const id=`fcov_${hashJson(report).slice(0,24)}`;
    db.prepare(`INSERT OR IGNORE INTO forward_label_coverage_snapshots
      (snapshot_id,cohort_date,dataset_version,report_json,created_at_ms) VALUES (?,?,?,?,?)`)
      .run(id,report.cohortDate,report.datasetVersion??null,JSON.stringify(report),nowMs);
  } catch { /* derived snapshot only */ }
}

interface InventorySpec { dataset:string; tables:string[]; sql:(existing:Set<string>)=>string|null; provenance:string; trust:string; limitations:string[]; }
const INVENTORY: InventorySpec[] = [
  {dataset:"historical_underlying_bars",tables:["historical_underlying_bars"],sql:()=>`SELECT COUNT(*) row_count,COUNT(DISTINCT symbol) distinct_symbols,NULL distinct_occs,COUNT(DISTINCT date(ts_ms/1000,'unixepoch','-4 hours')) session_count,MIN(ts_ms) earliest_ms,MAX(ts_ms) latest_ms,GROUP_CONCAT(DISTINCT source) sources FROM historical_underlying_bars`,provenance:"Normalized Massive underlying aggregates",trust:"POINT_IN_TIME_OHLC",limitations:["Session count uses a fixed ET offset; early/late DST boundary dates require calendar validation."]},
  {dataset:"historical_option_quotes",tables:["historical_option_quotes"],sql:()=>`SELECT COUNT(*) row_count,NULL distinct_symbols,COUNT(DISTINCT occ) distinct_occs,COUNT(DISTINCT date(ts_ms/1000,'unixepoch','-4 hours')) session_count,MIN(ts_ms) earliest_ms,MAX(ts_ms) latest_ms,GROUP_CONCAT(DISTINCT source) sources FROM historical_option_quotes`,provenance:"Normalized Massive exact-OCC /v3/quotes NBBO",trust:"EXECUTABLE_EXACT_OCC_NBBO",limitations:["Breadth is distinct OCCs and sessions, not row count; historical Greeks and OI are not reconstructed."]},
  {dataset:"historical_option_trades",tables:["historical_option_trades"],sql:()=>`SELECT COUNT(*) row_count,NULL distinct_symbols,COUNT(DISTINCT occ) distinct_occs,COUNT(DISTINCT date(ts_ms/1000,'unixepoch','-4 hours')) session_count,MIN(ts_ms) earliest_ms,MAX(ts_ms) latest_ms,GROUP_CONCAT(DISTINCT source) sources FROM historical_option_trades`,provenance:"Normalized Massive exact-OCC trade prints",trust:"TRADE_PRINT_NOT_NBBO",limitations:["Trade prints cannot be substituted for executable bid/ask."]},
  {dataset:"historical_contract_reference",tables:["historical_contract_reference"],sql:()=>`SELECT COUNT(*) row_count,COUNT(DISTINCT underlying) distinct_symbols,COUNT(DISTINCT occ) distinct_occs,NULL session_count,NULL earliest_ms,NULL latest_ms,GROUP_CONCAT(DISTINCT source) sources FROM historical_contract_reference`,provenance:"Massive expired-contract reference",trust:"REFERENCE_IDENTITY",limitations:["Reference rows describe identity, not price or executability."]},
  {dataset:"setup_episode_v2",tables:["setup_episodes"],sql:()=>`SELECT COUNT(*) row_count,COUNT(DISTINCT symbol) distinct_symbols,COUNT(DISTINCT selected_occ) distinct_occs,COUNT(DISTINCT trading_day) session_count,MIN(t0_ms) earliest_ms,MAX(t0_ms) latest_ms,GROUP_CONCAT(DISTINCT source) sources FROM setup_episodes WHERE episode_version=2`,provenance:"Immutable live SetupEpisodeV2 Zone A",trust:"IMMUTABLE_T0",limitations:["A setup episode is an observation, not necessarily a trade."]},
  {dataset:"forward_option_marks",tables:["options_paper_marks","asymmetry_marks","asymmetry_paper_marks"],sql:(e)=>{const parts=[];if(e.has("options_paper_marks"))parts.push("SELECT option_symbol occ,mark_at_ms ts,'options_paper_marks' source FROM options_paper_marks");if(e.has("asymmetry_marks"))parts.push("SELECT option_symbol occ,marked_at_ms ts,'asymmetry_marks' source FROM asymmetry_marks WHERE rejected_reason IS NULL");if(e.has("asymmetry_paper_marks")&&e.has("asymmetry_paper_positions"))parts.push("SELECT p.option_symbol occ,m.marked_at_ms ts,'asymmetry_paper_marks' source FROM asymmetry_paper_marks m JOIN asymmetry_paper_positions p USING(session_date,position_fingerprint) WHERE m.rejected_reason IS NULL");return parts.length?`SELECT COUNT(*) row_count,NULL distinct_symbols,COUNT(DISTINCT occ) distinct_occs,COUNT(DISTINCT date(ts/1000,'unixepoch','-4 hours')) session_count,MIN(ts) earliest_ms,MAX(ts) latest_ms,GROUP_CONCAT(DISTINCT source) sources FROM (${parts.join(" UNION ALL ")})`:null;},provenance:"Persisted exact-OCC paper/asymmetry marks",trust:"MIXED_EXACT_MARK_EVIDENCE",limitations:["Coverage is selected by existing paper and research lanes; it is not whole-market."]},
  {dataset:"research_observations",tables:["options_research_observations"],sql:()=>`SELECT COUNT(*) row_count,COUNT(DISTINCT symbol) distinct_symbols,COUNT(DISTINCT option_symbol) distinct_occs,COUNT(DISTINCT session_date) session_count,MIN(observed_at_ms) earliest_ms,MAX(observed_at_ms) latest_ms,GROUP_CONCAT(DISTINCT source) sources FROM options_research_observations`,provenance:"Prospective options research observations",trust:"PROSPECTIVE_T0_MIXED_COVERAGE",limitations:["A research observation may have no exact contract or executable quote."]},
  {dataset:"shadow_outcomes",tables:["options_shadow_outcomes","asymmetry_outcomes"],sql:(e)=>{const parts=[];if(e.has("options_shadow_outcomes"))parts.push("SELECT trading_session_date session_date,decision_at_ms ts,option_symbol occ FROM options_shadow_outcomes");if(e.has("asymmetry_outcomes"))parts.push("SELECT session_date,updated_at_ms ts,option_symbol occ FROM asymmetry_outcomes");return parts.length?`SELECT COUNT(*) row_count,NULL distinct_symbols,COUNT(DISTINCT occ) distinct_occs,COUNT(DISTINCT session_date) session_count,MIN(ts) earliest_ms,MAX(ts) latest_ms,'shadow outcome stores' sources FROM (${parts.join(" UNION ALL ")})`:null;},provenance:"Prospective shadow outcome stores",trust:"SHADOW_ONLY",limitations:["Shadow evidence has no live or subscriber authority."]},
  {dataset:"counterfactual_outcomes",tables:["episode_actions","episode_outcome_labels_v2"],sql:()=>`SELECT COUNT(DISTINCT l.label_id) row_count,COUNT(DISTINCT e.symbol) distinct_symbols,COUNT(DISTINCT l.exact_occ) distinct_occs,COUNT(DISTINCT e.trading_day) session_count,MIN(e.t0_ms) earliest_ms,MAX(l.label_as_of_ms) latest_ms,'SetupEpisodeV2 counterfactual + exact labels' sources FROM episode_actions a JOIN setup_episodes e USING(episode_key) JOIN episode_outcome_labels_v2 l USING(episode_key) WHERE a.action_kind='COUNTERFACTUAL' AND l.label_kind='EXACT_OPTION_EXECUTABLE_LABEL' AND l.label_version='FORWARD_LABEL_V1'`,provenance:"Defensible counterfactual actions joined to immutable exact-option labels",trust:"EXACT_WHEN_COMPLETE",limitations:["Censored labels remain unknown and must be filtered by coverage."]},
];

function plannerIndexEstimate(db: Db, index: string): { rows: number; distinctLeading: number | null } | null {
  try {
    const raw = String(db.prepare("SELECT stat FROM sqlite_stat1 WHERE idx=?").get(index)?.stat ?? "").trim();
    const parts = raw.split(/\s+/).map(Number);
    if (!Number.isFinite(parts[0]) || parts[0] < 0) return null;
    const perLeading = parts[1];
    return {
      rows: Math.round(parts[0]),
      distinctLeading: Number.isFinite(perLeading) && perLeading > 0 ? Math.max(1, Math.round(parts[0] / perLeading)) : null,
    };
  } catch { return null; }
}

function plannerTableRows(db: Db, table: string): number | null {
  try {
    const values = db.prepare("SELECT stat FROM sqlite_stat1 WHERE tbl=?").all(table)
      .map((r) => Number(String(r.stat ?? "").trim().split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n) && n >= 0);
    return values.length ? Math.max(...values) : null;
  } catch { return null; }
}

function fencedInventoryEstimate(db: Db, spec: InventorySpec, nowMs: number): string | null {
  const indexes: Record<string,string> = {
    historical_underlying_bars: "idx_hist_bars_symbol_time",
    historical_option_quotes: "idx_hist_opt_quotes_occ_time",
    historical_option_trades: "idx_hist_opt_trades_occ_time",
    historical_contract_reference: "idx_hist_contract_ref_underlying",
  };
  const index = indexes[spec.dataset];
  const indexedEstimate = index ? plannerIndexEstimate(db,index) : null;
  const tableRows = spec.tables.map((table) => plannerTableRows(db,table));
  const estimatedRows = tableRows.every((n) => n != null)
    ? tableRows.reduce((sum,n) => sum + Number(n),0)
    : indexedEstimate?.rows ?? null;
  // Below this threshold an exact aggregate is bounded enough for the off-peak
  // worker. Above it, publish an explicitly estimated breadth row instead of
  // blocking the scheduler on a multi-million-row DISTINCT scan.
  if (estimatedRows == null || estimatedRows <= 250_000) return null;
  const distinctSymbols = ["historical_underlying_bars","historical_contract_reference"].includes(spec.dataset)
    ? indexedEstimate?.distinctLeading ?? null : null;
  const distinctOccs = ["historical_option_quotes","historical_option_trades"].includes(spec.dataset)
    ? indexedEstimate?.distinctLeading ?? null : null;
  const limitations = [...spec.limitations,
    "Row and leading-identity counts are SQLite planner estimates. The exact full-table breadth scan was deliberately deferred so the research worker cannot block the live scheduler."];
  try {
    db.prepare(`INSERT INTO historical_evidence_inventory
      (dataset,row_count,distinct_symbols,distinct_occs,session_count,earliest_ms,latest_ms,sources_json,provenance,point_in_time_trust,limitations_json,measured_at_ms,query_duration_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dataset) DO UPDATE SET
      row_count=excluded.row_count,distinct_symbols=excluded.distinct_symbols,distinct_occs=excluded.distinct_occs,
      session_count=excluded.session_count,earliest_ms=excluded.earliest_ms,latest_ms=excluded.latest_ms,
      sources_json=excluded.sources_json,provenance=excluded.provenance,point_in_time_trust=excluded.point_in_time_trust,
      limitations_json=excluded.limitations_json,measured_at_ms=excluded.measured_at_ms,query_duration_ms=excluded.query_duration_ms`)
      .run(spec.dataset,estimatedRows,distinctSymbols,distinctOccs,null,null,null,JSON.stringify(["sqlite_stat1"]),
        spec.provenance,`${spec.trust}_PLANNER_ESTIMATE`,JSON.stringify(limitations),nowMs,0);
    return spec.dataset;
  } catch { return null; }
}

export function refreshNextHistoricalInventoryDatasetOnDb(db: Db, nowMs: number): string | null {
  const existing=new Set<string>();
  for(const table of new Set(INVENTORY.flatMap((x)=>x.tables).concat(["asymmetry_paper_positions"])))if(hasTable(db,table))existing.add(table);
  let ages=new Map<string,number>();
  try{for(const r of db.prepare("SELECT dataset,measured_at_ms FROM historical_evidence_inventory").all())ages.set(String(r.dataset),Number(r.measured_at_ms));}catch{/* schema unavailable */}
  const due=[...INVENTORY]
    .sort((a,b)=>(ages.get(a.dataset)??0)-(ages.get(b.dataset)??0))
    .filter((spec)=>nowMs-(ages.get(spec.dataset)??0)>=24*60*60_000);
  for (const spec of due) {
    const fenced = fencedInventoryEstimate(db,spec,nowMs);
    if (fenced) return fenced;
    const sql=spec.sql(existing); if(!sql)continue;
    const started=performance.now();
    try{
      const r=db.prepare(sql).get()??{}; const duration=performance.now()-started;
    db.prepare(`INSERT INTO historical_evidence_inventory
      (dataset,row_count,distinct_symbols,distinct_occs,session_count,earliest_ms,latest_ms,sources_json,provenance,point_in_time_trust,limitations_json,measured_at_ms,query_duration_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dataset) DO UPDATE SET
      row_count=excluded.row_count,distinct_symbols=excluded.distinct_symbols,distinct_occs=excluded.distinct_occs,
      session_count=excluded.session_count,earliest_ms=excluded.earliest_ms,latest_ms=excluded.latest_ms,
      sources_json=excluded.sources_json,provenance=excluded.provenance,point_in_time_trust=excluded.point_in_time_trust,
      limitations_json=excluded.limitations_json,measured_at_ms=excluded.measured_at_ms,query_duration_ms=excluded.query_duration_ms`)
      .run(spec.dataset,Number(r.row_count??0),num(r.distinct_symbols),num(r.distinct_occs),num(r.session_count),num(r.earliest_ms),num(r.latest_ms),
        JSON.stringify(String(r.sources??"").split(",").filter(Boolean).sort()),spec.provenance,spec.trust,JSON.stringify(spec.limitations),nowMs,duration);
      return spec.dataset;
    }catch{/* try the next independently measurable dataset */}
  }
  return null;
}

export function buildForwardLearningOverviewOnDb(db: Db, nowMs: number = Date.now(), _env: NodeJS.ProcessEnv = process.env): Record<string,any> {
  const day=tradingDay(nowMs);
  let coverage:any=null, worker:any=null, dataset:any=null, inventory:any[]=[], independentSessions=0;
  try{const r=db.prepare("SELECT report_json FROM forward_label_coverage_snapshots WHERE cohort_date=? ORDER BY created_at_ms DESC LIMIT 1").get(day);coverage=r?parseJson(r.report_json,null):null;}catch{/* */}
  try{worker=db.prepare("SELECT * FROM forward_label_worker_runs ORDER BY finished_at_ms DESC LIMIT 1").get()??null;}catch{/* */}
  try{const r=db.prepare("SELECT * FROM forward_label_dataset_versions ORDER BY created_at_ms DESC LIMIT 1").get();dataset=r?{datasetVersion:r.dataset_version,labelVersion:r.label_version,episodeCount:Number(r.episode_count),labelCount:Number(r.label_count),dateFrom:r.date_from,dateTo:r.date_to,rowsDigest:r.rows_digest}:null;}catch{/* */}
  try{inventory=db.prepare("SELECT * FROM historical_evidence_inventory ORDER BY dataset").all().map((r)=>({dataset:r.dataset,rowCount:Number(r.row_count),distinctSymbols:num(r.distinct_symbols),distinctOccs:num(r.distinct_occs),sessionCount:num(r.session_count),earliestMs:num(r.earliest_ms),latestMs:num(r.latest_ms),sources:parseJson(r.sources_json,[]),provenance:r.provenance,pointInTimeTrust:r.point_in_time_trust,limitations:parseJson(r.limitations_json,[]),measuredAtMs:Number(r.measured_at_ms),queryDurationMs:Number(r.query_duration_ms)}));}catch{/* */}
  try{independentSessions=Number(db.prepare(`SELECT COUNT(DISTINCT e.trading_day) n FROM setup_episodes e
    WHERE e.episode_version=2 AND EXISTS (SELECT 1 FROM episode_outcome_labels_v2 l
      WHERE l.episode_key=e.episode_key AND l.label_version=? AND l.coverage='COMPLETE')`).get(FORWARD_LABEL_VERSION)?.n??0);}catch{/* */}
  return {
    status:worker?.status==="ERROR"?"ERROR":coverage?"COLLECTING":"NOT_MEASURED_YET",version:"FORWARD_LEARNING_V1",
    explanation:"OptiScan is collecting what happened after each observed setup. These labels will be used to test historical patterns; they do not change live callouts.",
    observedToday:coverage?.episodes?.created??null,
    awaitingMaturity:coverage?Math.max(0,coverage.episodes.created-coverage.episodes.mature):null,
    underlyingOutcomesLabeled:coverage?.underlying?.labelsComplete??null,
    exactOptionOutcomesLabeled:coverage?.exactOption?.labelsComplete??null,
    exactOptionCoveragePct:coverage?.exactOption?.coveragePct??null,
    unknownCensoredCount:coverage?.unknown??null,
    independentSessions,latestWorker:worker,dataset,coverage,historicalEvidence:inventory,
    providerCallsAdded:0,providerCapsChanged:false,liveAuthorityChanged:false,
  };
}
