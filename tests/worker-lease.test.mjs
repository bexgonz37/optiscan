import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireLease, heartbeatLease, releaseLease, leaseHolder, ensureLeaseTable, LOCK_STALE_MS,
} from "../lib/instance-lock.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }

const T0 = Date.parse("2026-07-11T15:00:00Z");

if (Database) {
  test("first acquire wins; a second pid is refused while the lease is fresh", () => {
    const db = new Database(":memory:"); ensureLeaseTable(db);
    const a = acquireLease(db, "scheduler", { pid: 100, nowMs: T0 });
    assert.equal(a.acquired, true);
    const b = acquireLease(db, "scheduler", { pid: 200, nowMs: T0 + 1000 });
    assert.equal(b.acquired, false);
    assert.equal(b.holder.pid, 100);
  });

  test("same pid re-acquire always succeeds (hot reload / repeated boot)", () => {
    const db = new Database(":memory:"); ensureLeaseTable(db);
    acquireLease(db, "scheduler", { pid: 100, nowMs: T0 });
    const again = acquireLease(db, "scheduler", { pid: 100, nowMs: T0 + 5000 });
    assert.equal(again.acquired, true);
  });

  test("a crashed owner's stale lease can be recovered by another worker", () => {
    const db = new Database(":memory:"); ensureLeaseTable(db);
    acquireLease(db, "scheduler", { pid: 100, nowMs: T0 });
    // pid 100 stops heartbeating; after the staleness window pid 200 takes over.
    const staleNow = T0 + LOCK_STALE_MS + 1;
    const taken = acquireLease(db, "scheduler", { pid: 200, nowMs: staleNow });
    assert.equal(taken.acquired, true);
    assert.equal(leaseHolder(db, "scheduler", staleNow).holder.pid, 200);
  });

  test("heartbeat keeps the lease fresh so it is NOT stolen", () => {
    const db = new Database(":memory:"); ensureLeaseTable(db);
    acquireLease(db, "scheduler", { pid: 100, nowMs: T0 });
    heartbeatLease(db, "scheduler", 100, T0 + LOCK_STALE_MS - 1000);
    const contender = acquireLease(db, "scheduler", { pid: 200, nowMs: T0 + LOCK_STALE_MS + 500 });
    // The heartbeat at T0+stale-1000 is still within staleness at T0+stale+500.
    assert.equal(contender.acquired, false, "fresh heartbeat blocks takeover");
  });

  test("leaseHolder reports freshness for the health surface", () => {
    const db = new Database(":memory:"); ensureLeaseTable(db);
    assert.equal(leaseHolder(db, "scheduler", T0).holder, null);
    acquireLease(db, "scheduler", { pid: 100, nowMs: T0 });
    const fresh = leaseHolder(db, "scheduler", T0 + 1000);
    assert.equal(fresh.holder.pid, 100);
    assert.equal(fresh.fresh, true);
    const stale = leaseHolder(db, "scheduler", T0 + LOCK_STALE_MS + 1);
    assert.equal(stale.fresh, false);
  });

  test("named leases are independent (scanner vs scheduler)", () => {
    const db = new Database(":memory:"); ensureLeaseTable(db);
    assert.equal(acquireLease(db, "scheduler", { pid: 100, nowMs: T0 }).acquired, true);
    assert.equal(acquireLease(db, "supervisor", { pid: 100, nowMs: T0 }).acquired, true);
    // A different pid can hold a DIFFERENT lease name concurrently.
    assert.equal(acquireLease(db, "other", { pid: 999, nowMs: T0 }).acquired, true);
  });

  test("release removes the lease so a fresh acquire succeeds immediately", () => {
    const db = new Database(":memory:"); ensureLeaseTable(db);
    acquireLease(db, "scheduler", { pid: 100, nowMs: T0 });
    releaseLease(db, "scheduler", 100);
    assert.equal(acquireLease(db, "scheduler", { pid: 200, nowMs: T0 + 100 }).acquired, true);
  });
}
