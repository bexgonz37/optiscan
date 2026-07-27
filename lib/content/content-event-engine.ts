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
  | "WHY_THIS_FAILED";

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
}

export interface DraftMeta {
  text: string;
  charCount: number;
  hashtags: string[];
  suggestedScreenshot: string;
  suggestedChartAnnotation: string;
  suggestedCta: string;
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
  cta: string;
}

const CTA_FOLLOW = "Follow for more setups like this. Not financial advice.";
const CTA_DISCORD = "Full breakdowns drop first in the private Discord. Education only — not financial advice.";

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
    cta: CTA_FOLLOW,
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
    cta: CTA_DISCORD,
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
    cta: CTA_FOLLOW,
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
    cta: CTA_FOLLOW,
  },
  NEW_HIGH: {
    templates: [
      [
        "{{symbol}} {{contract}} just printed a new high.",
        "",
        "Up {{returnPct}} from the frozen entry {{premium}}.",
      ],
      [
        "New high of the move on {{symbol}}.",
        "Frozen entry was {{premium}} — now {{returnPct}}.",
      ],
      [
        "{{symbol}} keeps extending. {{returnPct}} and counting from entry.",
      ],
    ],
    screenshot: "Option P&L card for {{symbol}} {{contract}} at the new high.",
    chartAnnotation: "Mark the frozen entry and the new high on the option chart.",
    cta: CTA_DISCORD,
  },
  RETURN_MILESTONE: {
    templates: [
      [
        "{{symbol}} {{contract}} just hit {{milestonePercent}} from the frozen Discord entry {{premium}}.",
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
        "{{symbol}} runner update — {{milestonePercent}} from entry.",
        "Max seen: {{maxReturnPct}}.",
      ],
    ],
    screenshot: "Threaded Discord milestone card for {{symbol}} showing {{milestonePercent}}.",
    chartAnnotation: "Annotate the entry mark and the {{milestonePercent}} level.",
    cta: CTA_DISCORD,
  },
  CLOSED_WINNER: {
    templates: [
      [
        "Closed: {{symbol}} {{contract}} finished {{returnPct}}.",
        "",
        "Frozen entry {{premium}}. Max was {{maxReturnPct}}.",
      ],
      [
        "{{symbol}} is in the books at {{returnPct}}.",
        "Called it, tracked it, closed it. Receipts.",
      ],
      [
        "Winner closed on {{symbol}}: {{returnPct}} from the frozen entry.",
      ],
    ],
    screenshot: "Closed report card for {{symbol}} with the final {{returnPct}}.",
    chartAnnotation: "Mark entry, peak {{maxReturnPct}}, and the close.",
    cta: CTA_DISCORD,
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
    cta: CTA_FOLLOW,
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
    cta: CTA_DISCORD,
  },
  WHY_THIS_FAILED: {
    templates: [
      [
        "Why {{symbol}} failed:",
        "",
        "• {{reason}}",
        "• Lost {{support}}",
        "",
        "Closed {{returnPct}}. Lessons > hype.",
      ],
      [
        "{{symbol}} didn't work and here's the honest read: {{reason}}.",
      ],
      [
        "Post-mortem — {{symbol}} ({{returnPct}}): the setup broke when {{reason}}.",
      ],
    ],
    screenshot: "Annotated chart showing where the {{symbol}} thesis broke.",
    chartAnnotation: "Mark the invalidation point and {{support}} loss.",
    cta: CTA_FOLLOW,
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
    default:
      return [];
  }
}

function hashtagsFor(v: ContentVars, category: ContentCategory): string[] {
  const tags = new Set<string>();
  if (v.symbol) { tags.add(`$${String(v.symbol).toUpperCase()}`); tags.add(`#${String(v.symbol).toUpperCase()}`); }
  tags.add("#options");
  if (category === "RETURN_MILESTONE" || category === "CLOSED_WINNER" || category === "NEW_HIGH") tags.add("#trading");
  if (v.sector) tags.add(`#${String(v.sector).replace(/[^A-Za-z0-9]/g, "")}`);
  return [...tags];
}

/** Build 3–5 template drafts for a single category. Drops templates that can't render (missing vars). */
export function buildDraftBundle(category: ContentCategory, v: ContentVars): ContentDraftBundle | null {
  const spec = TEMPLATES[category];
  if (!spec) return null;
  const drafts: DraftMeta[] = [];
  for (const tpl of spec.templates) {
    const text = renderTemplate(tpl, v);
    if (!text) continue;
    if (!validateSocialDraftLanguage(text).ok) continue; // never emit "buy now"-style live language
    if (text.length > 280) continue;                     // respect the X character budget
    drafts.push({
      text,
      charCount: text.length,
      hashtags: hashtagsFor(v, category),
      suggestedScreenshot: renderLine(spec.screenshot, v) ?? spec.screenshot.replace(/\{\{\w+\}\}/g, "").replace(/\s+/g, " ").trim(),
      suggestedChartAnnotation: renderLine(spec.chartAnnotation, v) ?? spec.chartAnnotation.replace(/\{\{\w+\}\}/g, "").replace(/\s+/g, " ").trim(),
      suggestedCta: spec.cta,
    });
    if (drafts.length >= 5) break;
  }
  if (drafts.length < 1) return null;
  return { category, symbol: v.symbol ? String(v.symbol).toUpperCase() : "?", drafts, generatedByLlm: false };
}
