# OptiScan local database backup

OptiScan stores its local SQLite database at `data/optiscan.db` by default, or
under `ALERT_DB_DIR` when that environment variable is set.

Create a timestamped backup:

```powershell
node scripts/backup-db.mjs
```

Restore from a backup:

```powershell
node scripts/backup-db.mjs --restore data/backups/optiscan-YYYYMMDD-HHMMSS.db
```

Restore first creates a `pre-restore-*` backup of the current database. The
script copies `-wal` and `-shm` sidecar files when they exist and never prints
environment variable values or webhook URLs.
