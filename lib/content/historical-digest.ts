/**
 * historical-digest.ts — the CONSUMER for content drafts that were held back
 * from individual Discord delivery.
 *
 * ## The defect this exists to fix
 *
 * `a29688b` stopped the flood by rerouting old content events out of individual
 * delivery: `classifyDeliveryLane` returns HISTORICAL_DIGEST / ARCHIVE_ONLY and
 * `deliverDrafts` writes `HELD_FOR_HISTORICAL_DIGEST` or `ARCHIVED_IN_APP_ONLY`.
 *
 * That half is real and verified — production at `9c29c31` reports
 * `eventsAwaitingRecovery: 0` and `SENT` flat at 1083. But the reason code was
 * named for a digest that **did not exist**. 30 drafts sit under
 * `HELD_FOR_HISTORICAL_DIGEST` with nothing reading them, so the content is not
 * merely un-flooded, it is unreachable: held is not the same as consumed, and a
 * terminal status pointing at an absent consumer is a silent queue loss.
 *
 * ## What this module does
 *
 * It reads those held rows and collapses them to ONE owner-facing summary per
 * canonical outcome. The collapse is the whole point — the same three multipliers
 * that produced nine Discord messages for one closure are still present in the
 * held rows themselves:
 *
 *   EXIT_HIT + OPPORTUNITY_CLOSED  → two CLOSED_* events per closure
 *   OPPORTUNITY_REPORT_CARD_READY  → a third, as WHY_THIS_FAILED
 *   three template variants         → times three
 *
 * Grouping on `outcomeFingerprint` (case + exact contract + close event + result
 * + content version) means replaying the backlog through the digest cannot
 * reproduce the flood, because the multipliers collapse BEFORE anything is
 * rendered rather than being rate-limited afterwards.
 *
 * ## What it must never do
 *
 *   - delete or rewrite a historical row (drafts are only ever re-*reasoned*)
 *   - re-send an outcome that already reached Discord individually
 *   - present frozen evidence as a current entry or a current quote
 *   - post to public social media (this stays owner-only, same as the drafts)
 *   - outrank live content (enforced by the caller, see content-digest-runtime)
 *
 * Causes are NOT re-derived loosely here: the digest reuses `deriveFailureCause`
 * so a summary can only repeat what the evidence already established, and counts
 * "insufficient evidence" honestly rather than dropping those outcomes.
 */

import { deriveFailureCause, type FailureCauseCode } from "./failure-cause.ts";
import { outcomeFingerprint, isOutcomeReportCategory } from "./outcome-delivery-lane.ts";

/** Required label. Owner-facing digest output must carry it verbatim. */
export const HISTORICAL_DIGEST_LABEL = "HISTORICAL LEARNING DIGEST — NON-ACTIONABLE";

/** Required explanation. Owner-facing digest output must carry it verbatim. */
export const HISTORICAL_DIGEST_EXPLANATION =
  "These outcomes use frozen historical evidence. They are not current entries or current option quotes.";

/** Why a held outcome did not make it into THIS digest. Never "no data". */
export type DigestExclusionReason =
  /** A report card for this canonical outcome already reached Discord. */
  | "ALREADY_DELIVERED_INDIVIDUALLY"
  /** A previous digest already covered this canonical outcome. */
  | "ALREADY_IN_PRIOR_DIGEST"
  /** Beyond the bounded digest size. Carried forward, not dropped. */
  | "EXCEEDS_DIGEST_SIZE_CAP"
  /** Held under ARCHIVED_IN_APP_ONLY — older than the digest window. */
  | "ARCHIVE_ONLY_WINDOW";

export type OutcomeResult = "WINNER" | "LOSER" | "UNRESOLVED";

/** How much of the outcome's evidence was actually recorded. */
export type EvidenceQuality = "COMPLETE" | "PARTIAL" | "MINIMAL";

/**
 * One held draft row, already joined to its content event.
 *
 * Deliberately a plain shape rather than a DB row type: the grouping and
 * rendering logic is the part that must be provable in tests, and it should not
 * need a database to exercise.
 */
export interface HeldDraftRow {
  draftId: string;
  contentEventId: string;
  opportunityCaseId: string | null;
  category: string;
  templateFamily: string | null;
  templateVersion: string | null;
  draftText: string;
  deliveryReason: string | null;
  resultType: string | null;
  symbol: string | null;
  direction: string | null;
  optionType: string | null;
  strike: number | null;
  expiration: string | null;
  /** Exact OCC from `options_alerts.option_symbol`, when the case resolves one. */
  occ: string | null;
  frozenEntry: number | null;
  currentMark: number | null;
  returnPercent: number | null;
  maxReturnPercent: number | null;
  eventOccurredAtMs: number | null;
  draftCreatedAtMs: number | null;
}

/** One canonical outcome, after every duplicate variant has collapsed onto it. */
export interface DigestOutcome {
  /** `outcomeFingerprint` — the canonical outcome ID used everywhere downstream. */
  outcomeId: string;
  opportunityCaseId: string | null;
  symbol: string | null;
  occ: string | null;
  contractLabel: string | null;
  resultType: string | null;
  result: OutcomeResult;
  returnPercent: number | null;
  maxReturnPercent: number | null;
  evidenceQuality: EvidenceQuality;
  /** The one draft chosen to represent this outcome to the owner. */
  representativeDraftId: string;
  representativeText: string;
  /** Every draft that collapsed onto this outcome, representative included. */
  draftIds: string[];
  /** Every content event that described this same closure. */
  contentEventIds: string[];
  /** draftIds.length - 1: the messages this collapse prevents. */
  collapsedVariantCount: number;
  causeCode: FailureCauseCode;
  causeStatement: string;
  causeProvable: boolean;
  earliestEventMs: number | null;
  latestEventMs: number | null;
  contentVersion: string;
}

export interface DigestOutcomeExclusion {
  outcomeId: string;
  reason: DigestExclusionReason;
  explanation: string;
  draftIds: string[];
}

export interface HistoricalDigest {
  digestId: string;
  generatedAtMs: number;
  trigger: "SCHEDULED" | "MANUAL";
  /** Frozen so a later template change cannot silently re-date old output. */
  evidenceVersion: string;
  coveredFromMs: number | null;
  coveredToMs: number | null;
  included: DigestOutcome[];
  excluded: DigestOutcomeExclusion[];
  stats: {
    heldDraftRows: number;
    uniqueOutcomes: number;
    includedOutcomes: number;
    excludedOutcomes: number;
    duplicateVariantsCollapsed: number;
    verifiedWinners: number;
    verifiedLosers: number;
    unresolvedOutcomes: number;
    verifiedRootCauses: number;
    insufficientEvidenceRootCauses: number;
    repeatedFailureCauses: Record<string, number>;
    evidenceQuality: Record<EvidenceQuality, number>;
    /** Individual Discord messages this digest replaces (one per held draft). */
    messagesPrevented: number;
  };
  /** True when the size cap left outcomes for a later digest. */
  hasMore: boolean;
  remainingOutcomes: number;
}

function num(x: unknown): number | null {
  if (x == null || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function str(x: unknown): string | null {
  return typeof x === "string" && x.trim() ? x.trim() : null;
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Bounded digest size. A digest that grows with the backlog is the flood again
 * in one message, so the cap is a real limit and the overflow is carried, never
 * discarded.
 */
export function digestSizeCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CONTENT_DIGEST_MAX_OUTCOMES);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50) : 12;
}

/**
 * Contract identity for display, composed from the fields the event persisted.
 *
 * The exact OCC is preferred when the case resolves one. Otherwise the parts are
 * shown as parts — never reassembled into an OCC-looking string, because a
 * synthesised OCC that has not been verified against `options_alerts` would be a
 * claim about contract identity the digest cannot support.
 */
export function contractLabelFor(row: {
  occ?: string | null;
  symbol?: string | null;
  optionType?: string | null;
  strike?: number | null;
  expiration?: string | null;
}): string | null {
  const occ = str(row.occ);
  if (occ) return occ;
  const sym = str(row.symbol);
  const type = str(row.optionType);
  const strike = num(row.strike);
  const exp = str(row.expiration);
  if (!sym) return null;
  const parts = [sym];
  if (exp) parts.push(exp);
  if (strike != null) parts.push(`$${strike}`);
  if (type) parts.push(type.toUpperCase());
  return parts.length > 1 ? parts.join(" ") : null;
}

function resultOf(resultType: string | null, returnPercent: number | null): OutcomeResult {
  const rt = str(resultType)?.toUpperCase() ?? "";
  if (rt.includes("WIN")) return "WINNER";
  if (rt.includes("LOS")) return "LOSER";
  // Absence of a result type is not a loss. Fall back to arithmetic only when a
  // return was actually recorded; an unrecorded return stays UNRESOLVED rather
  // than being coerced to 0 and read as a break-even loser.
  const r = num(returnPercent);
  if (r == null) return "UNRESOLVED";
  if (r > 0) return "WINNER";
  if (r < 0) return "LOSER";
  return "UNRESOLVED";
}

function evidenceQualityOf(row: HeldDraftRow): EvidenceQuality {
  const present = [row.frozenEntry, row.currentMark, row.returnPercent, row.maxReturnPercent]
    .filter((v) => num(v) != null).length;
  if (present >= 4) return "COMPLETE";
  if (present >= 2) return "PARTIAL";
  return "MINIMAL";
}

/**
 * Which of several drafts describing one closure the owner should read.
 *
 * Preference order, most to least informative:
 *   1. an outcome-report category (CLOSED_ or WHY_THIS_) over anything else
 *   2. the earliest-created draft within that category — template family `_0`,
 *      the recommended phrasing, exactly as individual delivery chose it
 *
 * The alternates are not discarded; they stay on the outcome's `draftIds` and
 * remain queryable in the app, which is what "alternate variants remain
 * accessible" means.
 */
function pickRepresentative(rows: HeldDraftRow[]): HeldDraftRow {
  const ranked = [...rows].sort((a, b) => {
    const ao = isOutcomeReportCategory(a.category) ? 0 : 1;
    const bo = isOutcomeReportCategory(b.category) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const at = a.draftCreatedAtMs ?? Number.MAX_SAFE_INTEGER;
    const bt = b.draftCreatedAtMs ?? Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    return a.draftId < b.draftId ? -1 : 1;
  });
  return ranked[0];
}

/**
 * Collapse held draft rows into canonical outcomes.
 *
 * The grouping key is `outcomeFingerprint`, so one closure appears once no
 * matter how many events described it or how many phrasings each event produced.
 */
export function groupHeldDraftsIntoOutcomes(rows: HeldDraftRow[]): DigestOutcome[] {
  const byOutcome = new Map<string, HeldDraftRow[]>();
  for (const row of rows) {
    const contentVersion = str(row.templateVersion) ?? "v1";
    const id = outcomeFingerprint({
      canonicalOutcomeId: str(row.opportunityCaseId),
      opportunityId: str(row.opportunityCaseId),
      occ: str(row.occ) ?? contractLabelFor(row),
      // The close EVENT id is deliberately omitted: EXIT_HIT and
      // OPPORTUNITY_CLOSED are two event ids for ONE closure, so keying on it
      // would preserve exactly the duplication this collapse exists to remove.
      lifecycleCloseEventId: null,
      resultType: str(row.resultType),
      contentVersion,
    });
    const list = byOutcome.get(id);
    if (list) list.push(row);
    else byOutcome.set(id, [row]);
  }

  const out: DigestOutcome[] = [];
  for (const [outcomeId, group] of byOutcome) {
    const rep = pickRepresentative(group);
    const times = group.map((r) => r.eventOccurredAtMs).filter((t): t is number => num(t) != null);
    const cause = deriveFailureCause({
      returnPercent: rep.returnPercent,
      maxReturnPercent: rep.maxReturnPercent,
      frozenEntry: rep.frozenEntry,
      currentMark: rep.currentMark,
      optionType: rep.optionType,
      direction: rep.direction,
    });
    out.push({
      outcomeId,
      opportunityCaseId: str(rep.opportunityCaseId),
      symbol: str(rep.symbol),
      occ: str(rep.occ),
      contractLabel: contractLabelFor(rep),
      resultType: str(rep.resultType),
      result: resultOf(rep.resultType, rep.returnPercent),
      returnPercent: num(rep.returnPercent),
      maxReturnPercent: num(rep.maxReturnPercent),
      evidenceQuality: evidenceQualityOf(rep),
      representativeDraftId: rep.draftId,
      representativeText: rep.draftText,
      draftIds: group.map((r) => r.draftId),
      contentEventIds: [...new Set(group.map((r) => r.contentEventId))],
      collapsedVariantCount: Math.max(0, group.length - 1),
      causeCode: cause.code,
      causeStatement: cause.statement,
      causeProvable: cause.provable,
      earliestEventMs: times.length ? Math.min(...times) : null,
      latestEventMs: times.length ? Math.max(...times) : null,
      contentVersion: str(rep.templateVersion) ?? "v1",
    });
  }

  // Newest closure first: the owner reads the most recent learning at the top.
  // An outcome with no usable timestamp sorts last rather than being treated as
  // either newest or dropped.
  out.sort((a, b) => (b.latestEventMs ?? -1) - (a.latestEventMs ?? -1));
  return out;
}

const EXCLUSION_EXPLANATION: Record<DigestExclusionReason, string> = {
  ALREADY_DELIVERED_INDIVIDUALLY:
    "A report card for this outcome already reached Discord. Not repeated in the digest.",
  ALREADY_IN_PRIOR_DIGEST: "An earlier historical learning digest already covered this outcome.",
  EXCEEDS_DIGEST_SIZE_CAP:
    "Beyond this digest's size limit. Held for the next digest — not dropped and not deleted.",
  ARCHIVE_ONLY_WINDOW:
    "Older than the digest window. Kept in the app archive and searchable, never sent to Discord.",
};

export interface BuildDigestInput {
  rows: HeldDraftRow[];
  nowMs: number;
  trigger?: "SCHEDULED" | "MANUAL";
  /** Canonical outcome IDs already delivered individually or in a prior digest. */
  alreadyDeliveredOutcomeIds?: Iterable<string>;
  priorDigestOutcomeIds?: Iterable<string>;
  /** Opportunity case IDs with a SENT report card, for outcomes lacking an ID match. */
  casesWithDeliveredReportCard?: Iterable<string>;
  env?: NodeJS.ProcessEnv;
  evidenceVersion?: string;
}

/**
 * Build one bounded digest from held draft rows.
 *
 * Pure: no database, no clock, no Discord. Everything it decides is derivable
 * from its inputs, which is what makes "one outcome appears once" testable
 * rather than merely asserted.
 */
export function buildHistoricalDigest(input: BuildDigestInput): HistoricalDigest {
  const env = input.env ?? process.env;
  const cap = digestSizeCap(env);
  const outcomes = groupHeldDraftsIntoOutcomes(input.rows);
  const deliveredIds = new Set(input.alreadyDeliveredOutcomeIds ?? []);
  const priorIds = new Set(input.priorDigestOutcomeIds ?? []);
  const deliveredCases = new Set(input.casesWithDeliveredReportCard ?? []);

  const included: DigestOutcome[] = [];
  const excluded: DigestOutcomeExclusion[] = [];

  for (const o of outcomes) {
    const exclude = (reason: DigestExclusionReason) => {
      excluded.push({
        outcomeId: o.outcomeId,
        reason,
        explanation: EXCLUSION_EXPLANATION[reason],
        draftIds: o.draftIds,
      });
    };
    // ARCHIVE_ONLY rows are held under a different reason code and are surfaced
    // in the app archive, not the digest. They are reported as excluded so the
    // count is visible rather than silently absent.
    if (o.draftIds.length && input.rows.some(
      (r) => o.draftIds.includes(r.draftId) && r.deliveryReason === "ARCHIVED_IN_APP_ONLY",
    )) {
      exclude("ARCHIVE_ONLY_WINDOW");
      continue;
    }
    if (deliveredIds.has(o.outcomeId)) { exclude("ALREADY_DELIVERED_INDIVIDUALLY"); continue; }
    if (o.opportunityCaseId && deliveredCases.has(o.opportunityCaseId)) {
      exclude("ALREADY_DELIVERED_INDIVIDUALLY");
      continue;
    }
    if (priorIds.has(o.outcomeId)) { exclude("ALREADY_IN_PRIOR_DIGEST"); continue; }
    if (included.length >= cap) { exclude("EXCEEDS_DIGEST_SIZE_CAP"); continue; }
    included.push(o);
  }

  const repeated: Record<string, number> = {};
  const quality: Record<EvidenceQuality, number> = { COMPLETE: 0, PARTIAL: 0, MINIMAL: 0 };
  let winners = 0, losers = 0, unresolved = 0, verifiedCauses = 0, insufficientCauses = 0;
  let collapsed = 0, messagesPrevented = 0;

  for (const o of included) {
    if (o.result === "WINNER") winners += 1;
    else if (o.result === "LOSER") losers += 1;
    else unresolved += 1;
    if (o.causeProvable) verifiedCauses += 1; else insufficientCauses += 1;
    if (o.result === "LOSER") repeated[o.causeCode] = (repeated[o.causeCode] ?? 0) + 1;
    quality[o.evidenceQuality] += 1;
    collapsed += o.collapsedVariantCount;
    // Every held draft would have been its own Discord message before the lane
    // fix. The digest replaces all of them with one.
    messagesPrevented += o.draftIds.length;
  }

  const times = included
    .flatMap((o) => [o.earliestEventMs, o.latestEventMs])
    .filter((t): t is number => t != null);

  const overflow = excluded.filter((e) => e.reason === "EXCEEDS_DIGEST_SIZE_CAP").length;
  // Derived from the CONTENT, not the clock. The scheduled path runs every three
  // minutes; a clock-seeded id made every run a new digest row, so an undelivered
  // digest would accumulate hundreds of near-identical records. Same outcomes →
  // same id → the persist is an idempotent upsert of one pending digest.
  const evidenceVersion = input.evidenceVersion ?? "v1";
  const digestId = `dig_${djb2(`${evidenceVersion}|${[...included].map((o) => o.outcomeId).sort().join(",")}`)}`;

  return {
    digestId,
    generatedAtMs: input.nowMs,
    trigger: input.trigger ?? "SCHEDULED",
    evidenceVersion,
    coveredFromMs: times.length ? Math.min(...times) : null,
    coveredToMs: times.length ? Math.max(...times) : null,
    included,
    excluded,
    stats: {
      heldDraftRows: input.rows.length,
      uniqueOutcomes: outcomes.length,
      includedOutcomes: included.length,
      excludedOutcomes: excluded.length,
      duplicateVariantsCollapsed: collapsed,
      verifiedWinners: winners,
      verifiedLosers: losers,
      unresolvedOutcomes: unresolved,
      verifiedRootCauses: verifiedCauses,
      insufficientEvidenceRootCauses: insufficientCauses,
      repeatedFailureCauses: repeated,
      evidenceQuality: quality,
      messagesPrevented: Math.max(0, messagesPrevented - (included.length ? 1 : 0)),
    },
    hasMore: overflow > 0,
    remainingOutcomes: overflow,
  };
}

function fmtDate(ms: number | null): string {
  if (ms == null) return "unknown";
  try { return new Date(ms).toISOString().slice(0, 10); } catch { return "unknown"; }
}

function fmtPct(x: number | null): string {
  if (x == null) return "unrecorded";
  return `${x > 0 ? "+" : ""}${x.toFixed(1)}%`;
}

/**
 * Render one digest as a single bounded Discord message.
 *
 * The label and the frozen-evidence explanation are not optional decoration —
 * they are the difference between a learning summary and a message that reads as
 * a live call. They lead the message, before any number.
 *
 * Causal language is gated on `causeProvable`: an unproven cause prints the
 * module's insufficient-evidence sentence rather than a plausible story.
 */
export function renderHistoricalDigest(
  digest: HistoricalDigest,
  opts: { appUrl?: string | null; maxChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? 1900;
  const s = digest.stats;
  const head = [
    `**${HISTORICAL_DIGEST_LABEL}**`,
    `_${HISTORICAL_DIGEST_EXPLANATION}_`,
    `Covering ${fmtDate(digest.coveredFromMs)} → ${fmtDate(digest.coveredToMs)} · ${s.includedOutcomes} outcome${s.includedOutcomes === 1 ? "" : "s"} · digest \`${digest.digestId}\``,
    `Verified winners ${s.verifiedWinners} · verified losers ${s.verifiedLosers} · unresolved ${s.unresolvedOutcomes}`,
    `Root causes: ${s.verifiedRootCauses} evidence-backed · ${s.insufficientEvidenceRootCauses} insufficient evidence`,
    `Evidence quality: ${s.evidenceQuality.COMPLETE} complete · ${s.evidenceQuality.PARTIAL} partial · ${s.evidenceQuality.MINIMAL} minimal`,
    s.duplicateVariantsCollapsed > 0
      ? `${s.duplicateVariantsCollapsed} duplicate draft variant${s.duplicateVariantsCollapsed === 1 ? "" : "s"} collapsed into these outcomes.`
      : null,
  ].filter(Boolean).join("\n");

  const lines: string[] = [];
  for (const o of digest.included) {
    const contract = o.contractLabel ?? o.symbol ?? "contract unrecorded";
    const cause = o.causeProvable ? o.causeStatement : "No verified root cause has been established.";
    lines.push(
      `• **${contract}** — ${o.result} · closed ${fmtPct(o.returnPercent)} · best mark ${fmtPct(o.maxReturnPercent)}\n  ${cause}`,
    );
  }

  const repeatedEntries = Object.entries(s.repeatedFailureCauses)
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1]);
  const tail = [
    repeatedEntries.length
      ? `Repeated failure causes: ${repeatedEntries.map(([c, n]) => `${c} ×${n}`).join(" · ")}`
      : null,
    digest.hasMore
      ? `${digest.remainingOutcomes} further outcome${digest.remainingOutcomes === 1 ? "" : "s"} are held for the next digest.`
      : null,
    opts.appUrl ? `Full records: ${opts.appUrl}` : "Full records are in the app under Content → Historical digests.",
  ].filter(Boolean).join("\n");

  // Truncate the OUTCOME LIST, never the label or the frozen-evidence
  // explanation. A digest that dropped its own non-actionable warning to fit a
  // character budget would be worse than one that lists fewer outcomes.
  let body = "";
  let shown = 0;
  for (const line of lines) {
    const candidate = body ? `${body}\n${line}` : line;
    if (head.length + candidate.length + tail.length + 8 > maxChars) break;
    body = candidate;
    shown += 1;
  }
  const omitted = lines.length - shown;
  const omittedNote = omitted > 0 ? `\n_+${omitted} more in the app._` : "";
  return [head, "", body + omittedNote, "", tail].join("\n").slice(0, maxChars);
}
