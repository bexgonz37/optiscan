#!/usr/bin/env bash
# Nightly Railway/VPS entry point. The Node implementation uses SQLite's online
# backup API, writes checksum metadata, applies count-based retention, and owns
# the safe temporary restore-verification command.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/backup-db.mjs" "$@"
