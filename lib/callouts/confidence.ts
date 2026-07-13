/**
 * callouts/confidence.ts — PURE. The deterministic COMPACT-TRADE-CARD layer.
 *
 * The desk asked for a compact card as the DEFAULT view (Discord + frontend):
 * exact contract, exact strike/expiration/DTE, the underlying price and the live
 * option bid/ask/mid at alert time, a realistic estimated entry, and a plain
 * entry status. All the technical detail stays available — it just moves behind
 * Advanced. This module derives ONLY from fields already verified upstream on the
 * Callout; it never fetches, never fabricates a price, and never invents a
 * probability.
 *
 * Confidence is a DETERMINISTIC setup-quality tier (HIGH / MEDIUM / LOW), NOT a
 * statistical win probability. HIGH is reserved for a setup where every verified
 * gate passes AND the forward-looking entry window (when present) confirms an
 * entry right now — that is the only tier that sends a normal Discord alert.
 */
import type { Callout } from "./callout.ts";

export type ConfidenceTier = "HIGH" | "MEDIUM" | "LOW";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** Entry-window states that mean the move already ran / reversed — never HIGH. */
const LATE_ENTRY_STATES = new Set(["EXTENDED", "MISSED", "INVALIDATED", "WAIT_FOR_PULLBACK", "BLOCKED"]);
/** Entry-window states that mean a setup is forming but not confirmed for entry. */
const EARLY_ENTRY_STATES = new Set(["EARLY", "NEAR_TRIGGER", "DEVELOPING"]);
/** Candidate statuses that are inherently research-only / blocked → LOW. */
const LOW_STATUSES = new Set([
  "NO_VALID_CONTRACT", "DATA_STALE", "INVALIDATED", "MISSED", "EXTENDED",
  "RESEARCH_ONLY", "MODEL_INACTIVE", "MODEL_EXPERIMENTAL", "INSUFFICIENT_EVIDENCE",
]);

/** A usable two-sided option quote: both sides present, positive, not crossed. */
export function hasValidQuote(k: Callout["contract"]): boolean {
  return !!k && isNum(k.bid) && isNum(k.ask) && (k.bid as number) > 0 && (k.ask as number) > 0 && (k.ask as number) >= (k.bid as number);
}

/**
 * DETERMINISTIC confidence tier. HIGH demands every verified gate: an aligned,
 * actionable setup, a fresh & valid two-sided quote, an acceptable spread, risk
 * gates passed, and — when a forward-looking entry window exists — that it confirm
 * an entry NOW (never a late/early/reversing state). Anything research-only,
 * blocked, stale, contract-less, or already-late is LOW; a real forming setup that
 * is not yet confirmed for entry is MEDIUM.
 */
export function confidenceTier(c: Callout, env: NodeJS.ProcessEnv = process.env): ConfidenceTier {
  const k = c.contract;
  const es = c.entryState ?? null;
  const validQuote = hasValidQuote(k);
  const fresh = c.quoteFreshness === "fresh";
  const riskOk = !c.riskVerdict || c.riskVerdict.allowed !== false;
  const spreadOk = !!k && isNum(k.spreadPct) ? (k!.spreadPct as number) <= num(env.ENTRY_MAX_SPREAD_PCT, 8) : false;
  const late = es != null && LATE_ENTRY_STATES.has(es);
  const early = es != null && EARLY_ENTRY_STATES.has(es);
  // The entry window, when present, must confirm NOW (state ACTIONABLE). Absent an
  // entry window (no live tape), we fall back to the gates the callout already
  // passed to be ACTIONABLE_NOW — we do not hold missing tape against it.
  const windowConfirms = es === "ACTIONABLE" || es === null;

  if (c.actionable && c.status === "ACTIONABLE_NOW" && validQuote && fresh && spreadOk && riskOk && !late && !early && windowConfirms) {
    return "HIGH";
  }
  if (Boolean(c.researchOnlyWarning) || !validQuote || !fresh || late || LOW_STATUSES.has(c.status)) {
    return "LOW";
  }
  return "MEDIUM";
}

/** "HIGH CONFIDENCE" etc. — a plainly-labeled setup tier, never a probability. */
export function tierLabel(tier: ConfidenceTier): string {
  return `${tier} CONFIDENCE`;
}

/**
 * Realistic estimated entry, matching the paper engine's conservative fill model
 * (long entry ≈ ask + bounded slippage, capped). Returns a price ONLY when the
 * entry is actually available now (actionable + fresh, valid two-sided quote);
 * otherwise there is no tradable entry and we never show an old price as live.
 */
export function estimatedEntryPrice(c: Callout, env: NodeJS.ProcessEnv = process.env): number | null {
  const k = c.contract;
  if (!hasValidQuote(k) || c.quoteFreshness !== "fresh") return null;
  const frac = num(env.PAPER_ENTRY_SLIPPAGE_FRAC, 0.25);
  const cap = num(env.PAPER_MAX_SLIPPAGE_ABS, 0.05);
  const spreadAbs = (k!.ask as number) - (k!.bid as number);
  const slip = Math.max(0, Math.min(spreadAbs * frac, cap));
  return +((k!.ask as number) + slip).toFixed(2);
}

/**
 * Compact entry status the trader reads first:
 *   ACTIONABLE NOW · WAIT FOR PULLBACK · WAIT · NO VALID ENTRY · MISSED
 */
export function entryStatusLabel(c: Callout): string {
  const es = c.entryState ?? null;
  if (c.status === "MISSED" || es === "MISSED") return "MISSED";
  if (c.status === "NO_VALID_CONTRACT" || c.status === "DATA_STALE" || c.status === "INVALIDATED"
      || es === "INVALIDATED" || es === "BLOCKED" || !hasValidQuote(c.contract)) return "NO VALID ENTRY";
  if (c.status === "WAIT_FOR_PULLBACK" || es === "WAIT_FOR_PULLBACK" || es === "EXTENDED") return "WAIT FOR PULLBACK";
  if (c.actionable && c.status === "ACTIONABLE_NOW") return "ACTIONABLE NOW";
  return "WAIT";
}

/** "2026-07-17" → "Jul 17"; falls back to the raw value. */
export function shortExpiry(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Alert timestamp as US/Eastern clock time, e.g. "10:42 AM ET". */
export function easternClock(ts: number): string {
  const t = new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  return `${t} ET`;
}

const money = (v: number | null | undefined) => (isNum(v) ? `$${(v as number).toFixed(2)}` : "—");

export interface CompactCard {
  tier: ConfidenceTier;
  tierLabel: string;
  /** "NVDA CALL · HIGH CONFIDENCE" */
  headline: string;
  /** "NVDA $185 Call" */
  contract: string;
  /** "Jul 17" */
  expiration: string;
  /** "4" */
  dte: string;
  /** "$182.40" */
  stock: string;
  /** "$2.10 bid / $2.18 ask" */
  optionQuote: string;
  /** "$2.14" (mid) */
  optionMid: string;
  /** "$2.14" | "NO VALID ENTRY YET" */
  estimatedEntry: string;
  /** "ACTIONABLE NOW" */
  status: string;
  /** "1–5 DTE" */
  horizon: string;
  /** "10:42 AM ET" */
  time: string;
  /** "SETUP SCORE — NOT A WIN PROBABILITY: 78" (only when useful), else null. */
  setupScoreLine: string | null;
}

/** Build the DEFAULT compact trade card (shared by Discord + frontend). PURE. */
export function compactCard(c: Callout, env: NodeJS.ProcessEnv = process.env): CompactCard {
  const tier = confidenceTier(c, env);
  const side = (c.contract?.side ?? (c.direction === "bearish" ? "put" : "call"));
  const sideWord = side.toUpperCase();
  const sideTitle = side.charAt(0).toUpperCase() + side.slice(1); // "Call" / "Put"
  const strike = isNum(c.contract?.strike) ? `$${c.contract!.strike}` : "";
  const contractLine = `${c.ticker} ${strike} ${sideTitle}`.replace(/\s+/g, " ").trim();

  const k = c.contract;
  const optionQuote = k && (isNum(k.bid) || isNum(k.ask))
    ? `${money(k.bid)} bid / ${money(k.ask)} ask`
    : "—";
  const est = estimatedEntryPrice(c, env);
  const statusLabel = entryStatusLabel(c);
  const estimatedEntry = est != null && statusLabel === "ACTIONABLE NOW" ? money(est) : "NO VALID ENTRY YET";

  // The numeric setup score is shown ONLY when there is no validated probability
  // (model inactive/experimental) — and always plainly labeled as NOT a probability.
  const setupScoreLine = (c.probability == null && isNum(c.contractScore))
    ? `SETUP SCORE — NOT A WIN PROBABILITY: ${c.contractScore}`
    : null;

  return {
    tier,
    tierLabel: tierLabel(tier),
    headline: `${c.ticker} ${sideWord} · ${tierLabel(tier)}`,
    contract: contractLine,
    expiration: shortExpiry(c.contract?.expiration),
    dte: isNum(c.contract?.dte) ? String(c.contract!.dte) : "—",
    stock: money(c.underlyingPrice),
    optionQuote,
    optionMid: money(k?.mid),
    estimatedEntry,
    status: statusLabel,
    horizon: c.horizon,
    time: easternClock(c.timestamp),
    setupScoreLine,
  };
}

/** Whether Discord should append the Advanced block (default OFF). */
export function discordAdvancedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DISCORD_ADVANCED_DETAILS === "1";
}
