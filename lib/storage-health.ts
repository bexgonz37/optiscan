/**
 * Bounded SQLite / volume health evidence for the private owner surface.
 *
 * The live page performs filesystem stats and bounded indexed reads only. Writes,
 * WAL checkpoint observation, warning transitions, and retention run on the
 * scheduler maintenance beat. No provider, strategy, or subscriber path imports
 * this module.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveDbLocation } from "./db-schema-readiness.ts";

export type StorageWarningState = "OK" | "WARN_70" | "CRITICAL_85" | "EMERGENCY_95";

type Row = Record<string, any>;
export interface StorageDb {
  prepare(sql: string): {
    get: (...args: any[]) => Row | undefined;
    all: (...args: any[]) => Row[];
    run: (...args: any[]) => { changes: number; lastInsertRowid?: number | bigint };
  };
  pragma?: (source: string, options?: { simple?: boolean }) => any;
  exec(sql: string): void;
}

export interface StorageSnapshot {
  sampledAtMs: number;
  dbBytes: number;
  walBytes: number;
  shmBytes: number;
  volumeTotalBytes: number | null;
  volumeAvailableBytes: number | null;
  volumeUsedBytes: number | null;
  volumeUsedPct: number | null;
}

export interface StorageMaintenanceResult {
  sampled: boolean;
  sample: StorageSnapshot;
  warningTransition: null | {
    id: number;
    previousState: StorageWarningState | null;
    state: StorageWarningState;
    volumeUsedPct: number | null;
    message: string;
  };
}

const SAMPLE_INTERVAL_MS = 60 * 60_000;
const RETENTION_MS = 45 * 24 * 60 * 60_000;
let monitorBusyEvents = 0;
type StorageGlobal = typeof globalThis & { __optiscanBackupLaunchDay?: string | null };

function fileBytes(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function finiteNumber(v: unknown): number | null {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function storageWarningState(usedPct: number | null): StorageWarningState {
  if (usedPct == null) return "OK";
  if (usedPct >= 95) return "EMERGENCY_95";
  if (usedPct >= 85) return "CRITICAL_85";
  if (usedPct >= 70) return "WARN_70";
  return "OK";
}

export function readStorageSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): StorageSnapshot {
  const loc = resolveDbLocation(env);
  let volumeTotalBytes: number | null = null;
  let volumeAvailableBytes: number | null = null;
  try {
    const stat = fs.statfsSync(loc.directory, { bigint: true });
    const blockSize = finiteNumber(stat.bsize);
    const blocks = finiteNumber(stat.blocks);
    const availableBlocks = finiteNumber(stat.bavail);
    if (blockSize != null && blocks != null && availableBlocks != null) {
      volumeTotalBytes = blockSize * blocks;
      volumeAvailableBytes = blockSize * availableBlocks;
    }
  } catch { /* surfaced as unavailable, never guessed */ }
  const volumeUsedBytes = volumeTotalBytes != null && volumeAvailableBytes != null
    ? Math.max(0, volumeTotalBytes - volumeAvailableBytes)
    : null;
  const volumeUsedPct = volumeTotalBytes && volumeUsedBytes != null
    ? (volumeUsedBytes / volumeTotalBytes) * 100
    : null;
  return {
    sampledAtMs: nowMs,
    dbBytes: fileBytes(loc.file),
    walBytes: fileBytes(loc.walFile),
    shmBytes: fileBytes(loc.shmFile),
    volumeTotalBytes,
    volumeAvailableBytes,
    volumeUsedBytes,
    volumeUsedPct,
  };
}

function checkpointStatus(db: StorageDb): { busy: number | null; log: number | null; checkpointed: number | null } {
  try {
    const result = db.pragma?.("wal_checkpoint(PASSIVE)");
    const row = Array.isArray(result) ? result[0] : result;
    return {
      busy: finiteNumber(row?.busy),
      log: finiteNumber(row?.log),
      checkpointed: finiteNumber(row?.checkpointed),
    };
  } catch {
    return { busy: null, log: null, checkpointed: null };
  }
}

function warningMessage(state: StorageWarningState, pct: number | null): string {
  const shown = pct == null ? "unknown" : `${pct.toFixed(1)}%`;
  if (state === "EMERGENCY_95") return `OptiScan storage is ${shown} used. Immediate owner review is required.`;
  if (state === "CRITICAL_85") return `OptiScan storage is ${shown} used. Review growth and retention now.`;
  if (state === "WARN_70") return `OptiScan storage is ${shown} used. Capacity planning warning.`;
  return `OptiScan storage returned to ${shown} used.`;
}

/** Scheduler-only write path. It is repeat-safe and samples at most hourly. */
export function runStorageHealthMaintenanceOnDb(
  db: StorageDb,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): StorageMaintenanceResult {
  const sample = readStorageSnapshot(env, nowMs);
  const last = db.prepare("SELECT sampled_at_ms FROM storage_health_samples ORDER BY sampled_at_ms DESC LIMIT 1").get();
  if (last && nowMs - Number(last.sampled_at_ms) < SAMPLE_INTERVAL_MS) {
    return { sampled: false, sample, warningTransition: null };
  }

  const checkpoint = checkpointStatus(db);
  const started = performance.now();
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`
      INSERT INTO storage_health_samples (
        sampled_at_ms, db_bytes, wal_bytes, shm_bytes,
        volume_total_bytes, volume_available_bytes, volume_used_bytes, volume_used_pct,
        write_latency_ms, checkpoint_busy, checkpoint_log_pages, checkpointed_pages,
        monitor_busy_events_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      nowMs, sample.dbBytes, sample.walBytes, sample.shmBytes,
      sample.volumeTotalBytes, sample.volumeAvailableBytes, sample.volumeUsedBytes, sample.volumeUsedPct,
      checkpoint.busy, checkpoint.log, checkpoint.checkpointed, monitorBusyEvents,
    );
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* no active transaction */ }
    if (/busy|locked/i.test(String((err as Error)?.message ?? err))) monitorBusyEvents += 1;
    throw err;
  }
  const writeLatencyMs = Math.max(0, performance.now() - started);
  db.prepare("UPDATE storage_health_samples SET write_latency_ms=? WHERE sampled_at_ms=?")
    .run(writeLatencyMs, nowMs);
  db.prepare("DELETE FROM storage_health_samples WHERE sampled_at_ms < ?")
    .run(nowMs - RETENTION_MS);

  const state = storageWarningState(sample.volumeUsedPct);
  const previous = db.prepare("SELECT state FROM storage_warning_events ORDER BY transitioned_at_ms DESC, id DESC LIMIT 1").get();
  const previousState = (previous?.state as StorageWarningState | undefined) ?? null;
  let warningTransition: StorageMaintenanceResult["warningTransition"] = null;
  if (previousState !== state) {
    const message = warningMessage(state, sample.volumeUsedPct);
    const inserted = db.prepare(`
      INSERT INTO storage_warning_events (state, previous_state, volume_used_pct, message, transitioned_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(state, previousState, sample.volumeUsedPct, message, nowMs);
    warningTransition = {
      id: Number(inserted.lastInsertRowid ?? 0),
      previousState,
      state,
      volumeUsedPct: sample.volumeUsedPct,
      message,
    };
  }
  return { sampled: true, sample, warningTransition };
}

function growthFor(samples: Row[], nowMs: number, days: number, currentBytes: number): number | null {
  const target = nowMs - days * 24 * 60 * 60_000;
  const older = samples.find((r) => Number(r.sampled_at_ms) <= target);
  return older ? currentBytes - Number(older.db_bytes) : null;
}

function readBackupMetadata(env: NodeJS.ProcessEnv): Row | null {
  const loc = resolveDbLocation(env);
  const backupDir = path.join(loc.directory, "backups");
  try {
    const files = fs.readdirSync(backupDir)
      .filter((name) => /^optiscan-.*\.db\.meta\.json$/.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(backupDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(path.join(backupDir, files[0].name), "utf8"));
  } catch { return null; }
}

function easternDayAndHour(nowMs: number): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: `${value("year")}-${value("month")}-${value("day")}`, hour: Number(value("hour")) };
}

export function automatedBackupDecision(
  env: NodeJS.ProcessEnv,
  nowMs: number,
  latestBackupCreatedAtMs: number | null,
): { due: boolean; reason: string; day: string } {
  const railway = Boolean(env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT_NAME);
  const enabled = env.OPTISCAN_AUTOMATED_BACKUP_ENABLED === "1"
    || (railway && env.OPTISCAN_AUTOMATED_BACKUP_ENABLED !== "0");
  const current = easternDayAndHour(nowMs);
  if (!enabled) return { due: false, reason: "AUTOMATED_BACKUP_DISABLED", day: current.day };
  if (current.hour < 21) return { due: false, reason: "AFTER_CLOSE_WINDOW_NOT_OPEN", day: current.day };
  if (latestBackupCreatedAtMs != null && easternDayAndHour(latestBackupCreatedAtMs).day === current.day) {
    return { due: false, reason: "BACKUP_ALREADY_EXISTS_FOR_ET_DAY", day: current.day };
  }
  return { due: true, reason: "DUE", day: current.day };
}

/** Launches the online backup as a detached operational job; never awaits it. */
export function launchAutomatedBackupIfDue(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): { launched: boolean; reason: string } {
  const metadata = readBackupMetadata(env);
  const decision = automatedBackupDecision(env, nowMs, finiteNumber(metadata?.createdAtMs));
  if (!decision.due) return { launched: false, reason: decision.reason };
  const g = globalThis as StorageGlobal;
  if (g.__optiscanBackupLaunchDay === decision.day) return { launched: false, reason: "ALREADY_LAUNCHED_THIS_PROCESS_DAY" };
  g.__optiscanBackupLaunchDay = decision.day;
  const script = path.join(process.cwd(), "scripts", "backup-db.mjs");
  try {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(), env, stdio: "inherit", windowsHide: true,
    });
    child.once("exit", (code) => {
      if (code !== 0) {
        g.__optiscanBackupLaunchDay = null;
        console.error(`[storage] automated backup exited ${code}`);
      }
    });
    child.once("error", (err) => {
      g.__optiscanBackupLaunchDay = null;
      console.error(`[storage] automated backup failed to launch: ${err.message}`);
    });
    child.unref();
    return { launched: true, reason: "LAUNCHED_DETACHED" };
  } catch (err) {
    g.__optiscanBackupLaunchDay = null;
    return { launched: false, reason: `LAUNCH_ERROR:${String((err as Error)?.message ?? err).slice(0, 160)}` };
  }
}

function readRestoreVerification(env: NodeJS.ProcessEnv): Row | null {
  const loc = resolveDbLocation(env);
  try {
    return JSON.parse(fs.readFileSync(path.join(loc.directory, "backups", "last-restore-verification.json"), "utf8"));
  } catch { return null; }
}

function estimatedLargestTables(db: StorageDb): Array<{ table: string; estimatedRows: number | null; estimatedBytes: null }> {
  try {
    return db.prepare(`
      SELECT tbl AS table_name, stat
      FROM sqlite_stat1
      WHERE idx IS NULL OR idx NOT LIKE 'sqlite_autoindex%'
      ORDER BY CAST(substr(stat, 1, instr(stat || ' ', ' ') - 1) AS INTEGER) DESC
      LIMIT 12
    `).all().map((row) => {
      const n = Number(String(row.stat ?? "").split(" ")[0]);
      return { table: String(row.table_name), estimatedRows: Number.isFinite(n) ? n : null, estimatedBytes: null };
    });
  } catch { return []; }
}

/** Read-only, bounded health report for the private API/UI. */
export function getStorageHealthOnDb(
  db: StorageDb,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): Record<string, unknown> {
  const current = readStorageSnapshot(env, nowMs);
  const samples = db.prepare(`
    SELECT sampled_at_ms, db_bytes, write_latency_ms, checkpoint_busy,
           checkpoint_log_pages, checkpointed_pages, monitor_busy_events_total
    FROM storage_health_samples
    WHERE sampled_at_ms >= ?
    ORDER BY sampled_at_ms DESC
    LIMIT 800
  `).all(nowMs - 32 * 24 * 60 * 60_000);
  const latest = samples[0] ?? null;
  const growth1d = growthFor(samples, nowMs, 1, current.dbBytes);
  const growth7d = growthFor(samples, nowMs, 7, current.dbBytes);
  const growth30d = growthFor(samples, nowMs, 30, current.dbBytes);
  const growthPerDay = growth30d != null && growth30d > 0 ? growth30d / 30
    : growth7d != null && growth7d > 0 ? growth7d / 7
      : growth1d != null && growth1d > 0 ? growth1d : null;
  const projectedDaysToExhaustion = growthPerDay && current.volumeAvailableBytes != null
    ? current.volumeAvailableBytes / growthPerDay
    : null;
  const warning = db.prepare("SELECT * FROM storage_warning_events ORDER BY transitioned_at_ms DESC, id DESC LIMIT 1").get() ?? null;
  const backup = readBackupMetadata(env);
  const restore = readRestoreVerification(env)
    ?? db.prepare("SELECT * FROM backup_restore_verifications ORDER BY verified_at_ms DESC LIMIT 1").get()
    ?? null;
  return {
    measuredAtMs: nowMs,
    current,
    growth: {
      oneDayBytes: growth1d,
      sevenDayBytes: growth7d,
      thirtyDayBytes: growth30d,
      projectedDaysToExhaustion,
      basis: growthPerDay == null ? "INSUFFICIENT_HISTORY_OR_NONPOSITIVE_GROWTH" : "MEASURED_DB_FILE_GROWTH",
    },
    largestTables: estimatedLargestTables(db),
    largestTableBytes: { available: false, reason: "Not computed live: dbstat would scan the multi-GB database." },
    writeLatencyMs: latest?.write_latency_ms ?? null,
    sqliteBusyEvents: {
      count: latest?.monitor_busy_events_total ?? null,
      coverage: "STORAGE_MONITOR_WRITES_ONLY",
      reason: "SQLite has no global busy counter; this does not claim all application lock events.",
    },
    checkpoint: latest ? {
      sampledAtMs: latest.sampled_at_ms,
      busy: latest.checkpoint_busy,
      logPages: latest.checkpoint_log_pages,
      checkpointedPages: latest.checkpointed_pages,
    } : null,
    integrity: restore ? {
      status: restore.quickCheckResult ?? restore.quick_check_result ?? null,
      verifiedAtMs: restore.verifiedAtMs ?? restore.verified_at_ms ?? null,
      scope: "TEMPORARY_RESTORE_COPY",
    } : { status: null, reason: "No bounded restore verification has been recorded yet." },
    backup: backup ? {
      file: backup.file ?? backup.backupFile ?? null,
      createdAtMs: backup.createdAtMs ?? null,
      bytes: backup.bytes ?? null,
      sha256: backup.sha256 ?? null,
      ageMs: backup.createdAtMs ? Math.max(0, nowMs - Number(backup.createdAtMs)) : null,
    } : null,
    lastRestoreDrill: restore,
    warning: warning ? {
      state: warning.state,
      previousState: warning.previous_state,
      volumeUsedPct: warning.volume_used_pct,
      message: warning.message,
      transitionedAtMs: warning.transitioned_at_ms,
      ownerNotifiedAtMs: warning.owner_notified_at_ms,
      ownerNotifyResult: warning.owner_notify_result,
    } : { state: storageWarningState(current.volumeUsedPct), message: warningMessage(storageWarningState(current.volumeUsedPct), current.volumeUsedPct) },
    bounded: true,
  };
}

export function recordStorageOwnerNotificationOnDb(
  db: StorageDb,
  warningId: number,
  result: string,
  nowMs = Date.now(),
): void {
  db.prepare(`
    UPDATE storage_warning_events
    SET owner_notified_at_ms=?, owner_notify_result=?
    WHERE id=? AND owner_notified_at_ms IS NULL
  `).run(nowMs, result.slice(0, 240), warningId);
}
