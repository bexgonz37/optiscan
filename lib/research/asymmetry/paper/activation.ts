/**
 * activation.ts — the persisted runtime activation gate for the paper lane.
 *
 * WHY THIS EXISTS. `HIGH_ASYMMETRY_PAPER_ENABLED` is a Railway variable, so the
 * application cannot turn it on by itself. That made activation depend on a
 * human being awake at the right moment. This module replaces that step with a
 * gate the scheduler can satisfy on its own — WITHOUT weakening the standard.
 *
 * TWO INDEPENDENT LOCKS. A paper entry requires BOTH:
 *   1. HIGH_ASYMMETRY_PAPER_ENABLED=1   — the owner's master authorization
 *   2. persisted activation state ACTIVE — the machine's own live proof
 *
 * The variable alone must never open a position. That is the whole point: the
 * owner authorizes the system to TRY, and the system must then prove the live
 * exact-OCC quote path actually works before it is allowed to act. A test
 * asserts the environment flag by itself is not sufficient.
 *
 * ACTIVATION IS PER TRADING DAY. A quote path that worked yesterday says
 * nothing about today, so each session re-arms and must re-prove itself.
 *
 * PURE + store. No AI, no network, no provider calls. Every classification is a
 * readable rule over persisted rows.
 */

export const ACTIVATION_STATES = [
  "DISABLED",
  "ARMED_WAITING_FOR_LIVE_PROOF",
  "ACTIVE",
  "BLOCKED_INSUFFICIENT_EVIDENCE",
  "BLOCKED_QUOTE_PATH_DEFECT",
] as const;
export type ActivationState = (typeof ACTIVATION_STATES)[number];

/** The gate may only run inside this ET window. */
export const GATE_OPEN_ET_MINUTE = 9 * 60 + 40;   // 09:40 ET
export const GATE_CLOSE_ET_MINUTE = 11 * 60 + 30; // 11:30 ET

/**
 * Minimum mark attempts before "everything is failing" can be called a DEFECT
 * rather than thin data. Below this it is insufficient evidence, because
 * declaring a defect on two failed marks would be a guess.
 */
export const MIN_ATTEMPTS_FOR_DEFECT = 6;
/** Share of rejections that must be one reason before it is called systemic. */
export const DEFECT_DOMINANCE = 0.8;

type ActivationDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
  exec: (sql: string) => unknown;
};

/** Idempotent, additive schema. Safe to call on every access. */
export function ensureActivationSchema(db: ActivationDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS asymmetry_paper_activation (
      session_date TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      activated_at_ms INTEGER,
      gate_attempts INTEGER NOT NULL DEFAULT 0,
      block_reason TEXT,
      evidence_json TEXT,
      first_accepted_ask REAL,
      first_accepted_bid REAL,
      case_fingerprint TEXT,
      option_symbol TEXT,
      notified_state TEXT,
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function hasTable(db: ActivationDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

/** Minutes since ET midnight. Explicit time zone — never the process TZ. */
export function etMinutesOfDay(nowMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(nowMs));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? NaN);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
}

export function isWithinGateWindow(nowMs: number): boolean {
  const minute = etMinutesOfDay(nowMs);
  return Number.isFinite(minute) && minute >= GATE_OPEN_ET_MINUTE && minute <= GATE_CLOSE_ET_MINUTE;
}

export function isPastGateWindow(nowMs: number): boolean {
  const minute = etMinutesOfDay(nowMs);
  return Number.isFinite(minute) && minute > GATE_CLOSE_ET_MINUTE;
}

// ── Evidence ────────────────────────────────────────────────────────────────

export interface GateEvidence {
  casesCaptured: number;
  markAttempts: number;
  acceptedMarks: number;
  rejectionCounts: Record<string, number>;
  /** The first case that satisfied ask-then-later-bid on the exact same OCC. */
  proof: {
    caseFingerprint: string;
    optionSymbol: string;
    symbol: string;
    entryAsk: number;
    markBid: number;
    detectedAtMs: number;
    markedAtMs: number;
  } | null;
  schedulerHealthy: boolean;
  schedulerErrors: string[];
  canSendSubscriber: false;
  automaticRealTrading: false;
}

export interface GateDecision {
  outcome: "ACTIVATE" | "INSUFFICIENT" | "DEFECT";
  reason: string;
  failed: string[];
}

/**
 * The whole gate, as one pure function over gathered evidence.
 *
 * Conditions are checked in an order that reports the most fundamental problem
 * first: no cases at all is a different situation from cases whose quotes never
 * resolve, and conflating them would send someone looking in the wrong place.
 */
export function evaluateActivationGate(e: GateEvidence): GateDecision {
  const failed: string[] = [];

  // 9 + 10 first. These are structural invariants; if either were ever true the
  // correct action is to refuse everything, not to weigh it against quote data.
  if (e.canSendSubscriber !== false) {
    return { outcome: "DEFECT", reason: "canSendSubscriber is not false", failed: ["subscriber_isolation"] };
  }
  if (e.automaticRealTrading !== false) {
    return { outcome: "DEFECT", reason: "automaticRealTrading is not false", failed: ["real_trading_isolation"] };
  }

  // 1. Something must have been captured.
  if (e.casesCaptured < 1) {
    return {
      outcome: "INSUFFICIENT",
      reason: "no asymmetry case has been captured from the live options loop yet",
      failed: ["no_cases"],
    };
  }

  // 8. A sweep that is erroring cannot be used as proof of anything.
  if (!e.schedulerHealthy) {
    return {
      outcome: "INSUFFICIENT",
      reason: `scheduler reported errors: ${e.schedulerErrors.slice(0, 3).join("; ")}`,
      failed: ["scheduler_errors"],
    };
  }

  // 2-5. One case must show a fresh ask at capture AND a later valid bid on the
  // SAME exact OCC in the SAME session. That single fact proves the whole path.
  if (e.proof) {
    return { outcome: "ACTIVATE", reason: "exact-OCC ask-then-bid proof obtained from live data", failed: [] };
  }
  failed.push("no_ask_then_bid_proof");

  // 6 + 7. Nothing proved the path. Is it thin data, or is it broken?
  const total = Object.values(e.rejectionCounts).reduce((a, b) => a + b, 0);
  if (e.markAttempts >= MIN_ATTEMPTS_FOR_DEFECT && e.acceptedMarks === 0 && total > 0) {
    const [topReason, topCount] = Object.entries(e.rejectionCounts)
      .sort((a, b) => b[1] - a[1])[0] ?? ["UNKNOWN", 0];
    const share = topCount / total;
    if (share >= DEFECT_DOMINANCE) {
      // A provider outage is NOT our defect. It blocks activation, but calling
      // it a code defect would send someone to change code that is correct.
      if (topReason === "PROVIDER_ERROR") {
        return {
          outcome: "INSUFFICIENT",
          reason: `provider is failing (${topCount}/${total} PROVIDER_ERROR) — an outage, not a quote-path defect`,
          failed: [...failed, "provider_outage"],
        };
      }
      return {
        outcome: "DEFECT",
        reason: `${topCount}/${total} marks rejected as ${topReason} across ${e.markAttempts} attempts with zero accepted — the exact-OCC quote path is not resolving`,
        failed: [...failed, `dominant_${topReason.toLowerCase()}`],
      };
    }
  }

  return {
    outcome: "INSUFFICIENT",
    reason: e.markAttempts === 0
      ? "cases exist but no forward mark has been attempted yet"
      : `${e.acceptedMarks} accepted of ${e.markAttempts} mark attempts; no ask-then-bid pair on one OCC yet`,
    failed,
  };
}

// ── Persisted state ─────────────────────────────────────────────────────────

export interface ActivationRecord {
  sessionDate: string;
  state: ActivationState;
  activatedAtMs: number | null;
  gateAttempts: number;
  blockReason: string | null;
  evidence: unknown | null;
  firstAcceptedAsk: number | null;
  firstAcceptedBid: number | null;
  caseFingerprint: string | null;
  optionSymbol: string | null;
  notifiedState: string | null;
}

/** Read the record, or null when none exists for this session. */
export function readActivationOnDb(db: ActivationDb, sessionDate: string): ActivationRecord | null {
  if (!hasTable(db, "asymmetry_paper_activation")) return null;
  try {
    const r = db.prepare("SELECT * FROM asymmetry_paper_activation WHERE session_date=?").get(sessionDate) as any;
    if (!r) return null;
    return {
      sessionDate: String(r.session_date),
      state: String(r.state) as ActivationState,
      activatedAtMs: r.activated_at_ms == null ? null : Number(r.activated_at_ms),
      gateAttempts: Number(r.gate_attempts ?? 0),
      blockReason: r.block_reason == null ? null : String(r.block_reason),
      evidence: safeJson(r.evidence_json),
      firstAcceptedAsk: r.first_accepted_ask == null ? null : Number(r.first_accepted_ask),
      firstAcceptedBid: r.first_accepted_bid == null ? null : Number(r.first_accepted_bid),
      caseFingerprint: r.case_fingerprint == null ? null : String(r.case_fingerprint),
      optionSymbol: r.option_symbol == null ? null : String(r.option_symbol),
      notifiedState: r.notified_state == null ? null : String(r.notified_state),
    };
  } catch {
    return null;
  }
}

/**
 * Arm the session. Creates the row ARMED only if none exists — it must never
 * overwrite an ACTIVE or BLOCKED state that today already reached.
 */
export function armActivationOnDb(db: ActivationDb, sessionDate: string, nowMs: number): boolean {
  try {
    ensureActivationSchema(db);
    const res = db.prepare(`
      INSERT OR IGNORE INTO asymmetry_paper_activation
        (session_date, state, gate_attempts, updated_at_ms)
      VALUES (?, 'ARMED_WAITING_FOR_LIVE_PROOF', 0, ?)
    `).run(sessionDate, nowMs);
    return Number(res.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * ATOMIC activation. The UPDATE is guarded on the row still being ARMED, so a
 * second scheduler tick — or a second process — changes nothing and reports
 * that it did not activate. This is what makes repeated ticks safe without a
 * lock.
 */
export function activateOnDb(db: ActivationDb, i: {
  sessionDate: string; nowMs: number; evidence: GateEvidence;
}): boolean {
  try {
    ensureActivationSchema(db);
    const p = i.evidence.proof;
    const res = db.prepare(`
      UPDATE asymmetry_paper_activation
         SET state='ACTIVE', activated_at_ms=?, block_reason=NULL, evidence_json=?,
             first_accepted_ask=?, first_accepted_bid=?, case_fingerprint=?, option_symbol=?,
             updated_at_ms=?
       WHERE session_date=? AND state='ARMED_WAITING_FOR_LIVE_PROOF'
    `).run(
      i.nowMs, JSON.stringify(i.evidence),
      p?.entryAsk ?? null, p?.markBid ?? null, p?.caseFingerprint ?? null, p?.optionSymbol ?? null,
      i.nowMs, i.sessionDate,
    );
    return Number(res.changes ?? 0) === 1;
  } catch {
    return false;
  }
}

/** Record a blocked outcome. Guarded on ARMED so it cannot demote an ACTIVE day. */
export function blockActivationOnDb(db: ActivationDb, i: {
  sessionDate: string; nowMs: number; state: "BLOCKED_INSUFFICIENT_EVIDENCE" | "BLOCKED_QUOTE_PATH_DEFECT";
  reason: string; evidence: GateEvidence;
}): boolean {
  try {
    ensureActivationSchema(db);
    const res = db.prepare(`
      UPDATE asymmetry_paper_activation
         SET state=?, block_reason=?, evidence_json=?, updated_at_ms=?
       WHERE session_date=? AND state='ARMED_WAITING_FOR_LIVE_PROOF'
    `).run(i.state, i.reason, JSON.stringify(i.evidence), i.nowMs, i.sessionDate);
    return Number(res.changes ?? 0) === 1;
  } catch {
    return false;
  }
}

/** Count one gate attempt. Diagnostics only; never changes state. */
export function recordGateAttemptOnDb(db: ActivationDb, sessionDate: string, nowMs: number): void {
  try {
    db.prepare(
      "UPDATE asymmetry_paper_activation SET gate_attempts=gate_attempts+1, updated_at_ms=? WHERE session_date=?",
    ).run(nowMs, sessionDate);
  } catch { /* diagnostics only */ }
}

/** Claim the one notification for a state. Returns false if already claimed. */
export function claimNotificationOnDb(db: ActivationDb, sessionDate: string, state: string, nowMs: number): boolean {
  try {
    const res = db.prepare(`
      UPDATE asymmetry_paper_activation SET notified_state=?, updated_at_ms=?
       WHERE session_date=? AND (notified_state IS NULL OR notified_state <> ?)
    `).run(state, nowMs, sessionDate, state);
    return Number(res.changes ?? 0) === 1;
  } catch {
    return false;
  }
}

// ── The effective permission ────────────────────────────────────────────────

export interface PaperPermission {
  masterPaperAuthorized: boolean;
  activationState: ActivationState;
  paperEntriesAllowed: boolean;
  reason: string | null;
}

/**
 * The single place that answers "may a paper entry happen right now".
 *
 * BOTH locks are required. The environment flag alone returns
 * paperEntriesAllowed=false with the state that explains why, which is the
 * behaviour the owner is relying on: authorizing the attempt is not the same as
 * authorizing the trade.
 */
export function resolvePaperPermission(
  db: ActivationDb,
  sessionDate: string,
  env: NodeJS.ProcessEnv = process.env,
): PaperPermission {
  const masterPaperAuthorized = env.HIGH_ASYMMETRY_PAPER_ENABLED === "1";
  if (!masterPaperAuthorized) {
    return {
      masterPaperAuthorized: false,
      activationState: "DISABLED",
      paperEntriesAllowed: false,
      reason: "HIGH_ASYMMETRY_PAPER_ENABLED is not set",
    };
  }
  const record = readActivationOnDb(db, sessionDate);
  const activationState: ActivationState = record?.state ?? "ARMED_WAITING_FOR_LIVE_PROOF";
  return {
    masterPaperAuthorized: true,
    activationState,
    paperEntriesAllowed: activationState === "ACTIVE",
    reason: activationState === "ACTIVE" ? null : `activation state is ${activationState}`,
  };
}

function safeJson(v: unknown): unknown | null {
  try { return v == null ? null : JSON.parse(String(v)); } catch { return null; }
}
