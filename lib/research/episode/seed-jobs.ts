/**
 * lib/research/episode/seed-jobs.ts — asynchronous seed-run job model (Analog Engine, Phase E.3).
 *
 * The prior route ran the WHOLE historical replay synchronously inside the HTTP request, so a
 * 10-symbol / 6-month pilot (~60 rate-limited provider calls) blocked past the gateway timeout
 * and never returned. This turns seeding into a background job:
 *   • createSeedRun  — inserts a QUEUED run row and returns immediately (idempotent per params).
 *   • runSeedWorker  — a background loop (fired un-awaited from POST) that processes one symbol
 *                      per step and PERSISTS PROGRESS after every chunk + every symbol.
 *   • advanceSeedRun — one unit of work; the resumable, restart-safe core.
 *   • getSeedRunProgress / cancel / pause / resume — control + observability.
 *
 * The worker lives in the server process, so a CLIENT DISCONNECT never touches it. A SERVER
 * restart is recovered by resumeInterruptedSeedRuns (re-kicks QUEUED/RUNNING runs). Runs are
 * resumable (symbol-level checkpoint) and idempotent (episode INSERT OR IGNORE; duplicate POST
 * returns the existing active run). All provenance / survivorship / quota / flag / kill-switch
 * rules from the synchronous driver are preserved.
 */
import { researchFlags } from "../flags.ts";
import { seedSymbolOnDb, defaultSeedConfig, type SeedConfig } from "./seed.ts";
import { fetchHistoricalStockBars, replayDateWindows, type FetchBarsResult, type ChunkDetail } from "./../replay-provider.ts";
import { slog, timed } from "./seed-log.ts";

export type JobStatus = "QUEUED" | "RUNNING" | "PAUSED" | "PARTIAL" | "FAILED" | "COMPLETED" | "CANCELED";
const TERMINAL = new Set<JobStatus>(["PARTIAL", "FAILED", "COMPLETED", "CANCELED"]);

export type PerSymbolStatus = "OK" | "INCOMPLETE" | "NO_DATA" | "PROVIDER_ERROR" | "NO_PROVIDER";
export interface PerSymbolProgress { symbol: string; status: PerSymbolStatus; bars: number; episodes: number; labels: number; chunks: number; succeededChunks: number; rangeComplete: boolean; truncated: boolean; firstBarMs: number | null; lastBarMs: number | null; note: string }
interface Checkpoint { doneSymbols: string[]; perSymbol: PerSymbolProgress[]; errors: Array<{ symbol: string; note: string }> }

interface JobDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number } } }

/** Provider fetch (chunked) — same shape as fetchHistoricalStockBars; injectable for tests. */
export type FetchBarsFn = (symbol: string, opts: { from: string; to: string; timespan?: string; multiplier?: number; onChunk?: (d: ChunkDetail & { index: number; total: number }) => void; checkAbort?: () => boolean }, env: NodeJS.ProcessEnv) => Promise<FetchBarsResult>;
export interface SeedJobDeps { fetchBars?: FetchBarsFn }

export interface CreateSeedRunOpts {
  symbols: string[]; from: string; to: string; timespan?: string; config?: SeedConfig;
  providerCallBudget?: number; rateLimitMs?: number; maxSymbols?: number;
  universeSource: string; survivorshipBias: boolean;
}

// Workers actively looping in THIS process — prevents a duplicate worker for the same run and
// lets a status poll detect an orphaned (post-restart) run and re-kick it.
const ACTIVE = new Set<string>();
export function isSeedRunActive(runId: string): boolean { return ACTIVE.has(runId); }

const now = () => Date.now();
const parse = (s: any): any => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function djb2(s: string): string { let h = 5381; for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }

export function seedExperimentId(o: { symbols: string[]; from: string; to: string; config?: SeedConfig; universeSource: string; survivorshipBias: boolean }): string {
  const key = [[...o.symbols].map((s) => s.toUpperCase()).sort().join(","), o.from, o.to, (o.config ?? defaultSeedConfig()).configVersion, o.universeSource, o.survivorshipBias ? 1 : 0].join("|");
  return `seed_${djb2(key)}`;
}

const emptyCheckpoint = (): Checkpoint => ({ doneSymbols: [], perSymbol: [], errors: [] });

export interface CreateSeedRunResult { runId: string | null; status: JobStatus | "SKIPPED"; existing: boolean; reason?: string }

/** Insert a QUEUED run (idempotent per experiment id). Does NO provider work. */
export function createSeedRun(db: JobDb, opts: CreateSeedRunOpts, env: NodeJS.ProcessEnv = process.env, nowMs: number = now()): CreateSeedRunResult {
  const f = researchFlags(env);
  if (env.EPISODE_SEED_KILL === "1") return { runId: null, status: "SKIPPED", existing: false, reason: "kill switch engaged (EPISODE_SEED_KILL=1)" };
  if (!f.historicalReplay || !f.episodeCapture) return { runId: null, status: "SKIPPED", existing: false, reason: "requires HISTORICAL_REPLAY_ENABLED=1 and EPISODE_CAPTURE_ENABLED=1" };
  if (!opts.symbols?.length) return { runId: null, status: "SKIPPED", existing: false, reason: "no survivorship-free universe supplied" };

  const symbols = opts.symbols.slice(0, Math.max(1, opts.maxSymbols ?? 500)).map((s) => s.toUpperCase());
  const expId = seedExperimentId({ ...opts, symbols });
  const existing = db.prepare("SELECT run_id, status FROM replay_runs WHERE experiment_id=? AND status IN ('QUEUED','RUNNING') ORDER BY created_at_ms DESC LIMIT 1").get(expId) as any;
  if (existing) return { runId: existing.run_id, status: existing.status as JobStatus, existing: true };

  const cfg = opts.config ?? defaultSeedConfig();
  const chunksPerSymbol = Math.max(1, replayDateWindows(opts.from, opts.to).length);
  const budget = opts.providerCallBudget ?? symbols.length * chunksPerSymbol;
  const provenance = { universeSource: opts.universeSource, survivorshipBias: opts.survivorshipBias, rateLimitMs: Math.max(0, opts.rateLimitMs ?? 200) };
  const runId = `episode_seed_${nowMs}_${djb2(expId + nowMs)}`;
  db.prepare(
    `INSERT INTO replay_runs (run_id, experiment_id, asset_class, symbols_json, date_from, date_to, timespan, strategy_version, config_json, status, checkpoint_json, provider_call_budget, provider_limitations, symbols_total, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(runId, expId, "stock", JSON.stringify(symbols), opts.from, opts.to, opts.timespan ?? "minute", cfg.configVersion, JSON.stringify(cfg), "QUEUED", JSON.stringify(emptyCheckpoint()), budget, JSON.stringify(provenance), symbols.length, nowMs, nowMs);
  return { runId, status: "QUEUED", existing: false };
}

function computeFinal(checkpoint: Checkpoint, symbolsTotal: number): { status: JobStatus; error: string | null } {
  const per = checkpoint.perSymbol;
  const attempted = per.reduce((a, s) => a + s.chunks, 0);
  const withData = per.filter((s) => s.status === "OK" || s.status === "INCOMPLETE").length;
  const anyIncomplete = per.some((s) => s.status === "INCOMPLETE");
  const anyError = checkpoint.errors.length > 0 || per.some((s) => s.status === "PROVIDER_ERROR");
  const cutShort = checkpoint.doneSymbols.length < symbolsTotal;
  if (attempted === 0) return { status: "FAILED", error: "no provider calls were attempted — stock replay INACTIVE or provider unavailable" };
  if (withData === 0) return { status: "FAILED", error: "provider called but returned no bars for any symbol (check range/timespan/entitlement)" };
  if (cutShort || anyIncomplete || anyError || withData < checkpoint.doneSymbols.length) {
    return { status: "PARTIAL", error: `partial coverage — ${cutShort ? `${symbolsTotal - checkpoint.doneSymbols.length} symbol(s) not processed (budget/limit); ` : ""}${anyIncomplete ? "incomplete/truncated range on some symbols; " : ""}${anyError ? "some symbols errored; " : ""}re-run to complete (idempotent)`.trim() };
  }
  return { status: "COMPLETED", error: null };
}

function finalize(db: JobDb, runId: string, checkpoint: Checkpoint, symbolsTotal: number): { done: true; status: JobStatus } {
  const { status, error } = computeFinal(checkpoint, symbolsTotal);
  db.prepare("UPDATE replay_runs SET status=?, error=?, current_symbol=NULL, lease_owner=NULL, lease_until_ms=NULL, updated_at_ms=? WHERE run_id=?").run(status, error, now(), runId);
  slog("job_done", { runId, status });
  return { done: true, status };
}

/** True when the run has a persisted cancel request (cheap single-column read). */
function isRunCanceled(db: JobDb, runId: string): boolean {
  const r = db.prepare("SELECT cancel_requested FROM replay_runs WHERE run_id=?").get(runId) as any;
  return r?.cancel_requested === 1;
}

/** Terminal CANCELED transition that ALWAYS clears lease ownership. */
function finalizeCanceled(db: JobDb, runId: string, nowMs: number = now(), reason = "canceled by operator"): { done: true; status: JobStatus } {
  db.prepare("UPDATE replay_runs SET status='CANCELED', error=?, current_symbol=NULL, lease_owner=NULL, lease_until_ms=NULL, updated_at_ms=? WHERE run_id=?").run(reason, nowMs, runId);
  slog("job_done", { runId, status: "CANCELED", reason });
  return { done: true, status: "CANCELED" };
}

/** One unit of work: process the next unprocessed symbol (all its chunks). Restart-safe. */
export async function advanceSeedRun(db: JobDb, runId: string, env: NodeJS.ProcessEnv = process.env, deps: SeedJobDeps = {}, nowMs: number = now()): Promise<{ done: boolean; status: JobStatus }> {
  const row = db.prepare("SELECT * FROM replay_runs WHERE run_id=?").get(runId) as any;
  if (!row) return { done: true, status: "FAILED" };
  const status = row.status as JobStatus;
  if (TERMINAL.has(status) || status === "PAUSED") return { done: true, status };
  // Cancellation is checked BEFORE any recovery/provider work, and finalizing clears the lease.
  if (row.cancel_requested === 1) return finalizeCanceled(db, runId, nowMs);
  if (env.EPISODE_SEED_KILL === "1") { db.prepare("UPDATE replay_runs SET status='PAUSED', error='kill switch engaged (EPISODE_SEED_KILL=1)', updated_at_ms=? WHERE run_id=?").run(nowMs, runId); return { done: true, status: "PAUSED" }; }
  const f = researchFlags(env);
  if (!f.historicalReplay || !f.episodeCapture) { db.prepare("UPDATE replay_runs SET status='FAILED', error='flags disabled mid-run (HISTORICAL_REPLAY_ENABLED / EPISODE_CAPTURE_ENABLED)', updated_at_ms=? WHERE run_id=?").run(nowMs, runId); return { done: true, status: "FAILED" }; }

  const symbols: string[] = parse(row.symbols_json) ?? [];
  const checkpoint: Checkpoint = parse(row.checkpoint_json) ?? emptyCheckpoint();
  const doneSet = new Set(checkpoint.doneSymbols);
  const next = symbols.find((s) => !doneSet.has(s));
  if (!next) return finalize(db, runId, checkpoint, row.symbols_total ?? symbols.length);

  const attempted = row.provider_calls_attempted ?? 0;
  const budget = row.provider_call_budget ?? symbols.length;
  if (budget > 0 && attempted >= budget) return finalize(db, runId, checkpoint, row.symbols_total ?? symbols.length);

  const cfg: SeedConfig = parse(row.config_json) ?? defaultSeedConfig();
  const timespan = row.timespan ?? "minute";
  db.prepare("UPDATE replay_runs SET status='RUNNING', current_symbol=?, started_at_ms=COALESCE(started_at_ms, ?), updated_at_ms=? WHERE run_id=?").run(next, nowMs, nowMs, runId);

  const baseChunks = checkpoint.perSymbol.reduce((a, s) => a + s.chunks, 0);
  const fetchBars: FetchBarsFn = deps.fetchBars ?? ((sym, o, e) => fetchHistoricalStockBars(sym, o, e));
  // PERSIST AFTER EVERY CHUNK: absolute counters derived from base + local index (no drift).
  const onChunk = (d: ChunkDetail & { index: number; total: number }) => {
    db.prepare("UPDATE replay_runs SET chunks_completed=?, provider_calls_attempted=?, updated_at_ms=? WHERE run_id=?").run(baseChunks + d.index + 1, baseChunks + d.index + 1, now(), runId);
  };

  // Re-check cancellation immediately BEFORE the provider call — the flag may have been set after
  // we claimed/marked RUNNING. If so, no provider call is made at all.
  if (isRunCanceled(db, runId)) return finalizeCanceled(db, runId, now());

  let r: FetchBarsResult;
  try {
    // checkAbort lets the chunked fetch stop before the NEXT provider call once cancellation lands.
    r = await timed("provider_call_start", { runId, symbol: next }, () => fetchBars(next, { from: row.date_from, to: row.date_to, timespan, multiplier: 1, onChunk, checkAbort: () => isRunCanceled(db, runId) }, env));
  } catch (err: any) {
    r = { bars: [], providerCalls: 1, succeeded: false, note: `fetch threw: ${String(err?.message ?? err).slice(0, 160)}`, chunks: 1, rangeComplete: false, truncated: false, firstBarMs: null, lastBarMs: null, chunkDetail: [{ from: row.date_from, to: row.date_to, bars: 0, succeeded: false, truncated: false }], aborted: false };
  }

  // Cancellation observed during the fetch (chunk-boundary abort) or persisted meanwhile → stop now.
  if (r.aborted || isRunCanceled(db, runId)) return finalizeCanceled(db, runId, now());

  const succeededChunks = r.chunkDetail?.filter((c) => c.succeeded).length ?? (r.succeeded ? (r.chunks ?? 1) : 0);
  let ep = 0, lab = 0, pstatus: PerSymbolStatus;
  if (r.providerCalls === 0) pstatus = "NO_PROVIDER";
  else if (r.bars.length === 0) pstatus = r.succeeded ? "NO_DATA" : "PROVIDER_ERROR";
  else { const s = seedSymbolOnDb(db as any, next, r.bars, cfg, nowMs); ep = s.episodesCaptured; lab = s.labels; pstatus = (r.rangeComplete ?? true) ? "OK" : "INCOMPLETE"; }

  checkpoint.perSymbol.push({ symbol: next, status: pstatus, bars: r.bars.length, episodes: ep, labels: lab, chunks: r.chunks ?? r.providerCalls, succeededChunks, rangeComplete: r.rangeComplete ?? true, truncated: r.truncated ?? false, firstBarMs: r.firstBarMs ?? null, lastBarMs: r.lastBarMs ?? null, note: r.note });
  checkpoint.doneSymbols.push(next);
  if (pstatus === "PROVIDER_ERROR" || pstatus === "NO_PROVIDER") checkpoint.errors.push({ symbol: next, note: r.note });

  // Absolute counters recomputed from the checkpoint (reconciles the per-chunk heartbeat).
  const per = checkpoint.perSymbol;
  const totalChunks = per.reduce((a, s) => a + s.chunks, 0);
  const succCalls = per.reduce((a, s) => a + s.succeededChunks, 0);
  const withData = per.filter((s) => s.status === "OK" || s.status === "INCOMPLETE").length;
  const episodes = per.reduce((a, s) => a + s.episodes, 0);
  const labels = per.reduce((a, s) => a + s.labels, 0);
  db.prepare(
    `UPDATE replay_runs SET checkpoint_json=?, per_symbol_json=?, provider_calls=?, provider_calls_attempted=?, chunks_completed=?, symbols_with_data=?, symbols_done=?, episodes_captured=?, labels_captured=?, current_symbol=NULL, updated_at_ms=? WHERE run_id=?`,
  ).run(JSON.stringify(checkpoint), JSON.stringify(per), succCalls, totalChunks, totalChunks, withData, checkpoint.doneSymbols.length, episodes, labels, now(), runId);
  slog("checkpoint_write", { runId, symbol: next, status: pstatus, symbolsDone: checkpoint.doneSymbols.length, episodes });

  // If that was the last symbol, finalize now so the run reaches a terminal state promptly.
  if (checkpoint.doneSymbols.length >= symbols.length) return finalize(db, runId, checkpoint, row.symbols_total ?? symbols.length);
  return { done: false, status: "RUNNING" };
}

export const DEFAULT_LEASE_MS = 60_000;

/**
 * Atomically claim the next runnable job for a worker: a QUEUED run, or a RUNNING run whose lease
 * has EXPIRED (its worker crashed/restarted). The conditional UPDATE makes the claim safe even if
 * more than one worker ever polls. Returns the claimed runId, or null when nothing is runnable.
 */
export function claimNextSeedRun(db: JobDb, workerId: string, leaseMs: number = DEFAULT_LEASE_MS, nowMs: number = now()): string | null {
  const cand = db.prepare(
    `SELECT run_id FROM replay_runs
     WHERE asset_class='stock' AND cancel_requested=0
       AND (status='QUEUED' OR (status='RUNNING' AND (lease_until_ms IS NULL OR lease_until_ms < ?)))
     ORDER BY created_at_ms ASC LIMIT 1`,
  ).get(nowMs) as any;
  if (!cand) return null;
  const res = db.prepare(
    `UPDATE replay_runs SET status='RUNNING', lease_owner=?, lease_until_ms=?, heartbeat_ms=?, started_at_ms=COALESCE(started_at_ms, ?), updated_at_ms=?
     WHERE run_id=? AND cancel_requested=0 AND (status='QUEUED' OR (status='RUNNING' AND (lease_until_ms IS NULL OR lease_until_ms < ?)))`,
  ).run(workerId, nowMs + leaseMs, nowMs, nowMs, nowMs, cand.run_id, nowMs);
  if (res.changes === 0) return null; // lost the race
  slog("job_claim", { runId: cand.run_id, workerId });
  return cand.run_id;
}

function renewLease(db: JobDb, runId: string, workerId: string, leaseMs: number, nowMs: number): void {
  db.prepare("UPDATE replay_runs SET lease_until_ms=?, heartbeat_ms=? WHERE run_id=? AND lease_owner=?").run(nowMs + leaseMs, nowMs, runId, workerId);
  slog("lease_renew", { runId, workerId });
}

export interface RunSeedWorkerOpts { rateLimitMs?: number; maxSteps?: number; workerId?: string; leaseMs?: number }

/** Background loop: advance a single run until it reaches a terminal/paused state. Never throws.
 *  When workerId+leaseMs are supplied the lease is renewed after every symbol (heartbeat). */
export async function runSeedWorker(db: JobDb, runId: string, env: NodeJS.ProcessEnv = process.env, deps: SeedJobDeps = {}, opts: RunSeedWorkerOpts = {}): Promise<SeedRunProgress> {
  if (ACTIVE.has(runId)) return getSeedRunProgress(db, runId);
  ACTIVE.add(runId);
  slog("job_start", { runId, workerId: opts.workerId });
  try {
    const row = db.prepare("SELECT provider_limitations FROM replay_runs WHERE run_id=?").get(runId) as any;
    const rate = opts.rateLimitMs ?? Math.max(0, parse(row?.provider_limitations)?.rateLimitMs ?? 200);
    const maxSteps = opts.maxSteps ?? 100_000;
    for (let step = 0; step < maxSteps; step++) {
      const { done } = await advanceSeedRun(db, runId, env, deps);
      if (opts.workerId && opts.leaseMs) renewLease(db, runId, opts.workerId, opts.leaseMs, now());
      if (done) break;
      if (rate > 0) { slog("rate_sleep", { runId, ms: rate }); await sleep(rate); }
    }
  } catch (err: any) { slog("error", { runId, where: "runSeedWorker", err: String(err?.message ?? err).slice(0, 120) }); }
  finally { ACTIVE.delete(runId); slog("job_done", { runId, status: getSeedRunProgress(db, runId).status }); }
  return getSeedRunProgress(db, runId);
}

export interface SeedRunProgress {
  runId: string; found: boolean; status: JobStatus; symbolsTotal: number; symbolsDone: number; symbolsWithData: number;
  currentSymbol: string | null; chunksCompleted: number; providerCallsAttempted: number; providerCallsSucceeded: number;
  episodes: number; labels: number; errors: Array<{ symbol: string; note: string }>; perSymbol: PerSymbolProgress[];
  startedAtMs: number | null; updatedAtMs: number | null; elapsedMs: number | null; etaMs: number | null;
  error: string | null; provenance: { universeSource: string; survivorshipBias: boolean } | null; cancelRequested: boolean;
}

export function getSeedRunProgress(db: JobDb, runId: string, nowMs: number = now()): SeedRunProgress {
  const row = db.prepare("SELECT * FROM replay_runs WHERE run_id=?").get(runId) as any;
  if (!row) return { runId, found: false, status: "FAILED", symbolsTotal: 0, symbolsDone: 0, symbolsWithData: 0, currentSymbol: null, chunksCompleted: 0, providerCallsAttempted: 0, providerCallsSucceeded: 0, episodes: 0, labels: 0, errors: [], perSymbol: [], startedAtMs: null, updatedAtMs: null, elapsedMs: null, etaMs: null, error: "run not found", provenance: null, cancelRequested: false };
  const checkpoint: Checkpoint = parse(row.checkpoint_json) ?? emptyCheckpoint();
  const prov = parse(row.provider_limitations);
  const status = row.status as JobStatus;
  const symbolsDone = row.symbols_done ?? 0;
  const symbolsTotal = row.symbols_total ?? 0;
  const startedAtMs = row.started_at_ms ?? null;
  const elapsedMs = startedAtMs ? nowMs - startedAtMs : null;
  // ETA only when reliable: actively RUNNING, at least one symbol timed, and work remaining.
  const etaMs = status === "RUNNING" && startedAtMs && symbolsDone >= 1 && symbolsTotal > symbolsDone && elapsedMs != null
    ? Math.round((elapsedMs / symbolsDone) * (symbolsTotal - symbolsDone)) : null;
  return {
    runId, found: true, status, symbolsTotal, symbolsDone, symbolsWithData: row.symbols_with_data ?? 0,
    currentSymbol: row.current_symbol ?? null, chunksCompleted: row.chunks_completed ?? 0,
    providerCallsAttempted: row.provider_calls_attempted ?? 0, providerCallsSucceeded: row.provider_calls ?? 0,
    episodes: row.episodes_captured ?? 0, labels: row.labels_captured ?? 0, errors: checkpoint.errors ?? [], perSymbol: checkpoint.perSymbol ?? [],
    startedAtMs, updatedAtMs: row.updated_at_ms ?? null, elapsedMs, etaMs,
    error: row.error ?? null, provenance: prov ? { universeSource: prov.universeSource, survivorshipBias: prov.survivorshipBias } : null,
    cancelRequested: row.cancel_requested === 1,
  };
}

export interface ControlResult { runId: string; status: JobStatus; changed: boolean; note: string }

/**
 * Request cancellation — idempotent. Always records cancel_requested=1, then:
 *   • if NO worker is actively leasing the run (QUEUED, or RUNNING with an expired/absent lease and
 *     not active in THIS process) → finalize CANCELED immediately (clearing the lease), so a stale
 *     run can never remain RUNNING with cancel_requested=1 forever;
 *   • if a worker IS actively leasing it → leave cancel_requested=1 for the worker to observe at its
 *     next boundary (cooperative, avoids racing a live writer).
 */
export function cancelSeedRun(db: JobDb, runId: string, nowMs: number = now()): ControlResult {
  const row = db.prepare("SELECT status, lease_until_ms FROM replay_runs WHERE run_id=?").get(runId) as any;
  if (!row) return { runId, status: "FAILED", changed: false, note: "run not found" };
  const status = row.status as JobStatus;
  if (TERMINAL.has(status)) return { runId, status, changed: false, note: "already terminal" };
  db.prepare("UPDATE replay_runs SET cancel_requested=1, updated_at_ms=? WHERE run_id=?").run(nowMs, runId);
  const activelyLeased = ACTIVE.has(runId) || (typeof row.lease_until_ms === "number" && row.lease_until_ms > nowMs);
  if (!activelyLeased) { finalizeCanceled(db, runId, nowMs); return { runId, status: "CANCELED", changed: true, note: "canceled (no active worker lease)" }; }
  return { runId, status, changed: true, note: "cancellation requested — the worker will stop at its next boundary" };
}

export interface ReconcileResult { runId: string; from: JobStatus; to: JobStatus; reason: string }

/**
 * Admin-safe sweep for stale/malformed RUNNING rows with NO active lease. NEVER touches a run a
 * worker is actively leasing. Deterministic:
 *   • cancel_requested=1 → CANCELED (clears the lease) — fixes the "stuck RUNNING + canceled" case;
 *   • no resumable symbol plan (missing/empty symbols_json) → FAILED with an explicit reason —
 *     fixes legacy/synchronous rows that can never make progress.
 * Resumable, un-canceled rows are left for the worker's lease claim to reclaim & resume.
 */
export function reconcileStaleSeedRuns(db: JobDb, nowMs: number = now()): ReconcileResult[] {
  const rows = db.prepare(
    "SELECT run_id, status, cancel_requested, lease_until_ms, symbols_json FROM replay_runs WHERE asset_class='stock' AND status='RUNNING'",
  ).all() as any[];
  const out: ReconcileResult[] = [];
  for (const row of rows) {
    const activelyLeased = ACTIVE.has(row.run_id) || (typeof row.lease_until_ms === "number" && row.lease_until_ms > nowMs);
    if (activelyLeased) continue;
    const symbols = parse(row.symbols_json);
    const unresumable = !Array.isArray(symbols) || symbols.length === 0;
    if (row.cancel_requested === 1) {
      const res = db.prepare("UPDATE replay_runs SET status='CANCELED', error='canceled (reconciled: no active lease)', current_symbol=NULL, lease_owner=NULL, lease_until_ms=NULL, updated_at_ms=? WHERE run_id=? AND status='RUNNING'").run(nowMs, row.run_id);
      if (res.changes > 0) out.push({ runId: row.run_id, from: "RUNNING", to: "CANCELED", reason: "cancel_requested + no active lease" });
    } else if (unresumable) {
      const res = db.prepare("UPDATE replay_runs SET status='FAILED', error='unresumable run: missing symbol plan (legacy/malformed) — cannot resume', current_symbol=NULL, lease_owner=NULL, lease_until_ms=NULL, updated_at_ms=? WHERE run_id=? AND status='RUNNING'").run(nowMs, row.run_id);
      if (res.changes > 0) out.push({ runId: row.run_id, from: "RUNNING", to: "FAILED", reason: "unresumable: missing symbol plan" });
    }
  }
  if (out.length) slog("job_done", { reconciled: out.length });
  return out;
}

/** Pause a running/queued run (resumable). The worker stops after the current symbol. */
export function pauseSeedRun(db: JobDb, runId: string, nowMs: number = now()): ControlResult {
  const row = db.prepare("SELECT status FROM replay_runs WHERE run_id=?").get(runId) as any;
  if (!row) return { runId, status: "FAILED", changed: false, note: "run not found" };
  const status = row.status as JobStatus;
  if (status !== "RUNNING" && status !== "QUEUED") return { runId, status, changed: false, note: "not running" };
  db.prepare("UPDATE replay_runs SET status='PAUSED', updated_at_ms=? WHERE run_id=?").run(nowMs, runId);
  return { runId, status: "PAUSED", changed: true, note: "paused — resume to continue" };
}

/** Resume a PAUSED run: flip to QUEUED so a (re-)kicked worker continues from the checkpoint. */
export function resumeSeedRun(db: JobDb, runId: string, nowMs: number = now()): ControlResult {
  const row = db.prepare("SELECT status FROM replay_runs WHERE run_id=?").get(runId) as any;
  if (!row) return { runId, status: "FAILED", changed: false, note: "run not found" };
  const status = row.status as JobStatus;
  if (status !== "PAUSED") return { runId, status, changed: false, note: "not paused" };
  db.prepare("UPDATE replay_runs SET status='QUEUED', cancel_requested=0, updated_at_ms=? WHERE run_id=?").run(nowMs, runId);
  return { runId, status: "QUEUED", changed: true, note: "resumed" };
}

/** After a server restart, re-kick any QUEUED/RUNNING (not PAUSED, not terminal) runs whose
 *  in-process worker was lost. Fire-and-forget; returns the run ids re-kicked. */
export function resumeInterruptedSeedRuns(db: JobDb, env: NodeJS.ProcessEnv = process.env, deps: SeedJobDeps = {}): string[] {
  const rows = db.prepare("SELECT run_id FROM replay_runs WHERE asset_class='stock' AND status IN ('QUEUED','RUNNING') AND cancel_requested=0").all() as any[];
  const kicked: string[] = [];
  for (const r of rows) {
    if (ACTIVE.has(r.run_id)) continue;
    kicked.push(r.run_id);
    void runSeedWorker(db, r.run_id, env, deps).catch(() => { /* isolated */ });
  }
  return kicked;
}
