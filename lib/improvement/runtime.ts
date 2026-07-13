/**
 * improvement/runtime.ts — Next-only glue for the code-improvement agent (Phase 9).
 *
 * Scans the repo for a CONCRETE, checkable fact (top-level `lib/*.ts` modules with
 * no same-named `tests/*.test.mjs`), turns each into an immutable LOW-risk
 * test-coverage proposal, and records it write-once. It NEVER edits code, creates
 * branches, merges, or pushes — recording a proposal is the only side effect.
 *
 * Uses `@/` imports so it only runs inside Next (never imported by the pure test
 * runner). The pure classification/policy live in ./proposal, ./policy, ./audit.
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { proposalsFromAudit } from "./audit";
import { recordProposal, improvementStatus, type ImprovementStatus } from "@/lib/improvement-store";

/** Top-level `lib/*.ts` modules that have no `tests/<base>.test.mjs`. */
function untestedTopLevelModules(root: string, cap = 25): string[] {
  const libDir = join(root, "lib");
  let entries: string[] = [];
  try { entries = readdirSync(libDir); } catch { return []; }
  const out: string[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
    const base = name.replace(/\.ts$/, "");
    const testFile = join(root, "tests", `${base}.test.mjs`);
    if (!existsSync(testFile)) out.push(`lib/${name}`);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Generate + record test-coverage proposals from the current repo state, then
 * return the honest agent status. Deterministic given the filesystem.
 */
export function runImprovementAudit(nowMs = Date.now()): ImprovementStatus {
  const root = process.cwd();
  const modulesWithoutTests = untestedTopLevelModules(root);
  const proposals = proposalsFromAudit({ modulesWithoutTests, nowMs });
  for (const p of proposals) {
    try { recordProposal(p); } catch { /* never fail the request over a single record */ }
  }
  return improvementStatus();
}
