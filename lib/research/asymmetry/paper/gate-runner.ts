/**
 * gate-runner.ts — the scheduled job that proves the live exact-OCC quote path
 * and, only on proof, activates automatic paper trading.
 *
 *   runPaperActivationGate()
 *     -> armActivationOnDb()          [write: create today's ARMED row]
 *     -> gatherGateEvidence()         [read: cases, marks, scheduler state]
 *     -> evaluateActivationGate()     [PURE, deterministic]
 *     -> activateOnDb | blockActivationOnDb   [atomic, guarded on ARMED]
 *     -> injected notify              [one owner-private message per state]
 *
 * NO AI. No model is imported, called, or awaited. The gate is arithmetic and
 * SQL over rows the rest of the system already wrote.
 *
 * NO PROVIDER CALLS. The gate deliberately does not fetch a quote of its own.
 * It reads the marks the mark-runner already produced, so it is judging the
 * REAL production quote path rather than a parallel one that might succeed
 * where the real one fails.
 *
 * Never throws. Every failure is a returned result.
 */
import { tradingDay } from "../../../trading-session.ts";
import { PAPER_ENABLED_ENV } from "./lane.ts";
import {
  ensureActivationSchema, armActivationOnDb, readActivationOnDb, activateOnDb,
  blockActivationOnDb, recordGateAttemptOnDb, claimNotificationOnDb,
  evaluateActivationGate, isWithinGateWindow, isPastGateWindow, etMinutesOfDay,
  GATE_OPEN_ET_MINUTE, GATE_CLOSE_ET_MINUTE,
  type GateEvidence, type ActivationState,
} from "./activation.ts";

type GateDb = Parameters<typeof readActivationOnDb>[0];

export interface GateRunResult {
  ran: boolean;
  reason: string | null;
  sessionDate: string;
  state: ActivationState | null;
  outcome: "ACTIVATE" | "INSUFFICIENT" | "DEFECT" | null;
  activated: boolean;
  blocked: boolean;
  notified: string | null;
  evidence: GateEvidence | null;
  errors: string[];
}

export interface GateDeps {
  nowMs: number;
  env?: NodeJS.ProcessEnv;
  /** Scheduler sweep health, injected so the gate stays pure over the db. */
  schedulerErrors?: string[];
  /** Owner-private sender. Injected — this module never touches the network. */
  notify?: (content: string) => Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Gather every fact the gate needs, in ONE pass over persisted rows.
 *
 * The proof query is the heart of it: a single row joining a case to a mark
 * establishes conditions 2 through 5 simultaneously — same exact OCC, same
 * session, a fresh executable ask at capture, and a LATER valid bid. Checking
 * them separately would allow a combination that never actually co-occurred.
 */
export function gatherGateEvidence(db: GateDb, sessionDate: string, schedulerErrors: string[] = []): GateEvidence {
  const evidence: GateEvidence = {
    casesCaptured: 0, markAttempts: 0, acceptedMarks: 0, rejectionCounts: {},
    proof: null, schedulerHealthy: schedulerErrors.length === 0, schedulerErrors,
    canSendSubscriber: false, automaticRealTrading: false,
  };
  const one = (sql: string, ...args: unknown[]): any => {
    try { return db.prepare(sql).get(...args); } catch { return null; }
  };
  const many = (sql: string, ...args: unknown[]): any[] => {
    try { return db.prepare(sql).all(...args) as any[]; } catch { return []; }
  };

  evidence.casesCaptured = Number(
    one("SELECT COUNT(*) n FROM asymmetry_cases WHERE session_date=?", sessionDate)?.n ?? 0,
  );
  evidence.markAttempts = Number(
    one("SELECT COUNT(*) n FROM asymmetry_marks WHERE session_date=?", sessionDate)?.n ?? 0,
  );
  evidence.acceptedMarks = Number(
    one("SELECT COUNT(*) n FROM asymmetry_marks WHERE session_date=? AND rejected_reason IS NULL AND bid > 0", sessionDate)?.n ?? 0,
  );
  for (const r of many(
    "SELECT rejected_reason reason, COUNT(*) n FROM asymmetry_marks WHERE session_date=? AND rejected_reason IS NOT NULL GROUP BY rejected_reason",
    sessionDate,
  )) {
    evidence.rejectionCounts[String(r.reason)] = Number(r.n ?? 0);
  }

  // Conditions 2-5 in one row, or nothing.
  const proof = one(`
    SELECT c.fingerprint fp, c.option_symbol occ, c.symbol sym, c.early_ask ask,
           m.bid bid, c.first_detected_at_ms det, m.marked_at_ms mk
      FROM asymmetry_cases c
      JOIN asymmetry_marks m
        ON m.session_date = c.session_date
       AND m.fingerprint  = c.fingerprint
       AND m.option_symbol = c.option_symbol   -- exact OCC identity, both sides
     WHERE c.session_date = ?
       AND m.rejected_reason IS NULL
       AND m.bid > 0                            -- a real, executable bid
       AND c.early_ask IS NOT NULL AND c.early_ask > 0   -- a fresh ask existed
       AND m.marked_at_ms > c.first_detected_at_ms       -- the bid came LATER
     ORDER BY m.marked_at_ms ASC
     LIMIT 1
  `, sessionDate);
  if (proof) {
    evidence.proof = {
      caseFingerprint: String(proof.fp), optionSymbol: String(proof.occ), symbol: String(proof.sym),
      entryAsk: Number(proof.ask), markBid: Number(proof.bid),
      detectedAtMs: Number(proof.det), markedAtMs: Number(proof.mk),
    };
  }
  return evidence;
}

/** Deterministic owner-private status message. Pure. */
export function buildGateMessage(
  kind: "PAPER_GATE_ACTIVE" | "PAPER_GATE_INSUFFICIENT_EVIDENCE" | "PAPER_GATE_BLOCKED_QUOTE_PATH",
  sessionDate: string,
  e: GateEvidence,
  reason: string,
): string {
  const lines = [`**HIGH-ASYMMETRY PAPER GATE — ${kind}**`, `Session ${sessionDate}`, ""];
  if (kind === "PAPER_GATE_ACTIVE" && e.proof) {
    lines.push(
      "Automatic paper trading is now ACTIVE for this session.",
      "",
      `Proof contract: ${e.proof.symbol} ${e.proof.optionSymbol}`,
      `Entry ask at capture: $${e.proof.entryAsk.toFixed(2)}`,
      `Later valid bid: $${e.proof.markBid.toFixed(2)}`,
      `Detected ${new Date(e.proof.detectedAtMs).toISOString()}, marked ${new Date(e.proof.markedAtMs).toISOString()}`,
    );
  } else {
    lines.push(reason);
  }
  lines.push(
    "",
    `Cases ${e.casesCaptured} · mark attempts ${e.markAttempts} · accepted ${e.acceptedMarks}`,
    Object.keys(e.rejectionCounts).length
      ? `Rejections: ${Object.entries(e.rejectionCounts).map(([k, v]) => `${k}×${v}`).join(" · ")}`
      : "Rejections: none",
    "",
    "Simulated paper research only. No subscriber alert, no real order, no AI in any trading decision.",
  );
  return lines.join("\n").slice(0, 1900);
}

/**
 * Run the gate once. Idempotent: a second tick after activation does nothing,
 * because the state transition is guarded on the row still being ARMED.
 */
export async function runPaperActivationGate(db: GateDb, deps: GateDeps): Promise<GateRunResult> {
  const env = deps.env ?? process.env;
  const sessionDate = tradingDay(deps.nowMs);
  const out: GateRunResult = {
    ran: false, reason: null, sessionDate, state: null, outcome: null,
    activated: false, blocked: false, notified: null, evidence: null, errors: [],
  };
  try {
    // Lock 1. Without the owner's master authorization the gate does no work at
    // all — no reads beyond nothing, no writes, no notification.
    if (env[PAPER_ENABLED_ENV] !== "1") {
      out.state = "DISABLED";
      out.reason = `${PAPER_ENABLED_ENV} is not set`;
      return out;
    }
    out.ran = true;
    ensureActivationSchema(db as any);
    armActivationOnDb(db as any, sessionDate, deps.nowMs);

    const existing = readActivationOnDb(db, sessionDate);
    out.state = existing?.state ?? "ARMED_WAITING_FOR_LIVE_PROOF";

    // Already settled for today. Nothing to re-decide.
    if (out.state !== "ARMED_WAITING_FOR_LIVE_PROOF") {
      out.reason = `already ${out.state} for ${sessionDate}`;
      return out;
    }

    // The window. Before 09:40 ET there is no meaningful options data to judge,
    // and an equity premarket print must never be mistaken for proof that the
    // option quote path works.
    if (!isWithinGateWindow(deps.nowMs)) {
      const past = isPastGateWindow(deps.nowMs);
      if (!past) {
        out.reason = `outside the gate window (ET minute ${etMinutesOfDay(deps.nowMs)} < ${GATE_OPEN_ET_MINUTE})`;
        return out;
      }
      // Past 11:30 ET without proof: stop retrying and say so plainly.
      const evidence = gatherGateEvidence(db, sessionDate, deps.schedulerErrors ?? []);
      out.evidence = evidence;
      out.outcome = "INSUFFICIENT";
      const reason = `gate window closed at ${GATE_CLOSE_ET_MINUTE / 60}:30 ET without an exact-OCC ask-then-bid proof`;
      out.blocked = blockActivationOnDb(db as any, {
        sessionDate, nowMs: deps.nowMs, state: "BLOCKED_INSUFFICIENT_EVIDENCE", reason, evidence,
      });
      out.state = "BLOCKED_INSUFFICIENT_EVIDENCE";
      out.notified = await maybeNotify(db, deps, sessionDate, "PAPER_GATE_INSUFFICIENT_EVIDENCE", evidence, reason, out);
      return out;
    }

    recordGateAttemptOnDb(db as any, sessionDate, deps.nowMs);
    const evidence = gatherGateEvidence(db, sessionDate, deps.schedulerErrors ?? []);
    out.evidence = evidence;
    const decision = evaluateActivationGate(evidence);
    out.outcome = decision.outcome;

    if (decision.outcome === "ACTIVATE") {
      out.activated = activateOnDb(db as any, { sessionDate, nowMs: deps.nowMs, evidence });
      out.state = out.activated ? "ACTIVE" : (readActivationOnDb(db, sessionDate)?.state ?? out.state);
      if (out.activated) {
        out.notified = await maybeNotify(db, deps, sessionDate, "PAPER_GATE_ACTIVE", evidence, decision.reason, out);
      }
      return out;
    }

    if (decision.outcome === "DEFECT") {
      out.blocked = blockActivationOnDb(db as any, {
        sessionDate, nowMs: deps.nowMs, state: "BLOCKED_QUOTE_PATH_DEFECT",
        reason: decision.reason, evidence,
      });
      out.state = "BLOCKED_QUOTE_PATH_DEFECT";
      out.notified = await maybeNotify(db, deps, sessionDate, "PAPER_GATE_BLOCKED_QUOTE_PATH", evidence, decision.reason, out);
      return out;
    }

    // INSUFFICIENT inside the window: stay ARMED and try again next tick. The
    // criteria are never relaxed as the window runs down.
    out.reason = decision.reason;
    return out;
  } catch (err: any) {
    out.errors.push(String(err?.message ?? err));
    return out;
  }
}

/** One message per state per session. A send failure never affects state. */
async function maybeNotify(
  db: GateDb,
  deps: GateDeps,
  sessionDate: string,
  kind: "PAPER_GATE_ACTIVE" | "PAPER_GATE_INSUFFICIENT_EVIDENCE" | "PAPER_GATE_BLOCKED_QUOTE_PATH",
  evidence: GateEvidence,
  reason: string,
  out: GateRunResult,
): Promise<string | null> {
  try {
    if (!deps.notify) return null;
    if (!claimNotificationOnDb(db as any, sessionDate, kind, deps.nowMs)) return null;
    const res = await deps.notify(buildGateMessage(kind, sessionDate, evidence, reason));
    if (!res.ok) {
      out.errors.push(`notify: ${res.reason ?? "send failed"}`);
      return null;
    }
    return kind;
  } catch (err: any) {
    out.errors.push(`notify: ${String(err?.message ?? err)}`);
    return null;
  }
}
