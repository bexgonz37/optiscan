/**
 * Scanner protections (Freqtrade Protections-inspired).
 * Suppress alert inserts — never place orders. Every lock is auditable.
 */
export interface AlertLock {
  ticker: string;
  reason: string;
  lockedUntilMs: number;
  createdAtMs: number;
  metaJson?: string | null;
}

export interface ProtectionCheck {
  allowed: boolean;
  reason: string | null;
  lock?: AlertLock | null;
}

type ProtDb = {
  prepare: (sql: string) => {
    run: (...a: unknown[]) => unknown;
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
  exec: (sql: string) => unknown;
};

export function ensureAlertLocksSchema(db: ProtDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      reason TEXT NOT NULL,
      locked_until_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      meta_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alert_locks_ticker_until ON alert_locks(ticker, locked_until_ms);
  `);
}

function numEnv(env: NodeJS.ProcessEnv, key: string, d: number): number {
  const x = Number(env[key]);
  return Number.isFinite(x) ? x : d;
}

/**
 * Opt-IN. Protections suppress captures, so they stay inert until explicitly
 * enabled — Phase 1 of the quant pack is visibility only and must not change
 * scanner behavior.
 */
export function isProtectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALERT_PROTECTIONS_ENABLED === "1";
}

/** Active lock for ticker if any. */
export function getActiveLockOnDb(db: ProtDb, ticker: string, nowMs: number): AlertLock | null {
  try {
    ensureAlertLocksSchema(db);
    const row = db.prepare(
      `SELECT ticker, reason, locked_until_ms AS lockedUntilMs, created_at_ms AS createdAtMs, meta_json AS metaJson
       FROM alert_locks WHERE ticker=? AND locked_until_ms > ? ORDER BY locked_until_ms DESC LIMIT 1`,
    ).get(ticker.toUpperCase(), nowMs) as AlertLock | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

export function createAlertLockOnDb(db: ProtDb, lock: AlertLock): void {
  ensureAlertLocksSchema(db);
  db.prepare(
    `INSERT INTO alert_locks (ticker, reason, locked_until_ms, created_at_ms, meta_json) VALUES (?,?,?,?,?)`,
  ).run(lock.ticker.toUpperCase(), lock.reason, lock.lockedUntilMs, lock.createdAtMs, lock.metaJson ?? null);
}

/** CooldownPeriod — no new alert on ticker for N minutes after any insert. */
export function applyCooldownLock(
  db: ProtDb,
  ticker: string,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isProtectionEnabled(env)) return;
  const mins = numEnv(env, "ALERT_COOLDOWN_MINUTES", 15);
  if (mins <= 0) return;
  createAlertLockOnDb(db, {
    ticker,
    reason: "CooldownPeriod",
    lockedUntilMs: nowMs + mins * 60_000,
    createdAtMs: nowMs,
    metaJson: JSON.stringify({ minutes: mins }),
  });
}

/**
 * StoplossGuard — after N consecutive false positives on a ticker, lock for M hours.
 */
export function maybeApplyStreakLock(
  db: ProtDb,
  ticker: string,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isProtectionEnabled(env)) return;
  const streak = numEnv(env, "ALERT_FP_STREAK_LOCK", 3);
  const hours = numEnv(env, "ALERT_FP_STREAK_HOURS", 24);
  if (streak <= 0) return;
  try {
    const rows = db.prepare(
      `SELECT is_false_positive AS fp FROM alerts
       WHERE ticker=? AND is_false_positive IS NOT NULL
       ORDER BY id DESC LIMIT ?`,
    ).all(ticker.toUpperCase(), streak) as Array<{ fp: number }>;
    if (rows.length < streak) return;
    if (!rows.every((r) => Number(r.fp) === 1)) return;
    createAlertLockOnDb(db, {
      ticker,
      reason: "StoplossGuard",
      lockedUntilMs: nowMs + hours * 3600_000,
      createdAtMs: nowMs,
      metaJson: JSON.stringify({ streak, hours }),
    });
  } catch { /* optional */ }
}

/**
 * LowQualityTickers — high recent FP rate on ticker → lock.
 */
export function maybeApplyLowQualityLock(
  db: ProtDb,
  ticker: string,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isProtectionEnabled(env)) return;
  const minN = numEnv(env, "ALERT_LQ_MIN_SAMPLE", 5);
  const maxFp = numEnv(env, "ALERT_LQ_MAX_FP_RATE", 0.7);
  const hours = numEnv(env, "ALERT_LQ_LOCK_HOURS", 48);
  try {
    const row = db.prepare(
      `SELECT COUNT(*) n,
              SUM(CASE WHEN is_false_positive=1 THEN 1 ELSE 0 END) fp
       FROM alerts
       WHERE ticker=? AND is_false_positive IS NOT NULL
         AND alert_time >= datetime('now', '-14 days')`,
    ).get(ticker.toUpperCase()) as { n: number; fp: number };
    if (!row || Number(row.n) < minN) return;
    const rate = Number(row.fp) / Number(row.n);
    if (rate < maxFp) return;
    createAlertLockOnDb(db, {
      ticker,
      reason: "LowQualityTickers",
      lockedUntilMs: nowMs + hours * 3600_000,
      createdAtMs: nowMs,
      metaJson: JSON.stringify({ rate, n: row.n, fp: row.fp }),
    });
  } catch { /* optional */ }
}

/**
 * MaxDrawdown-style daily false-positive-rate breaker — halt new captures when today's FP rate is extreme.
 */
export function dailyFalsePositiveBreaker(
  db: ProtDb,
  tradingDay: string,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): ProtectionCheck {
  const minN = numEnv(env, "ALERT_DAILY_FP_MIN_SAMPLE", 8);
  const maxRate = numEnv(env, "ALERT_DAILY_FP_MAX_RATE", 0.85);
  try {
    const row = db.prepare(
      `SELECT COUNT(*) n,
              SUM(CASE WHEN is_false_positive=1 THEN 1 ELSE 0 END) fp
       FROM alerts WHERE trading_day=? AND is_false_positive IS NOT NULL`,
    ).get(tradingDay) as { n: number; fp: number };
    if (!row || Number(row.n) < minN) return { allowed: true, reason: null };
    const rate = Number(row.fp) / Number(row.n);
    if (rate < maxRate) return { allowed: true, reason: null };
    return {
      allowed: false,
      reason: `daily_fp_breaker rate=${rate.toFixed(2)} n=${row.n}`,
      lock: {
        ticker: "*",
        reason: "MaxDrawdown",
        lockedUntilMs: nowMs + 60 * 60_000,
        createdAtMs: nowMs,
        metaJson: JSON.stringify({ tradingDay, rate, n: row.n }),
      },
    };
  } catch {
    return { allowed: true, reason: null };
  }
}

/** Pre-insert protection gate. */
export function checkAlertProtections(
  db: ProtDb,
  ticker: string,
  tradingDay: string,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): ProtectionCheck {
  if (!isProtectionEnabled(env)) return { allowed: true, reason: null };
  ensureAlertLocksSchema(db);
  const daily = dailyFalsePositiveBreaker(db, tradingDay, nowMs, env);
  if (!daily.allowed) return daily;
  const lock = getActiveLockOnDb(db, ticker, nowMs);
  if (lock) return { allowed: false, reason: `locked:${lock.reason}`, lock };
  maybeApplyLowQualityLock(db, ticker, nowMs, env);
  maybeApplyStreakLock(db, ticker, nowMs, env);
  const again = getActiveLockOnDb(db, ticker, nowMs);
  if (again) return { allowed: false, reason: `locked:${again.reason}`, lock: again };
  return { allowed: true, reason: null };
}
