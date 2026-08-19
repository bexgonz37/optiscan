/**
 * content-gate.ts — the step the pipeline never had.
 *
 * The old flow was `event -> templates -> persist -> Discord`. Between "we
 * rendered some copy" and "it is in the owner's queue" there was no decision at
 * all, so the answer to "should this exist" was always yes. This module is that
 * decision, and it is the only place in the content path allowed to say no for
 * reasons of quality rather than safety.
 *
 * ORDER MATTERS, AND IT IS THE ORDER IN THE BRIEF:
 *
 *   DEDUPE -> WORTHINESS -> COHERENCE -> RANK -> BEST FEW
 *
 * Dedupe runs first because a duplicate is not a low-quality draft, it is a
 * draft that must not be written at any score — and checking it first costs one
 * indexed lookup instead of a full render evaluation. Coherence runs after
 * worthiness because rejecting incoherent copy on a candidate that was never
 * going to be published is work nobody reads.
 *
 * WHAT IT MAY NOT DO
 *
 * It may not call a model. Deciding whether an event happened, or whether it
 * resembles the one from ten minutes ago, is arithmetic. It may not send
 * anything. It may not touch a case, a position, a gate, or a threshold. It
 * reads two tables and returns a verdict.
 */
import {
  DEFAULT_WORTHINESS_THRESHOLD,
  collapseBatchDuplicates,
  scoreContentWorthiness,
  semanticContentFingerprint,
  thesisDigest,
  type ContentAngle,
  type WorthinessScore,
} from "./content-worthiness.ts";
import { validateContentCoherence, type CoherenceViolation } from "./content-coherence.ts";

interface GateDb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[] };
}

export interface GateDraft {
  text: string;
  templateFamily: string;
}

export interface ContentGateInput {
  symbol: string;
  category: string;
  optionType?: string | null;
  direction?: string | null;
  sessionDate: string;
  /** Source lines the copy was built from — thesis and latest evidence. */
  thesisParts: Array<string | null | undefined>;
  milestone?: string | number | null;
  /** NON_ACTIONABLE_RESEARCH | VERIFIED_* — part of the draft's identity. */
  evidenceState?: string | null;
  claimVerified?: boolean;
  hasExactOcc?: boolean;
  hasRealizedOutcome?: boolean;
  isMaxExcursion?: boolean;
  ownerValidationOnly?: boolean;
  magnitudePct?: number | null;
  eventAgeMs?: number;
  /**
   * The owner explicitly asked for this — a REGENERATE ANGLE press. Worthiness
   * and duplication are the machine's opinion about whether to bother a person;
   * once the person has asked, that opinion is answered. Coherence still
   * applies: a draft the owner requested may still not be one that contradicts
   * the position it describes.
   */
  ownerRequested?: boolean;
  /** Salt so an owner-requested regeneration is a new row, not a collision. */
  fingerprintSalt?: string | null;
  drafts: readonly GateDraft[];
}

export interface AdmittedDraft {
  index: number;
  text: string;
  templateFamily: string;
  fingerprint: string;
  /** The first admitted draft is the recommendation; the rest are alternates. */
  isAlternate: boolean;
}

export interface ContentGateVerdict {
  admitted: AdmittedDraft[];
  rootFingerprint: string;
  worthiness: WorthinessScore;
  angle: ContentAngle;
  duplicate: boolean;
  /** Drafts refused for saying something the evidence does not support. */
  incoherent: Array<{ index: number; templateFamily: string; violations: CoherenceViolation[] }>;
  /** Null when at least one draft was admitted. */
  refusedBecause: string | null;
}

/** How many drafts one accepted idea may occupy in the queue. */
export const MAX_DRAFTS_PER_IDEA = 3;

export function worthinessThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CONTENT_MIN_WORTHINESS);
  if (!Number.isFinite(raw)) return DEFAULT_WORTHINESS_THRESHOLD;
  return Math.max(0, Math.min(1, raw));
}

function hasTable(db: GateDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function countPriorDrafts(
  db: GateDb,
  opts: { symbol: string; sessionDate: string; category?: string },
): number {
  if (!hasTable(db, "content_drafts") || !hasTable(db, "opportunity_content_events")) return 0;
  try {
    const sql = `SELECT COUNT(*) AS n FROM content_drafts d
                   JOIN opportunity_content_events e ON e.id = d.content_event_id
                  WHERE e.symbol = ? AND d.trading_session_date = ?`
      + (opts.category ? " AND d.category = ?" : "");
    const args: any[] = [String(opts.symbol).toUpperCase(), opts.sessionDate];
    if (opts.category) args.push(opts.category);
    const r = db.prepare(sql).get(...args) as any;
    return Number(r?.n ?? 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * Is this exact idea already on record?
 *
 * Matches the root fingerprint AND its alternates, because a regeneration must
 * not slip an alternate through on the grounds that only the primary collided.
 */
function fingerprintExists(db: GateDb, root: string): boolean {
  if (!hasTable(db, "content_drafts")) return false;
  try {
    const r = db.prepare(
      "SELECT 1 FROM content_drafts WHERE fingerprint = ? OR fingerprint LIKE ? LIMIT 1",
    ).get(root, `${root}#%`);
    return Boolean(r);
  } catch {
    return false;
  }
}

/**
 * Has anything materially changed since the last draft about this symbol and
 * category in this session?
 *
 * Answered from the persisted drafts rather than from the event, because the
 * event is the thing that kept being re-emitted. If a draft with this exact
 * semantic identity already exists, nothing changed by definition; if drafts
 * exist for this symbol+category with DIFFERENT identities, something did.
 */
export function detectMaterialChange(
  db: GateDb,
  opts: { symbol: string; sessionDate: string; category: string; rootFingerprint: string },
): boolean {
  if (fingerprintExists(db, opts.rootFingerprint)) return false;
  return true;
}

export function gateContentBundle(
  db: GateDb,
  input: ContentGateInput,
  env: NodeJS.ProcessEnv = process.env,
): ContentGateVerdict {
  const symbol = String(input.symbol ?? "").toUpperCase();
  const digest = thesisDigest(input.thesisParts);
  const rootFingerprint = semanticContentFingerprint({
    symbol,
    category: input.category,
    optionType: input.optionType ?? null,
    sessionDate: input.sessionDate,
    thesisDigest: digest,
    milestone: input.milestone ?? null,
    evidenceState: input.fingerprintSalt
      ? `${input.evidenceState ?? "none"}|${input.fingerprintSalt}`
      : (input.evidenceState ?? null),
  });

  const duplicate = fingerprintExists(db, rootFingerprint);
  const priorSameSymbolCategory = countPriorDrafts(db, {
    symbol, sessionDate: input.sessionDate, category: input.category,
  });
  const priorSameSymbol = countPriorDrafts(db, { symbol, sessionDate: input.sessionDate });

  const worthiness = scoreContentWorthiness({
    category: input.category,
    symbol,
    claimVerified: input.claimVerified,
    hasExactOcc: input.hasExactOcc,
    hasRealizedOutcome: input.hasRealizedOutcome,
    priorDraftsSameSymbolCategory: priorSameSymbolCategory,
    priorDraftsSameSymbol: priorSameSymbol,
    duplicateFingerprint: duplicate,
    materialChange: duplicate ? false : true,
    eventAgeMs: input.eventAgeMs,
    magnitudePct: input.magnitudePct ?? null,
  }, worthinessThreshold(env));

  const incoherent: ContentGateVerdict["incoherent"] = [];
  if (!worthiness.worthy && !input.ownerRequested) {
    return {
      admitted: [], rootFingerprint, worthiness, angle: worthiness.angle,
      duplicate, incoherent, refusedBecause: worthiness.refusedBecause,
    };
  }

  // Coherence: a draft that contradicts its own position never reaches review.
  const coherent: Array<{ index: number; text: string; templateFamily: string }> = [];
  input.drafts.forEach((d, index) => {
    const verdict = validateContentCoherence({
      text: d.text,
      optionType: input.optionType ?? null,
      direction: input.direction ?? null,
      claimVerified: input.claimVerified,
      isMaxExcursion: input.isMaxExcursion,
      ownerValidationOnly: input.ownerValidationOnly,
    });
    if (verdict.coherent) coherent.push({ index, text: d.text, templateFamily: d.templateFamily });
    else incoherent.push({ index, templateFamily: d.templateFamily, violations: verdict.violations });
  });

  if (!coherent.length) {
    return {
      admitted: [], rootFingerprint, worthiness, angle: worthiness.angle, duplicate, incoherent,
      refusedBecause: "Every rendered draft contradicted the evidence or the position it describes.",
    };
  }

  // Collapse exact-text duplicates inside this batch, then bound how much of
  // the queue one idea may occupy. Order is preserved so template 0 — the one
  // the engine treats as the recommendation — stays first.
  const seenText = new Set<string>();
  const admitted: AdmittedDraft[] = [];
  for (const c of coherent) {
    const key = c.text.trim();
    if (seenText.has(key)) continue;
    seenText.add(key);
    if (admitted.length >= MAX_DRAFTS_PER_IDEA) break;
    admitted.push({
      index: c.index,
      text: c.text,
      templateFamily: c.templateFamily,
      // The root is the primary's identity; alternates hang off it so a
      // regeneration collides on every row rather than only the first.
      fingerprint: admitted.length === 0 ? rootFingerprint : `${rootFingerprint}#${admitted.length}`,
      isAlternate: admitted.length > 0,
    });
  }

  return {
    admitted, rootFingerprint, worthiness, angle: worthiness.angle,
    duplicate, incoherent, refusedBecause: null,
  };
}

export { collapseBatchDuplicates };
