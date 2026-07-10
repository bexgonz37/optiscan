/**
 * Maps live scanner tape rows → opportunity lifecycle signals. PURE (no DB, no
 * `@/` alias) so it is runtime-testable alongside the lifecycle logic.
 *
 * Safety: honours the bearish gate. A bearish/put thesis is NEVER confirmed or
 * near-trigger here — it is demoted to research-only unless BEARISH_ACTIONABLE
 * is explicitly on. This mirrors lib/bearish-gate.ts and keeps the
 * BEARISH_ACTIONABLE-off guarantee intact end to end.
 */
import type { OppSignal, OppFlags } from "./opportunity-lifecycle.ts";

export type TapeRow = {
  symbol?: string;
  price?: number | null;
  movePct?: number | null;
  shortRate?: number | null;
  direction?: string | null;
  confidence?: number | null;
  hodBreak?: boolean;
  lodBreak?: boolean;
  aboveVwap?: boolean;
  vwapDistPct?: number | null;
  relVol?: number | null;
  core?: boolean;
};

export type MapContext = {
  /** required data is blocking for this symbol (from data-freshness) */
  staleSymbols?: Set<string>;
  /** true when short/put outputs may be actionable (BEARISH_ACTIONABLE=1) */
  bearishActionable?: boolean;
  /** outside a tradable options session → confirmations become research-only */
  optionsSession?: boolean;
};

function isBearish(direction: string | null | undefined): boolean {
  return String(direction ?? "").toLowerCase() === "bearish";
}

/**
 * Derive an opportunity signal from a tape row. Returns null for rows too weak
 * to track (keeps the opportunity table from filling with noise).
 */
export function signalFromTapeRow(row: TapeRow, ctx: MapContext = {}): OppSignal | null {
  const ticker = String(row.symbol ?? "").toUpperCase();
  if (!ticker) return null;
  const confidence = Math.max(0, Math.min(100, Number(row.confidence) || 0));
  const bearish = isBearish(row.direction);

  // Only track rows with some conviction; below this they are pure tape noise.
  if (confidence < 20) return null;

  const stale = ctx.staleSymbols?.has(ticker) ?? false;
  const bearishBlocked = bearish && !ctx.bearishActionable;
  const outOfSession = ctx.optionsSession === false;

  // A break of the day's extreme in the trade direction = confirmation candidate.
  const brokeLevel = bearish ? Boolean(row.lodBreak) : Boolean(row.hodBreak);
  const strongMomentum = Math.abs(Number(row.shortRate) || 0) >= 0.17 && confidence >= 60;

  const flags: OppFlags = {};
  if (stale) {
    flags.dataStale = true;
  } else if (bearishBlocked) {
    // bearish gate: research-only, never actionable
    flags.researchOnly = true;
  } else if (outOfSession) {
    // outside RTH options window: detectable, not actionable
    flags.researchOnly = true;
  } else if (brokeLevel && strongMomentum) {
    flags.confirmed = true;
  } else if (confidence >= 55 && (strongMomentum || brokeLevel)) {
    flags.nearTrigger = true;
  }

  return {
    ticker,
    setupType: bearish ? "momentum_short" : "momentum_long",
    score: confidence,
    triggerLevel: row.price ?? null,
    entryZone: row.price != null ? `~${Number(row.price).toFixed(2)}` : null,
    invalidationLevel: null,
    expirationTime: null,
    flags,
  };
}

/** Map a batch of tape rows, dropping the ones too weak to track. */
export function signalsFromTape(rows: TapeRow[], ctx: MapContext = {}): OppSignal[] {
  const out: OppSignal[] = [];
  for (const row of rows ?? []) {
    const sig = signalFromTapeRow(row, ctx);
    if (sig) out.push(sig);
  }
  return out;
}
