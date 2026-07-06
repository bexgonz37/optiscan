import Database from "better-sqlite3";
const db = new Database("data/optiscan.db");
const s = db.prepare("SELECT discord_enabled, discord_requires_manual_confirm FROM notification_settings WHERE id=1").get();
const pending = db.prepare("SELECT count(*) as c FROM notification_events WHERE status='pending_confirm'").get();
const auto = db.prepare("SELECT value FROM scanner_settings WHERE key='discord_auto_defaults_v1'").get();
console.log(JSON.stringify({ settings: s, pending: pending.c, migration: auto?.value ?? null }, null, 2));
