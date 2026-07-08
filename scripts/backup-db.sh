#!/usr/bin/env bash
# backup-db.sh — nightly SQLite backup with 14-day retention (audit P1-6/T9).
#
# Uses sqlite3's online .backup (WAL-safe: consistent snapshot while the app
# keeps writing). Run from cron on the VPS host or inside the container:
#
#   host cron (02:30 ET nightly):
#     30 2 * * * docker compose -f /path/to/optiscan/docker-compose.yml \
#       exec -T optiscan /app/scripts/backup-db.sh >> /var/log/optiscan-backup.log 2>&1
#
#   or directly (bare-metal / dev):
#     30 2 * * * /path/to/optiscan/scripts/backup-db.sh
#
# Restore: stop the app, copy the dated file over data/optiscan.db (also delete
# optiscan.db-wal / optiscan.db-shm), start the app. Test a restore quarterly.
set -euo pipefail

DB_DIR="${ALERT_DB_DIR:-$(cd "$(dirname "$0")/.." && pwd)/data}"
DB_FILE="$DB_DIR/optiscan.db"
BACKUP_DIR="$DB_DIR/backups"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%F)"
OUT="$BACKUP_DIR/optiscan-$STAMP.db"

if [ ! -f "$DB_FILE" ]; then
  echo "[backup-db] no database at $DB_FILE — nothing to back up"
  exit 0
fi

mkdir -p "$BACKUP_DIR"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_FILE" ".backup '$OUT'"
else
  # Fallback: node + better-sqlite3 (same online-backup API), for images
  # without the sqlite3 CLI installed.
  node -e "
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1], { readonly: true });
    db.backup(process.argv[2]).then(() => { db.close(); }).catch((e) => { console.error(e); process.exit(1); });
  " "$DB_FILE" "$OUT"
fi

echo "[backup-db] wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Retention: keep the newest KEEP_DAYS dated backups.
find "$BACKUP_DIR" -name 'optiscan-*.db' -type f -mtime "+$KEEP_DAYS" -print -delete |
  sed 's/^/[backup-db] pruned /' || true

echo "[backup-db] done ($(ls "$BACKUP_DIR" | wc -l) backups retained)"
