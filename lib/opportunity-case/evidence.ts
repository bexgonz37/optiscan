/**
 * Append-only evidence events for an active Opportunity Case.
 * Never overwrites the frozen original thesis.
 */
export interface OpportunityEvidenceEvent {
  id: string;
  opportunityCaseId: string;
  observedAt: string;
  observedAtMs: number;
  source: string;
  signalType: string;
  score: number | null;
  details: Record<string, unknown>;
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function evidenceEventId(input: {
  opportunityCaseId: string;
  observedAtMs: number;
  source: string;
  signalType: string;
  score?: number | null;
}): string {
  return `ev_${djb2([
    input.opportunityCaseId,
    String(input.observedAtMs),
    input.source,
    input.signalType,
    input.score == null ? "na" : String(input.score),
  ].join("|"))}`;
}

export function buildEvidenceEvent(input: {
  opportunityCaseId: string;
  observedAtMs: number;
  source: string;
  signalType: string;
  score?: number | null;
  details?: Record<string, unknown>;
}): OpportunityEvidenceEvent {
  return {
    id: evidenceEventId(input),
    opportunityCaseId: input.opportunityCaseId,
    observedAt: new Date(input.observedAtMs).toISOString(),
    observedAtMs: input.observedAtMs,
    source: input.source,
    signalType: input.signalType,
    score: input.score ?? null,
    details: input.details ?? {},
  };
}

interface EvDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run: (...a: any[]) => { changes: number };
  };
}

function hasTable(db: EvDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

/** Idempotent insert. Returns true when a new row was written. */
export function persistEvidenceEventOnDb(db: EvDb, ev: OpportunityEvidenceEvent): boolean {
  if (!hasTable(db, "opportunity_evidence_events")) return false;
  try {
    const r = db.prepare(
      `INSERT OR IGNORE INTO opportunity_evidence_events
        (id, opportunity_case_id, observed_at_ms, source, signal_type, score, details_json, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      ev.id,
      ev.opportunityCaseId,
      ev.observedAtMs,
      ev.source,
      ev.signalType,
      ev.score,
      JSON.stringify(ev.details ?? {}),
      ev.observedAtMs,
    );
    return Number(r.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

export function listEvidenceForCaseOnDb(db: EvDb, opportunityCaseId: string, limit = 50): OpportunityEvidenceEvent[] {
  if (!hasTable(db, "opportunity_evidence_events")) return [];
  try {
    const rows = db.prepare(
      `SELECT id, opportunity_case_id, observed_at_ms, source, signal_type, score, details_json
       FROM opportunity_evidence_events
       WHERE opportunity_case_id=?
       ORDER BY observed_at_ms DESC
       LIMIT ?`,
    ).all(opportunityCaseId, limit) as any[];
    return rows.map((r) => ({
      id: String(r.id),
      opportunityCaseId: String(r.opportunity_case_id),
      observedAt: new Date(Number(r.observed_at_ms)).toISOString(),
      observedAtMs: Number(r.observed_at_ms),
      source: String(r.source),
      signalType: String(r.signal_type),
      score: r.score == null ? null : Number(r.score),
      details: (() => {
        try { return JSON.parse(String(r.details_json ?? "{}")); } catch { return {}; }
      })(),
    }));
  } catch {
    return [];
  }
}
