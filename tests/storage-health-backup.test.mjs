import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureEnterpriseSchemaOnDb } from "../lib/db-schema-readiness.ts";
import {
  automatedBackupDecision,
  getStorageHealthOnDb,
  runStorageHealthMaintenanceOnDb,
  storageWarningState,
} from "../lib/storage-health.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function sha(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("storage warning thresholds are deterministic and non-overlapping", () => {
  assert.equal(storageWarningState(null), "OK");
  assert.equal(storageWarningState(69.99), "OK");
  assert.equal(storageWarningState(70), "WARN_70");
  assert.equal(storageWarningState(85), "CRITICAL_85");
  assert.equal(storageWarningState(95), "EMERGENCY_95");
});

test("Railway backup automation is after-close, daily, and explicitly disableable", () => {
  const afterClose = Date.UTC(2026, 7, 20, 2, 0); // 22:00 ET on Aug 19
  assert.equal(automatedBackupDecision({ RAILWAY_PROJECT_ID: "p" }, afterClose, null).due, true);
  assert.equal(automatedBackupDecision({ RAILWAY_PROJECT_ID: "p" }, afterClose - 10 * 60 * 60_000, null).due, false);
  assert.equal(automatedBackupDecision({ RAILWAY_PROJECT_ID: "p", OPTISCAN_AUTOMATED_BACKUP_ENABLED: "0" }, afterClose, null).due, false);
  assert.equal(automatedBackupDecision({ RAILWAY_PROJECT_ID: "p" }, afterClose, afterClose - 60_000).reason, "BACKUP_ALREADY_EXISTS_FOR_ET_DAY");
});

test("storage maintenance samples hourly, transitions once, and live report is bounded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optiscan-storage-health-"));
  const dbFile = path.join(dir, "optiscan.db");
  const db = new Database(dbFile);
  try {
    db.pragma("journal_mode = WAL");
    ensureEnterpriseSchemaOnDb(db);
    const env = { ALERT_DB_DIR: dir };
    const t0 = Date.UTC(2026, 7, 19, 12);
    const first = runStorageHealthMaintenanceOnDb(db, env, t0);
    assert.equal(first.sampled, true);
    assert.equal(first.warningTransition?.state, "OK");
    const skipped = runStorageHealthMaintenanceOnDb(db, env, t0 + 10 * 60_000);
    assert.equal(skipped.sampled, false);
    const second = runStorageHealthMaintenanceOnDb(db, env, t0 + 2 * 60 * 60_000);
    assert.equal(second.sampled, true);
    assert.equal(second.warningTransition, null);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM storage_health_samples").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM storage_warning_events").get().n, 1);

    const report = getStorageHealthOnDb(db, env, t0 + 2 * 60 * 60_000);
    assert.equal(report.bounded, true);
    assert.equal(report.sqliteBusyEvents.coverage, "STORAGE_MONITOR_WRITES_ONLY");
    assert.equal(report.largestTableBytes.available, false);
    assert.equal(report.current.dbBytes > 0, true);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing canonical storage schema throws instead of returning silent empty evidence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optiscan-storage-missing-"));
  const db = new Database(path.join(dir, "optiscan.db"));
  try {
    assert.throws(() => getStorageHealthOnDb(db, { ALERT_DB_DIR: dir }), /storage_health_samples/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("online backup writes checksum and restore verification never overwrites source", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optiscan-backup-proof-"));
  const dbFile = path.join(dir, "optiscan.db");
  const db = new Database(dbFile);
  db.exec("CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO proof(value) VALUES ('phase-1');");
  db.close();
  const sourceBefore = sha(dbFile);
  const env = { ...process.env, ALERT_DB_DIR: dir, OPTISCAN_BACKUP_KEEP_COUNT: "2" };
  try {
    const backed = spawnSync(process.execPath, [path.join(root, "scripts", "backup-db.mjs")], {
      cwd: root, env, encoding: "utf8",
    });
    assert.equal(backed.status, 0, backed.stderr || backed.stdout);
    const backupDir = path.join(dir, "backups");
    const backup = fs.readdirSync(backupDir).find((name) => /^optiscan-.*\.db$/.test(name));
    assert.ok(backup);
    const backupPath = path.join(backupDir, backup);
    const meta = JSON.parse(fs.readFileSync(`${backupPath}.meta.json`, "utf8"));
    assert.equal(meta.kind, "SQLITE_ONLINE_BACKUP");
    assert.equal(meta.sha256, sha(backupPath));
    assert.equal(meta.bytes, fs.statSync(backupPath).size);

    const verified = spawnSync(process.execPath, [path.join(root, "scripts", "backup-db.mjs"), "--verify", backupPath], {
      cwd: root, env, encoding: "utf8",
    });
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    const record = JSON.parse(fs.readFileSync(path.join(backupDir, "last-restore-verification.json"), "utf8"));
    assert.equal(record.quickCheckResult, "ok");
    assert.equal(record.productionOverwritten, false);
    assert.equal(record.temporaryDestination, "OS_TEMPORARY_DESTINATION_REMOVED_AFTER_VERIFICATION");
    assert.equal(sha(dbFile), sourceBefore);

    const refused = spawnSync(process.execPath, [
      path.join(root, "scripts", "backup-db.mjs"), "--restore", backupPath, "--target", dbFile,
    ], { cwd: root, env, encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Refusing to overwrite configured live database/);
    assert.equal(sha(dbFile), sourceBefore);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
