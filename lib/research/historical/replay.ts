/**
 * replay.ts — HISTORICAL_REPLAY_V1. Reconstruct what OptiScan COULD HAVE KNOWN at a
 * historical instant T, from the durable store only.
 *
 * ── The one rule ─────────────────────────────────────────────────────────────
 *
 *     ONLY DATA TIMESTAMPED <= T MAY BE VISIBLE.
 *
 * Every read in this module is fenced by `asOfMs` in SQL, not filtered afterwards in
 * TypeScript. The distinction is load-bearing: a post-filter is a line of code someone
 * can move, reorder or short-circuit, and the resulting leak produces a backtest that
 * looks brilliant and predicts nothing. A `WHERE ts_ms <= ?` in the query cannot be
 * bypassed by a later edit to the caller.
 *
 * This is why the module reads the DURABLE STORE rather than the provider. A live
 * fetcher has no notion of "as of"; it returns whatever exists now, and every honest
 * fence would have to be re-implemented at each call site.
 *
 * ── What "could have known" excludes ─────────────────────────────────────────
 *
 * No future bars. No future quotes. No later option marks. No realized outcome. And
 * specifically NO SESSION HIGH/LOW computed over the whole day — the single most
 * seductive leak in this codebase, because the final HOD/LOD is exactly what makes a
 * "share of the move consumed" metric look precise. Session extremes here are computed
 * from bars up to T and are therefore SESSION-TO-DATE, which is what a live scanner
 * would have had.
 *
 * ── Fail closed ──────────────────────────────────────────────────────────────
 *
 * Absent inputs produce nulls and a named `missing` list, never a substituted value.
 * A replay that quietly fills a gap is worse than one that refuses: the refusal is
 * visible in the evidence strength, the substitution is not.
 *
 * RESEARCH ONLY. Nothing here is read by a gate, threshold, ranking weight, stop, exit
 * or alert.
 */
import type { StoreDb, Timeframe } from "./store.ts";

export const HISTORICAL_REPLAY_VERSION = "HISTORICAL_REPLAY_V1" as const;

const num = (v: unknown): number | null => {
  const x = Number(v);
  return v == null || v === "" || !Number.isFinite(x) ? null : x;
};

function hasTable(db: StoreDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get?.(name));
  } catch {
    return false;
  }
}

export interface ReplayBar {
  tsMs: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  vwap: number | null;
}

/**
 * Bars for `symbol` at or before `asOfMs`, oldest first.
 *
 * `asOfMs` is compared against the bar's OPEN time, and the comparison is `<=`. A bar
 * that opened at exactly T was in progress at T, so its close is NOT knowable — callers
 * that need only settled bars must pass `settledOnly`, which requires the bar to have
 * closed by T given its timeframe.
 */
export function replayBarsOnDb(
  db: StoreDb,
  symbol: string,
  opts: { asOfMs: number; timeframe?: Timeframe; lookbackMs?: number; settledOnly?: boolean; limit?: number },
): ReplayBar[] {
  if (!hasTable(db, "historical_underlying_bars")) return [];
  const tf: Timeframe = opts.timeframe ?? "1m";
  const limit = Math.max(1, Math.min(20_000, opts.limit ?? 2000));
  const sinceMs = opts.lookbackMs != null ? opts.asOfMs - opts.lookbackMs : null;
  // A bar is settled at T only if its whole span is behind T.
  const spanMs = tf === "1d" ? 86_400_000 : tf === "5m" ? 300_000 : 60_000;
  const cutoff = opts.settledOnly ? opts.asOfMs - spanMs : opts.asOfMs;
  try {
    const rows = (db.prepare(
      `SELECT ts_ms, open, high, low, close, volume, vwap
         FROM historical_underlying_bars
        WHERE symbol=? AND timeframe=? AND ts_ms <= ?
          ${sinceMs != null ? "AND ts_ms >= ?" : ""}
        ORDER BY ts_ms ASC LIMIT ?`,
    ).all?.(
      ...(sinceMs != null
        ? [String(symbol).toUpperCase(), tf, cutoff, sinceMs, limit]
        : [String(symbol).toUpperCase(), tf, cutoff, limit]),
    ) ?? []) as any[];
    return rows.map((r) => ({
      tsMs: Number(r.ts_ms),
      open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.close),
      volume: num(r.volume), vwap: num(r.vwap),
    }));
  } catch {
    return [];
  }
}

/**
 * The NBBO in force at T: the last quote at or before T, subject to staleness.
 *
 * Returns null rather than the nearest quote when the gap exceeds tolerance. A contract
 * with no quote near the instant was not executable then, and returning the nearest one
 * manufactures a fill that never existed. Never reads forward — the nearest quote AFTER
 * T is exactly the leak this function exists to refuse.
 */
export function replayQuoteAsOfOnDb(
  db: StoreDb,
  occ: string,
  opts: { asOfMs: number; maxStalenessMs?: number },
): { tsMs: number; bid: number | null; ask: number | null; ageMs: number } | null {
  if (!hasTable(db, "historical_option_quotes")) return null;
  const tol = Math.max(1000, opts.maxStalenessMs ?? 5 * 60_000);
  try {
    const r = db.prepare(
      `SELECT ts_ms, bid, ask FROM historical_option_quotes
        WHERE occ=? AND ts_ms <= ? ORDER BY ts_ms DESC LIMIT 1`,
    ).get?.(String(occ).toUpperCase(), opts.asOfMs);
    if (!r) return null;
    const ts = Number(r.ts_ms);
    const age = opts.asOfMs - ts;
    if (age > tol) return null;
    return { tsMs: ts, bid: num(r.bid), ask: num(r.ask), ageMs: age };
  } catch {
    return null;
  }
}

/** Trade prints at or before T. Reported as trades, never as executable quotes. */
export function replayTradesUpToOnDb(
  db: StoreDb,
  occ: string,
  opts: { asOfMs: number; sinceMs?: number | null; limit?: number },
): Array<{ tsMs: number; price: number | null; size: number | null }> {
  if (!hasTable(db, "historical_option_trades")) return [];
  const limit = Math.max(1, Math.min(20_000, opts.limit ?? 5000));
  try {
    const rows = (db.prepare(
      `SELECT ts_ms, price, size FROM historical_option_trades
        WHERE occ=? AND ts_ms <= ? ${opts.sinceMs != null ? "AND ts_ms >= ?" : ""}
        ORDER BY ts_ms ASC LIMIT ?`,
    ).all?.(
      ...(opts.sinceMs != null
        ? [String(occ).toUpperCase(), opts.asOfMs, opts.sinceMs, limit]
        : [String(occ).toUpperCase(), opts.asOfMs, limit]),
    ) ?? []) as any[];
    return rows.map((r) => ({ tsMs: Number(r.ts_ms), price: num(r.price), size: num(r.size) }));
  } catch {
    return [];
  }
}

// ── reconstructed state ──────────────────────────────────────────────────────

export type ReplayEvidenceStrength = "COMPLETE" | "PARTIAL" | "INSUFFICIENT";

export interface ReplayUnderlyingState {
  version: typeof HISTORICAL_REPLAY_VERSION;
  symbol: string;
  asOfMs: number;
  sessionDate: string | null;

  price: number | null;
  /** SESSION-TO-DATE extremes, computed from bars up to T only. Never the day's final. */
  sessionHigh: number | null;
  sessionLow: number | null;
  sessionOpen: number | null;
  vwap: number | null;
  aboveVwap: boolean | null;

  /** Recent realized range as a share of price. Small = compressed. */
  compressionPct: number | null;
  /** Latest bar volume vs the mean of the prior window. */
  volumeAcceleration: number | null;
  /** Percent move over the last few bars. */
  velocityPct: number | null;

  barsUsed: number;
  missing: string[];
  evidenceStrength: ReplayEvidenceStrength;
  note: string;
}

/** Eastern session date for an instant, so replay rows bucket like live rows. */
export function sessionDateOf(atMs: number): string | null {
  try {
    return new Date(atMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  } catch {
    return null;
  }
}

/** Eastern midnight for the session containing `atMs`, as an epoch ms lower bound. */
function sessionStartMs(atMs: number): number {
  const d = sessionDateOf(atMs);
  if (!d) return atMs - 86_400_000;
  // 09:30 ET is the session open; bars before it are premarket and still knowable.
  const parsed = Date.parse(`${d}T00:00:00-05:00`);
  return Number.isFinite(parsed) ? parsed : atMs - 86_400_000;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * Reconstruct the underlying picture at T from stored bars.
 *
 * Everything is computed from the bars this function itself fetched under the fence, so
 * there is no path by which a later bar can reach the result. `sessionHigh`/`sessionLow`
 * are the running extremes THROUGH T, which is what a live scanner would have seen — the
 * day's final HOD/LOD is not knowable at T and is never used.
 */
export function replayUnderlyingStateOnDb(
  db: StoreDb,
  symbol: string,
  asOfMs: number,
  opts: { timeframe?: Timeframe; lookbackBars?: number } = {},
): ReplayUnderlyingState {
  const tf: Timeframe = opts.timeframe ?? "1m";
  const missing: string[] = [];
  const sessionStart = sessionStartMs(asOfMs);

  const sessionBars = replayBarsOnDb(db, symbol, {
    asOfMs, timeframe: tf, lookbackMs: asOfMs - sessionStart, limit: 5000,
  });

  const base: ReplayUnderlyingState = {
    version: HISTORICAL_REPLAY_VERSION,
    symbol: String(symbol).toUpperCase(),
    asOfMs,
    sessionDate: sessionDateOf(asOfMs),
    price: null, sessionHigh: null, sessionLow: null, sessionOpen: null,
    vwap: null, aboveVwap: null,
    compressionPct: null, volumeAcceleration: null, velocityPct: null,
    barsUsed: sessionBars.length,
    missing,
    evidenceStrength: "INSUFFICIENT",
    note: "",
  };

  if (!sessionBars.length) {
    missing.push("bars");
    base.note = "no stored bars at or before this instant; nothing about the underlying is knowable";
    return base;
  }

  const closes = sessionBars.map((b) => b.close).filter((v): v is number => v != null);
  const highs = sessionBars.map((b) => b.high).filter((v): v is number => v != null);
  const lows = sessionBars.map((b) => b.low).filter((v): v is number => v != null);
  const vols = sessionBars.map((b) => b.volume).filter((v): v is number => v != null);

  base.price = closes.length ? closes[closes.length - 1] : null;
  if (base.price == null) missing.push("price");
  base.sessionHigh = highs.length ? Math.max(...highs) : null;
  base.sessionLow = lows.length ? Math.min(...lows) : null;
  if (base.sessionHigh == null || base.sessionLow == null) missing.push("sessionExtremes");
  base.sessionOpen = sessionBars[0]?.open ?? null;
  if (base.sessionOpen == null) missing.push("sessionOpen");

  // VWAP from the provider's per-bar vwap weighted by volume; null when either is absent
  // rather than falling back to a close average, which is a different statistic.
  const vwapPairs = sessionBars
    .map((b) => (b.vwap != null && b.volume != null && b.volume > 0 ? [b.vwap, b.volume] as const : null))
    .filter((p): p is readonly [number, number] => p != null);
  if (vwapPairs.length) {
    const totVol = vwapPairs.reduce((a, [, v]) => a + v, 0);
    base.vwap = totVol > 0 ? +(vwapPairs.reduce((a, [p, v]) => a + p * v, 0) / totVol).toFixed(6) : null;
  } else {
    missing.push("vwap");
  }
  base.aboveVwap = base.vwap != null && base.price != null ? base.price >= base.vwap : null;

  // Compression: the recent realized range as a share of price. Uses the tail of the
  // fenced window, so it can never widen because of a later bar.
  const tail = sessionBars.slice(-Math.max(5, opts.lookbackBars ?? 20));
  const tHigh = tail.map((b) => b.high).filter((v): v is number => v != null);
  const tLow = tail.map((b) => b.low).filter((v): v is number => v != null);
  if (tHigh.length && tLow.length && base.price && base.price > 0) {
    base.compressionPct = +(((Math.max(...tHigh) - Math.min(...tLow)) / base.price) * 100).toFixed(4);
  } else {
    missing.push("compressionPct");
  }

  if (vols.length >= 6) {
    const latest = vols[vols.length - 1];
    const prior = mean(vols.slice(-6, -1));
    base.volumeAcceleration = prior && prior > 0 ? +(latest / prior).toFixed(4) : null;
  }
  if (base.volumeAcceleration == null) missing.push("volumeAcceleration");

  if (closes.length >= 6) {
    const back = closes[closes.length - 6];
    base.velocityPct = back > 0 ? +(((base.price! - back) / back) * 100).toFixed(4) : null;
  }
  if (base.velocityPct == null) missing.push("velocityPct");

  base.evidenceStrength = missing.length === 0
    ? "COMPLETE"
    : base.price != null && base.sessionHigh != null && base.sessionLow != null
      ? "PARTIAL"
      : "INSUFFICIENT";
  base.note =
    `reconstructed from ${sessionBars.length} stored ${tf} bars at or before the instant. `
    + "Session extremes are SESSION-TO-DATE through this instant, never the day's final high/low.";
  return base;
}

// ── contract economics at T ──────────────────────────────────────────────────

export interface ReplayContractState {
  version: typeof HISTORICAL_REPLAY_VERSION;
  occ: string;
  asOfMs: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadPct: number | null;
  quoteAgeMs: number | null;
  /** What a buyer would have crossed for. Null when no executable quote existed. */
  executableAsk: number | null;
  dte: number | null;
  moneynessPct: number | null;
  strike: number | null;
  side: "call" | "put" | null;
  expiration: string | null;
  missing: string[];
  evidenceStrength: ReplayEvidenceStrength;
  note: string;
}

/**
 * Contract economics at T, from stored NBBO plus stored reference metadata.
 *
 * `executableAsk` is null unless a quote existed within tolerance. Trades are
 * deliberately NOT used as a fallback: a print says someone traded there, not that we
 * could have. Substituting one for the other is the specific fiction this refuses.
 */
export function replayContractStateOnDb(
  db: StoreDb,
  occ: string,
  asOfMs: number,
  opts: { underlyingPrice?: number | null; maxStalenessMs?: number } = {},
): ReplayContractState {
  const missing: string[] = [];
  const key = String(occ).toUpperCase();
  const out: ReplayContractState = {
    version: HISTORICAL_REPLAY_VERSION,
    occ: key, asOfMs,
    bid: null, ask: null, mid: null, spreadPct: null, quoteAgeMs: null, executableAsk: null,
    dte: null, moneynessPct: null, strike: null, side: null, expiration: null,
    missing, evidenceStrength: "INSUFFICIENT", note: "",
  };

  let ref: any = null;
  if (hasTable(db, "historical_contract_reference")) {
    try { ref = db.prepare("SELECT * FROM historical_contract_reference WHERE occ=?").get?.(key); }
    catch { ref = null; }
  }
  if (ref) {
    out.strike = num(ref.strike);
    out.side = String(ref.side) === "put" ? "put" : "call";
    out.expiration = ref.expiration == null ? null : String(ref.expiration);
    if (out.expiration) {
      const expMs = Date.parse(`${out.expiration}T21:00:00Z`);
      if (Number.isFinite(expMs)) out.dte = Math.max(0, Math.round((expMs - asOfMs) / 86_400_000));
    }
  } else {
    missing.push("contractReference");
  }

  const q = replayQuoteAsOfOnDb(db, key, { asOfMs, maxStalenessMs: opts.maxStalenessMs });
  if (q) {
    out.bid = q.bid; out.ask = q.ask; out.quoteAgeMs = q.ageMs;
    if (q.bid != null && q.ask != null && q.ask > 0) {
      out.mid = +((q.bid + q.ask) / 2).toFixed(6);
      out.spreadPct = +(((q.ask - q.bid) / q.ask) * 100).toFixed(4);
    }
    out.executableAsk = q.ask;
  } else {
    missing.push("executableQuote");
  }

  const up = num(opts.underlyingPrice);
  if (up != null && up > 0 && out.strike != null) {
    out.moneynessPct = +(((out.strike - up) / up) * 100).toFixed(4);
  } else if (out.strike != null) {
    missing.push("moneynessPct");
  }

  out.evidenceStrength = out.executableAsk != null && ref
    ? (missing.length === 0 ? "COMPLETE" : "PARTIAL")
    : "INSUFFICIENT";
  out.note = out.executableAsk == null
    ? "no executable NBBO within tolerance at this instant; a trade print is NOT substituted for one"
    : "economics reconstructed from stored NBBO at or before the instant";
  return out;
}

// ── forward measurement (hindsight ALLOWED, and only here) ───────────────────

export interface ForwardExcursion {
  version: typeof HISTORICAL_REPLAY_VERSION;
  occ: string;
  fromMs: number;
  toMs: number;
  entryConvention: string;
  entry: number | null;
  /** Best/worst subsequent MID, on the same contract. Null when unsupported. */
  mfePct: number | null;
  maePct: number | null;
  msToMilestone: Record<string, number | null>;
  quotesUsed: number;
  note: string;
}

export const FORWARD_MILESTONES = [10, 25, 50, 100, 200] as const;

/**
 * What the contract did AFTER T. Hindsight is legitimate here and nowhere else.
 *
 * Kept in this module but rigorously separate from the reconstruction functions above,
 * and named so a caller cannot mistake one for the other. Fusing them would produce a
 * classifier that grades itself perfectly in backtest and is worthless live.
 *
 * Entry is the ASK at T — what a buyer crosses — and every later observation is the MID,
 * which is the conservative reading of "what the position was worth". Using the ask for
 * both would understate every move; using the bid for both would overstate it.
 */
export function forwardExcursionOnDb(
  db: StoreDb,
  occ: string,
  opts: { fromMs: number; toMs: number; maxStalenessMs?: number },
): ForwardExcursion {
  const key = String(occ).toUpperCase();
  const out: ForwardExcursion = {
    version: HISTORICAL_REPLAY_VERSION,
    occ: key, fromMs: opts.fromMs, toMs: opts.toMs,
    entryConvention: "ASK at T (a buyer crosses the spread); later observations are MID",
    entry: null, mfePct: null, maePct: null,
    msToMilestone: Object.fromEntries(FORWARD_MILESTONES.map((m) => [String(m), null])),
    quotesUsed: 0,
    note: "",
  };
  const at = replayQuoteAsOfOnDb(db, key, { asOfMs: opts.fromMs, maxStalenessMs: opts.maxStalenessMs });
  if (!at || at.ask == null || !(at.ask > 0)) {
    out.note = "no executable entry quote at T; nothing can be measured from an entry that did not exist";
    return out;
  }
  out.entry = at.ask;

  if (!hasTable(db, "historical_option_quotes")) {
    out.note = "no stored quotes";
    return out;
  }
  let rows: any[] = [];
  try {
    rows = (db.prepare(
      `SELECT ts_ms, bid, ask FROM historical_option_quotes
        WHERE occ=? AND ts_ms > ? AND ts_ms <= ? ORDER BY ts_ms ASC LIMIT 50000`,
    ).all?.(key, opts.fromMs, opts.toMs) ?? []) as any[];
  } catch {
    rows = [];
  }
  const marks = rows
    .map((r) => {
      const b = num(r.bid); const a = num(r.ask);
      return b != null && a != null ? { tsMs: Number(r.ts_ms), mid: (b + a) / 2 } : null;
    })
    .filter((m): m is { tsMs: number; mid: number } => m != null);
  out.quotesUsed = marks.length;
  if (!marks.length) {
    out.note = "an entry existed but nothing was quoted afterwards in the window";
    return out;
  }

  const rets = marks.map((m) => ({ tsMs: m.tsMs, pct: ((m.mid - out.entry!) / out.entry!) * 100 }));
  out.mfePct = +Math.max(...rets.map((r) => r.pct)).toFixed(4);
  out.maePct = +Math.min(...rets.map((r) => r.pct)).toFixed(4);
  for (const m of FORWARD_MILESTONES) {
    const hit = rets.find((r) => r.pct >= m);
    out.msToMilestone[String(m)] = hit ? hit.tsMs - opts.fromMs : null;
  }
  out.note = `${marks.length} same-contract quotes after T; entry ${out.entry} (ask at T)`;
  return out;
}
