#!/usr/bin/env node
/**
 * WAL-safe OptiScan SQLite backup and non-production restore verification.
 *
 * Usage:
 *   node scripts/backup-db.mjs
 *   node scripts/backup-db.mjs --verify data/backups/optiscan-....db
 *   node scripts/backup-db.mjs --restore data/backups/optiscan-....db --target /explicit/non-production/path.db
 *
 * A restore command is refused when its target is the configured live database.
 * The acceptance drill always uses an OS-created temporary destination.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.ALERT_DB_DIR || path.join(root, "data"));
const dbPath = path.join(dataDir, "optiscan.db");
const backupDir = path.join(dataDir, "backups");
const keepCount = Math.max(1, Math.min(10, Number(process.env.OPTISCAN_BACKUP_KEEP_COUNT ?? 2) || 2));

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function resolveInput(file) {
  return path.resolve(process.cwd(), String(file));
}

function isLiveDatabase(file) {
  return path.resolve(file).toLowerCase() === path.resolve(dbPath).toLowerCase();
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
}

function pruneBackups() {
  const backups = fs.readdirSync(backupDir)
    .filter((name) => /^optiscan-.*\.db$/.test(name))
    .map((name) => ({ name, file: path.join(backupDir, name), mtime: fs.statSync(path.join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of backups.slice(keepCount)) {
    if (path.dirname(old.file) !== backupDir) throw new Error(`Refusing to prune outside backup directory: ${old.file}`);
    fs.rmSync(old.file, { force: true });
    fs.rmSync(`${old.file}.meta.json`, { force: true });
    console.log(`[backup-db] pruned ${old.name}`);
  }
}

async function backup() {
  fs.mkdirSync(backupDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    console.log(`[backup-db] no database at ${dbPath}; nothing to back up`);
    return null;
  }
  const out = path.join(backupDir, `optiscan-${timestamp()}.db`);
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(out);
  } finally {
    source.close();
  }
  const stat = fs.statSync(out);
  const sha256 = await sha256File(out);
  const metadata = {
    formatVersion: 1,
    kind: "SQLITE_ONLINE_BACKUP",
    file: path.basename(out),
    sourceFile: path.basename(dbPath),
    createdAtMs: Date.now(),
    bytes: stat.size,
    sha256,
    walSafe: true,
  };
  writeJson(`${out}.meta.json`, metadata);
  pruneBackups();
  console.log(`[backup-db] created ${out}`);
  console.log(`[backup-db] bytes=${stat.size} sha256=${sha256}`);
  return out;
}

function safeTemporaryDirectory() {
  const tempRoot = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, "optiscan-restore-verify-"));
  if (path.dirname(dir) !== tempRoot || !path.basename(dir).startsWith("optiscan-restore-verify-")) {
    throw new Error(`Unsafe temporary restore directory: ${dir}`);
  }
  return dir;
}

async function verifyRestore(sourceFile) {
  const source = resolveInput(sourceFile);
  if (!fs.existsSync(source)) throw new Error(`Backup not found: ${source}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const temporaryDirectory = safeTemporaryDirectory();
  const temporaryDestination = path.join(temporaryDirectory, "restored-optiscan.db");
  let quickCheckResult = "NOT_RUN";
  try {
    fs.copyFileSync(source, temporaryDestination);
    const sourceSha256 = await sha256File(source);
    const restoredSha256 = await sha256File(temporaryDestination);
    if (sourceSha256 !== restoredSha256) throw new Error("Temporary restore checksum does not match backup");
    const restored = new Database(temporaryDestination, { readonly: true, fileMustExist: true });
    try {
      quickCheckResult = String(restored.pragma("quick_check(1)", { simple: true }));
    } finally {
      restored.close();
    }
    if (quickCheckResult.toLowerCase() !== "ok") throw new Error(`SQLite quick_check failed: ${quickCheckResult}`);
    const record = {
      formatVersion: 1,
      verificationId: crypto.randomUUID(),
      backupFile: path.basename(source),
      backupCreatedAtMs: fs.statSync(source).mtimeMs,
      backupBytes: fs.statSync(source).size,
      sha256: sourceSha256,
      verifiedAtMs: Date.now(),
      temporaryDestination: "OS_TEMPORARY_DESTINATION_REMOVED_AFTER_VERIFICATION",
      quickCheckResult,
      productionOverwritten: false,
    };
    writeJson(path.join(backupDir, "last-restore-verification.json"), record);
    console.log(`[backup-db] restore verification passed for ${source}`);
    console.log(`[backup-db] quick_check=${quickCheckResult} productionOverwritten=false`);
    return record;
  } finally {
    if (path.dirname(temporaryDirectory) === path.resolve(os.tmpdir()) && path.basename(temporaryDirectory).startsWith("optiscan-restore-verify-")) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

async function restoreToExplicitTarget(sourceFile, targetFile) {
  if (!targetFile) throw new Error("--restore requires --target with an explicit non-production destination");
  const source = resolveInput(sourceFile);
  const target = resolveInput(targetFile);
  if (!fs.existsSync(source)) throw new Error(`Backup not found: ${source}`);
  if (isLiveDatabase(target)) throw new Error(`Refusing to overwrite configured live database: ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  console.log(`[backup-db] restored to explicit non-production target: ${target}`);
}

async function main() {
  const args = process.argv.slice(2);
  const verifyAt = args.indexOf("--verify");
  const restoreAt = args.indexOf("--restore");
  const targetAt = args.indexOf("--target");
  if (verifyAt >= 0) return verifyRestore(args[verifyAt + 1]);
  if (restoreAt >= 0) return restoreToExplicitTarget(args[restoreAt + 1], targetAt >= 0 ? args[targetAt + 1] : null);
  return backup();
}

main().catch((err) => {
  console.error(`[backup-db] ${String(err?.message ?? err)}`);
  process.exitCode = 1;
});
