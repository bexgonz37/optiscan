/**
 * request-accounting.ts — deterministic accounting for every Massive request the
 * historical research lane issues, plus the caps that bound it. PURE STATE, no
 * network, no DB, no AI.
 *
 * WHY THIS EXISTS. The historical lane (Sections 5-7 of the research plan) is
 * the first part of OptiScan that can issue an unbounded number of provider
 * requests: one exact-OCC quote window per candidate per horizon, across a
 * cohort, is a multiplicative cost. The live scanner's meter in
 * lib/polygon-provider.js counts calls but has no notion of "this run", "this
 * symbol", or "this contract", so it cannot stop a mining run from consuming
 * the day's budget before the opening bell.
 *
 * THE RULES ARE NON-NEGOTIABLE AND ENCODED HERE, NOT IN CALLERS:
 *   1. Every request is counted BEFORE it is issued, by type.
 *   2. A cap that would be exceeded BLOCKS the request and records
 *      PROVIDER_BUDGET_BLOCKED. It never throws into the scanner.
 *   3. Blocking is local: enrichment stops, live capture / marks / paper /
 *      Quant continue on whatever evidence already exists.
 *   4. A blocked or failed request NEVER produces a value. Missing stays
 *      missing — no interpolation, no midpoint, no carry-forward.
 *   5. Diagnostics read this ledger. Diagnostics never cause a request, so
 *      nothing in this module may issue one.
 */

/** Every request type the historical lane can issue. Counted separately. */
export type RequestKind =
  | "LIVE_CHAIN"
  | "LIVE_QUOTE"
  | "UNDERLYING"
  | "HIST_QUOTE"
  | "HIST_AGG"
  | "HIST_TRADE"
  | "HIST_CHAIN"
  | "REFERENCE";

export const REQUEST_KINDS: readonly RequestKind[] = Object.freeze([
  "LIVE_CHAIN", "LIVE_QUOTE", "UNDERLYING",
  "HIST_QUOTE", "HIST_AGG", "HIST_TRADE", "HIST_CHAIN", "REFERENCE",
]);

/** The historical kinds that the per-run / per-symbol caps apply to. */
export const HISTORICAL_KINDS: readonly RequestKind[] = Object.freeze([
  "HIST_QUOTE", "HIST_AGG", "HIST_TRADE", "HIST_CHAIN",
]);

export type BlockReason =
  | "MAX_HISTORICAL_PER_RUN"
  | "MAX_HISTORICAL_PER_SYMBOL"
  | "MAX_WINDOWS_PER_OCC"
  | "MAX_LIVE_ENRICHMENT_PER_CANDIDATE"
  | "CIRCUIT_OPEN";

export interface RequestCaps {
  /** Hard ceiling on historical requests for one mining run. */
  maxHistoricalPerRun: number;
  /** Ceiling per underlying symbol inside one run. */
  maxHistoricalPerSymbol: number;
  /** Ceiling on distinct timestamp windows fetched for one exact OCC. */
  maxWindowsPerOcc: number;
  /** Ceiling on live enrichment requests attributable to one candidate. */
  maxLiveEnrichmentPerCandidate: number;
  /** In-flight request ceiling. Bounds burst pressure on the provider. */
  maxConcurrency: number;
  /** Attempts AFTER the first, per request. 0 disables retry. */
  maxRetries: number;
  /** First backoff step in ms; doubled per retry. */
  backoffBaseMs: number;
  /** Consecutive failures (incl. 429s) that trip the breaker. */
  circuitFailureThreshold: number;
  /** How long the breaker stays open before a single probe is allowed. */
  circuitOpenMs: number;
}

export const DEFAULT_REQUEST_CAPS: Readonly<RequestCaps> = Object.freeze({
  maxHistoricalPerRun: 2_000,
  maxHistoricalPerSymbol: 200,
  maxWindowsPerOcc: 12,
  maxLiveEnrichmentPerCandidate: 2,
  maxConcurrency: 4,
  maxRetries: 2,
  backoffBaseMs: 500,
  circuitFailureThreshold: 8,
  circuitOpenMs: 60_000,
});

export function resolveRequestCaps(env: NodeJS.ProcessEnv = process.env): RequestCaps {
  const n = (raw: string | undefined, d: number, lo: number, hi: number): number => {
    const x = Number(raw);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.floor(x))) : d;
  };
  const d = DEFAULT_REQUEST_CAPS;
  return {
    maxHistoricalPerRun: n(env.ASYM_HIST_MAX_PER_RUN, d.maxHistoricalPerRun, 0, 1_000_000),
    maxHistoricalPerSymbol: n(env.ASYM_HIST_MAX_PER_SYMBOL, d.maxHistoricalPerSymbol, 0, 100_000),
    maxWindowsPerOcc: n(env.ASYM_HIST_MAX_WINDOWS_PER_OCC, d.maxWindowsPerOcc, 1, 500),
    maxLiveEnrichmentPerCandidate: n(env.ASYM_MAX_LIVE_ENRICH_PER_CANDIDATE, d.maxLiveEnrichmentPerCandidate, 0, 50),
    maxConcurrency: n(env.ASYM_HIST_MAX_CONCURRENCY, d.maxConcurrency, 1, 32),
    maxRetries: n(env.ASYM_HIST_MAX_RETRIES, d.maxRetries, 0, 6),
    backoffBaseMs: n(env.ASYM_HIST_BACKOFF_BASE_MS, d.backoffBaseMs, 50, 30_000),
    circuitFailureThreshold: n(env.ASYM_HIST_CIRCUIT_THRESHOLD, d.circuitFailureThreshold, 1, 1000),
    circuitOpenMs: n(env.ASYM_HIST_CIRCUIT_OPEN_MS, d.circuitOpenMs, 1_000, 30 * 60_000),
  };
}

export interface RequestLedger {
  /** Attempted requests by kind. Counted before issue, never after. */
  requests: Record<RequestKind, number>;
  cacheHits: number;
  cacheMisses: number;
  /** Requests skipped because an identical in-flight/completed key existed. */
  duplicatesAvoided: number;
  retries: number;
  rateLimited429: number;
  providerFailures: number;
  circuitOpens: number;
  budgetBlocks: number;
  blocksByReason: Record<string, number>;
  /** Historical requests attributed to each underlying symbol. */
  perSymbol: Record<string, number>;
  /** Distinct window keys fetched per exact OCC. */
  windowsPerOcc: Record<string, number>;
  /** Live enrichment requests attributed to each candidate identity. */
  liveEnrichmentPerCandidate: Record<string, number>;
  historicalTotal: number;
}

export function emptyLedger(): RequestLedger {
  return {
    requests: Object.fromEntries(REQUEST_KINDS.map((k) => [k, 0])) as Record<RequestKind, number>,
    cacheHits: 0, cacheMisses: 0, duplicatesAvoided: 0,
    retries: 0, rateLimited429: 0, providerFailures: 0,
    circuitOpens: 0, budgetBlocks: 0, blocksByReason: {},
    perSymbol: {}, windowsPerOcc: {}, liveEnrichmentPerCandidate: {},
    historicalTotal: 0,
  };
}

interface CircuitState {
  consecutiveFailures: number;
  openedAtMs: number | null;
  /** Set while a single probe is allowed through after the open window. */
  halfOpen: boolean;
}

export interface AdmissionRequest {
  kind: RequestKind;
  /** Underlying symbol. Required for historical kinds so per-symbol caps work. */
  symbol?: string | null;
  /** Exact OCC. Required for HIST_QUOTE/HIST_AGG/HIST_TRADE window accounting. */
  occ?: string | null;
  /** Distinct window identity for this OCC (e.g. "1785516000000-1785516300000"). */
  windowKey?: string | null;
  /** Candidate identity, for live enrichment accounting. */
  candidateId?: string | null;
}

export type Admission =
  | { admitted: true; reason: null }
  | { admitted: false; reason: BlockReason };

/**
 * The accountant. One instance per mining run (or per session for the live
 * lane). Deliberately NOT a module singleton: two concurrent runs must not
 * share a budget silently, and tests must not inherit state.
 */
export class RequestAccountant {
  readonly caps: RequestCaps;
  readonly ledger: RequestLedger;
  private circuit: CircuitState = { consecutiveFailures: 0, openedAtMs: null, halfOpen: false };
  /** Window keys already counted, so a repeat is a duplicate not a new window. */
  private seenWindows = new Set<string>();

  constructor(caps: RequestCaps = DEFAULT_REQUEST_CAPS) {
    this.caps = caps;
    this.ledger = emptyLedger();
  }

  /**
   * Decide whether a request may be issued, and COUNT it if so. Callers must
   * treat `admitted: false` as final for this request: continue with whatever
   * evidence already exists, and never substitute a fabricated value.
   */
  admit(req: AdmissionRequest, nowMs: number = Date.now()): Admission {
    if (this.isCircuitOpen(nowMs)) return this.block("CIRCUIT_OPEN");

    const historical = HISTORICAL_KINDS.includes(req.kind);
    if (historical) {
      if (this.ledger.historicalTotal >= this.caps.maxHistoricalPerRun) {
        return this.block("MAX_HISTORICAL_PER_RUN");
      }
      const sym = normalizeSymbol(req.symbol);
      if (sym) {
        const used = this.ledger.perSymbol[sym] ?? 0;
        if (used >= this.caps.maxHistoricalPerSymbol) return this.block("MAX_HISTORICAL_PER_SYMBOL");
      }
      const occ = normalizeOcc(req.occ);
      if (occ && req.windowKey) {
        const key = `${occ}|${req.windowKey}`;
        if (!this.seenWindows.has(key)) {
          const windows = this.ledger.windowsPerOcc[occ] ?? 0;
          if (windows >= this.caps.maxWindowsPerOcc) return this.block("MAX_WINDOWS_PER_OCC");
        }
      }
    }

    if ((req.kind === "LIVE_CHAIN" || req.kind === "LIVE_QUOTE") && req.candidateId) {
      const used = this.ledger.liveEnrichmentPerCandidate[req.candidateId] ?? 0;
      if (used >= this.caps.maxLiveEnrichmentPerCandidate) {
        return this.block("MAX_LIVE_ENRICHMENT_PER_CANDIDATE");
      }
    }

    // Admitted — count everything now, before the request is issued, so a
    // crashed or timed-out request is still accounted for.
    this.ledger.requests[req.kind] += 1;
    if (historical) {
      this.ledger.historicalTotal += 1;
      const sym = normalizeSymbol(req.symbol);
      if (sym) this.ledger.perSymbol[sym] = (this.ledger.perSymbol[sym] ?? 0) + 1;
      const occ = normalizeOcc(req.occ);
      if (occ && req.windowKey) {
        const key = `${occ}|${req.windowKey}`;
        if (!this.seenWindows.has(key)) {
          this.seenWindows.add(key);
          this.ledger.windowsPerOcc[occ] = (this.ledger.windowsPerOcc[occ] ?? 0) + 1;
        }
      }
    }
    if ((req.kind === "LIVE_CHAIN" || req.kind === "LIVE_QUOTE") && req.candidateId) {
      this.ledger.liveEnrichmentPerCandidate[req.candidateId] =
        (this.ledger.liveEnrichmentPerCandidate[req.candidateId] ?? 0) + 1;
    }
    return { admitted: true, reason: null };
  }

  recordCacheHit(): void { this.ledger.cacheHits += 1; }
  recordCacheMiss(): void { this.ledger.cacheMisses += 1; }
  recordDuplicateAvoided(): void { this.ledger.duplicatesAvoided += 1; }
  recordRetry(): void { this.ledger.retries += 1; }

  /** A request came back cleanly. Closes a half-open breaker. */
  recordSuccess(): void {
    this.circuit.consecutiveFailures = 0;
    this.circuit.openedAtMs = null;
    this.circuit.halfOpen = false;
  }

  /**
   * A request failed. `rateLimited` marks a 429 specifically, which is counted
   * separately because it means "slow down", not "the provider is broken".
   */
  recordFailure(opts: { rateLimited?: boolean } = {}, nowMs: number = Date.now()): void {
    if (opts.rateLimited) this.ledger.rateLimited429 += 1;
    else this.ledger.providerFailures += 1;
    this.circuit.consecutiveFailures += 1;
    this.circuit.halfOpen = false;
    if (this.circuit.consecutiveFailures >= this.caps.circuitFailureThreshold && this.circuit.openedAtMs == null) {
      this.circuit.openedAtMs = nowMs;
      this.ledger.circuitOpens += 1;
    }
  }

  /** Backoff for retry attempt `attempt` (1-based). Deterministic, no jitter. */
  backoffMs(attempt: number): number {
    const a = Math.max(1, Math.floor(attempt));
    return this.caps.backoffBaseMs * Math.pow(2, a - 1);
  }

  isCircuitOpen(nowMs: number = Date.now()): boolean {
    if (this.circuit.openedAtMs == null) return false;
    if (nowMs - this.circuit.openedAtMs >= this.caps.circuitOpenMs) {
      // Allow exactly one probe through; a failure re-opens the window.
      this.circuit.openedAtMs = nowMs;
      this.circuit.halfOpen = true;
      return false;
    }
    return true;
  }

  /** Immutable snapshot for diagnostics. Reading this issues no request. */
  snapshot(): RequestLedger & { circuitOpen: boolean; consecutiveFailures: number } {
    return {
      ...this.ledger,
      requests: { ...this.ledger.requests },
      blocksByReason: { ...this.ledger.blocksByReason },
      perSymbol: { ...this.ledger.perSymbol },
      windowsPerOcc: { ...this.ledger.windowsPerOcc },
      liveEnrichmentPerCandidate: { ...this.ledger.liveEnrichmentPerCandidate },
      circuitOpen: this.circuit.openedAtMs != null,
      consecutiveFailures: this.circuit.consecutiveFailures,
    };
  }

  private block(reason: BlockReason): Admission {
    this.ledger.budgetBlocks += 1;
    this.ledger.blocksByReason[reason] = (this.ledger.blocksByReason[reason] ?? 0) + 1;
    return { admitted: false, reason };
  }
}

function normalizeSymbol(s: string | null | undefined): string | null {
  const v = String(s ?? "").trim().toUpperCase();
  return v ? v : null;
}
function normalizeOcc(s: string | null | undefined): string | null {
  const v = String(s ?? "").trim().toUpperCase();
  return v.startsWith("O:") ? v : null;
}

/** The persisted marker for a capped request. Never a value, always a reason. */
export const PROVIDER_BUDGET_BLOCKED = "PROVIDER_BUDGET_BLOCKED" as const;
