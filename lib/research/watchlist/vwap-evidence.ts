/**
 * vwap-evidence.ts — PURE classification of underlying VWAP provenance.
 *
 * The Watchlist evidence gate needs to know not just "what is the VWAP" but
 * "how much can this number be trusted, and for what". A VWAP computed from
 * yesterday's bars is a legitimate reference for an overnight plan and an
 * illegitimate basis for a live SEND, so the two uses are separated here rather
 * than at the call sites.
 *
 * HONESTY RULES:
 *  - A VWAP is never invented, defaulted, or carried forward. Absent input is
 *    UNAVAILABLE, and UNAVAILABLE never reads as a level.
 *  - Freshness is derived from when the value was COMPUTED and which trading
 *    session its bars belong to — never from when it was persisted.
 *  - Only LIVE evidence is usable for live subscriber delivery. PRIOR_SESSION is
 *    usable for overnight planning only, and is always labelled as such.
 */
import { tradingDay } from "../../trading-session.ts";

export type VwapEvidenceState = "LIVE" | "PRIOR_SESSION" | "STALE" | "UNAVAILABLE";

/** Default staleness bound for treating a computed session VWAP as live. */
export const DEFAULT_VWAP_MAX_LIVE_AGE_MS = 5 * 60_000;

export interface VwapEvidence {
  /** The VWAP value, or null when no trustworthy value exists. */
  value: number | null;
  state: VwapEvidenceState;
  /** Human-readable freshness, safe to render directly. */
  freshness: string;
  /** ET trading day of the bars the VWAP was computed from. */
  session: string | null;
  /** Provider/derivation source, e.g. "session_bars_1m". */
  source: string | null;
  /** When the value was computed (not when it was stored). */
  asOfMs: number | null;
  ageMs: number | null;
  /** Overnight/next-session planning may use LIVE or PRIOR_SESSION. */
  usableForWatchlist: boolean;
  /** Live subscriber delivery requires LIVE evidence only. */
  usableForLiveSend: boolean;
  /** Why the value was rejected, when it was. */
  reason: string | null;
}

function unavailable(reason: string): VwapEvidence {
  return {
    value: null,
    state: "UNAVAILABLE",
    freshness: "Unavailable",
    session: null,
    source: null,
    asOfMs: null,
    ageMs: null,
    usableForWatchlist: false,
    usableForLiveSend: false,
    reason,
  };
}

/**
 * Classify a computed VWAP into evidence usable for planning and/or live send.
 *
 * `barsTradingDay` is the ET trading day of the candles the VWAP was computed
 * from. When omitted it is derived from `computedAtMs`, which is only correct
 * when the bars are from the same session — callers with the bar timestamps
 * should always pass it explicitly.
 */
export function classifyVwapEvidence(input: {
  vwap: number | null | undefined;
  computedAtMs: number | null | undefined;
  barsTradingDay?: string | null;
  nowMs: number;
  source?: string | null;
  maxLiveAgeMs?: number;
}): VwapEvidence {
  const { vwap, computedAtMs, nowMs } = input;
  if (vwap == null || !Number.isFinite(vwap) || vwap <= 0) {
    return unavailable("no_vwap_value");
  }
  if (computedAtMs == null || !Number.isFinite(computedAtMs)) {
    return unavailable("no_computation_timestamp");
  }
  const ageMs = nowMs - computedAtMs;
  if (ageMs < 0) return unavailable("computation_timestamp_in_future");

  const source = input.source ?? "session_bars_1m";
  const session = input.barsTradingDay ?? tradingDay(computedAtMs);
  const currentDay = tradingDay(nowMs);
  const maxLiveAgeMs = Math.max(1_000, input.maxLiveAgeMs ?? DEFAULT_VWAP_MAX_LIVE_AGE_MS);

  // Bars from an earlier session are a valid overnight reference, never a live mark.
  if (session !== currentDay) {
    return {
      value: vwap,
      state: "PRIOR_SESSION",
      freshness: `Prior session (${session})`,
      session,
      source,
      asOfMs: computedAtMs,
      ageMs,
      usableForWatchlist: true,
      usableForLiveSend: false,
      reason: null,
    };
  }

  // Same session but the computation is old: usable for planning, not for a live mark.
  if (ageMs > maxLiveAgeMs) {
    return {
      value: vwap,
      state: "STALE",
      freshness: `Stale (${Math.round(ageMs / 60_000)}m old)`,
      session,
      source,
      asOfMs: computedAtMs,
      ageMs,
      usableForWatchlist: true,
      usableForLiveSend: false,
      reason: "computation_older_than_live_bound",
    };
  }

  return {
    value: vwap,
    state: "LIVE",
    freshness: "Live session VWAP",
    session,
    source,
    asOfMs: computedAtMs,
    ageMs,
    usableForWatchlist: true,
    usableForLiveSend: true,
    reason: null,
  };
}

/** Persisted columns for one alert's VWAP evidence. Nulls stay null. */
export interface VwapEvidenceColumns {
  vwapAtAlert: number | null;
  vwapDistPctAtAlert: number | null;
  aboveVwap: boolean | null;
  vwapEvidenceState: VwapEvidenceState;
  vwapFreshness: string;
  vwapSession: string | null;
  vwapSource: string | null;
  vwapAsOfMs: number | null;
}

/**
 * Shape VWAP evidence for persistence alongside an alert. `underlyingPrice` is
 * only used to derive the distance percentage; it is never used to invent a VWAP.
 */
export function vwapEvidenceColumns(
  evidence: VwapEvidence,
  underlyingPrice: number | null | undefined,
): VwapEvidenceColumns {
  const value = evidence.value;
  const price = underlyingPrice != null && Number.isFinite(underlyingPrice) && underlyingPrice > 0
    ? underlyingPrice
    : null;
  const distPct = value != null && price != null
    ? +(((price - value) / value) * 100).toFixed(4)
    : null;
  return {
    vwapAtAlert: value,
    vwapDistPctAtAlert: distPct,
    aboveVwap: value == null || price == null ? null : price >= value,
    vwapEvidenceState: evidence.state,
    vwapFreshness: evidence.freshness,
    vwapSession: evidence.session,
    vwapSource: evidence.source,
    vwapAsOfMs: evidence.asOfMs,
  };
}

export interface VwapCompleteness {
  total: number;
  live: number;
  priorSession: number;
  stale: number;
  unavailable: number;
  /** Rows with a VWAP usable for Watchlist planning (LIVE + PRIOR_SESSION + STALE). */
  usableForWatchlist: number;
  usablePct: number | null;
  /** Rows with no VWAP at all — the Watchlist blocker. */
  missingPct: number | null;
}

/**
 * Completeness diagnostic over persisted alert rows. Counts only what is
 * actually stored; a row with no evidence column is UNAVAILABLE, never assumed.
 */
export function vwapCompleteness(
  rows: Array<{ vwap_at_alert?: unknown; vwap_evidence_state?: unknown }>,
): VwapCompleteness {
  const out: VwapCompleteness = {
    total: rows.length,
    live: 0,
    priorSession: 0,
    stale: 0,
    unavailable: 0,
    usableForWatchlist: 0,
    usablePct: null,
    missingPct: null,
  };
  for (const row of rows) {
    const value = Number(row.vwap_at_alert);
    const hasValue = row.vwap_at_alert != null && Number.isFinite(value) && value > 0;
    const state = String(row.vwap_evidence_state ?? "").toUpperCase();
    // An explicit UNAVAILABLE state overrides a stored value: the planner rejects it,
    // so counting it as usable here would overstate completeness.
    if (!hasValue || state === "UNAVAILABLE") { out.unavailable += 1; continue; }
    if (state === "LIVE") out.live += 1;
    else if (state === "PRIOR_SESSION") out.priorSession += 1;
    else if (state === "STALE") out.stale += 1;
    else {
      // A stored value with no recorded provenance cannot be promoted to LIVE.
      out.stale += 1;
    }
  }
  out.usableForWatchlist = out.live + out.priorSession + out.stale;
  if (out.total > 0) {
    out.usablePct = +((out.usableForWatchlist / out.total) * 100).toFixed(1);
    out.missingPct = +((out.unavailable / out.total) * 100).toFixed(1);
  }
  return out;
}
