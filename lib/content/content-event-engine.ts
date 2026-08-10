/**
 * lib/content/content-event-engine.ts — DETERMINISTIC content-draft generator. NO language model, EVER.
 *
 * Turns an already-persisted `opportunity_content_events` row (emitted by the Opportunity Case
 * lifecycle) into private Twitter/X DRAFT ideas using templates + business rules. It never posts
 * anywhere and never fabricates numbers: a template line whose placeholder value is missing is
 * DROPPED, so we never emit a literal `{{strike}}` or a made-up figure. All copy is past-tense /
 * frozen-entry only (no "buy now" language) — validated by the existing social-draft language guard.
 *
 * Extensibility: categories and their templates live in TEMPLATES below (pure data). Add a category
 * by adding a rule in `eligibleCategories` + a TEMPLATES entry — no engine changes needed.
 */
import { validateSocialDraftLanguage } from "../social-drafts.ts";
import { isPerformanceCategory, isSafeCategory, mfeDisclaimer } from "./claim-integrity.ts";

export type ContentCategory =
  | "JUST_ENTERED_RADAR"
  | "HIGH_CONVICTION"
  | "CONVICTION_INCREASED"
  | "THESIS_WEAKENED"
  | "NEW_HIGH"
  | "RETURN_MILESTONE"
  | "CLOSED_WINNER"
  | "CLOSED_LOSER"
  | "WHY_THIS_WORKED"
  | "WHY_THIS_FAILED"
  | "NEXT_SESSION_WATCH"
  | "EDUCATIONAL_BREAKDOWN"
  | "MARKET_OBSERVATION";

export type CtaType =
  | "NONE"
  | "EDUCATIONAL"
  | "PROOF_RECAP"
  | "SOFT_FOLLOW"
  | "STRONG_PROMO";

export const TEMPLATE_VERSION = "v1";

/** Raw values available to templates. `undefined`/`null` ⇒ any line referencing it is dropped. */
export interface ContentVars {
  symbol?: string | null;
  optionType?: string | null;      // CALL | PUT
  strike?: number | null;
  expiration?: string | null;
  premium?: number | null;         // frozen entry premium
  confidence?: number | null;      // 0..1 or 0..100 (rendered as %)
  relativeVolume?: number | null;  // e.g. 4.2 (×)
  callFlow?: number | null;
  putFlow?: number | null;
  sector?: string | null;
  catalyst?: string | null;
  vwap?: number | null;
  support?: number | null;
  resistance?: number | null;
  underlyingPrice?: number | null;
  returnPct?: number | null;
  milestonePercent?: number | null;
  maxReturnPct?: number | null;
  elapsed?: string | null;
  reason?: string | null;
  /**
   * The evidence-grounded loss explanation from `deriveFailureCause`. Failure
   * templates render THIS, never `reason`: `reason` carries the ENTRY thesis,
   * and printing it after "why this failed" produced the inverted claims found
   * in production (see lib/content/failure-cause.ts).
   */
  failureCause?: string | null;
  /** The entry thesis, rendered only where it is explicitly labelled as such. */
  entryThesis?: string | null;
}

export interface DraftMeta {
  text: string;
  charCount: number;
  hashtags: string[];
  suggestedScreenshot: string;
  suggestedChartAnnotation: string;
  suggestedCta: string;
  ctaType: CtaType;
  templateFamily: string;
  templateVersion: string;
}

export interface ContentDraftBundle {
  category: ContentCategory;
  symbol: string;
  drafts: DraftMeta[];
  generatedByLlm: false;   // structural guarantee — this engine is template-only
}

export interface EligibilityThresholds {
  minConfidence: number;      // fraction 0..1
  minRelativeVolume: number;  // ×
  minCallFlow: number;        // notional / contracts (source-defined)
}

export function eligibilityThresholds(env: NodeJS.ProcessEnv = process.env): EligibilityThresholds {
  const n = (k: string, d: number) => { const x = Number(env[k]); return Number.isFinite(x) ? x : d; };
  return {
    minConfidence: n("CONTENT_MIN_CONFIDENCE", 0.6),
    minRelativeVolume: n("CONTENT_MIN_REL_VOLUME", 2.0),
    minCallFlow: n("CONTENT_MIN_CALL_FLOW", 0),
  };
}

// ── deterministic value formatting ───────────────────────────────────────────
function asFrac(x: number | null | undefined): number | null {
  if (x == null || !Number.isFinite(x)) return null;
  return x > 1 ? x / 100 : x; // accept 0..1 or 0..100
}
function fmtPct(x: number | null | undefined): string | null {
  const f = asFrac(x);
  return f == null ? null : `${Math.round(f * 100)}%`;
}
function fmtSignedPct(x: number | null | undefined): string | null {
  if (x == null || !Number.isFinite(x)) return null;
  return `${x > 0 ? "+" : ""}${Number.isInteger(x) ? x : x.toFixed(1)}%`;
}
function fmtX(x: number | null | undefined): string | null {
  if (x == null || !Number.isFinite(x)) return null;
  return `${x.toFixed(1)}x`;
}
function fmtMoney(x: number | null | undefined): string | null {
  if (x == null || !Number.isFinite(x)) return null;
  return `$${x.toFixed(2)}`;
}
function fmtNum(x: number | null | undefined): string | null {
  if (x == null || !Number.isFinite(x)) return null;
  return Number.isInteger(x) ? String(x) : x.toFixed(2);
}

/** Resolve a placeholder token to a formatted string, or null when the underlying value is absent. */
function resolve(token: string, v: ContentVars): string | null {
  switch (token) {
    case "symbol": return v.symbol ? `$${String(v.symbol).toUpperCase()}` : null;
    case "optionType": return v.optionType ? String(v.optionType).toUpperCase() : null;
    case "strike": return v.strike != null ? `$${fmtNum(v.strike)}` : null;
    case "expiration": return v.expiration ? String(v.expiration) : null;
    case "premium": return fmtMoney(v.premium);
    case "confidence": return fmtPct(v.confidence);
    case "relativeVolume": return fmtX(v.relativeVolume);
    case "callFlow": return fmtNum(v.callFlow);
    case "putFlow": return fmtNum(v.putFlow);
    case "sector": return v.sector ? String(v.sector) : null;
    case "catalyst": return v.catalyst ? String(v.catalyst) : null;
    case "vwap": return fmtMoney(v.vwap);
    case "support": return fmtMoney(v.support);
    case "resistance": return fmtMoney(v.resistance);
    case "underlyingPrice": return fmtMoney(v.underlyingPrice);
    case "returnPct": return fmtSignedPct(v.returnPct);
    case "milestonePercent": return fmtSignedPct(v.milestonePercent);
    case "maxReturnPct": return fmtSignedPct(v.maxReturnPct);
    case "elapsed": return v.elapsed ? String(v.elapsed) : null;
    case "reason": return v.reason ? String(v.reason) : null;
    case "failureCause": return v.failureCause ? String(v.failureCause) : null;
    case "entryThesis": return v.entryThesis ? String(v.entryThesis) : null;
    // "contract" = a composite convenience token used in several templates.
    case "contract": {
      const parts = [resolve("expiration", v), resolve("strike", v), resolve("optionType", v)].filter(Boolean);
      return parts.length >= 2 ? parts.join(" ") : null;
    }
    default: return null;
  }
}

/** Render one line; returns null (drops the line) if any referenced placeholder is missing. */
export function renderLine(line: string, v: ContentVars): string | null {
  const tokens = [...line.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  if (tokens.length === 0) return line;
  let out = line;
  for (const t of tokens) {
    const val = resolve(t, v);
    if (val == null) return null; // required placeholder missing → drop the whole line
    out = out.replace(new RegExp(`\\{\\{${t}\\}\\}`, "g"), val);
  }
  return out;
}

/** Render a multi-line template, dropping unresolved lines. Returns null if the required header drops. */
export function renderTemplate(lines: string[], v: ContentVars): string | null {
  const rendered = lines.map((l) => (l === "" ? "" : renderLine(l, v)));
  if (rendered[0] == null) return null; // header line requires its placeholders (always the symbol)
  const kept = rendered.filter((l) => l != null) as string[];
  // collapse consecutive blanks
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length ? text : null;
}

// ── template registry (pure data; each category has 3–5 drafts) ───────────────
interface CategoryTemplates {
  templates: string[][];
  screenshot: string;
  chartAnnotation: string;
  /** Per-template CTA types — deliberate mix; not every draft gets subscribe/follow. */
  ctaTypes: CtaType[];
}

const CTA_COPY: Record<CtaType, string> = {
  NONE: "",
  EDUCATIONAL: "Education only — not financial advice.",
  PROOF_RECAP: "Receipts from the private Discord board. Past results do not guarantee future performance.",
  SOFT_FOLLOW: "Follow for more setups like this. Not financial advice.",
  STRONG_PROMO: "Full breakdowns drop first in the private Discord. Education only — not financial advice.",
};

const TEMPLATES: Record<ContentCategory, CategoryTemplates> = {
  JUST_ENTERED_RADAR: {
    templates: [
      [
        "{{symbol}} wasn't on my radar 15 minutes ago.",
        "Now it is.",
        "",
        "Here's why:",
        "• Relative volume crossed {{relativeVolume}}",
        "• Large call buying detected",
        "• Buyers reclaimed VWAP at {{vwap}}",
        "• {{sector}} strengthening",
        "",
        "Watching the {{contract}} closely.",
      ],
      [
        "Something changed in {{symbol}}.",
        "",
        "OptiScan just moved it onto my watchlist after detecting unusual options activity.",
        "",
        "Watching the {{contract}}.",
      ],
      [
        "{{symbol}} just entered my universe.",
        "",
        "Not because the candle is green...",
        "",
        "Because the options market suddenly changed.",
      ],
      [
        "New on the radar: {{symbol}}",
        "",
        "• Rel volume {{relativeVolume}}",
        "• Reclaimed {{vwap}}",
        "• {{catalyst}}",
        "",
        "Contract I'm watching: {{contract}}.",
      ],
    ],
    screenshot: "Scanner row for {{symbol}} showing the relative-volume spike and options-flow flag.",
    chartAnnotation: "Mark the VWAP reclaim and the volume bar that crossed {{relativeVolume}}.",
    ctaTypes: ["NONE", "EDUCATIONAL", "SOFT_FOLLOW", "STRONG_PROMO"],
  },
  HIGH_CONVICTION: {
    templates: [
      [
        "{{symbol}} is now high-conviction on my board.",
        "",
        "• Confidence {{confidence}}",
        "• Rel volume {{relativeVolume}}",
        "• Structure holding above {{support}}",
        "",
        "Contract: {{contract}}.",
      ],
      [
        "This is the kind of {{symbol}} setup I don't ignore.",
        "",
        "Confidence {{confidence}} and buyers defended {{vwap}}.",
        "",
        "Watching {{contract}}.",
      ],
      [
        "{{symbol}} checks the boxes:",
        "• {{sector}} strong",
        "• {{catalyst}}",
        "• Reclaimed structure",
        "",
        "Frozen contract of interest: {{contract}}.",
      ],
    ],
    screenshot: "Conviction panel for {{symbol}} with the confidence score visible.",
    chartAnnotation: "Highlight the support at {{support}} and the reclaim of {{vwap}}.",
    ctaTypes: ["EDUCATIONAL", "SOFT_FOLLOW", "STRONG_PROMO"],
  },
  CONVICTION_INCREASED: {
    templates: [
      [
        "Conviction on {{symbol}} just increased.",
        "",
        "The thesis strengthened: {{reason}}.",
        "",
        "Still watching {{contract}}.",
      ],
      [
        "{{symbol}} update: the setup got stronger, not weaker.",
        "",
        "• {{reason}}",
        "• Holding {{support}}",
      ],
      [
        "Adding conviction to {{symbol}}.",
        "Confidence now {{confidence}}.",
      ],
    ],
    screenshot: "Timeline for {{symbol}} showing the conviction step-up.",
    chartAnnotation: "Annotate the higher-low that confirmed the thesis.",
    ctaTypes: ["NONE", "EDUCATIONAL", "SOFT_FOLLOW"],
  },
  THESIS_WEAKENED: {
    templates: [
      [
        "Heads up on {{symbol}}: the thesis weakened.",
        "",
        "{{reason}}.",
        "",
        "Managing risk on the {{contract}}.",
      ],
      [
        "{{symbol}} is losing the structure that made it interesting.",
        "",
        "Lost {{support}}. Staying honest about it.",
      ],
      [
        "Not every setup works. {{symbol}} is cooling off.",
        "Watching {{vwap}} — a loss of it changes the plan.",
      ],
    ],
    screenshot: "Chart of {{symbol}} showing the failed hold of {{support}}.",
    chartAnnotation: "Mark where price lost {{support}} / {{vwap}}.",
    ctaTypes: ["NONE", "EDUCATIONAL", "SOFT_FOLLOW"],
  },
  NEXT_SESSION_WATCH: {
    templates: [
      [
        "Watchlist for next session: {{symbol}}",
        "",
        "• Rel volume {{relativeVolume}}",
        "• Levels: support {{support}} / resistance {{resistance}}",
        "",
        "Recap only — not a live entry call.",
      ],
      [
        "{{symbol}} stays on the board for the next regular session.",
        "Thesis: {{reason}}.",
      ],
      [
        "Next-session watch: {{symbol}} {{contract}}.",
        "No actionable entry right now — waiting for regular hours.",
      ],
    ],
    screenshot: "Watchlist card for {{symbol}} with levels marked.",
    chartAnnotation: "Mark {{support}} and {{resistance}} for the next session plan.",
    ctaTypes: ["NONE", "EDUCATIONAL", "SOFT_FOLLOW"],
  },
  EDUCATIONAL_BREAKDOWN: {
    templates: [
      [
        "How I read {{symbol}} today:",
        "",
        "• Rel volume {{relativeVolume}}",
        "• Structure vs {{vwap}}",
        "• {{reason}}",
        "",
        "Education only — not a trade recommendation.",
      ],
      [
        "Options flow lesson from {{symbol}}:",
        "{{reason}}.",
        "",
        "Watching structure, not chasing candles.",
      ],
      [
        "{{symbol}} breakdown (educational):",
        "• {{sector}}",
        "• {{catalyst}}",
        "• Contract of interest: {{contract}}",
      ],
    ],
    screenshot: "Annotated educational chart for {{symbol}}.",
    chartAnnotation: "Label VWAP, support, and the flow that mattered.",
    ctaTypes: ["NONE", "EDUCATIONAL", "SOFT_FOLLOW"],
  },
  MARKET_OBSERVATION: {
    templates: [
      [
        "Market observation: {{symbol}}",
        "",
        "{{reason}}",
        "",
        "Not a call to act — just what the tape showed.",
      ],
      [
        "Noted on {{symbol}}: rel volume {{relativeVolume}}.",
        "Logging it for the journal.",
      ],
      [
        "{{symbol}} observation from the session.",
        "Levels of interest: {{support}} / {{resistance}}.",
      ],
    ],
    screenshot: "Session observation card for {{symbol}}.",
    chartAnnotation: "Mark the observation window and key levels.",
    ctaTypes: ["NONE", "EDUCATIONAL", "SOFT_FOLLOW"],
  },
  NEW_HIGH: {
    templates: [
      [
        "{{symbol}} {{contract}} printed a new high of the move.",
        "",
        "Up {{returnPct}} from the frozen Discord entry {{premium}}.",
        "",
        "MFE note: max favorable move {{maxReturnPct}} — not a realized subscriber return.",
      ],
      [
        "New high of the move on {{symbol}}.",
        "Frozen entry was {{premium}} — current mark {{returnPct}}.",
      ],
      [
        "{{symbol}} keeps extending. {{returnPct}} from frozen entry.",
        "Peak favorable excursion {{maxReturnPct}} is not the same as a closed gain.",
      ],
    ],
    screenshot: "Option P&L card for {{symbol}} {{contract}} at the new high.",
    chartAnnotation: "Mark the frozen entry and the new high on the option chart.",
    ctaTypes: ["PROOF_RECAP", "EDUCATIONAL", "STRONG_PROMO"],
  },
  RETURN_MILESTONE: {
    templates: [
      [
        "{{symbol}} {{contract}} hit {{milestonePercent}} from the frozen Discord entry {{premium}}.",
        "",
        "Called {{elapsed}} ago.",
      ],
      [
        "{{milestonePercent}} on {{symbol}}.",
        "",
        "Frozen entry {{premium}}. This was on the board before it moved.",
      ],
      [
        "Milestone: {{symbol}} {{optionType}} reached {{milestonePercent}}.",
        "Receipts, not hindsight.",
      ],
      [
        "{{symbol}} runner update — {{milestonePercent}} from frozen entry.",
        "Max favorable move seen: {{maxReturnPct}} (MFE — not a realized return).",
      ],
    ],
    screenshot: "Threaded Discord milestone card for {{symbol}} showing {{milestonePercent}}.",
    chartAnnotation: "Annotate the entry mark and the {{milestonePercent}} level.",
    ctaTypes: ["PROOF_RECAP", "NONE", "EDUCATIONAL", "STRONG_PROMO"],
  },
  CLOSED_WINNER: {
    templates: [
      [
        "Closed: {{symbol}} {{contract}} finished {{returnPct}}.",
        "",
        "Frozen entry {{premium}}. Max favorable move was {{maxReturnPct}} (MFE).",
      ],
      [
        "{{symbol}} is in the books at {{returnPct}}.",
        "Called it, tracked it, closed it. Receipts.",
      ],
      [
        "Winner closed on {{symbol}}: {{returnPct}} from the frozen Discord entry.",
      ],
    ],
    screenshot: "Closed report card for {{symbol}} with the final {{returnPct}}.",
    chartAnnotation: "Mark entry, peak {{maxReturnPct}}, and the close.",
    ctaTypes: ["PROOF_RECAP", "EDUCATIONAL", "STRONG_PROMO"],
  },
  CLOSED_LOSER: {
    templates: [
      [
        "Closed: {{symbol}} {{contract}} finished {{returnPct}}.",
        "",
        "Not every call works — and I show those too.",
      ],
      [
        "{{symbol}} didn't work: closed {{returnPct}}.",
        "Risk was defined. On to the next.",
      ],
      [
        "Loser on the board: {{symbol}} {{returnPct}}. Full transparency.",
      ],
    ],
    screenshot: "Closed report card for {{symbol}} showing the {{returnPct}} loss.",
    chartAnnotation: "Mark entry and the invalidation that closed it.",
    ctaTypes: ["NONE", "EDUCATIONAL", "PROOF_RECAP"],
  },
  WHY_THIS_WORKED: {
    templates: [
      [
        "Why {{symbol}} worked:",
        "",
        "• {{reason}}",
        "• Rel volume {{relativeVolume}}",
        "• Held {{support}}",
        "",
        "Finished {{returnPct}}.",
      ],
      [
        "Breakdown — {{symbol}} ({{returnPct}}):",
        "The tell was {{reason}}.",
      ],
      [
        "{{symbol}} post-mortem: the signal was {{catalyst}}, and it played out to {{returnPct}}.",
      ],
    ],
    screenshot: "Annotated chart of the full {{symbol}} move, entry to close.",
    chartAnnotation: "Label the signal ({{reason}}), the entry, and the exit.",
    ctaTypes: ["PROOF_RECAP", "EDUCATIONAL", "SOFT_FOLLOW"],
  },
  // Every template here renders `{{failureCause}}` — the derived, evidence-graded
  // explanation — and NEVER `{{reason}}`. `reason` is the ENTRY thesis; rendering
  // it after "why this failed" is what produced "Why $AAPL failed: Lower high
  // continuation with bearish structure intact." for a PUT that lost 48.6%.
  // The thesis still appears, but only under an explicit "Entry thesis was:" label,
  // where it is a true statement about the entry rather than a claimed cause.
  WHY_THIS_FAILED: {
    templates: [
      [
        "Why {{symbol}} failed:",
        "",
        "{{failureCause}}",
        "",
        "Closed {{returnPct}}. Lessons > hype.",
      ],
      [
        "{{symbol}} didn't work. Here's the honest read:",
        "",
        "{{failureCause}}",
      ],
      [
        "Post-mortem — {{symbol}} ({{returnPct}}).",
        "",
        "{{failureCause}}",
        "",
        "Entry thesis was: {{entryThesis}}",
      ],
    ],
    screenshot: "Annotated chart showing where the {{symbol}} thesis broke.",
    chartAnnotation: "Mark the invalidation point and {{support}} loss.",
    ctaTypes: ["NONE", "EDUCATIONAL", "PROOF_RECAP"],
  },
};

/** Map a persisted content-event type + vars to eligible categories (deterministic business rules). */
export function eligibleCategories(
  eventType: string,
  v: ContentVars,
  thresholds: EligibilityThresholds = eligibilityThresholds(),
): ContentCategory[] {
  const conf = asFrac(v.confidence);
  const strongEntry = (conf == null || conf >= thresholds.minConfidence)
    && (v.relativeVolume == null || v.relativeVolume >= thresholds.minRelativeVolume)
    && (v.callFlow == null || v.callFlow >= thresholds.minCallFlow);
  switch (eventType) {
    case "OPPORTUNITY_OPENED":
      return strongEntry ? ["JUST_ENTERED_RADAR"] : [];
    case "CONFIRMATION":
      return conf != null && conf >= thresholds.minConfidence ? ["HIGH_CONVICTION"] : ["JUST_ENTERED_RADAR"];
    case "THESIS_STRENGTHENED":
      return ["CONVICTION_INCREASED"];
    case "THESIS_WEAKENING":
      return ["THESIS_WEAKENED"];
    case "NEW_HIGH":
      return ["NEW_HIGH"];
    case "RETURN_MILESTONE_REACHED":
      return ["RETURN_MILESTONE"];
    case "OPPORTUNITY_CLOSED":
    case "EXIT_HIT":
      return (v.returnPct ?? 0) >= 0 ? ["CLOSED_WINNER"] : ["CLOSED_LOSER"];
    case "OPPORTUNITY_REPORT_CARD_READY":
      return (v.returnPct ?? 0) >= 0 ? ["WHY_THIS_WORKED"] : ["WHY_THIS_FAILED"];
    case "NEXT_SESSION_WATCH":
      return ["NEXT_SESSION_WATCH"];
    case "EDUCATIONAL_BREAKDOWN":
      return ["EDUCATIONAL_BREAKDOWN"];
    case "MARKET_OBSERVATION":
      return ["MARKET_OBSERVATION"];
    default:
      return [];
  }
}

/**
 * Filter categories for private testing: safe categories always allowed;
 * performance categories only when claimVerified=true.
 */
export function filterCategoriesForClaim(
  cats: ContentCategory[],
  claimVerified: boolean,
): ContentCategory[] {
  return cats.filter((c) => {
    if (isSafeCategory(c)) return true;
    if (isPerformanceCategory(c)) return claimVerified;
    return false;
  });
}

function hashtagsFor(v: ContentVars, category: ContentCategory): string[] {
  const tags = new Set<string>();
  if (v.symbol) { tags.add(`$${String(v.symbol).toUpperCase()}`); tags.add(`#${String(v.symbol).toUpperCase()}`); }
  tags.add("#options");
  if (category === "RETURN_MILESTONE" || category === "CLOSED_WINNER" || category === "NEW_HIGH") tags.add("#trading");
  if (v.sector) tags.add(`#${String(v.sector).replace(/[^A-Za-z0-9]/g, "")}`);
  return [...tags];
}

export interface BuildDraftOpts {
  /** When true, session is outside regular hours — block live-action phrases. */
  outsideRegularSession?: boolean;
  /** Append MFE disclaimer to drafts that mention maxReturnPct. */
  appendMfeDisclaimer?: boolean;
}

/** Build 3–5 template drafts for a single category. Drops templates that can't render (missing vars). */
export function buildDraftBundle(
  category: ContentCategory,
  v: ContentVars,
  opts: BuildDraftOpts = {},
): ContentDraftBundle | null {
  const spec = TEMPLATES[category];
  if (!spec) return null;
  const drafts: DraftMeta[] = [];
  for (let i = 0; i < spec.templates.length; i++) {
    const tpl = spec.templates[i];
    let text = renderTemplate(tpl, v);
    if (!text) continue;
    const ctaType = spec.ctaTypes[i % spec.ctaTypes.length] ?? "NONE";
    const cta = CTA_COPY[ctaType];
    if (opts.appendMfeDisclaimer && v.maxReturnPct != null && /max favorable|MFE/i.test(text)) {
      const disc = mfeDisclaimer(v.maxReturnPct);
      if (!text.includes("not the same as a realized") && (text.length + disc.length + 2) <= 280) {
        text = `${text}\n\n${disc}`;
      }
    }
    // Backstop. With no quotable peak, `renderLine` already drops any line whose
    // {{maxReturnPct}} placeholder is null — the draft survives without its MFE line,
    // which is what keeps a true realized return publishable when only the excursion
    // is unprovable. This catches the other shape: copy that TALKS about a maximum
    // favourable move without using the placeholder. Such a line would read as an
    // excursion claim with no evidence behind it, so the draft is dropped entirely.
    if (v.maxReturnPct == null && /max favorable|maximum favorable|MFE|peak favorable/i.test(text)) {
      continue;
    }
    const lang = validateSocialDraftLanguage(text, { outsideRegularSession: opts.outsideRegularSession === true });
    if (!lang.ok) continue;
    if (text.length > 280) continue;
    drafts.push({
      text,
      charCount: text.length,
      hashtags: hashtagsFor(v, category),
      suggestedScreenshot: renderLine(spec.screenshot, v) ?? spec.screenshot.replace(/\{\{\w+\}\}/g, "").replace(/\s+/g, " ").trim(),
      suggestedChartAnnotation: renderLine(spec.chartAnnotation, v) ?? spec.chartAnnotation.replace(/\{\{\w+\}\}/g, "").replace(/\s+/g, " ").trim(),
      suggestedCta: cta || "(none)",
      ctaType,
      templateFamily: `${category}_${i}`,
      templateVersion: TEMPLATE_VERSION,
    });
    if (drafts.length >= 5) break;
  }
  if (drafts.length < 1) return null;
  return { category, symbol: v.symbol ? String(v.symbol).toUpperCase() : "?", drafts, generatedByLlm: false };
}

/** List of template families for a category (for regenerate). */
export function templateFamiliesFor(category: ContentCategory): string[] {
  const spec = TEMPLATES[category];
  if (!spec) return [];
  return spec.templates.map((_, i) => `${category}_${i}`);
}
