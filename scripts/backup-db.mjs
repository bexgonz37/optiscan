#!/usr/bin/env node
/**
 * Backup / restore the local OptiScan SQLite database.
 *
 * Usage:
 *   node scripts/backup-db.mjs
 *   node scripts/backup-db.mjs --restore data/backups/optiscan-20260710-120000.db
 *
 * The script never reads or prints environment variables. It also backs up WAL
 * sidecars when present so long-running dev sessions can be restored cleanly.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dataDir = process.env.ALERT_DB_DIR || path.join(root, "data");
const dbPath = path.join(dataDir, "optiscan.db");
const backupDir = path.join(dataDir, "backups");

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "-",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join("");
}

function copyIfExists(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.copyFileSync(from, to);
  return true;
}

function backup(label = timestamp()) {
  fs.mkdirSync(backupDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    console.log(`No database found at ${dbPath}; nothing to back up.`);
    return null;
  }
  const base = path.join(backupDir, `optiscan-${label}.db`);
  copyIfExists(dbPath, base);
  copyIfExists(`${dbPath}-wal`, `${base}-wal`);
  copyIfExists(`${dbPath}-shm`, `${base}-shm`);
  console.log(`Backup created: ${base}`);
  return base;
}

function restore(src) {
  if (!src) throw new Error("Missing backup path after --restore");
  const resolved = path.resolve(root, src);
  if (!fs.existsSync(resolved)) throw new Error(`Backup not found: ${resolved}`);
  fs.mkdirSync(dataDir, { recursive: true });
  backup(`pre-restore-${timestamp()}`);
  copyIfExists(resolved, dbPath);
  copyIfExists(`${resolved}-wal`, `${dbPath}-wal`);
  copyIfExists(`${resolved}-shm`, `${dbPath}-shm`);
  console.log(`Restored database from: ${resolved}`);
}

const args = process.argv.slice(2);
const restoreIdx = args.indexOf("--restore");
if (restoreIdx >= 0) restore(args[restoreIdx + 1]);
else backup();
