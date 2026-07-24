/**
 * Deep persistOk diagnostics — OBSERVABILITY ONLY.
 *
 * Explains WHY `speedPersistentFromRing` returned false without changing the
 * live boolean gate. Mirrors the production algorithm in lib/zero-dte.js so
 * sub-reasons stay aligned with the gate that actually blocked the callout.
 *
 * Never influences trigger / delivery decisions.
 */

export type PersistOkSubReason =
  | "ring_too_short"
  | "insufficient_hits"
  | "rate_below_threshold"
  | "no_measurable_rate"
  | "passed";

export type FirstFailedGate =
  | "cooldown"
  | "persistOk"
  | "accelOk"
  | "tapeMoving"
  | "shouldTrigger"
  | "unknown";

export interface PersistOkExplainInput {
  ring: Array<{ t: number; p: number }>;
  minRate: number;
  direction: "bullish" | "bearish";
  minHits: number;
  subWindowMs?: number;
  window?: number;
  nowMs?: number;
  cooldownBlocked?: boolean;
  /** True when persistOk was the first failed gate in evaluation order. */
  firstFailedGate?: string | null;
}

export interface PersistOkExplainResult {
  ok: boolean;
  subReason: PersistOkSubReason;
  /** Human-readable deterministic explanation. */
  detail: string;
  ringLength: number;
  window: number;
  minHits: number;
  hits: number;
  minRate: number;
  subWindowMs: number;
  rates: Array<number | null>;
  /** When another gate failed first, persistOk may still be false but is not the blocking cause. */
  anotherGateFirst: boolean;
  firstFailedGate: string | null;
  cooldownActive: boolean;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Mirror of zero-dte.js ratePctPerMin — pure, local, no import from .js for test isolation. */
function ratePctPerMin(
  ring: Array<{ t: number; p: number }>,
  windowMs: number,
  nowMs?: number,
): number | null {
  if (!Array.isArray(ring) || ring.length < 2) return null;
  const end = ring[ring.length - 1];
  const startT = (nowMs ?? end.t) - windowMs;
  let start = ring[0];
  for (const tick of ring) {
    if (tick.t <= startT) start = tick;
    else break;
  }
  const dtMin = (end.t - start.t) / 60_000;
  if (dtMin <= 0 || !isNum(start.p) || !isNum(end.p) || start.p <= 0) return null;
  return ((end.p - start.p) / start.p) * 100 / dtMin;
}

/**
 * Explain persistence failure with the same inputs the live gate uses.
 * `ok` must match `speedPersistentFromRing(...)` for identical parameters.
 */
export function explainSpeedPersistence(input: PersistOkExplainInput): PersistOkExplainResult {
  const window = input.window ?? 5;
  const subWindowMs = input.subWindowMs ?? 4000;
  const ring = Array.isArray(input.ring) ? input.ring : [];
  const firstFailedGate = input.firstFailedGate ?? null;
  const cooldownActive = Boolean(input.cooldownBlocked);
  const anotherGateFirst = Boolean(
    firstFailedGate && firstFailedGate !== "persistOk" && firstFailedGate !== "unknown",
  );

  const base = {
    ringLength: ring.length,
    window,
    minHits: input.minHits,
    minRate: input.minRate,
    subWindowMs,
    firstFailedGate,
    anotherGateFirst,
    cooldownActive,
  };

  if (ring.length < window) {
    return {
      ...base,
      ok: false,
      hits: 0,
      rates: [],
      subReason: "ring_too_short",
      detail: `ring length ${ring.length} < window ${window}`,
    };
  }

  const end = input.nowMs ?? ring[ring.length - 1]?.t;
  const rates: Array<number | null> = [];
  let hits = 0;
  let measurable = 0;
  for (let i = ring.length - window; i < ring.length; i++) {
    const sub = ring.slice(Math.max(0, i - Math.ceil(subWindowMs / 1000)), i + 1);
    if (sub.length < 2) {
      rates.push(null);
      continue;
    }
    const rate = ratePctPerMin(sub, subWindowMs, end);
    rates.push(rate == null ? null : +rate.toFixed(4));
    if (rate == null) continue;
    measurable += 1;
    if (input.direction === "bearish" && rate <= -input.minRate) hits += 1;
    else if (input.direction !== "bearish" && rate >= input.minRate) hits += 1;
  }

  const ok = hits >= input.minHits;
  if (ok) {
    return {
      ...base,
      ok: true,
      hits,
      rates,
      subReason: "passed",
      detail: `persistence passed (${hits}/${input.minHits} hits at minRate ${input.minRate})`,
    };
  }

  if (measurable === 0) {
    return {
      ...base,
      ok: false,
      hits,
      rates,
      subReason: "no_measurable_rate",
      detail: "no measurable sub-window rate in persistence window",
    };
  }

  if (hits === 0) {
    return {
      ...base,
      ok: false,
      hits,
      rates,
      subReason: "rate_below_threshold",
      detail: `0 hits: all measurable rates below minRate ${input.minRate} (${input.direction})`,
    };
  }

  return {
    ...base,
    ok: false,
    hits,
    rates,
    subReason: "insufficient_hits",
    detail: `hits ${hits} < minHits ${input.minHits} (rates measured=${measurable})`,
  };
}

export interface PersistOkSummaryBucket {
  subReason: PersistOkSubReason | "another_gate_first" | "cooldown_first";
  count: number;
  pct: number | null;
}

/** Aggregate persisted gate_diagnostics_json / direction_json persistOk blocks. */
export function summarizePersistOkFailures(
  rows: Array<{ gateDiagnostics?: unknown; reason?: string | null; firstFailedGate?: string | null }>,
): { total: number; buckets: PersistOkSummaryBucket[]; bySubReason: Record<string, number> } {
  const bySubReason: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const reason = String(row.reason ?? "");
    const isPersist =
      /blocked:\s*persistOk/i.test(reason) ||
      row.firstFailedGate === "persistOk" ||
      (row.gateDiagnostics as any)?.persistOk?.subReason;
    if (!isPersist && !(row.gateDiagnostics as any)?.persistOk) continue;

    total += 1;
    const diag = (row.gateDiagnostics as any)?.persistOk ?? null;
    let key: string;
    if (diag?.anotherGateFirst && diag?.firstFailedGate && diag.firstFailedGate !== "persistOk") {
      key = diag.firstFailedGate === "cooldown" ? "cooldown_first" : "another_gate_first";
    } else if (diag?.cooldownActive && diag?.firstFailedGate === "cooldown") {
      key = "cooldown_first";
    } else {
      key = String(diag?.subReason ?? "insufficient_hits");
    }
    bySubReason[key] = (bySubReason[key] ?? 0) + 1;
  }

  const buckets: PersistOkSummaryBucket[] = Object.entries(bySubReason)
    .map(([subReason, count]) => ({
      subReason: subReason as PersistOkSummaryBucket["subReason"],
      count,
      pct: total > 0 ? Math.round((count / total) * 1000) / 10 : null,
    }))
    .sort((a, b) => b.count - a.count);

  return { total, buckets, bySubReason };
}
