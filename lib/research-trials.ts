/**
 * Research trial log + day-based split helpers + Šidák multiple-testing adjustment.
 * Prevents Factor Lab tuning from manufacturing false winners.
 */
export interface ResearchTrial {
  id?: number;
  trialKey: string;
  hypothesis: string;
  factor?: string | null;
  horizon?: string | null;
  metricName: string;
  metricValue: number | null;
  pRaw: number | null;
  pAdj: number | null;
  nTrialsFamily: number;
  sampleDays: number;
  sampleAlerts: number;
  splitMethod: "trading_day";
  trainDaysJson?: string | null;
  testDaysJson?: string | null;
  notes?: string | null;
  createdAtMs: number;
}

/** Šidák-adjusted p-value: 1 - (1 - p)^N */
export function sidakAdjust(pRaw: number | null, nTrials: number): number | null {
  if (pRaw == null || !Number.isFinite(pRaw) || nTrials < 1) return null;
  const p = Math.min(1, Math.max(0, pRaw));
  const adj = 1 - Math.pow(1 - p, nTrials);
  return +Math.min(1, Math.max(0, adj)).toFixed(8);
}

/** Approximate two-sided p from IC IR under normal approximation (for logging only). */
export function approxIcPValue(icIr: number | null, usableDays: number): number | null {
  if (icIr == null || !Number.isFinite(icIr) || usableDays < 3) return null;
  const z = Math.abs(icIr) * Math.sqrt(usableDays);
  // erfc approximation for two-sided normal p
  const t = 1 / (1 + 0.5 * Math.min(z, 20));
  const tau =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t * (1.00002368 +
          t * (0.37409196 +
            t * (0.09678418 +
              t * (-0.18628806 +
                t * (0.27886807 +
                  t * (-1.13520398 +
                    t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  const p = Math.min(1, Math.max(0, tau));
  return +p.toFixed(8);
}

/** Split trading days into train/test by chronological blocks (no within-day leakage). */
export function splitTradingDays(
  days: string[],
  testFraction = 0.3,
): { trainDays: string[]; testDays: string[] } {
  const sorted = [...new Set(days)].sort();
  if (sorted.length < 2) return { trainDays: sorted, testDays: [] };
  const nTest = Math.max(1, Math.floor(sorted.length * testFraction));
  const cut = sorted.length - nTest;
  return { trainDays: sorted.slice(0, cut), testDays: sorted.slice(cut) };
}

type TrialDb = {
  prepare: (sql: string) => {
    run: (...a: unknown[]) => { changes: number; lastInsertRowid?: number | bigint };
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
  exec: (sql: string) => unknown;
};

export function ensureResearchTrialsSchema(db: TrialDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_trials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trial_key TEXT NOT NULL,
      hypothesis TEXT NOT NULL,
      factor TEXT,
      horizon TEXT,
      metric_name TEXT NOT NULL,
      metric_value REAL,
      p_raw REAL,
      p_adj REAL,
      n_trials_family INTEGER NOT NULL DEFAULT 1,
      sample_days INTEGER NOT NULL DEFAULT 0,
      sample_alerts INTEGER NOT NULL DEFAULT 0,
      split_method TEXT NOT NULL DEFAULT 'trading_day',
      train_days_json TEXT,
      test_days_json TEXT,
      notes TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_research_trials_key ON research_trials(trial_key, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_research_trials_factor ON research_trials(factor, horizon, created_at_ms);
  `);
}

export function countTrialsInFamily(db: TrialDb, trialKey: string): number {
  try {
    const row = db.prepare("SELECT COUNT(*) n FROM research_trials WHERE trial_key=?").get(trialKey) as { n: number };
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

export function recordResearchTrialOnDb(db: TrialDb, trial: ResearchTrial): { id: number } {
  ensureResearchTrialsSchema(db);
  const familyN = Math.max(1, trial.nTrialsFamily);
  const pAdj = trial.pAdj ?? sidakAdjust(trial.pRaw, familyN);
  const r = db.prepare(
    `INSERT INTO research_trials (
      trial_key, hypothesis, factor, horizon, metric_name, metric_value,
      p_raw, p_adj, n_trials_family, sample_days, sample_alerts, split_method,
      train_days_json, test_days_json, notes, created_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    trial.trialKey,
    trial.hypothesis,
    trial.factor ?? null,
    trial.horizon ?? null,
    trial.metricName,
    trial.metricValue,
    trial.pRaw,
    pAdj,
    familyN,
    trial.sampleDays,
    trial.sampleAlerts,
    trial.splitMethod,
    trial.trainDaysJson ?? null,
    trial.testDaysJson ?? null,
    trial.notes ?? null,
    trial.createdAtMs,
  );
  return { id: Number(r.lastInsertRowid ?? 0) };
}

export function listResearchTrialsOnDb(db: TrialDb, limit = 50): ResearchTrial[] {
  try {
    ensureResearchTrialsSchema(db);
    const rows = db.prepare(
      `SELECT id, trial_key AS trialKey, hypothesis, factor, horizon,
              metric_name AS metricName, metric_value AS metricValue,
              p_raw AS pRaw, p_adj AS pAdj, n_trials_family AS nTrialsFamily,
              sample_days AS sampleDays, sample_alerts AS sampleAlerts,
              split_method AS splitMethod, train_days_json AS trainDaysJson,
              test_days_json AS testDaysJson, notes, created_at_ms AS createdAtMs
       FROM research_trials ORDER BY created_at_ms DESC LIMIT ?`,
    ).all(limit) as ResearchTrial[];
    return rows;
  } catch {
    return [];
  }
}
