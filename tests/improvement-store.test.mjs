import test from "node:test";
import assert from "node:assert/strict";
import { buildProposal } from "../lib/improvement/proposal.ts";
import { recordProposalOnDb, listProposalsOnDb, improvementStatusOnDb } from "../lib/improvement-store.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  Database = null;
}

const DDL = `
CREATE TABLE IF NOT EXISTS improvement_proposals (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
  rationale TEXT NOT NULL, target_paths_json TEXT NOT NULL, risk TEXT NOT NULL,
  forbidden INTEGER NOT NULL DEFAULT 0, forbidden_reasons_json TEXT, branch_name TEXT NOT NULL,
  disposition TEXT NOT NULL, disposition_reasons_json TEXT, source_recommendation TEXT,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`;

const NOW = Date.parse("2026-07-11T14:30:00Z");
const OFF = { automationAvailable: false, autoMergeEnabled: false };
const p = (over) => buildProposal({ category: "test_coverage", title: "add tests", rationale: "cover foo", targetPaths: ["lib/foo.ts"], createdAtMs: NOW, ...over });

if (Database) {
  test("record then list; disposition computed at record time", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    const stored = recordProposalOnDb(db, p(), OFF);
    assert.equal(stored.disposition, "READY_FOR_CODING_AGENT");
    const list = listProposalsOnDb(db);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, stored.id);
    assert.deepEqual(list[0].targetPaths, ["lib/foo.ts"]);
  });

  test("proposals are write-once (immutable) — re-recording is a no-op", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    const a = p();
    recordProposalOnDb(db, a, OFF);
    // Re-record the SAME id under a DIFFERENT context; the stored row must not change.
    recordProposalOnDb(db, a, { automationAvailable: true, autoMergeEnabled: true });
    const rows = listProposalsOnDb(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].disposition, "READY_FOR_CODING_AGENT", "original disposition preserved");
  });

  test("a forbidden proposal records as BLOCKED", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    const stored = recordProposalOnDb(db, p({ category: "live_execution", title: "x", rationale: "y" }), { automationAvailable: true, autoMergeEnabled: true });
    assert.equal(stored.disposition, "BLOCKED");
    assert.equal(stored.forbidden, true);
  });

  test("status: no automation ⇒ INACTIVE_NO_AUTOMATION with recorded blockers + prohibitions", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    recordProposalOnDb(db, p(), OFF);
    const st = improvementStatusOnDb(db, {});
    assert.equal(st.agentState, "INACTIVE_NO_AUTOMATION");
    assert.equal(st.automationAvailable, false);
    assert.ok(st.blockers.some((b) => /automation/i.test(b)));
    assert.ok(st.blockers.some((b) => /branch protection/i.test(b)));
    assert.ok(st.prohibitions.length >= 5);
    assert.equal(st.counts.total, 1);
    assert.equal(st.counts.READY_FOR_CODING_AGENT, 1);
  });

  test("status: automation + auto-merge ⇒ ACTIVE_AUTO_MERGE_LOW_RISK", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    const st = improvementStatusOnDb(db, { IMPROVEMENT_AUTOMATION: "1", IMPROVEMENT_AUTO_MERGE: "1" });
    assert.equal(st.agentState, "ACTIVE_AUTO_MERGE_LOW_RISK");
  });
}

test("store writes ONLY to improvement_proposals — never code, thresholds, or rules (source-spec)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(root, "lib/improvement-store.ts"), "utf8");
  // The only INSERT/UPDATE/DELETE target is improvement_proposals.
  const writes = src.match(/\b(INSERT|UPDATE|DELETE)\b[^;]*/gi) ?? [];
  assert.ok(writes.length > 0, "has at least one write");
  for (const w of writes) assert.ok(/improvement_proposals/i.test(w), `unexpected write target: ${w}`);
  // No git/merge/push side effects.
  assert.ok(!/child_process|execSync|spawn|git push|force/i.test(src), "no shell/git side effects");
});
