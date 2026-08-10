/**
 * Owner-mirror audit — does every delivered owner opening leave exactly one paper
 * position on the exact contract it was alerted on?
 *
 * 231784c added the mirror. It has tests, but it had not yet been exercised by a live
 * owner opening, and the three openings delivered on 2026-08-07 (QQQ 10/16 $750C,
 * META 08/14 $600C, SPY 08/21 $777C) predate it and have no mirror at all. Those three
 * are permanently DELIVERED_OWNER_ALERT_WITHOUT_FORWARD_PAPER_EVIDENCE: nothing may
 * reconstruct their outcome after the fact, and this audit reports them as missing
 * rather than inventing anything.
 *
 * What it proves prospectively, per owner opening:
 *   the Discord delivery -> one OWNER_VALIDATION_PAPER mirror -> the same exact OCC
 *   -> a frozen entry -> marks
 *
 * Read-only. No provider call, no quota spend, no send authority.
 */

import {
  excursionForPaperTradeOnDb,
  type ExcursionEvidenceState,
} from "../../opportunity-case/excursion.ts";

export interface OwnerAuditDb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[] };
}

function hasTable(db: OwnerAuditDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function normalizeOcc(occ: unknown): string | null {
  const s = String(occ ?? "").trim().toUpperCase();
  return s.length > 0 ? s : null;
}

export type OwnerMirrorState =
  /** Exactly one mirror, on the alerted OCC, with a frozen entry. */
  | "MIRRORED_EXACT"
  /** A mirror exists but sits on a different contract than the opening named. */
  | "MIRROR_OCC_MISMATCH"
  /** More than one mirror claims this opening. */
  | "DUPLICATE_MIRROR"
  /** Mirror exists on the right OCC but carries no marks — unmeasurable so far. */
  | "MIRRORED_UNMARKED"
  /** No mirror at all. For pre-231784c openings this is permanent. */
  | "NO_FORWARD_PAPER_EVIDENCE"
  /** The opening records no contract, so nothing can be matched to it. */
  | "OPENING_OCC_UNKNOWN";

export interface OwnerOpeningAudit {
  deliveryId: string;
  sentAt: string | null;
  sentAtMs: number | null;
  opportunityCaseId: string | null;
  symbol: string | null;
  openingOptionSymbol: string | null;
  mirrorCount: number;
  mirrorTradeIds: number[];
  mirrorOptionSymbols: string[];
  mirrorEntryFill: number | null;
  mirrorStatus: string | null;
  markCount: number;
  state: OwnerMirrorState;
  /**
   * Realized outcome, and whether it is evidenced. VERIFIED requires an EXITED mirror
   * on the alerted contract carrying its own return_pct. Reported separately from the
   * excursion below, because the two need different evidence and a trade can have a
   * sound realized return with an unknowable trajectory.
   */
  realizedReturnPct: number | null;
  realizedEvidence: "VERIFIED" | "STILL_OPEN" | "UNAVAILABLE";
  /** Trajectory quality. Never inferred from the realized number. */
  excursionState: ExcursionEvidenceState;
  excursionMfePct: number | null;
  excursionMaePct: number | null;
  /** True when this opening was delivered before the mirror fix shipped. */
  predatesMirrorFix: boolean;
  note: string | null;
}

export interface OwnerMirrorAuditResult {
  sinceMs: number;
  mirrorFixAtMs: number;
  ownerOpenings: number;
  mirrored: number;
  missingMirrors: number;
  occMismatches: number;
  duplicateMirrors: number;
  unmarkedMirrors: number;
  /** Openings delivered AFTER the mirror fix — the only ones the fix can be judged on. */
  prospective: {
    openings: number;
    mirroredExact: number;
    /** 1.0 is the target. null when no owner opening has happened since the fix. */
    mirrorRate: number | null;
    /** Mirrors carrying at least one mark, and those still unmarked. */
    withMarks: number;
    withoutMarks: number;
    /** Realized evidence, counted separately from trajectory evidence. */
    realizedVerified: number;
    realizedStillOpen: number;
    realizedUnavailable: number;
    /** Trajectory evidence. A verified realized return does not imply a verified peak. */
    excursionVerified: number;
    excursionInsufficient: number;
  };
  openings: OwnerOpeningAudit[];
  note: string;
}

/** 231784c — "Give every owner opening a paper mirror on the contract it alerted". */
export const OWNER_MIRROR_FIX_AT_MS = Date.parse("2026-08-07T23:14:28Z");

export function auditOwnerMirrorsOnDb(
  db: OwnerAuditDb,
  opts: { sinceMs?: number; nowMs?: number; limit?: number } = {},
): OwnerMirrorAuditResult {
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = opts.sinceMs ?? nowMs - 30 * 86_400_000;
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
  const empty: OwnerMirrorAuditResult = {
    sinceMs,
    mirrorFixAtMs: OWNER_MIRROR_FIX_AT_MS,
    ownerOpenings: 0,
    mirrored: 0,
    missingMirrors: 0,
    occMismatches: 0,
    duplicateMirrors: 0,
    unmarkedMirrors: 0,
    prospective: {
      openings: 0, mirroredExact: 0, mirrorRate: null,
      withMarks: 0, withoutMarks: 0,
      realizedVerified: 0, realizedStillOpen: 0, realizedUnavailable: 0,
      excursionVerified: 0, excursionInsufficient: 0,
    },
    openings: [],
    note: "",
  };
  if (!hasTable(db, "discord_deliveries")) {
    return { ...empty, note: "discord_deliveries table missing" };
  }

  let rows: Record<string, any>[] = [];
  try {
    rows = db.prepare(
      `SELECT delivery_id, created_at, sent_at, opportunity_case_id, payload_json
         FROM discord_deliveries
        WHERE payload_type='owner_intraday_actionable'
          AND lifecycle_state='OPENING'
          AND status='SENT'
          AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?`,
    ).all(new Date(sinceMs).toISOString(), limit) as Record<string, any>[];
  } catch {
    return { ...empty, note: "owner delivery query failed" };
  }

  const casesReady = hasTable(db, "opportunity_cases");
  const paperReady = hasTable(db, "options_paper_trades");
  const marksReady = hasTable(db, "options_paper_marks");

  const openings: OwnerOpeningAudit[] = rows.map((r) => {
    const deliveryId = String(r.delivery_id);
    const caseId = r.opportunity_case_id == null ? null : String(r.opportunity_case_id);
    const sentAt = (r.sent_at ?? r.created_at) == null ? null : String(r.sent_at ?? r.created_at);
    const sentAtMs = sentAt ? Date.parse(sentAt) : null;

    // The contract the owner was actually shown, read from the case the delivery
    // references. Never inferred from ticker/strike text.
    let openingOcc: string | null = null;
    let symbol: string | null = null;
    if (caseId && casesReady) {
      try {
        const c = db.prepare("SELECT underlying_symbol, case_json FROM opportunity_cases WHERE opportunity_id=?")
          .get(caseId) as { underlying_symbol?: string; case_json?: string } | undefined;
        symbol = c?.underlying_symbol == null ? null : String(c.underlying_symbol);
        if (c?.case_json) {
          openingOcc = normalizeOcc(JSON.parse(c.case_json)?.selectedContract?.optionSymbol);
        }
      } catch { /* isolated */ }
    }

    // Owner mirrors carry no alert_id — owner openings never write an options_alerts
    // row — so they are matched through the case id recorded in their feature snapshot.
    let mirrors: Record<string, any>[] = [];
    if (paperReady && caseId) {
      try {
        mirrors = db.prepare(
          `SELECT id, option_symbol, entry_fill, status, return_pct
             FROM options_paper_trades
            WHERE paper_kind='OWNER_VALIDATION_PAPER'
              AND feature_snapshot_json LIKE ?
            ORDER BY id ASC`,
        ).all(`%"opportunityCaseId":"${caseId}"%`) as Record<string, any>[];
      } catch { /* isolated */ }
    }

    const mirrorOccs = mirrors.map((m) => normalizeOcc(m.option_symbol)).filter((o): o is string => o != null);
    let markCount = 0;
    if (marksReady && mirrors.length) {
      try {
        const ids = mirrors.map((m) => Number(m.id));
        markCount = Number((db.prepare(
          `SELECT COUNT(*) n FROM options_paper_marks WHERE trade_id IN (${ids.map(() => "?").join(",")})`,
        ).get(...ids) as any)?.n ?? 0);
      } catch { /* isolated */ }
    }

    const predatesMirrorFix = sentAtMs != null && sentAtMs < OWNER_MIRROR_FIX_AT_MS;
    let state: OwnerMirrorState;
    let note: string | null = null;
    if (!openingOcc) {
      state = "OPENING_OCC_UNKNOWN";
      note = "the opening records no exact contract, so no mirror can be matched to it";
    } else if (mirrors.length === 0) {
      state = "NO_FORWARD_PAPER_EVIDENCE";
      note = predatesMirrorFix
        ? "delivered before the mirror fix — permanently without forward paper evidence; nothing may be reconstructed"
        : "delivered after the mirror fix but left no mirror — the fix did not hold";
    } else if (mirrors.length > 1) {
      state = "DUPLICATE_MIRROR";
      note = `${mirrors.length} mirrors claim this opening`;
    } else if (mirrorOccs[0] !== openingOcc) {
      state = "MIRROR_OCC_MISMATCH";
      note = `mirror is on ${mirrorOccs[0]}, the opening alerted ${openingOcc}`;
    } else if (markCount === 0) {
      state = "MIRRORED_UNMARKED";
      note = "mirror exists on the alerted contract but carries no marks yet";
    } else {
      state = "MIRRORED_EXACT";
    }

    // Realized and trajectory evidence are resolved INDEPENDENTLY.
    //
    // A realized return needs one thing: an exited mirror on the alerted contract with
    // its own return_pct. An excursion needs a mark series dense enough to have seen
    // the extremes. An owner trade can be a VERIFIED +47% realized winner whose MFE is
    // simply unknown, and the diagnostic has to be able to say exactly that rather than
    // downgrading the win or inventing a peak.
    const onExactContract = mirrors.length === 1 && openingOcc != null && mirrorOccs[0] === openingOcc;
    const mirrorStatus = mirrors[0]?.status == null ? null : String(mirrors[0].status);
    const mirrorReturnPct = mirrors[0]?.return_pct == null ? null : Number(mirrors[0].return_pct);
    let realizedEvidence: OwnerOpeningAudit["realizedEvidence"] = "UNAVAILABLE";
    if (onExactContract && mirrorStatus === "EXITED" && mirrorReturnPct != null && Number.isFinite(mirrorReturnPct)) {
      realizedEvidence = "VERIFIED";
    } else if (onExactContract && mirrorStatus === "ENTERED") {
      realizedEvidence = "STILL_OPEN";
    }
    const excursion = onExactContract
      ? excursionForPaperTradeOnDb(db as any, Number(mirrors[0].id), mirrorOccs[0])
      : { state: "NO_MIRROR" as ExcursionEvidenceState, mfePct: null, maePct: null, marksOnContract: 0 };

    return {
      deliveryId,
      sentAt,
      sentAtMs,
      opportunityCaseId: caseId,
      symbol,
      openingOptionSymbol: openingOcc,
      mirrorCount: mirrors.length,
      mirrorTradeIds: mirrors.map((m) => Number(m.id)),
      mirrorOptionSymbols: mirrorOccs,
      mirrorEntryFill: mirrors[0]?.entry_fill == null ? null : Number(mirrors[0].entry_fill),
      mirrorStatus,
      markCount,
      state,
      realizedReturnPct: realizedEvidence === "VERIFIED" ? mirrorReturnPct : null,
      realizedEvidence,
      excursionState: excursion.state,
      excursionMfePct: excursion.mfePct,
      excursionMaePct: excursion.maePct,
      predatesMirrorFix,
      note,
    };
  });

  const count = (s: OwnerMirrorState) => openings.filter((o) => o.state === s).length;
  const after = openings.filter((o) => !o.predatesMirrorFix);
  const afterExact = after.filter((o) => o.state === "MIRRORED_EXACT" || o.state === "MIRRORED_UNMARKED").length;

  return {
    sinceMs,
    mirrorFixAtMs: OWNER_MIRROR_FIX_AT_MS,
    ownerOpenings: openings.length,
    mirrored: openings.filter((o) => o.mirrorCount > 0).length,
    missingMirrors: count("NO_FORWARD_PAPER_EVIDENCE"),
    occMismatches: count("MIRROR_OCC_MISMATCH"),
    duplicateMirrors: count("DUPLICATE_MIRROR"),
    unmarkedMirrors: count("MIRRORED_UNMARKED"),
    prospective: {
      openings: after.length,
      mirroredExact: afterExact,
      mirrorRate: after.length ? afterExact / after.length : null,
      withMarks: after.filter((o) => o.markCount > 0).length,
      withoutMarks: after.filter((o) => o.mirrorCount > 0 && o.markCount === 0).length,
      realizedVerified: after.filter((o) => o.realizedEvidence === "VERIFIED").length,
      realizedStillOpen: after.filter((o) => o.realizedEvidence === "STILL_OPEN").length,
      realizedUnavailable: after.filter((o) => o.realizedEvidence === "UNAVAILABLE").length,
      excursionVerified: after.filter((o) => o.excursionState === "VERIFIED_EXCURSION").length,
      excursionInsufficient: after.filter((o) => o.excursionState === "INSUFFICIENT_MARKS").length,
    },
    openings,
    note:
      "Openings delivered before the mirror fix can never gain forward evidence; they are reported "
      + "missing, never reconstructed. Only the prospective block judges the fix.",
  };
}
