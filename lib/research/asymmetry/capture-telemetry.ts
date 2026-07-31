/**
 * capture-telemetry.ts — visibility into every ATTEMPT to reach the radar.
 *
 * WHY THIS EXISTS. The live loop calls `captureAsymmetryCandidate` and
 * deliberately discards the result — correct for isolation, but it means a
 * radar that is being called and refusing everything looks EXACTLY like one
 * that is never called at all. Production showed zero cases with a healthy
 * options monitor and 522 chains fetched, and nothing in the system could tell
 * those two situations apart.
 *
 * It distinguishes the four possibilities that matter:
 *
 *   A. NO_CONTRACT_SELECTED — the loop reached the capture point with no OCC
 *   B. CAPTURE_NEVER_CALLED — the loop never reached the capture point at all
 *   C. CALLED_AND_REJECTED  — capture ran and intake refused (with the reason)
 *   D. PERSIST_FAILED       — intake admitted it and the write failed
 *
 * DIAGNOSTICS ONLY. This module loosens no intake rule, changes no threshold,
 * and cannot alter a capture decision. It records what already happened.
 *
 * Counters are an aggregated upsert, not a row per attempt: the loop runs over
 * hundreds of candidates per cycle and a row each would be a write amplifier on
 * the scanner's hot path. Recent samples are bounded and pruned.
 *
 * Never throws. No AI. No secrets.
 */

type TelemetryDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
  exec: (sql: string) => unknown;
};

/** Every distinguishable outcome of one attempt to reach the radar. */
export const CAPTURE_STAGES = [
  "LOOP_REACHED",           // the loop got to the capture decision point
  "NO_CONTRACT_SELECTED",   // ...but res.contract was null, so no OCC existed
  "CAPTURE_CALLED",         // captureAsymmetryCandidate was actually invoked
  "CAPTURE_DISABLED",       // ...and returned immediately, flag off
  "CAPTURE_ACCEPTED",       // a case was created
  "CAPTURE_DUPLICATE",      // already captured this session
  "CAPTURE_BLOCKED",        // intake refused; see the rejection counters
  "CAPTURE_PERSIST_FAILED", // admitted but the write failed
  "CAPTURE_ERROR",          // an exception was contained
] as const;
export type CaptureStage = (typeof CAPTURE_STAGES)[number];

export const MAX_RECENT_SAMPLES = 40;

/** Idempotent, additive schema. */
export function ensureCaptureTelemetrySchema(db: TelemetryDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS asymmetry_capture_counters (
      session_date TEXT NOT NULL,
      stage TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      last_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_date, stage)
    );

    CREATE TABLE IF NOT EXISTS asymmetry_capture_rejections (
      session_date TEXT NOT NULL,
      reason TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      last_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_date, reason)
    );

    CREATE TABLE IF NOT EXISTS asymmetry_capture_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_date TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      stage TEXT NOT NULL,
      symbol TEXT,
      option_symbol TEXT,
      reason TEXT,
      blocked_by TEXT,
      labels TEXT,
      -- The RAW provider timestamp exactly as received, plus the clock it was
      -- compared against. Stored unmodified so a units question can be settled
      -- by magnitude instead of inference.
      raw_quote_at_ms INTEGER,
      compared_now_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_asym_capture_samples_session
      ON asymmetry_capture_samples(session_date, id DESC);
  `);
  // ADDITIVE COLUMN MIGRATION. The samples table already exists in production
  // from an earlier deploy, and CREATE TABLE IF NOT EXISTS will not add a
  // column to it — the wider INSERT would fail on every write and, because
  // this module swallows its own errors, record nothing while looking healthy.
  // Each ADD COLUMN is guarded by a pragma check so a repeat run is a no-op.
  addColumnIfMissing(db, "asymmetry_capture_samples", "raw_quote_at_ms", "INTEGER");
  addColumnIfMissing(db, "asymmetry_capture_samples", "compared_now_ms", "INTEGER");
}

/** Repeat-safe additive column. Never drops, never rewrites an existing column. */
function addColumnIfMissing(db: TelemetryDb, table: string, column: string, type: string): void {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (cols.some((c) => String(c.name) === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch { /* telemetry only; a failed widening must never reach the caller */ }
}

function hasTable(db: TelemetryDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

/** Increment one stage counter. Never throws. */
export function recordCaptureStageOnDb(db: TelemetryDb, sessionDate: string, stage: CaptureStage, nowMs: number): void {
  try {
    ensureCaptureTelemetrySchema(db);
    db.prepare(`
      INSERT INTO asymmetry_capture_counters (session_date, stage, count, last_at_ms)
      VALUES (?,?,1,?)
      ON CONFLICT(session_date, stage) DO UPDATE SET
        count = asymmetry_capture_counters.count + 1, last_at_ms = excluded.last_at_ms
    `).run(sessionDate, stage, nowMs);
  } catch { /* telemetry must never affect the caller */ }
}

/** Increment one rejection reason. `blockedBy` may carry several at once. */
export function recordCaptureRejectionsOnDb(db: TelemetryDb, sessionDate: string, reasons: string[], nowMs: number): void {
  try {
    if (!reasons.length) return;
    ensureCaptureTelemetrySchema(db);
    const stmt = db.prepare(`
      INSERT INTO asymmetry_capture_rejections (session_date, reason, count, last_at_ms)
      VALUES (?,?,1,?)
      ON CONFLICT(session_date, reason) DO UPDATE SET
        count = asymmetry_capture_rejections.count + 1, last_at_ms = excluded.last_at_ms
    `);
    // Every reason is counted, not just the first: a candidate blocked by three
    // things is three separate facts, and recording only one would hide two.
    for (const reason of reasons) stmt.run(sessionDate, String(reason), nowMs);
  } catch { /* telemetry only */ }
}

/**
 * Keep a bounded window of recent attempts, so a reason can be tied to an actual
 * symbol and contract rather than only a count.
 */
export function recordCaptureSampleOnDb(db: TelemetryDb, s: {
  sessionDate: string; observedAtMs: number; stage: CaptureStage;
  symbol: string | null; optionSymbol: string | null; reason: string | null;
  blockedBy?: string[]; labels?: string[];
  rawQuoteAtMs?: number | null; comparedNowMs?: number | null;
}): void {
  try {
    ensureCaptureTelemetrySchema(db);
    db.prepare(`
      INSERT INTO asymmetry_capture_samples
        (session_date, observed_at_ms, stage, symbol, option_symbol, reason, blocked_by, labels, raw_quote_at_ms, compared_now_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      s.sessionDate, s.observedAtMs, s.stage, s.symbol, s.optionSymbol, s.reason,
      JSON.stringify(s.blockedBy ?? []), JSON.stringify(s.labels ?? []),
      s.rawQuoteAtMs ?? null, s.comparedNowMs ?? null,
    );
    // Prune to the newest MAX_RECENT_SAMPLES for this session.
    db.prepare(`
      DELETE FROM asymmetry_capture_samples
       WHERE session_date = ?
         AND id NOT IN (
           SELECT id FROM asymmetry_capture_samples
            WHERE session_date = ? ORDER BY id DESC LIMIT ?
         )
    `).run(s.sessionDate, s.sessionDate, MAX_RECENT_SAMPLES);
  } catch { /* telemetry only */ }
}

export interface CaptureTelemetry {
  counters: Record<string, number>;
  rejections: Array<{ reason: string; count: number; lastAtMs: number | null }>;
  recentSamples: Array<{
    observedAtMs: number; stage: string; symbol: string | null;
    optionSymbol: string | null; reason: string | null; blockedBy: string[]; labels: string[];
    rawQuoteAtMs: number | null; comparedNowMs: number | null;
    /** Order-of-magnitude ratio raw/now. ~1 = ms, ~1e3 = us, ~1e6 = ns. */
    magnitudeRatio: number | null;
  }>;
  /** The deterministic verdict on WHY there are no cases. Never guessed. */
  dominantCause: string;
}

/** Read-only telemetry for diagnostics. */
export function readCaptureTelemetryOnDb(db: TelemetryDb, sessionDate: string): CaptureTelemetry {
  const empty: CaptureTelemetry = {
    counters: {}, rejections: [], recentSamples: [],
    dominantCause: "NO_TELEMETRY_RECORDED_YET",
  };
  if (!hasTable(db, "asymmetry_capture_counters")) return empty;
  try {
    const counters: Record<string, number> = {};
    for (const stage of CAPTURE_STAGES) counters[stage] = 0;
    for (const r of db.prepare(
      "SELECT stage, count FROM asymmetry_capture_counters WHERE session_date=?",
    ).all(sessionDate) as any[]) {
      counters[String(r.stage)] = Number(r.count ?? 0);
    }
    const rejections = (db.prepare(
      "SELECT reason, count, last_at_ms FROM asymmetry_capture_rejections WHERE session_date=? ORDER BY count DESC",
    ).all(sessionDate) as any[]).map((r) => ({
      reason: String(r.reason), count: Number(r.count ?? 0),
      lastAtMs: r.last_at_ms == null ? null : Number(r.last_at_ms),
    }));
    const recentSamples = (db.prepare(
      "SELECT observed_at_ms, stage, symbol, option_symbol, reason, blocked_by, labels, raw_quote_at_ms, compared_now_ms FROM asymmetry_capture_samples WHERE session_date=? ORDER BY id DESC LIMIT ?",
    ).all(sessionDate, MAX_RECENT_SAMPLES) as any[]).map((r) => ({
      observedAtMs: Number(r.observed_at_ms),
      stage: String(r.stage),
      symbol: r.symbol == null ? null : String(r.symbol),
      optionSymbol: r.option_symbol == null ? null : String(r.option_symbol),
      reason: r.reason == null ? null : String(r.reason),
      blockedBy: safeArray(r.blocked_by),
      labels: safeArray(r.labels),
      rawQuoteAtMs: r.raw_quote_at_ms == null ? null : Number(r.raw_quote_at_ms),
      comparedNowMs: r.compared_now_ms == null ? null : Number(r.compared_now_ms),
      magnitudeRatio: r.raw_quote_at_ms == null || !Number(r.compared_now_ms)
        ? null
        : Math.round((Number(r.raw_quote_at_ms) / Number(r.compared_now_ms)) * 1000) / 1000,
    }));
    return { counters, rejections, recentSamples, dominantCause: classifyCause(counters, rejections) };
  } catch {
    return empty;
  }
}

/**
 * Name the dominant cause from counters alone. PURE.
 *
 * Ordered so the most upstream explanation wins: if the loop never reached the
 * capture point, the rejection counts downstream are irrelevant and reporting
 * them as the cause would send someone to the wrong place.
 */
export function classifyCause(
  counters: Record<string, number>,
  rejections: Array<{ reason: string; count: number }>,
): string {
  const n = (k: string) => Number(counters[k] ?? 0);
  // Nothing recorded at all is NOT "the loop never ran" — it is "we have not
  // observed anything yet", which is what premarket and a fresh deploy both
  // look like. Conflating them would report a defect where there is only
  // absence of data.
  if (Object.values(counters).every((v) => Number(v ?? 0) === 0)) return "NO_TELEMETRY_RECORDED_YET";
  if (n("LOOP_REACHED") === 0) return "B_CAPTURE_NEVER_CALLED: the options loop never reached the capture point";
  if (n("CAPTURE_CALLED") === 0) {
    return n("NO_CONTRACT_SELECTED") > 0
      ? `A_NO_CONTRACT_SELECTED: the loop ran ${n("LOOP_REACHED")} times but selected no exact OCC`
      : "B_CAPTURE_NEVER_CALLED: the loop ran but capture was not invoked";
  }
  if (n("CAPTURE_DISABLED") > 0 && n("CAPTURE_ACCEPTED") === 0) {
    return "CAPTURE_DISABLED: HIGH_ASYMMETRY_CAPTURE_ENABLED is not set in the running process";
  }
  if (n("CAPTURE_ACCEPTED") > 0) return "CAPTURING: cases are being created";
  if (n("CAPTURE_PERSIST_FAILED") > 0) return "D_PERSIST_FAILED: intake admitted candidates but the write failed";
  if (n("CAPTURE_BLOCKED") > 0) {
    const top = rejections[0];
    return top
      ? `C_CALLED_AND_REJECTED: dominant blocker ${top.reason} (${top.count})`
      : "C_CALLED_AND_REJECTED: intake refused every candidate";
  }
  if (n("CAPTURE_DUPLICATE") > 0) return "DUPLICATES_ONLY: every candidate was already captured this session";
  return "INDETERMINATE: capture was called but produced no classified outcome";
}

function safeArray(v: unknown): string[] {
  try {
    const p = JSON.parse(String(v ?? "[]"));
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
}
