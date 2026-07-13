/**
 * improvement-store.ts — persistence for the controlled code-improvement agent
 * (Phase 9). Records IMMUTABLE, write-once improvement proposals and their
 * disposition, and reports the agent's honest state. It writes ONLY to
 * `improvement_proposals` — never a source file, threshold, risk limit, or
 * trading rule. There is no git/merge/push path here: when automation is not
 * configured, non-forbidden work is surfaced as READY_FOR_CODING_AGENT for a
 * human or coding agent to pick up.
 *
 * The `*OnDb` core takes a better-sqlite3 handle so it is unit-testable; the
 * public wrappers resolve `@/lib/db` lazily.
 */
import type { ImprovementProposal } from "./improvement/proposal.ts";
import {
  decideDisposition,
  automationContextFromEnv,
  ABSOLUTE_PROHIBITIONS,
  type AutomationContext,
  type Disposition,
} from "./improvement/policy.ts";

export interface StoredProposal {
  id: string;
  version: number;
  category: string;
  title: string;
  rationale: string;
  targetPaths: string[];
  risk: string;
  forbidden: boolean;
  forbiddenReasons: string[];
  branchName: string;
  disposition: Disposition;
  dispositionReasons: string[];
  sourceRecommendation: string | null;
  createdAtMs: number;
}

/**
 * Record a proposal write-once. The deterministic id is the PRIMARY KEY, so
 * re-recording the same proposal is a no-op (history is never rewritten). The
 * disposition is computed from the CURRENT automation context at record time.
 */
export function recordProposalOnDb(db: any, p: ImprovementProposal, ctx: AutomationContext): StoredProposal {
  const d = decideDisposition(p, ctx);
  db.prepare(
    `INSERT OR IGNORE INTO improvement_proposals
       (id, version, category, title, rationale, target_paths_json, risk, forbidden,
        forbidden_reasons_json, branch_name, disposition, disposition_reasons_json,
        source_recommendation, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    p.id, p.version, p.category, p.title, p.rationale, JSON.stringify(p.targetPaths),
    p.risk, p.forbidden ? 1 : 0, JSON.stringify(p.forbiddenReasons), p.branchName,
    d.disposition, JSON.stringify(d.reasons), p.sourceRecommendation, p.createdAtMs,
  );
  const row = db.prepare("SELECT * FROM improvement_proposals WHERE id=?").get(p.id);
  return rowToStored(row);
}

function safeParse(raw: any): any[] {
  if (!raw) return [];
  try { const o = JSON.parse(raw); return Array.isArray(o) ? o : []; } catch { return []; }
}

function rowToStored(r: any): StoredProposal {
  return {
    id: r.id,
    version: r.version,
    category: r.category,
    title: r.title,
    rationale: r.rationale,
    targetPaths: safeParse(r.target_paths_json),
    risk: r.risk,
    forbidden: Boolean(r.forbidden),
    forbiddenReasons: safeParse(r.forbidden_reasons_json),
    branchName: r.branch_name,
    disposition: r.disposition,
    dispositionReasons: safeParse(r.disposition_reasons_json),
    sourceRecommendation: r.source_recommendation ?? null,
    createdAtMs: r.created_at_ms,
  };
}

export function listProposalsOnDb(db: any, limit = 100): StoredProposal[] {
  const rows = db.prepare("SELECT * FROM improvement_proposals ORDER BY created_at_ms DESC, id DESC LIMIT ?").all(limit) as any[];
  return rows.map(rowToStored);
}

export type ImprovementAgentState = "INACTIVE_NO_AUTOMATION" | "ACTIVE_PROPOSE_ONLY" | "ACTIVE_AUTO_MERGE_LOW_RISK";

export interface ImprovementStatus {
  agentState: ImprovementAgentState;
  automationAvailable: boolean;
  autoMergeEnabled: boolean;
  blockers: string[];
  prohibitions: string[];
  counts: Record<string, number>;
  proposals: StoredProposal[];
}

/**
 * The agent's honest state. With no automation wired up it is
 * INACTIVE_NO_AUTOMATION and the recorded blocker explains exactly what is
 * missing; proposals still get recorded and surfaced as READY_FOR_CODING_AGENT.
 */
export function improvementStatusOnDb(db: any, env: NodeJS.ProcessEnv = process.env): ImprovementStatus {
  const ctx = automationContextFromEnv(env);
  const proposals = listProposalsOnDb(db);

  const counts: Record<string, number> = { total: proposals.length };
  for (const p of proposals) counts[p.disposition] = (counts[p.disposition] ?? 0) + 1;

  const blockers: string[] = [];
  let agentState: ImprovementAgentState;
  if (!ctx.automationAvailable) {
    agentState = "INACTIVE_NO_AUTOMATION";
    blockers.push("No coding-agent / GitHub automation configured (IMPROVEMENT_AUTOMATION!=1). Proposals are recorded and surfaced as READY_FOR_CODING_AGENT; nothing is branched, merged, or pushed automatically.");
    blockers.push("Branch protection / required reviews on `main` must be configured manually in GitHub — this agent does not assume or request those permissions.");
  } else if (ctx.autoMergeEnabled) {
    agentState = "ACTIVE_AUTO_MERGE_LOW_RISK";
  } else {
    agentState = "ACTIVE_PROPOSE_ONLY";
  }

  return {
    agentState,
    automationAvailable: ctx.automationAvailable,
    autoMergeEnabled: ctx.autoMergeEnabled,
    blockers,
    prohibitions: [...ABSOLUTE_PROHIBITIONS],
    counts,
    proposals,
  };
}

// ── Public wrappers (lazy @/lib/db) ──────────────────────────────────────────

function lazyDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/lib/db");
  return getDb();
}

export function recordProposal(p: ImprovementProposal): StoredProposal {
  return recordProposalOnDb(lazyDb(), p, automationContextFromEnv());
}

export function listProposals(limit = 100): StoredProposal[] {
  try { return listProposalsOnDb(lazyDb(), limit); } catch { return []; }
}

export function improvementStatus(): ImprovementStatus {
  try { return improvementStatusOnDb(lazyDb()); } catch (err: any) {
    return {
      agentState: "INACTIVE_NO_AUTOMATION",
      automationAvailable: false,
      autoMergeEnabled: false,
      blockers: [`Improvement status unavailable: ${err?.message}`],
      prohibitions: [...ABSOLUTE_PROHIBITIONS],
      counts: { total: 0 },
      proposals: [],
    };
  }
}
