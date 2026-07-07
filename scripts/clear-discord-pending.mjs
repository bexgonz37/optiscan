import Database from "better-sqlite3";

const db = new Database("data/optiscan.db");
const before = db
  .prepare(
    "SELECT COUNT(*) AS c FROM notification_events WHERE channel='discord_webhook' AND status='pending_confirm'",
  )
  .get().c;

db.prepare(
  `UPDATE notification_events SET status='skipped', error='superseded: auto-send enabled'
   WHERE channel='discord_webhook' AND status='pending_confirm'`,
).run();

db.prepare("UPDATE notification_settings SET discord_requires_manual_confirm=0 WHERE id=1").run();

db.prepare(
  `INSERT INTO scanner_settings (key, value) VALUES ('discord_discard_stale_pending_v1', '1')
   ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
).run();

const after = db
  .prepare(
    "SELECT COUNT(*) AS c FROM notification_events WHERE channel='discord_webhook' AND status='pending_confirm'",
  )
  .get().c;

const settings = db
  .prepare("SELECT discord_enabled, discord_requires_manual_confirm FROM notification_settings WHERE id=1")
  .get();

console.log(JSON.stringify({ settings, pendingBefore: before, pendingAfter: after }, null, 2));
