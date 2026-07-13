/**
 * callouts/state-store.ts — persistent lifecycle/dedup state for canonical
 * callouts (live runtime wiring). The PURE dedup (decideEmission/nextCalloutState)
 * still owns the transition logic; this layer just hydrates the prior-state map
 * from SQLite and writes it back, so dedup/cooldown/lifecycle survive process and
 * worker restarts and horizontal scaling. A restart therefore never resends an
 * unchanged callout.
 *
 * The `*OnDb` core takes a better-sqlite3 handle so it is unit-testable; public
 * wrappers resolve `@/lib/db` lazily.
 */
import type { Callout } from "./callout.ts";
import type { PriorCallout, EmissionDecision } from "./dedup.ts";
import { materialStateHash } from "./material-hash.ts";

/** Hydrate the prior-state map the pure dedup needs, keyed by callout key. */
export function loadPriorCalloutsOnDb(db: any): Map<string, PriorCallout> {
  const rows = db.prepare("SELECT callout_key, last_status, last_emit_at_ms FROM callout_state").all() as any[];
  const map = new Map<string, PriorCallout>();
  for (const r of rows) {
    map.set(r.callout_key, { status: r.last_status, lastEmitMs: Number(r.last_emit_at_ms ?? 0) });
  }
  return map;
}

export interface CalloutStateWrite {
  callout: Callout;
  decision: EmissionDecision;
  deliveryId?: string | null;
  deliveryStatus?: string | null;
}

/**
 * Persist the post-cycle state for each callout. `last_emit_at_ms` and the
 * delivery fields are only advanced when the callout actually emitted; otherwise
 * the prior values are preserved (COALESCE), so a suppressed re-observation never
 * clobbers the real last-sent record.
 */
export function persistCalloutStateOnDb(db: any, items: CalloutStateWrite[], nowMs: number): void {
  const stmt = db.prepare(
    `INSERT INTO callout_state
       (callout_key, ticker, direction, horizon, last_status, last_material_hash,
        last_emit_at_ms, last_idempotency_key, last_delivery_id, last_delivery_status, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(callout_key) DO UPDATE SET
       ticker=excluded.ticker,
       direction=excluded.direction,
       horizon=excluded.horizon,
       last_status=excluded.last_status,
       last_material_hash=excluded.last_material_hash,
       last_emit_at_ms=COALESCE(excluded.last_emit_at_ms, callout_state.last_emit_at_ms),
       last_idempotency_key=COALESCE(excluded.last_idempotency_key, callout_state.last_idempotency_key),
       last_delivery_id=COALESCE(excluded.last_delivery_id, callout_state.last_delivery_id),
       last_delivery_status=COALESCE(excluded.last_delivery_status, callout_state.last_delivery_status),
       updated_at_ms=excluded.updated_at_ms`,
  );
  const tx = db.transaction((rows: CalloutStateWrite[]) => {
    for (const it of rows) {
      const c = it.callout;
      const emitted = it.decision.emit;
      stmt.run(
        c.key,
        c.ticker,
        c.direction,
        c.horizon,
        c.status,
        materialStateHash(c),
        emitted ? nowMs : null,
        emitted ? it.decision.idempotencyKey : null,
        it.deliveryId ?? null,
        it.deliveryStatus ?? null,
        nowMs,
      );
    }
  });
  tx(items);
}

/** Read-only snapshot for the health/status surface. */
export function calloutStateSummaryOnDb(db: any): { total: number; byStatus: Record<string, number>; lastEmitAtMs: number | null } {
  const total = Number((db.prepare("SELECT COUNT(*) AS n FROM callout_state").get() as any)?.n ?? 0);
  const rows = db.prepare("SELECT last_status, COUNT(*) AS n FROM callout_state GROUP BY last_status").all() as any[];
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.last_status] = Number(r.n);
  const lastEmitAtMs = (db.prepare("SELECT MAX(last_emit_at_ms) AS m FROM callout_state").get() as any)?.m ?? null;
  return { total, byStatus, lastEmitAtMs: lastEmitAtMs != null ? Number(lastEmitAtMs) : null };
}

// ── Public wrappers (lazy @/lib/db) ──────────────────────────────────────────

function lazyDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/lib/db");
  return getDb();
}

export function loadPriorCallouts(): Map<string, PriorCallout> {
  try { return loadPriorCalloutsOnDb(lazyDb()); } catch { return new Map(); }
}

export function persistCalloutState(items: CalloutStateWrite[], nowMs: number = Date.now()): void {
  try { persistCalloutStateOnDb(lazyDb(), items, nowMs); } catch { /* best-effort */ }
}

export function calloutStateSummary(): { total: number; byStatus: Record<string, number>; lastEmitAtMs: number | null } {
  try { return calloutStateSummaryOnDb(lazyDb()); } catch { return { total: 0, byStatus: {}, lastEmitAtMs: null }; }
}
