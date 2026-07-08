import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// better-sqlite3 is a native module; when the platform binary can't load
// (e.g. CI container with a different-OS node_modules) the functional tests
// skip — the source spec test below still guards the pragma set.
let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  Database = null;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbSource = readFileSync(join(root, "lib/db.ts"), "utf8");

/**
 * SQLite concurrency hardening (audit P1-2/T6). getDb() cannot be imported
 * here (it uses the "@/" path alias), so we spec the source AND functionally
 * verify the exact pragma set on a real better-sqlite3 handle.
 */

test("getDb() sets every hardening pragma", () => {
  for (const pragma of [
    'db.pragma("journal_mode = WAL")',
    'db.pragma("busy_timeout = 5000")',
    'db.pragma("synchronous = NORMAL")',
    'db.pragma("foreign_keys = ON")',
    'db.pragma("wal_autocheckpoint = 1000")',
  ]) {
    assert.ok(dbSource.includes(pragma), `lib/db.ts getDb() must call ${pragma}`);
  }
});

function openHardened(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("wal_autocheckpoint = 1000");
  return db;
}

test("pragma set actually applies on a real database", (t) => {
  if (!Database) return t.skip("better-sqlite3 native binary unavailable on this platform");
  const dir = mkdtempSync(join(tmpdir(), "optiscan-db-test-"));
  const db = openHardened(join(dir, "t.db"));
  try {
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);
    assert.equal(db.pragma("synchronous", { simple: true }), 1); // NORMAL
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(db.pragma("wal_autocheckpoint", { simple: true }), 1000);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WAL: reader sees consistent data while a second connection writes", (t) => {
  if (!Database) return t.skip("better-sqlite3 native binary unavailable on this platform");
  const dir = mkdtempSync(join(tmpdir(), "optiscan-db-test-"));
  const file = join(dir, "t.db");
  const writer = openHardened(file);
  const reader = openHardened(file);
  try {
    writer.exec("CREATE TABLE marks (id INTEGER PRIMARY KEY, v REAL)");
    const ins = writer.prepare("INSERT INTO marks (v) VALUES (?)");
    for (let i = 0; i < 50; i++) ins.run(i);
    // Reads interleaved with writes must not throw "database is locked".
    const count = reader.prepare("SELECT COUNT(*) AS n FROM marks").get().n;
    assert.equal(count, 50);
    writer.prepare("INSERT INTO marks (v) VALUES (999)").run();
    assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM marks").get().n, 51);
  } finally {
    writer.close();
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write lock released -> queued writer succeeds (busy_timeout semantics)", (t) => {
  if (!Database) return t.skip("better-sqlite3 native binary unavailable on this platform");
  const dir = mkdtempSync(join(tmpdir(), "optiscan-db-test-"));
  const file = join(dir, "t.db");
  const a = openHardened(file);
  const b = openHardened(file);
  try {
    a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    a.exec("BEGIN IMMEDIATE");
    a.prepare("INSERT INTO t (v) VALUES ('a')").run();
    // b with zero timeout must fail fast while a holds the write lock...
    b.pragma("busy_timeout = 0");
    assert.throws(() => b.prepare("INSERT INTO t (v) VALUES ('b')").run(), /SQLITE_BUSY|locked/i);
    a.exec("COMMIT");
    // ...and succeed after the lock clears (what busy_timeout=5000 gives the
    // tracker automatically instead of a throw).
    b.pragma("busy_timeout = 5000");
    b.prepare("INSERT INTO t (v) VALUES ('b')").run();
    assert.equal(a.prepare("SELECT COUNT(*) AS n FROM t").get().n, 2);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
