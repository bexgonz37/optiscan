import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  acquireScannerLock,
  heartbeatScannerLock,
  releaseScannerLock,
  LOCK_STALE_MS,
} from "../lib/instance-lock.ts";

// Native module may not load on foreign-platform node_modules; functional
// tests then run on an in-memory shim with identical single-row semantics.
let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  Database = null;
}

/** Minimal single-row shim matching the DbLike surface instance-lock uses. */
function memoryDb() {
  let row = null;
  return {
    exec() {},
    prepare(sql) {
      if (sql.startsWith("SELECT")) return { get: () => (row ? { ...row } : undefined), run() {} };
      if (sql.startsWith("INSERT")) {
        return {
          get() {},
          run(pid, hostname, started, beat) {
            row = { pid, hostname, started_at: started, heartbeat_at: beat };
          },
        };
      }
      if (sql.startsWith("UPDATE")) {
        return {
          get() {},
          run(beat, pid) {
            if (row && row.pid === pid) row.heartbeat_at = beat;
          },
        };
      }
      if (sql.startsWith("DELETE")) {
        return {
          get() {},
          run(pid) {
            if (row && row.pid === pid) row = null;
          },
        };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

function openDb(ctx) {
  if (Database) {
    ctx.dir = mkdtempSync(join(tmpdir(), "optiscan-lock-test-"));
    return new Database(join(ctx.dir, "t.db"));
  }
  return memoryDb();
}

function closeDb(db, ctx) {
  if (Database && db.close) db.close();
  if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true });
}

const NOW = 1_800_000_000_000;

test("first boot acquires the lock", () => {
  const ctx = {};
  const db = openDb(ctx);
  try {
    const res = acquireScannerLock(db, { pid: 100, nowMs: NOW });
    assert.equal(res.acquired, true);
  } finally {
    closeDb(db, ctx);
  }
});

test("second process with a FRESH lock is refused and sees the holder", () => {
  const ctx = {};
  const db = openDb(ctx);
  try {
    acquireScannerLock(db, { pid: 100, nowMs: NOW });
    const res = acquireScannerLock(db, { pid: 200, nowMs: NOW + 5000 });
    assert.equal(res.acquired, false);
    assert.equal(res.holder?.pid, 100);
  } finally {
    closeDb(db, ctx);
  }
});

test("same pid re-acquires (dev hot reload)", () => {
  const ctx = {};
  const db = openDb(ctx);
  try {
    acquireScannerLock(db, { pid: 100, nowMs: NOW });
    const res = acquireScannerLock(db, { pid: 100, nowMs: NOW + 5000 });
    assert.equal(res.acquired, true);
  } finally {
    closeDb(db, ctx);
  }
});

test("stale lock (crashed holder) is taken over", () => {
  const ctx = {};
  const db = openDb(ctx);
  try {
    acquireScannerLock(db, { pid: 100, nowMs: NOW });
    const res = acquireScannerLock(db, { pid: 200, nowMs: NOW + LOCK_STALE_MS + 1 });
    assert.equal(res.acquired, true);
  } finally {
    closeDb(db, ctx);
  }
});

test("heartbeat keeps the lock fresh; only the owner can beat", () => {
  const ctx = {};
  const db = openDb(ctx);
  try {
    acquireScannerLock(db, { pid: 100, nowMs: NOW });
    heartbeatScannerLock(db, 100, NOW + LOCK_STALE_MS); // owner refresh
    const refused = acquireScannerLock(db, { pid: 200, nowMs: NOW + LOCK_STALE_MS + 1000 });
    assert.equal(refused.acquired, false, "refreshed lock must still hold");
    heartbeatScannerLock(db, 999, NOW + 10 * LOCK_STALE_MS); // non-owner: no-op
    const taken = acquireScannerLock(db, { pid: 200, nowMs: NOW + 2 * LOCK_STALE_MS + 1000 });
    assert.equal(taken.acquired, true, "non-owner heartbeat must not extend the lock");
  } finally {
    closeDb(db, ctx);
  }
});

test("release lets the next process in immediately", () => {
  const ctx = {};
  const db = openDb(ctx);
  try {
    acquireScannerLock(db, { pid: 100, nowMs: NOW });
    releaseScannerLock(db, 100);
    const res = acquireScannerLock(db, { pid: 200, nowMs: NOW + 1000 });
    assert.equal(res.acquired, true);
  } finally {
    closeDb(db, ctx);
  }
});

test("startScannerLoop wires the advisory lock (source spec)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(root, "lib/scanner-loop.ts"), "utf8");
  assert.ok(src.includes("acquireScannerLock"), "loop must attempt the advisory lock before starting");
  assert.ok(src.includes("heartbeatScannerLock"), "loop must heartbeat the lock");
  const startIdx = src.indexOf("export function startScannerLoop");
  const lockIdx = src.indexOf("acquireScannerLock", startIdx);
  const runningIdx = src.indexOf("s.running = true", startIdx);
  assert.ok(lockIdx > -1 && lockIdx < runningIdx, "lock check must happen before s.running = true");
});
