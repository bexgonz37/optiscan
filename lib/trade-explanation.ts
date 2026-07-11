/**
 * trade-explanation.ts — the ONE pure, deterministic explanation builder shared
 * by the desktop dashboard (Simple + Advanced) and Discord.
 *
 * PURE by design: no DB, no provider I/O, no `@/` alias, and no wall-clock in the
 * OUTPUT (callers pass any timestamps they need pre-resolved). This mirrors the
 * lifecycle/store split — impure gathering lives in lib/explanation-adapters.ts,
 * which normalizes verified fields and calls buildTradeExplanation() here.
 *
 * Determinism + honesty guarantees:
 *   - Every field is null / [] when its source value is absent — NOTHING is
 *     fabricated (no invented market data, probabilities, win rates, or reasons).
 *   - A PUT / bearish thesis can NEVER become ACTIONABLE here. The selector and
 *     lib/bearish-gate.ts remain the authorities; this is only a display guard.
 *   - Historical evidence is gated: only an ESTABLISHED sample ever surfaces a
 *     numeric win rate / expectancy — weaker samples show a qualitative caveat.
 *
 * Type-only imports (erased at runtime) keep this module free of side effects.
 */
import type { SelectionResult, RejectionCode } from "./contract-selector.ts";
import type { LifecycleStatus } from "./opportunity-lifecycle.ts";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export type ActionabilityStatus =
  | "ACTIONABLE"
  | "WATCH"
  | "RESEARCH_ONLY"
  | "BLOCKED"
  | "INVALIDATED"
  | "NO_VALID_CONTRACT";

export type EvidenceStatus =
  | "NOT_TRACKED"
  | "INSUFFICIENT_HISTORY"
  | "EARLY_EVIDENCE"
  | "ESTABLISHED_EVIDENCE";

/** A metric to show, already formatted (Advanced view + Discord one-liner). */
export interface SupportingMetric {
  key: string; // METRIC_GLOSSARY key when one exists, else ""
  label: string;
  value: string;
  raw?: number | null;
}

/** A glossary pointer — the client resolves full text via metricInfo(key). */
export interface GlossaryRef {
  key: string;
  label: string;
}

export interface ExplanationContract {
  optionSymbol?: string | null;
  strike?: number | null;
  side?: "call" | "put" | null;
  expiration?: string | null;
  dte?: number | null;
  bid?: number | null;
  ask?: number | null;
  mid?: number | null;
  spreadPct?: number | null;
  delta?: number | null;
  iv?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  breakevenPct?: number | null;
}

export interface ExplanationEvidence {
  dataQuality?: "empty" | "limited" | "developing" | "strong" | null;
  sampleSize?: number | null;
  winRate?: number | null; // 0..100 (already a percent)
  expectancy?: number | null; // percent
}

/**
 * Normalized, already-verified inputs. The adapter fills what it has; the builder
 * never invents anything for the fields left null.
 */
export interface ExplanationSource {
  ticker: string;
  direction?: "bullish" | "bearish" | "neutral" | null;
  side?: "call" | "put" | null;

  /** Lifecycle status (opportunities). Optional for pure selection/alert sources. */
  lifecycleStatus?: LifecycleStatus | null;

  /** Structured contract-selection result — the richest source when present. */
  selection?: SelectionResult | null;

  /** Freshness (already evaluated by the adapter via data-freshness). */
  freshnessBlocked?: boolean;
  freshnessReason?: string | null;
  freshnessLabel?: string | null; // e.g. "LIVE", "STALE (after-hours)"

  /** Narrative fragments (deterministic, from explain.js / lifecycle). */
  whyNow?: string | null;
  improveIf?: string | null;
  invalidateIf?: string | null;

  /** Market context for metrics + risk wording. */
  movePct?: number | null;
  relVol?: number | null;
  vwapRelationship?: string | null; // "above VWAP" | "below VWAP" | null
  riskScore?: number | null;
  riskLabel?: string | null;
  score?: number | null; // setup/selection score for advanced

  /** Contract descriptor. When absent, contractSummary is null. */
  contract?: ExplanationContract | null;
  /** Label for the price quote, e.g. "Estimated midpoint". */
  midpointLabel?: string | null;

  evidence?: ExplanationEvidence | null;

  /** Extra safety/context notes to carry through verbatim. */
  extraNotes?: string[];
}

export interface TradeExplanation {
  schemaVersion: 1;
  ticker: string;
  direction: "bullish" | "bearish" | "neutral";
  side: "call" | "put" | null;
  actionabilityStatus: ActionabilityStatus;
  statusLabel: string;
  plainSummary: string;
  whyNow: string | null;
  contractSummary: string | null;
  riskSummary: string;
  selectedBecause: string | null;
  rejectedBecause: string | null;
  wouldImproveIf: string | null;
  invalidatedIf: string | null;
  supportingMetrics: SupportingMetric[];
  glossaryTerms: GlossaryRef[];
  evidenceStatus: EvidenceStatus;
  evidenceSummary: string;
  advanced: {
    bid: number | null;
    ask: number | null;
    mid: number | null;
    spreadPct: number | null;
    delta: number | null;
    iv: number | null;
    volume: number | null;
    openInterest: number | null;
    dte: number | null;
    breakevenPct: number | null;
    relVol: number | null;
    vwapRelationship: string | null;
    freshness: string | null;
    score: number | null;
    passedGates: string[];
    failedGates: string[];
    rejection: { code: string; reason: string; blockedByGate: Record<string, number> } | null;
  };
  notes: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Human labels
// ─────────────────────────────────────────────────────────────────────────────

const ACTIONABILITY_LABEL: Record<ActionabilityStatus, string> = {
  ACTIONABLE: "Actionable",
  WATCH: "Watch",
  RESEARCH_ONLY: "Research only",
  BLOCKED: "Blocked",
  INVALIDATED: "Invalidated",
  NO_VALID_CONTRACT: "No valid contract",
};

export function actionabilityLabel(s: ActionabilityStatus): string {
  return ACTIONABILITY_LABEL[s];
}

/** Rejection codes that indicate a data/freshness problem (→ BLOCKED, not NVC). */
const DATA_BLOCK_CODES: ReadonlySet<RejectionCode> = new Set<RejectionCode>([
  "CHAIN_UNAVAILABLE",
  "CHAIN_STALE",
  "STALE_CONTRACT",
]);

/**
 * Deterministic plain-English for each rejection code. improve = what would make
 * the setup tradable, stated only in terms of the real blocking gate.
 */
export function rejectionToPlain(
  code: RejectionCode,
  side: "call" | "put" | null,
): { rejectedBecause: string; wouldImproveIf: string } {
  const s = side ?? "option";
  switch (code) {
    case "CHAIN_UNAVAILABLE":
      return {
        rejectedBecause: "The options chain is currently unavailable from the data provider.",
        wouldImproveIf: "This resolves once the provider returns a fresh options chain.",
      };
    case "CHAIN_STALE":
      return {
        rejectedBecause: "The options chain data is stale, so no contract can be confirmed.",
        wouldImproveIf: "This improves once a fresh options chain arrives within the allowed age.",
      };
    case "NO_CONTRACTS":
    case "NO_SIDE_CONTRACTS":
      return {
        rejectedBecause: `No ${s} contracts were available to evaluate.`,
        wouldImproveIf: `This improves when tradable ${s} contracts appear in the chain.`,
      };
    case "NO_MID_QUOTE":
      return {
        rejectedBecause: "The best available contract has no live bid/ask midpoint.",
        wouldImproveIf: "This improves once the contract shows a live two-sided quote.",
      };
    case "SPREAD_TOO_WIDE":
      return {
        rejectedBecause: "The best available contract's bid/ask spread is above the allowed limit.",
        wouldImproveIf: "This improves if the bid/ask spread tightens below the allowed limit.",
      };
    case "NO_LIQUID_CONTRACT":
      return {
        rejectedBecause: "No contract met the liquidity requirements (open interest / volume).",
        wouldImproveIf: "This improves if open interest and volume increase.",
      };
    case "NO_DELTA_ZONE":
      return {
        rejectedBecause: "No contract fell inside the usable delta range.",
        wouldImproveIf: "This improves if a strike closer to the money becomes tradable.",
      };
    case "DTE_OUT_OF_WINDOW":
      return {
        rejectedBecause: "No contract fell inside the required days-to-expiration window.",
        wouldImproveIf: "This improves when an expiration inside the window becomes liquid.",
      };
    case "BREAKEVEN_UNREACHABLE":
      return {
        rejectedBecause: "The contract's breakeven move is larger than the move plausibly left.",
        wouldImproveIf: "This improves if the premium falls or more move plausibly remains.",
      };
    case "STALE_CONTRACT":
      return {
        rejectedBecause: "The best contract's own quote is stale.",
        wouldImproveIf: "This improves once the contract quote refreshes within the allowed age.",
      };
    case "SESSION_NOT_ACTIONABLE":
      return {
        rejectedBecause: "The market session does not allow an actionable entry right now.",
        wouldImproveIf: "This improves during the regular options session.",
      };
    default:
      return {
        rejectedBecause: "No contract passed the selection requirements.",
        wouldImproveIf: "This improves when a contract passes the spread and liquidity requirements.",
      };
  }
}

/**
 * Map an already-computed historical sample into an evidence status + summary.
 * Only ESTABLISHED_EVIDENCE ever authorizes surfacing the numeric stats.
 */
export function evidenceFrom(ev?: ExplanationEvidence | null): {
  evidenceStatus: EvidenceStatus;
  evidenceSummary: string;
} {
  const q = ev?.dataQuality ?? null;
  if (q == null || q === "empty") {
    return { evidenceStatus: "NOT_TRACKED", evidenceSummary: "Historical results are not tracked for this setup yet." };
  }
  if (q === "limited") {
    return {
      evidenceStatus: "INSUFFICIENT_HISTORY",
      evidenceSummary: "There are not enough completed examples to evaluate this setup reliably.",
    };
  }
  if (q === "developing") {
    return {
      evidenceStatus: "EARLY_EVIDENCE",
      evidenceSummary: "Early results exist for this setup, but the sample is not yet large enough to rely on.",
    };
  }
  // strong
  return {
    evidenceStatus: "ESTABLISHED_EVIDENCE",
    evidenceSummary: "This setup has an established sample of completed results.",
  };
}

/**
 * Decide the single actionability status. Precedence puts safety first, then
 * data blocks, then the selector verdict. A put is never ACTIONABLE.
 */
export function actionabilityFrom(src: ExplanationSource): ActionabilityStatus {
  const isPut = src.side === "put" || src.direction === "bearish";

  if (src.lifecycleStatus === "INVALIDATED") return "INVALIDATED";
  if (src.freshnessBlocked) return "BLOCKED";

  const sel = src.selection;
  if (sel && sel.ok === false) {
    return DATA_BLOCK_CODES.has(sel.rejectionCode) ? "BLOCKED" : "NO_VALID_CONTRACT";
  }
  if (src.lifecycleStatus === "NO_VALID_CONTRACT") return "NO_VALID_CONTRACT";
  if (src.lifecycleStatus === "DATA_STALE") return "BLOCKED";

  // Bearish/put research-only guard — never actionable here.
  if (isPut) return "RESEARCH_ONLY";
  if (src.lifecycleStatus === "RESEARCH_ONLY") return "RESEARCH_ONLY";

  if (sel && sel.ok === true) {
    if (sel.actionable && !sel.researchOnly) return "ACTIONABLE";
    return "RESEARCH_ONLY";
  }

  if (src.lifecycleStatus === "ENTRY_CONFIRMED") return "ACTIONABLE";
  if (src.lifecycleStatus === "EXTENDED") return "WATCH";
  return "WATCH";
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers (deterministic)
// ─────────────────────────────────────────────────────────────────────────────

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtExpiry(exp?: string | null, dte?: number | null): string | null {
  if (exp) {
    const parts = String(exp).slice(0, 10).split("-").map((p) => Number(p));
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      const [y, m, d] = parts;
      return `${d} ${MONTH[Math.max(0, Math.min(11, m - 1))]} ${String(y).slice(-2)}`;
    }
  }
  if (isNum(dte)) return dte === 0 ? "today (0DTE)" : `${dte} DTE`;
  return null;
}

function fmtUsd(v?: number | null): string | null {
  return isNum(v) ? `$${v.toFixed(2)}` : null;
}

function fmtPct(v?: number | null, digits = 1): string | null {
  return isNum(v) ? `${v.toFixed(digits)}%` : null;
}

function sideWord(side?: "call" | "put" | null): "CALL" | "PUT" | null {
  if (side === "call") return "CALL";
  if (side === "put") return "PUT";
  return null;
}

function riskSummaryFrom(src: ExplanationSource): string {
  const dte = src.contract?.dte ?? null;
  const base = src.riskLabel ? `${src.riskLabel}` : null;
  if (dte === 0) {
    return "High risk: this option expires today and can lose value very quickly.";
  }
  if (isNum(dte) && dte <= 2) {
    return "High risk: this option expires soon and can lose value quickly.";
  }
  if (base) return `${base}: options can lose value quickly, especially on a reversal.`;
  return "Options carry real risk and can lose value quickly, especially on a reversal.";
}

/** Build the contract one-liner, or null when no contract is present. */
function contractSummaryFrom(src: ExplanationSource): string | null {
  const c = src.contract;
  if (!c) return null;
  const side = sideWord(c.side ?? src.side ?? null);
  const strike = isNum(c.strike) ? `$${Number.isInteger(c.strike) ? c.strike : +c.strike.toFixed(2)}` : null;
  const exp = fmtExpiry(c.expiration, c.dte);
  const head = [src.ticker, strike, side ? `${side.charAt(0)}${side.slice(1).toLowerCase()}` : null]
    .filter(Boolean)
    .join(" ");
  const parts = [head];
  if (exp) parts.push(`expires ${exp}`);
  const midTxt = fmtUsd(c.mid);
  if (midTxt) parts.push(`${src.midpointLabel ?? "Estimated midpoint"} ${midTxt}`);
  return parts.join(" — ");
}

/** whyNow fallback from raw structured facts (no fabrication). */
function whyNowFallback(src: ExplanationSource): string | null {
  if (src.whyNow) return src.whyNow;
  const bits: string[] = [];
  if (isNum(src.movePct) && Math.abs(src.movePct) >= 0.1) {
    bits.push(`${src.ticker} is moving ${src.movePct > 0 ? "+" : ""}${src.movePct.toFixed(1)}% on the day`);
  }
  if (src.vwapRelationship) bits.push(`price is ${src.vwapRelationship}`);
  if (isNum(src.relVol) && src.relVol >= 1.5) bits.push(`relative volume is ${src.relVol}x`);
  if (!bits.length) return null;
  return bits.join(", ") + ".";
}

function invalidateFallback(src: ExplanationSource): string | null {
  if (src.invalidateIf) return src.invalidateIf;
  if (src.vwapRelationship === "above VWAP") return "This is invalidated if price loses VWAP and momentum fades.";
  if (src.vwapRelationship === "below VWAP") return "This is invalidated if price reclaims VWAP and momentum fades.";
  return null;
}

function improveFallback(src: ExplanationSource): string | null {
  if (src.improveIf) return src.improveIf;
  if (src.vwapRelationship === "above VWAP") return "This improves if price stays above VWAP and volume keeps increasing.";
  if (src.vwapRelationship === "below VWAP") return "This improves if price stays below VWAP and volume keeps increasing.";
  return null;
}

const GLOSSARY_LABELS: Record<string, string> = {
  delta: "Delta",
  spread: "Bid/ask spread %",
  iv: "Implied volatility (IV)",
  relVol: "Relative volume (RVOL)",
  openInterest: "Open interest (OI)",
  vwap: "VWAP",
};

function buildMetrics(src: ExplanationSource): { metrics: SupportingMetric[]; glossary: GlossaryRef[] } {
  const c = src.contract ?? {};
  const metrics: SupportingMetric[] = [];
  const glossaryKeys: string[] = [];
  const push = (key: string, label: string, value: string | null, raw?: number | null) => {
    if (value == null) return;
    metrics.push({ key, label, value, raw: raw ?? null });
    if (key && GLOSSARY_LABELS[key] && !glossaryKeys.includes(key)) glossaryKeys.push(key);
  };
  push("delta", "Delta", isNum(c.delta) ? c.delta.toFixed(2) : null, c.delta);
  push("spread", "Spread", fmtPct(c.spreadPct), c.spreadPct);
  push("iv", "IV", isNum(c.iv) ? `${Math.round((c.iv <= 5 ? c.iv * 100 : c.iv))}%` : null, c.iv);
  push("openInterest", "Open interest", isNum(c.openInterest) ? c.openInterest.toLocaleString("en-US") : null, c.openInterest);
  push("", "Volume", isNum(c.volume) ? c.volume.toLocaleString("en-US") : null, c.volume);
  push("relVol", "Rel. volume", isNum(src.relVol) ? `${src.relVol}x` : null, src.relVol);
  push("", "Breakeven", fmtPct(c.breakevenPct, 2), c.breakevenPct);

  // Only surface established numeric evidence as a metric.
  const ev = evidenceFrom(src.evidence);
  if (ev.evidenceStatus === "ESTABLISHED_EVIDENCE") {
    if (isNum(src.evidence?.winRate)) push("winRate", "Historical win rate", `${Math.round(src.evidence!.winRate!)}%`, src.evidence!.winRate);
    if (isNum(src.evidence?.expectancy)) push("expectancy", "Historical expectancy", `${src.evidence!.expectancy! > 0 ? "+" : ""}${src.evidence!.expectancy!.toFixed(1)}%`, src.evidence!.expectancy);
  }

  const glossary: GlossaryRef[] = glossaryKeys.map((k) => ({ key: k, label: GLOSSARY_LABELS[k] }));
  return { metrics, glossary };
}

function advancedFrom(src: ExplanationSource, status: ActionabilityStatus): TradeExplanation["advanced"] {
  const c = src.contract ?? {};
  const sel = src.selection;
  let passedGates: string[] = [];
  let failedGates: string[] = [];
  let rejection: TradeExplanation["advanced"]["rejection"] = null;
  if (sel && sel.ok === false) {
    failedGates = Object.keys(sel.blockedByGate ?? {});
    rejection = { code: sel.rejectionCode, reason: sel.reason, blockedByGate: sel.blockedByGate ?? {} };
  } else if (sel && sel.ok === true) {
    // ok means every enforced gate with data passed; list the ones we can prove.
    if (isNum(c.spreadPct)) passedGates.push("spread");
    if (isNum(c.delta)) passedGates.push("delta");
    if (isNum(c.openInterest) || isNum(c.volume)) passedGates.push("liquidity");
    passedGates.push("freshness");
  }
  return {
    bid: c.bid ?? null,
    ask: c.ask ?? null,
    mid: c.mid ?? null,
    spreadPct: c.spreadPct ?? null,
    delta: c.delta ?? null,
    iv: c.iv ?? null,
    volume: c.volume ?? null,
    openInterest: c.openInterest ?? null,
    dte: c.dte ?? null,
    breakevenPct: c.breakevenPct ?? null,
    relVol: src.relVol ?? null,
    vwapRelationship: src.vwapRelationship ?? null,
    freshness: src.freshnessLabel ?? null,
    score: src.score ?? (sel && sel.ok ? sel.score : null),
    passedGates,
    failedGates,
    rejection,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The builder
// ─────────────────────────────────────────────────────────────────────────────

export function buildTradeExplanation(src: ExplanationSource): TradeExplanation {
  const ticker = String(src.ticker || "").toUpperCase();
  const direction: TradeExplanation["direction"] = src.direction ?? (src.side === "put" ? "bearish" : src.side === "call" ? "bullish" : "neutral");
  const side = src.side ?? (src.selection && src.selection.ok ? (String(src.selection.contract.side) as "call" | "put") : null);

  const status = actionabilityFrom({ ...src, side, direction });
  const statusLabel = actionabilityLabel(status);

  const sideTxt = sideWord(side);
  const plainSummary = `${ticker}${sideTxt ? ` ${sideTxt}` : ""} — ${statusLabel.toUpperCase()}`;

  const contractSummary = contractSummaryFrom({ ...src, side });

  // selectedBecause / rejectedBecause / wouldImproveIf
  let selectedBecause: string | null = null;
  let rejectedBecause: string | null = null;
  let wouldImproveIf: string | null = improveFallback(src);
  const notes: string[] = [];

  const sel = src.selection;
  if (sel && sel.ok === true) {
    const gateWord = side === "put" ? "put" : side === "call" ? "call" : "contract";
    selectedBecause = `This ${gateWord} was selected because its spread and liquidity met the contract requirements.`;
    for (const n of sel.notes ?? []) notes.push(n);
  } else if (sel && sel.ok === false) {
    const plain = rejectionToPlain(sel.rejectionCode, side);
    rejectedBecause = plain.rejectedBecause;
    wouldImproveIf = plain.wouldImproveIf;
  }
  for (const n of src.extraNotes ?? []) notes.push(n);
  if (src.freshnessBlocked && src.freshnessReason) notes.push(src.freshnessReason);
  if (side === "put") notes.push("Bearish/put ideas are research-only; bearish actionability stays governed by the bearish gate.");

  const { metrics, glossary } = buildMetrics({ ...src, side });
  const ev = evidenceFrom(src.evidence);
  const advanced = advancedFrom({ ...src, side }, status);

  return {
    schemaVersion: 1,
    ticker,
    direction,
    side,
    actionabilityStatus: status,
    statusLabel,
    plainSummary,
    whyNow: whyNowFallback(src),
    contractSummary,
    riskSummary: riskSummaryFrom({ ...src, side }),
    selectedBecause,
    rejectedBecause,
    wouldImproveIf,
    invalidatedIf: invalidateFallback(src),
    supportingMetrics: metrics,
    glossaryTerms: glossary,
    evidenceStatus: ev.evidenceStatus,
    evidenceSummary: ev.evidenceSummary,
    advanced,
    notes,
  };
}

/** Compact one-line advanced metrics string (Discord "Advanced:" line). */
export function advancedMetricsLine(exp: TradeExplanation): string | null {
  const a = exp.advanced;
  const parts: string[] = [];
  if (isNum(a.delta)) parts.push(`Delta ${a.delta.toFixed(2)}`);
  if (isNum(a.spreadPct)) parts.push(`Spread ${a.spreadPct.toFixed(1)}%`);
  if (isNum(a.iv)) parts.push(`IV ${Math.round(a.iv <= 5 ? a.iv * 100 : a.iv)}%`);
  if (isNum(a.volume)) parts.push(`Volume ${a.volume.toLocaleString("en-US")}`);
  if (isNum(a.openInterest)) parts.push(`OI ${a.openInterest.toLocaleString("en-US")}`);
  return parts.length ? parts.join(" | ") : null;
}
