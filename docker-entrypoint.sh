#!/bin/sh
# OptiScan container entrypoint.
#
# Runs as root only long enough to guarantee the persistent data directory
# (the SQLite volume mount, e.g. Railway's volume at /app/data) is writable by
# the unprivileged `nodejs` user, then drops privileges via gosu and execs the
# standalone Next server. This makes the same image work whether the volume is
# mounted root-owned (managed platforms) or already owned by nodejs (plain VPS).
set -e

DATA_DIR="${ALERT_DB_DIR:-/app/data}"
mkdir -p "$DATA_DIR"
# Best-effort: never fail boot if the platform disallows chown on the mount.
chown -R nodejs:nodejs "$DATA_DIR" 2>/dev/null || true
# Log the resolved DB location for production diagnostics (no secrets).
echo "[optiscan] SQLite directory: ${DATA_DIR} (file: ${DATA_DIR}/optiscan.db)"

# Exec so the Node process is PID 1 and receives signals (graceful shutdown).
exec gosu nodejs "$@"
