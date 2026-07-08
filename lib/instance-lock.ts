/**
 * instance-lock.ts — DB-based advisory lock so only ONE scanner loop runs
 * (audit P1-3/T7).
 *
 * The in-memory `s.running` guard is per-process; a stray `next dev` next to
 * the Docker container, or an accidental second replica, would run a second
 * loop that doubles Polygon spend and double-fires triggers (cooldowns are
 * in-memory). This lock lives in SQLite so every process that shares the data
 * volume competes for the same row.
 *
 * Semantics:
 *  - single row (id=1) holding pid/hostname/started_at/heartbeat_at
 *  - a lock is FRESH when its heartbeat is younger than LOCK_STALE_MS;
 *    a crashed process stops heartbeating and its lock expires on its own
 *  - same-pid re-acquire always succeeds (Next dev hot reload)
 *  - failure to acquire = do NOT start the loop; surface in note + /api/health
 *
 * Functions take the db handle as a parameter (no "@/" imports) so tests can
 * exercise them against a temp database directly.
 */

type DbLike = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => {
    get: (...args: unknown[]) => any;
    run: (...args: unknown[]) => unknown;
  };
};

export const LOCK_STALE_MS = 120_000;

export interface LockHolder {
  pid: number;
  hostname: string;
  started_at: string;
  heartbeat_at: string;
}

export interface AcquireResult {
  acquired: boolean;
  holder: LockHolder | null;
}

export function ensureLockTable(db: DbLike): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scanner_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pid INTEGER NOT NULL,
    hostname TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL
  )`);
}

export function acquireScannerLock(
  db: DbLike,
  opts: { pid: number; hostname?: string; nowMs?: number; staleMs?: number },
): AcquireResult {
  const nowMs = opts.nowMs ?? Date.now();
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const hostname = opts.hostname ?? "";
  ensureLockTable(db);
  const row = db.prepare("SELECT pid, hostname, started_at, heartbeat_at FROM scanner_lock WHERE id = 1").get() as
    | LockHolder
    | undefined;

  if (row) {
    const beatMs = Date.parse(row.heartbeat_at);
    const fresh = Number.isFinite(beatMs) && nowMs - beatMs < staleMs;
    if (fresh && row.pid !== opts.pid) {
      return { acquired: false, holder: row };
    }
  }

  const nowIso = new Date(nowMs).toISOString();
  db.prepare(
    `INSERT INTO scanner_lock (id, pid, hostname, started_at, heartbeat_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       pid = excluded.pid,
       hostname = excluded.hostname,
       started_at = excluded.started_at,
       heartbeat_at = excluded.heartbeat_at`,
  ).run(opts.pid, hostname, nowIso, nowIso);
  return { acquired: true, holder: null };
}

/** Refresh our heartbeat; only touches the row while we still own it. */
export function heartbeatScannerLock(db: DbLike, pid: number, nowMs: number = Date.now()): void {
  db.prepare("UPDATE scanner_lock SET heartbeat_at = ? WHERE id = 1 AND pid = ?").run(
    new Date(nowMs).toISOString(),
    pid,
  );
}

/** Best-effort release (crash-safety comes from staleness, not from this). */
export function releaseScannerLock(db: DbLike, pid: number): void {
  db.prepare("DELETE FROM scanner_lock WHERE id = 1 AND pid = ?").run(pid);
}
