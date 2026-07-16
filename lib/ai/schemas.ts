/**
 * ai/schemas.ts - PURE validators for AI responses. A response is trusted ONLY
 * after it passes these; anything malformed throws and the provider fails closed.
 *
 * The nightly narrative additionally passes an anti-fabrication guard:
 * quantitative claims in narrative text must be backed by typed deterministic
 * evidence from the summary. Weekly proposals are exempt from that numeric guard
 * because a proposal legitimately introduces NEW candidate config values; they
 * are validated structurally instead.
 */

function asString(v: unknown, field: string, { min = 1 } = {}): string {
  if (typeof v !== "string" || v.trim().length < min) throw new Error(`field '${field}' must be a non-empty string`);
  return v.trim();
}
function asStringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new Error(`field '${field}' must be an array`);
  return v.map((x, i) => asString(x, `${field}[${i}]`));
}
function optString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Recursively collect every number in an object as normalized string tokens. */
export function flattenNumbers(obj: unknown, acc: Set<string> = new Set()): Set<string> {
  if (typeof obj === "number" && Number.isFinite(obj)) {
    acc.add(String(obj));
    acc.add(String(Math.round(obj)));
    acc.add(String(Math.round(obj * 10) / 10));
    acc.add(String(Math.abs(obj)));
  } else if (Array.isArray(obj)) {
    for (const x of obj) flattenNumbers(x, acc);
  } else if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) flattenNumbers(v, acc);
  } else if (typeof obj === "string") {
    // Legacy support for numeric labels in older tests and callers.
    for (const m of obj.matchAll(/\d+(?:\.\d+)?/g)) acc.add(m[0]);
  }
  return acc;
}

export type QuantEvidenceType =
  | "count"
  | "percentage"
  | "currency"
  | "decimal"
  | "duration"
  | "time_range"
  | "clock_time"
  | "date"
  | "identifier"
  | "ratio";

export interface QuantEvidence {
  type: QuantEvidenceType;
  value: string | number;
  source: string;
  formatted?: string[];
}

export interface NumericClaimDiagnostic {
  token: string;
  semanticType: QuantEvidenceType;
  context: string;
  normalizedValue: string | number | null;
  result: "allowed" | "allowed_temporal" | "allowed_identifier" | "rejected";
  closestAllowedEvidence: QuantEvidence[];
  sourceFieldExpected: string | null;
}

export interface AntiFabricationValidationDetail {
  claim: NumericClaimDiagnostic;
  rejectedClaims: NumericClaimDiagnostic[];
  allowedEvidenceSample: QuantEvidence[];
}

const TIME_BUCKET_LABELS: Record<string, string[]> = {
  open_0930_1000: ["09:30-10:00", "9:30-10:00"],
  morning_1000_1200: ["10:00-12:00"],
  midday_1200_1400: ["12:00-14:00"],
  afternoon_1400_1600: ["14:00-16:00"],
};

const STOPWORDS_WITH_NUMBERS = new Set(["0", "1"]);

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizeNumber(value: number): string[] {
  const values = new Set<string>();
  values.add(String(value));
  values.add(String(Math.abs(value)));
  values.add(String(Math.round(value)));
  values.add(String(round1(value)));
  values.add(String(round1(Math.abs(value))));
  return [...values];
}

function inferEvidenceType(source: string, value: number): QuantEvidenceType {
  const s = source.toLowerCase();
  if (/(pct|percent|rate|ratio|hitrate|winrate|breakevenrate|avgreturn)/i.test(s)) return "percentage";
  if (/(usd|pnl|dollar|cost|price|premium|debit|credit)/i.test(s)) return "currency";
  if (/(duration|latency|ttl|ms|seconds|minutes|hours|age)/i.test(s)) return "duration";
  return Number.isInteger(value) ? "count" : "decimal";
}

function evidenceForNumber(value: number, source: string): QuantEvidence {
  const type = inferEvidenceType(source, value);
  const formatted = normalizeNumber(value);
  if (type === "percentage") formatted.push(...normalizeNumber(value).map((v) => `${v}%`));
  if (type === "currency") formatted.push(...normalizeNumber(value).map((v) => `$${v}`));
  return { type, value, source, formatted: [...new Set(formatted)] };
}

function canonicalTimeRange(token: string): string {
  return token.replace(/\s+/g, "").replace(/[--]/g, "-");
}

function addStringEvidence(registry: QuantEvidence[], value: string, source: string): void {
  const text = value.trim();
  if (!text) return;
  for (const m of text.matchAll(/\b\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\b/g)) {
    registry.push({ type: "time_range", value: canonicalTimeRange(m[0]), source, formatted: [m[0], canonicalTimeRange(m[0])] });
  }
  for (const m of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g)) {
    registry.push({ type: "date", value: m[0], source, formatted: [m[0]] });
  }
  for (const m of text.matchAll(/\b[A-Z]{1,6}\d{6}[CP]\d{8}\b/g)) {
    registry.push({ type: "identifier", value: m[0], source, formatted: [m[0]] });
  }
}

/**
 * Build typed evidence from deterministic summary data. This is intentionally
 * source-aware: a win-rate percentage is not interchangeable with a count, and
 * time labels are evidence only for temporal labels.
 */
export function buildQuantEvidenceRegistry(summary: unknown): QuantEvidence[] {
  const registry: QuantEvidence[] = [];
  const visit = (value: unknown, path: string[] = []): void => {
    const source = path.join(".") || "root";
    if (typeof value === "number" && Number.isFinite(value)) {
      registry.push(evidenceForNumber(value, source));
      return;
    }
    if (typeof value === "string") {
      addStringEvidence(registry, value, source);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (TIME_BUCKET_LABELS[key]) {
          for (const label of TIME_BUCKET_LABELS[key]) {
            registry.push({
              type: "time_range",
              value: canonicalTimeRange(label),
              source: [...path, key].join("."),
              formatted: [label, canonicalTimeRange(label)],
            });
          }
        }
        visit(child, [...path, key]);
      }
    }
  };
  visit(summary);
  return registry;
}

export function legacyNumericTokensForAudit(text: string): string[] {
  return [...String(text).matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
}

interface Span {
  start: number;
  end: number;
  type: QuantEvidenceType;
  token: string;
  normalizedValue: string | number | null;
}

function inProtectedSpan(start: number, end: number, spans: Span[]): boolean {
  return spans.some((span) => start < span.end && span.start < end);
}

function contextFor(text: string, start: number, end: number): string {
  return text.slice(Math.max(0, start - 45), Math.min(text.length, end + 45)).replace(/\s+/g, " ").trim();
}

function uniqueEvidence(values: QuantEvidence[]): QuantEvidence[] {
  const seen = new Set<string>();
  const out: QuantEvidence[] = [];
  for (const ev of values) {
    const key = `${ev.type}|${ev.value}|${ev.source}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(ev);
    }
  }
  return out;
}

function numericValue(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(String(value).replace(/[$,%]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function valuesMatch(a: unknown, b: unknown): boolean {
  const an = numericValue(a);
  const bn = numericValue(b);
  if (an != null && bn != null) return Math.abs(an - bn) < 0.0001 || Math.abs(round1(an) - round1(bn)) < 0.0001;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function evidenceMatches(claim: NumericClaimDiagnostic, evidence: QuantEvidence): boolean {
  const formatted = evidence.formatted ?? [];
  if (formatted.some((v) => String(v).toLowerCase() === claim.token.toLowerCase())) return true;
  if (claim.semanticType === "time_range") return evidence.type === "time_range" && valuesMatch(claim.normalizedValue, evidence.value);
  if (claim.semanticType === "date") return evidence.type === "date" && valuesMatch(claim.normalizedValue, evidence.value);
  if (claim.semanticType === "identifier") return evidence.type === "identifier" && valuesMatch(claim.normalizedValue, evidence.value);
  if (claim.semanticType === "ratio") return false;
  if (claim.semanticType === "percentage") return evidence.type === "percentage" && valuesMatch(claim.normalizedValue, evidence.value);
  if (claim.semanticType === "currency") return evidence.type === "currency" && valuesMatch(claim.normalizedValue, evidence.value);
  if (claim.semanticType === "duration") return evidence.type === "duration" && valuesMatch(claim.normalizedValue, evidence.value);
  if (claim.semanticType === "decimal") return (evidence.type === "decimal" || evidence.type === "percentage") && valuesMatch(claim.normalizedValue, evidence.value);
  if (claim.semanticType === "count") return evidence.type === "count" && valuesMatch(claim.normalizedValue, evidence.value);
  return false;
}

function closestEvidence(claim: NumericClaimDiagnostic, evidence: QuantEvidence[]): QuantEvidence[] {
  const sameType = evidence.filter((ev) => ev.type === claim.semanticType || (claim.semanticType === "decimal" && ev.type === "percentage"));
  const claimNumber = numericValue(claim.normalizedValue);
  const ranked = [...(sameType.length ? sameType : evidence)].sort((a, b) => {
    if (claimNumber == null) return String(a.source).localeCompare(String(b.source));
    const an = numericValue(a.value);
    const bn = numericValue(b.value);
    const ad = an == null ? Number.POSITIVE_INFINITY : Math.abs(an - claimNumber);
    const bd = bn == null ? Number.POSITIVE_INFINITY : Math.abs(bn - claimNumber);
    return ad - bd;
  });
  return uniqueEvidence(ranked).slice(0, 5);
}

function makeClaim(text: string, span: Span, evidence: QuantEvidence[]): NumericClaimDiagnostic {
  const claim: NumericClaimDiagnostic = {
    token: span.token,
    semanticType: span.type,
    context: contextFor(text, span.start, span.end),
    normalizedValue: span.normalizedValue,
    result: "rejected",
    closestAllowedEvidence: [],
    sourceFieldExpected: null,
  };
  const match = evidence.find((ev) => evidenceMatches(claim, ev));
  if (match) {
    claim.result = claim.semanticType === "date" || claim.semanticType === "time_range" || claim.semanticType === "clock_time" ? "allowed_temporal" : claim.semanticType === "identifier" ? "allowed_identifier" : "allowed";
    claim.closestAllowedEvidence = [match];
    claim.sourceFieldExpected = match.source;
    return claim;
  }
  claim.closestAllowedEvidence = closestEvidence(claim, evidence);
  claim.sourceFieldExpected = claim.closestAllowedEvidence[0]?.source ?? null;
  return claim;
}

function extractClaims(text: string, evidence: QuantEvidence[]): NumericClaimDiagnostic[] {
  const t = String(text);
  const spans: Span[] = [];
  const addMatches = (regex: RegExp, type: QuantEvidenceType, norm: (token: string) => string | number | null): void => {
    for (const m of t.matchAll(regex)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (inProtectedSpan(start, end, spans)) continue;
      spans.push({ start, end, type, token: m[0], normalizedValue: norm(m[0]) });
    }
  };

  addMatches(/\b[A-Z]{1,6}\d{6}[CP]\d{8}\b/g, "identifier", (token) => token);
  addMatches(/\b\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\b/g, "time_range", canonicalTimeRange);
  addMatches(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "date", (token) => token);
  addMatches(/\b(?:report|id)\s*#?\s*\d+\b/gi, "identifier", (token) => token.replace(/\s+/g, " "));
  addMatches(/\b\d{1,2}:\d{2}\b/g, "clock_time", (token) => token);
  addMatches(/[-+]?\$\s*\d+(?:,\d{3})*(?:\.\d+)?\b/g, "currency", (token) => Number(token.replace(/[$,\s]/g, "")));
  addMatches(/[-+]?\d+(?:\.\d+)?\s*%/g, "percentage", (token) => Number(token.replace(/[%\s]/g, "")));
  addMatches(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|second|seconds|min|mins|minute|minutes|hour|hours)\b/gi, "duration", (token) => Number(token.replace(/[^\d.]/g, "")));
  addMatches(/\b\d+\s*(?:of|\/)\s*\d+\b/gi, "ratio", (token) => token.toLowerCase().replace(/\s+/g, " "));

  for (const m of t.matchAll(/[-+]?\d+\.\d+/g)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (inProtectedSpan(start, end, spans)) continue;
    spans.push({ start, end, type: "decimal", token: m[0], normalizedValue: Number(m[0]) });
  }

  for (const m of t.matchAll(/(?<![\w.:%$])-?\d+(?![\w.:%])/g)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (inProtectedSpan(start, end, spans)) continue;
    spans.push({ start, end, type: "count", token: m[0], normalizedValue: Number(m[0]) });
  }

  return spans.sort((a, b) => a.start - b.start).map((span) => makeClaim(t, span, evidence));
}

function rejectedClaims(text: string, evidence: QuantEvidence[]): NumericClaimDiagnostic[] {
  return extractClaims(text, evidence).filter((claim) => {
    if (claim.result !== "rejected") return false;
    if (claim.semanticType === "count" && STOPWORDS_WITH_NUMBERS.has(String(claim.normalizedValue))) return false;
    if (claim.semanticType === "ratio") {
      const parts = String(claim.token).match(/\d+/g) ?? [];
      return parts.some((part) => !evidence.some((ev) => ev.type === "count" && valuesMatch(part, ev.value)));
    }
    if (claim.semanticType === "identifier") return false;
    if (claim.semanticType === "clock_time") return false;
    return true;
  });
}

/**
 * Assert the text introduces no unsupported quantitative claim. The Set overload
 * keeps legacy callers working; the evidence-registry overload is used by the
 * nightly validator and records structured diagnostics.
 */
export function assertNoFabricatedNumbers(text: string, allowed: Set<string> | QuantEvidence[]): void {
  if (allowed instanceof Set) {
    const tokens = String(text).matchAll(/\d+(?:\.\d+)?/g);
    for (const m of tokens) {
      const raw = m[0];
      if (raw === "0" || raw === "1") continue;
      const norm = String(Number(raw));
      const norm1 = String(Math.round(Number(raw) * 10) / 10);
      if (allowed.has(raw) || allowed.has(norm) || allowed.has(norm1)) continue;
      throw new Error(`narrative contains a number not present in the deterministic summary: ${raw}`);
    }
    return;
  }

  const failures = rejectedClaims(text, allowed);
  if (failures.length === 0) return;
  const err = new Error(`narrative contains an unsupported quantitative claim: ${failures[0].token}`);
  (err as any).validationDetail = {
    claim: failures[0],
    rejectedClaims: failures,
    allowedEvidenceSample: uniqueEvidence(allowed).slice(0, 20),
  } satisfies AntiFabricationValidationDetail;
  throw err;
}

export interface NightlyNarrative {
  headline: string;
  whatHappened: string;
  repeatedPatterns: string[];
  successPatterns: string[];
  bottlenecks: string[];
  supportedConclusions: string[];
  needsMoreEvidence: string[];
  prioritizedIssue: string;
}

export const NIGHTLY_NARRATIVE_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "headline",
    "whatHappened",
    "repeatedPatterns",
    "successPatterns",
    "bottlenecks",
    "supportedConclusions",
    "needsMoreEvidence",
    "prioritizedIssue",
  ],
  properties: {
    headline: { type: "string", minLength: 1 },
    whatHappened: { type: "string", minLength: 1 },
    repeatedPatterns: { type: "array", items: { type: "string" } },
    successPatterns: { type: "array", items: { type: "string" } },
    bottlenecks: { type: "array", items: { type: "string" } },
    supportedConclusions: { type: "array", items: { type: "string" } },
    needsMoreEvidence: { type: "array", items: { type: "string" } },
    prioritizedIssue: { type: "string", minLength: 1 },
  },
} as const;

/**
 * Validate the nightly narrative structure AND enforce the anti-fabrication guard
 * against typed deterministic evidence present in the summary.
 */
export function validateNightlyNarrative(json: unknown, summary: unknown): NightlyNarrative {
  if (!json || typeof json !== "object") throw new Error("narrative must be a JSON object");
  const j = json as Record<string, unknown>;
  const narrative: NightlyNarrative = {
    headline: asString(j.headline, "headline"),
    whatHappened: asString(j.whatHappened, "whatHappened"),
    repeatedPatterns: asStringArray(j.repeatedPatterns ?? [], "repeatedPatterns"),
    successPatterns: asStringArray(j.successPatterns ?? [], "successPatterns"),
    bottlenecks: asStringArray(j.bottlenecks ?? [], "bottlenecks"),
    supportedConclusions: asStringArray(j.supportedConclusions ?? [], "supportedConclusions"),
    needsMoreEvidence: asStringArray(j.needsMoreEvidence ?? [], "needsMoreEvidence"),
    prioritizedIssue: asString(j.prioritizedIssue, "prioritizedIssue"),
  };
  const allowed = buildQuantEvidenceRegistry(summary);
  const allText = [
    narrative.headline, narrative.whatHappened, narrative.prioritizedIssue,
    ...narrative.repeatedPatterns, ...narrative.successPatterns, ...narrative.bottlenecks,
    ...narrative.supportedConclusions, ...narrative.needsMoreEvidence,
  ].join("  ");
  assertNoFabricatedNumbers(allText, allowed);
  return narrative;
}

export interface WeeklyProposalDraft {
  title: string;
  problem: string;
  evidence: string;
  sampleSize: number;
  affectedStrategy: string | null;
  affectedSession: string | null;
  affectedConfig: string | null;
  proposedChange: string;
  relevantFiles: string[];
  changeLevel: "config-only" | "code-level" | null;
  expectedBenefit: string | null;
  downsideRisk: string | null;
  overfittingRisk: string | null;
  requiredTests: string | null;
  backtestPlan: string | null;
  shadowTestPlan: string | null;
  paperTestPlan: string | null;
  rollbackPlan: string | null;
  suggestedPatch: string | null;
  confidence: "LOW" | "MEDIUM" | "HIGH";
}

function asConfidence(v: unknown): "LOW" | "MEDIUM" | "HIGH" {
  const s = String(v ?? "").toUpperCase();
  return s === "HIGH" ? "HIGH" : s === "MEDIUM" ? "MEDIUM" : "LOW";
}

function validateOneProposal(j: Record<string, unknown>): WeeklyProposalDraft {
  const changeLevelRaw = String(j.changeLevel ?? "").toLowerCase();
  const changeLevel = changeLevelRaw === "config-only" ? "config-only" : changeLevelRaw === "code-level" ? "code-level" : null;
  const sample = Number(j.sampleSize);
  return {
    title: asString(j.title, "title"),
    problem: asString(j.problem, "problem"),
    evidence: asString(j.evidence, "evidence"),
    sampleSize: Number.isFinite(sample) ? Math.max(0, Math.floor(sample)) : 0,
    affectedStrategy: optString(j.affectedStrategy),
    affectedSession: optString(j.affectedSession),
    affectedConfig: optString(j.affectedConfig),
    proposedChange: asString(j.proposedChange, "proposedChange"),
    relevantFiles: Array.isArray(j.relevantFiles) ? j.relevantFiles.map(String).filter(Boolean).slice(0, 20) : [],
    changeLevel,
    expectedBenefit: optString(j.expectedBenefit),
    downsideRisk: optString(j.downsideRisk),
    overfittingRisk: optString(j.overfittingRisk),
    requiredTests: optString(j.requiredTests),
    backtestPlan: optString(j.backtestPlan),
    shadowTestPlan: optString(j.shadowTestPlan),
    paperTestPlan: optString(j.paperTestPlan),
    rollbackPlan: optString(j.rollbackPlan),
    suggestedPatch: optString(j.suggestedPatch),
    confidence: asConfidence(j.confidence),
  };
}

/** Validate the weekly proposals payload: { proposals: [...] } or a bare array. */
export function validateWeeklyProposals(json: unknown): WeeklyProposalDraft[] {
  const arr = Array.isArray(json)
    ? json
    : (json && typeof json === "object" && Array.isArray((json as any).proposals))
      ? (json as any).proposals
      : null;
  if (!arr) throw new Error("weekly proposals must be an array or { proposals: [...] }");
  if (arr.length === 0) return [];
  return arr.slice(0, 10).map((p: unknown, i: number) => {
    if (!p || typeof p !== "object") throw new Error(`proposal[${i}] must be an object`);
    return validateOneProposal(p as Record<string, unknown>);
  });
}
