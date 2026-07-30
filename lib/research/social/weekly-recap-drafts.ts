/**
 * weekly-recap-drafts.ts — deterministic draft rendering for the weekly recap.
 *
 * Every figure printed here is read straight from the deterministic report. This
 * module performs NO arithmetic beyond sign formatting, so a draft can never drift
 * from the audited numbers, and drafts are byte-identical for identical input.
 *
 * Nothing here posts, sends, or schedules anything. Output is text for an owner to
 * read, edit, and publish by hand.
 */
import {
  LABEL_COMBINED_PEAK,
  LABEL_COMBINED_TRACKED,
  screenRecapWording,
  type LaneTotals,
  type RecapCallout,
  type WeeklySocialRecap,
} from "./weekly-recap.ts";

export type DraftStyle = "A_CLEAN_RECAP" | "B_TWITTER_THREAD" | "C_CONCISE_FLEX" | "D_REPORT_CARD";
export const DRAFT_STYLES: DraftStyle[] = ["A_CLEAN_RECAP", "B_TWITTER_THREAD", "C_CONCISE_FLEX", "D_REPORT_CARD"];
export const DRAFT_STYLE_LABELS: Record<DraftStyle, string> = {
  A_CLEAN_RECAP: "Style A — Clean weekly recap",
  B_TWITTER_THREAD: "Style B — Twitter thread",
  C_CONCISE_FLEX: "Style C — Concise flex post",
  D_REPORT_CARD: "Style D — Transparent report card",
};

export interface RecapDraft {
  style: DraftStyle;
  label: string;
  /** Full copyable text. For threads, tweets joined by a separator. */
  text: string;
  /** Individual tweets when the style is a thread; otherwise a single block. */
  parts: string[];
  wordingOk: boolean;
  wordingViolations: Array<{ phrase: string; why: string }>;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Signed percentage exactly as stored — no rounding beyond the report's own. */
export function pct(n: number | null | undefined): string {
  if (!isNum(n)) return "unavailable";
  const rounded = Math.round(n * 100) / 100;
  const body = Number.isInteger(rounded) ? String(Math.abs(rounded)) : String(Math.abs(rounded));
  const withSep = Math.abs(rounded) >= 1000
    ? Math.abs(rounded).toLocaleString("en-US", { maximumFractionDigits: 2 })
    : body;
  return `${rounded < 0 ? "-" : "+"}${withSep}%`;
}

function money(n: number | null | undefined): string {
  return isNum(n) ? `$${Number(n.toFixed(2))}` : "unavailable";
}

function topCallouts(callouts: RecapCallout[], limit: number): RecapCallout[] {
  return callouts.slice(0, limit);
}

function calloutLine(c: RecapCallout): string {
  const tracked = c.status === "OPEN" ? "OPEN (no tracked exit yet)" : `tracked ${pct(c.trackedPct)}`;
  return `${c.contractLabel} · peak ${pct(c.peakPct)} · ${tracked}`;
}

/** Section title and framing for the Watchlist link-through. */
export const WATCHLIST_SECTION_TITLE = "WATCHLIST → VERIFIED CALLOUTS";
export const WATCHLIST_SECTION_DESCRIPTION =
  "Watchlist symbols that later produced a verified subscriber callout during the selected period.";
export const WATCHLIST_TRACKING_CAVEAT =
  "Watchlist outcome tracking is not yet available, so no result is assigned to the Watchlist plan itself. "
  + "The figures below belong to the verified subscriber callout that followed, and are not included in subscriber totals.";

/**
 * Attribute the numbers to the SUBSEQUENT verified callout, never to the plan.
 *
 * Phrasing matters here: "NVDA · peak +187%" would read as the Watchlist plan
 * returning 187%. The plan has no measured return, and nothing implies its original
 * trigger was entered.
 */
function watchlistLine(c: RecapCallout): string {
  const tracked = c.status === "OPEN" ? "still open" : `tracked ${pct(c.trackedPct)}`;
  return `${c.symbol} — later produced verified callout ${c.contractLabel} (peak ${pct(c.peakPct)}, ${tracked})`;
}

function headlineBlock(t: LaneTotals): string[] {
  const lines = [`${t.eligibleCallouts} verified setup${t.eligibleCallouts === 1 ? "" : "s"}`];
  if (t.closedCallouts > 0) {
    lines.push(`${t.winners} winner${t.winners === 1 ? "" : "s"}`);
    if (isNum(t.winRatePct)) lines.push(`${pct(t.winRatePct).replace("+", "")} win rate`);
  }
  if (t.openCallouts > 0) lines.push(`${t.openCallouts} still open`);
  return lines;
}

function warningsBlock(recap: WeeklySocialRecap): string[] {
  return recap.warnings.length ? ["", ...recap.warnings] : [];
}

function styleA(recap: WeeklySocialRecap): string[] {
  const t = recap.verifiedSubscriber;
  const lines = [
    "This week's OptiScan callouts:",
    "",
    ...headlineBlock(t),
    "",
    `${LABEL_COMBINED_PEAK}: ${pct(t.combinedPeakMovePct)}`,
    `${LABEL_COMBINED_TRACKED}: ${pct(t.combinedTrackedResultPct)}`,
  ];
  const top = topCallouts(recap.callouts.verifiedSubscriber, 3);
  if (top.length) {
    lines.push("", "Top callouts:", ...top.map(calloutLine));
  }
  lines.push(...warningsBlock(recap));
  lines.push(
    "",
    `${LABEL_COMBINED_PEAK} are the sum of individual callout peaks, not portfolio return.`,
    "Past performance does not guarantee future results.",
    "Educational purposes only. Options involve substantial risk.",
  );
  return [lines.join("\n")];
}

function styleB(recap: WeeklySocialRecap): string[] {
  const t = recap.verifiedSubscriber;
  const first = [
    `OptiScan produced ${t.eligibleCallouts} verified options setup${t.eligibleCallouts === 1 ? "" : "s"} this week.`,
    "",
    `${LABEL_COMBINED_PEAK}: ${pct(t.combinedPeakMovePct)}`,
    `${LABEL_COMBINED_TRACKED}: ${pct(t.combinedTrackedResultPct)}`,
  ];
  if (t.closedCallouts > 0) {
    first.push(`${t.winners} of ${t.closedCallouts} closed green.`);
  }
  if (t.openCallouts > 0) first.push(`${t.openCallouts} still open and excluded from tracked results.`);
  first.push("", "The biggest verified callouts:");

  const perCallout = topCallouts(recap.callouts.verifiedSubscriber, 5).map((c, i) => {
    const lines = [
      `${i + 1}/ ${c.symbol} ${c.expirationLabel} $${Number(c.strike.toFixed(3))} ${c.side}`,
      `Posted entry: ${money(c.frozenEntry)}`,
      `Verified peak: ${pct(c.peakPct)}`,
      c.status === "OPEN"
        ? "Tracked exit: still open"
        : `Tracked exit result: ${pct(c.trackedPct)}`,
    ];
    if (c.setupReason) lines.push(c.setupReason);
    return lines.join("\n");
  });

  const last = [
    `${LABEL_COMBINED_PEAK} is the sum of each callout's individual peak. It is not a portfolio return and not a realized result.`,
    "",
    "Every figure uses the frozen entry posted at the callout and verified option bid marks. OptiScan can verify what a callout did; it cannot prove any person entered, exited, or captured it.",
    "",
    "Educational purposes only. Options involve substantial risk. Past performance does not guarantee future results.",
  ].join("\n");

  return [first.join("\n"), ...perCallout, last];
}

function styleC(recap: WeeklySocialRecap): string[] {
  const t = recap.verifiedSubscriber;
  const lines = [
    `${pct(t.combinedPeakMovePct)} in combined verified peak moves across this week's OptiScan callouts.`,
    "",
  ];
  const top = topCallouts(recap.callouts.verifiedSubscriber, 5);
  lines.push(...top.map((c) => `${c.contractLabel} · peak ${pct(c.peakPct)}`));
  lines.push(
    "",
    `${LABEL_COMBINED_PEAK} are the sum of individual callout peaks, not portfolio return. Educational purposes only.`,
  );
  return [lines.join("\n")];
}

function styleD(recap: WeeklySocialRecap): string[] {
  const t = recap.verifiedSubscriber;
  const lines = [
    `OptiScan weekly report card — ${recap.window.label}`,
    "",
    "VERIFIED SUBSCRIBER CALLOUTS",
    `Total callouts: ${t.eligibleCallouts}`,
    `Winners: ${t.winners}`,
    `Losers: ${t.losers}`,
    `Open: ${t.openCallouts}`,
    `Win rate: ${isNum(t.winRatePct) ? `${Math.round(t.winRatePct * 100) / 100}%` : "unavailable"}`,
    `Average callout (tracked): ${pct(t.averageTrackedPct)}`,
    `${LABEL_COMBINED_TRACKED}: ${pct(t.combinedTrackedResultPct)}`,
    `${LABEL_COMBINED_PEAK}: ${pct(t.combinedPeakMovePct)}`,
    `Largest winner (tracked): ${t.bestTracked ? `${t.bestTracked.contractLabel} ${pct(t.bestTracked.pct)}` : "none"}`,
    `Largest loss (tracked): ${t.largestLoss ? `${t.largestLoss.contractLabel} ${pct(t.largestLoss.pct)}` : "none"}`,
    `Highest verified peak: ${t.bestPeak ? `${t.bestPeak.contractLabel} ${pct(t.bestPeak.pct)}` : "none"}`,
    `Profit given back (moved up, closed at a loss): ${t.profitGivenBackCount}`,
  ];

  if (recap.callouts.verifiedSubscriber.length) {
    lines.push("", "Every verified callout:");
    for (const c of recap.callouts.verifiedSubscriber) lines.push(`  ${calloutLine(c)}`);
  }

  if (recap.researchOnly.eligibleCallouts > 0) {
    lines.push(
      "",
      "RESEARCH-ONLY CALLOUTS (never sent to subscribers, never counted above)",
      `Callouts: ${recap.researchOnly.eligibleCallouts} · ${LABEL_COMBINED_PEAK}: ${pct(recap.researchOnly.combinedPeakMovePct)} · ${LABEL_COMBINED_TRACKED}: ${pct(recap.researchOnly.combinedTrackedResultPct)}`,
      ...recap.callouts.researchOnly.map((c) => `  ${calloutLine(c)}`),
    );
  }

  if (recap.watchlist.eligibleCallouts > 0) {
    // Deliberately NOT called a "win": no Watchlist outcome tracking exists, so the
    // plan itself has no measured result. Every figure below belongs to the verified
    // subscriber callout that followed, and none of it enters subscriber totals.
    lines.push(
      "",
      WATCHLIST_SECTION_TITLE,
      WATCHLIST_SECTION_DESCRIPTION,
      WATCHLIST_TRACKING_CAVEAT,
      ...recap.callouts.watchlist.map((c) => `  ${watchlistLine(c)}`),
    );
  }

  lines.push("", `Excluded rows: ${recap.exclusions.length}`);
  for (const ex of recap.exclusions) {
    lines.push(`  ${ex.symbol || ex.alertId}: ${ex.reason}`);
  }

  lines.push(...warningsBlock(recap));
  lines.push("", ...recap.disclaimers);
  return [lines.join("\n")];
}

const RENDERERS: Record<DraftStyle, (r: WeeklySocialRecap) => string[]> = {
  A_CLEAN_RECAP: styleA,
  B_TWITTER_THREAD: styleB,
  C_CONCISE_FLEX: styleC,
  D_REPORT_CARD: styleD,
};

export function renderDraft(recap: WeeklySocialRecap, style: DraftStyle): RecapDraft {
  const parts = RENDERERS[style](recap);
  const text = parts.join("\n\n---\n\n");
  const screen = screenRecapWording(text);
  return {
    style,
    label: DRAFT_STYLE_LABELS[style],
    text,
    parts,
    wordingOk: screen.ok,
    wordingViolations: screen.violations,
  };
}

export function renderAllDrafts(recap: WeeklySocialRecap): RecapDraft[] {
  return DRAFT_STYLES.map((s) => renderDraft(recap, s));
}

// ------------------------------------------------------------ numeric validation

export type DraftFailureKind =
  | "UNSUPPORTED_NUMBER"
  | "UNKNOWN_SYMBOL"
  | "FORBIDDEN_WORDING"
  | "MISSING_REQUIRED_DISCLOSURE"
  | "MISLABELLED_PEAK";

export interface DraftValidation {
  ok: boolean;
  failures: Array<{ kind: DraftFailureKind; detail: string; token?: string }>;
  numbersChecked: string[];
}

/** Numbers that are structure or identity, not performance claims. */
function extractDraftNumbers(text: string): string[] {
  const prose = String(text ?? "")
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g, " ")
    // Contract dates ("07/31") and thread markers ("1/", "2/") are identifiers.
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ")
    .replace(/(^|\n)\s*\d{1,2}\/\s/g, "$1")
    .replace(/(^|\n)[ \t]*[-*]?[ \t]*\d{1,2}[.)][ \t]+/g, "$1")
    .replace(/\((\d{1,2})\)/g, " ");
  const out: string[] = [];
  for (const m of prose.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const cleaned = m.replace(/^-/, "");
    if (!cleaned) continue;
    if (/^(19|20)\d{2}$/.test(cleaned.replace(/,/g, ""))) continue;
    out.push(cleaned);
  }
  return out;
}

/**
 * Validate any wording — deterministic or AI-rewritten — against the report.
 *
 * This is the gate that makes an AI rewrite safe: the model may reorganise prose,
 * but a number or ticker it did not get from the report cannot survive.
 */
export function validateDraftAgainstRecap(text: string, recap: WeeklySocialRecap): DraftValidation {
  const failures: DraftValidation["failures"] = [];
  const allowed = new Set(recap.allowedNumbers.map((n) => n.replace(/,/g, "")));
  const numbers = extractDraftNumbers(text);
  for (const token of numbers) {
    if (!allowed.has(token.replace(/,/g, ""))) {
      failures.push({ kind: "UNSUPPORTED_NUMBER", detail: `${token} is not a figure in the deterministic weekly report.`, token });
    }
  }

  const allowedSymbols = new Set(recap.allowedSymbols);
  // The risk being guarded is an INVENTED CALLOUT, so only contract-shaped references
  // count as ticker claims: "$AAPL", or a symbol followed by a contract date/strike.
  // Matching every uppercase run instead flagged ordinary copy like "VWAP" and "ET".
  const candidates = new Set<string>();
  for (const m of String(text ?? "").matchAll(/\$([A-Z]{1,6})\b/g)) candidates.add(m[1] as string);
  for (const m of String(text ?? "").matchAll(/\b([A-Z]{1,6})\s+\d{1,2}\/\d{1,2}\b/g)) candidates.add(m[1] as string);
  for (const m of String(text ?? "").matchAll(/\b([A-Z]{1,6})\s+(?:\d{1,2}\/\d{1,2}\s+)?\$\d/g)) candidates.add(m[1] as string);
  for (const sym of candidates) {
    if (allowedSymbols.has(sym)) continue;
    failures.push({ kind: "UNKNOWN_SYMBOL", detail: `${sym} is not a symbol in this week's eligible callouts.`, token: sym });
  }

  const screen = screenRecapWording(text);
  for (const v of screen.violations) {
    failures.push({ kind: "FORBIDDEN_WORDING", detail: `"${v.phrase}" ${v.why}.`, token: v.phrase });
  }

  // A peak figure must never be presented as a portfolio or realized result.
  if (/combined peak/i.test(text) && !/not (?:a )?portfolio return/i.test(text)) {
    failures.push({
      kind: "MISSING_REQUIRED_DISCLOSURE",
      detail: "Any mention of combined peak moves must state that it is not portfolio return.",
    });
  }
  if (/\b(?:combined|total)\s+(?:peak|peaks)[^.]{0,40}\b(?:portfolio|account)\b/i.test(text)) {
    failures.push({ kind: "MISLABELLED_PEAK", detail: "Peak sums were described as a portfolio or account figure." });
  }
  if (!/Educational purposes only/i.test(text)) {
    failures.push({ kind: "MISSING_REQUIRED_DISCLOSURE", detail: "Missing the educational-purposes disclosure." });
  }

  return { ok: failures.length === 0, failures, numbersChecked: numbers };
}
