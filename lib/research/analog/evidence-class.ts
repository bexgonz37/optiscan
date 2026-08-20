/**
 * evidence-class.ts — ANALOG_EVIDENCE_CLASS_V1. The one taxonomy every analog result
 * must declare.
 *
 * ── The failure this exists to prevent ───────────────────────────────────────
 *
 * OptiScan already holds five different kinds of "what happened next", and they are
 * currently distinguished by five different vocabularies in five different modules:
 * `episode_labels.outcome_kind`, `historical_pre_move_replay.origin`, the paper lane
 * names, the shadow tables, and the exact-OCC winner events. Each one is careful on its
 * own. None of them can be compared to another, because nothing states what they are in
 * a shared language.
 *
 * That gap is where the destructive mistake lives. The analog engine's corpus is, in
 * production TODAY, 100% REAL_UNDERLYING labels — not one option outcome in 11,679 rows.
 * Its scorer returns a number called `p`, the shadow bridge relabels it `confidence`, and
 * it is queried against live OPTIONS candidates. Nothing in the type system, the return
 * shape, or the persisted row says "this probability is about the underlying, not the
 * contract". A reader who takes that number as P(the option pays) is not misreading it —
 * there is nothing there to read.
 *
 * So the class travels WITH the evidence, as a required field, and the permission to make
 * an option-return claim is a property OF THE CLASS rather than a decision at the call
 * site. A call site can forget. A type cannot.
 *
 * ── Six classes, not five ────────────────────────────────────────────────────
 *
 * The specification named five. The schema has a sixth: `outcome_kind='MODELED_OPTION'`,
 * an option return produced by repricing through Greeks rather than observed on a tape.
 * It is currently 0 rows in production, which is exactly why it must be named now — an
 * empty category silently acquires meaning the first time something writes to it, and a
 * modeled fill pooled into exact-option evidence is indistinguishable afterwards.
 *
 * MODELED_OPTION is therefore its own class, and it does NOT carry exact-option authority.
 *
 * ── Pooling is refused, not discouraged ──────────────────────────────────────
 *
 * `assertSingleEvidenceClass` throws. It is not a warning and not a flag on the result,
 * because the only way a mixed cohort becomes a number is if something reduced it, and by
 * then the classes are gone. Widening N by mixing populations is the cheapest way to clear
 * an evidence floor and the most expensive mistake to detect later.
 */

/** The canonical evidence classes. Every analog cohort and every outcome states exactly one. */
export type AnalogEvidenceClass =
  | "FORWARD_EXACT_OPTION"
  | "HISTORICAL_EXACT_OPTION"
  | "FORWARD_UNDERLYING_ONLY"
  | "HISTORICAL_UNDERLYING_ONLY"
  | "MODELED_OPTION"
  | "SHADOW_OBSERVATION"
  | "PAPER_DELIVERED_FORWARD";

export const ANALOG_EVIDENCE_CLASS_VERSION = "ANALOG_EVIDENCE_CLASS_V1";

export interface EvidenceClassSpec {
  /** Machine identity; equals the key. */
  readonly id: AnalogEvidenceClass;
  /** May a cohort of this class express P(option return >= X)? */
  readonly optionReturnClaimAllowed: boolean;
  /** May a cohort of this class express an UNDERLYING move statistic? */
  readonly underlyingReturnClaimAllowed: boolean;
  /** Was the option leg OBSERVED on a real quote/tape (vs modeled, vs absent)? */
  readonly exactOptionEvidence: boolean;
  /** Forward (recorded as it happened) vs historical reconstruction. */
  readonly temporality: "FORWARD" | "HISTORICAL";
  /** Ranked evidence quality; higher is stronger. Used only for reporting, never to pool. */
  readonly rank: number;
  readonly description: string;
  /** Where rows of this class actually live today. */
  readonly source: string;
}

const SPECS: Record<AnalogEvidenceClass, EvidenceClassSpec> = {
  FORWARD_EXACT_OPTION: {
    id: "FORWARD_EXACT_OPTION",
    optionReturnClaimAllowed: true,
    underlyingReturnClaimAllowed: true,
    exactOptionEvidence: true,
    temporality: "FORWARD",
    rank: 5,
    description:
      "A frozen live candidate whose exact OCC had contemporaneous quote evidence at T0 and an executable forward label. The strongest evidence the system can hold.",
    source: "episode_outcome_labels_v2 (FORWARD_LABEL_V1) joined to setup_episodes episode_version=2",
  },
  HISTORICAL_EXACT_OPTION: {
    id: "HISTORICAL_EXACT_OPTION",
    optionReturnClaimAllowed: true,
    underlyingReturnClaimAllowed: true,
    exactOptionEvidence: true,
    temporality: "HISTORICAL",
    rank: 4,
    description:
      "A historical reconstruction where point-in-time NBBO genuinely exists for the exact OCC, entry taken at the contemporaneous ask and later value at the bid/mid convention recorded on the event.",
    source: "historical_option_quotes via winner-events.ts / cohort-v2.ts",
  },
  PAPER_DELIVERED_FORWARD: {
    id: "PAPER_DELIVERED_FORWARD",
    optionReturnClaimAllowed: true,
    underlyingReturnClaimAllowed: false,
    exactOptionEvidence: true,
    temporality: "FORWARD",
    rank: 3,
    description:
      "The realized paper record of an actually delivered or mirrored opening, marked on its own frozen OCC. Reflects a policy, not just a tape.",
    source: "options_paper_marks / opportunity cases via cohort-probability HISTORICAL_COHORT_V1",
  },
  MODELED_OPTION: {
    id: "MODELED_OPTION",
    optionReturnClaimAllowed: false,
    underlyingReturnClaimAllowed: true,
    exactOptionEvidence: false,
    temporality: "HISTORICAL",
    rank: 2,
    description:
      "An option return DERIVED by repricing an underlying move through Greeks. No contract was quoted at these prices. It may describe a hypothesis; it may never stand in for an executable option outcome.",
    source: "episode_labels.outcome_kind='MODELED_OPTION' (0 rows in production as of 2026-08-20)",
  },
  FORWARD_UNDERLYING_ONLY: {
    id: "FORWARD_UNDERLYING_ONLY",
    optionReturnClaimAllowed: false,
    underlyingReturnClaimAllowed: true,
    exactOptionEvidence: false,
    temporality: "FORWARD",
    rank: 2,
    description:
      "A frozen live candidate whose UNDERLYING path was observed forward, but whose option leg had no usable exact-OCC evidence. Real, forward, and underlying-only — it is not a reconstruction, and it is not an option outcome.",
    source: "episode_outcome_labels_v2 label_kind='UNDERLYING_LABEL'",
  },
  HISTORICAL_UNDERLYING_ONLY: {
    id: "HISTORICAL_UNDERLYING_ONLY",
    optionReturnClaimAllowed: false,
    underlyingReturnClaimAllowed: true,
    exactOptionEvidence: false,
    temporality: "HISTORICAL",
    rank: 1,
    description:
      "Historical replay where the setup and the underlying path reconstruct cleanly but no option evidence exists. Supports underlying/setup statistics ONLY.",
    source: "episode_labels.outcome_kind='REAL_UNDERLYING' joined to setup_episodes (the entire analog corpus today)",
  },
  SHADOW_OBSERVATION: {
    id: "SHADOW_OBSERVATION",
    optionReturnClaimAllowed: false,
    underlyingReturnClaimAllowed: false,
    exactOptionEvidence: false,
    temporality: "FORWARD",
    rank: 0,
    description:
      "A non-alert research observation. Useful for selection-bias analysis and hypothesis generation. Never a delivered trade and never an outcome claim.",
    source: "analog_shadow / discovery_shadow / options_shadow_decisions",
  },
};

export const ALL_EVIDENCE_CLASSES: readonly AnalogEvidenceClass[] = Object.freeze(
  (Object.keys(SPECS) as AnalogEvidenceClass[]).slice().sort(),
);

export function evidenceClassSpec(cls: AnalogEvidenceClass): EvidenceClassSpec {
  const spec = SPECS[cls];
  if (!spec) throw new Error(`unknown analog evidence class: ${String(cls)}`);
  return spec;
}

export function isAnalogEvidenceClass(v: unknown): v is AnalogEvidenceClass {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(SPECS, v);
}

/**
 * May this class produce an OPTION-return probability?
 *
 * This is the guard behind requirement "underlying-only evidence never produces an
 * option-return probability". It is deliberately a total function over the class rather
 * than a check on the data, so a caller cannot satisfy it by describing its rows well.
 */
export function optionReturnProbabilityAllowed(cls: AnalogEvidenceClass): boolean {
  return evidenceClassSpec(cls).optionReturnClaimAllowed;
}

export function underlyingReturnClaimAllowed(cls: AnalogEvidenceClass): boolean {
  return evidenceClassSpec(cls).underlyingReturnClaimAllowed;
}

/** Thrown when populations of different evidence classes would be reduced into one number. */
export class EvidencePoolingError extends Error {
  readonly classes: AnalogEvidenceClass[];
  constructor(classes: AnalogEvidenceClass[]) {
    super(
      `refusing to pool ${classes.length} evidence classes into one statistic: ${classes.join(", ")}. ` +
        "These populations have different entry conventions, different denominators and different meanings. " +
        "Compute them separately and report them side by side.",
    );
    this.name = "EvidencePoolingError";
    this.classes = classes;
  }
}

/**
 * Assert that every member carries the SAME evidence class, and return it.
 * Throws `EvidencePoolingError` on a mixed population and a plain Error on an empty or
 * unclassified one — an unclassified row is not a neutral row, it is an unknown one.
 */
export function assertSingleEvidenceClass(
  members: readonly { evidenceClass: AnalogEvidenceClass }[],
): AnalogEvidenceClass {
  if (members.length === 0) throw new Error("cannot determine an evidence class from an empty population");
  const seen = new Set<AnalogEvidenceClass>();
  for (const m of members) {
    if (!isAnalogEvidenceClass(m.evidenceClass)) {
      throw new Error(`population contains a row with no valid evidence class (${String(m.evidenceClass)})`);
    }
    seen.add(m.evidenceClass);
  }
  if (seen.size > 1) throw new EvidencePoolingError([...seen].sort());
  return [...seen][0];
}

/** Composition of a population by class, for reporting. Never used to merge. */
export function evidenceClassComposition(
  members: readonly { evidenceClass: AnalogEvidenceClass }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of members) {
    const k = isAnalogEvidenceClass(m.evidenceClass) ? m.evidenceClass : "UNCLASSIFIED";
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
