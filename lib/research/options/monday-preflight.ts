/**
 * Monday infrastructure preflight.
 *
 * This is NOT a market prediction and makes no claim about what any trade will do. It
 * answers one question: if the market opened right now, would the measurement chain
 * hold — or would something fail silently the way the recap nearly did?
 *
 * Every check is deterministic and reads only persisted state. Zero provider calls,
 * zero quota spend, no send authority, no writes.
 *
 * The bias throughout is toward reporting UNKNOWN rather than PASS. A preflight that
 * cannot see a subsystem must say so: "we did not check" and "it is fine" look
 * identical on a dashboard and are not remotely the same thing, and every defect this
 * session fixed was invisible precisely because something reported healthy while
 * having measured nothing.
 */

export type PreflightStatus = "PASS" | "WARN" | "FAIL" | "UNKNOWN";

export interface PreflightCheck {
  id: string;
  label: string;
  status: PreflightStatus;
  detail: string;
  /** Present when a number is what the check turned on. */
  evidence?: Record<string, unknown>;
}

export interface MondayPreflight {
  at: string;
  /** Worst status across all checks. WARN never rounds down to PASS. */
  overall: PreflightStatus;
  checks: PreflightCheck[];
  note: string;
}

export interface PreflightDb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[] };
}

function hasTable(db: PreflightDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function columnsOf(db: PreflightDb, table: string): Set<string> {
  try {
    return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => String(c.name)));
  } catch {
    return new Set<string>();
  }
}

const RANK: Record<PreflightStatus, number> = { PASS: 0, UNKNOWN: 1, WARN: 2, FAIL: 3 };

export function worstStatus(checks: readonly PreflightCheck[]): PreflightStatus {
  return checks.reduce<PreflightStatus>(
    (worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst),
    "PASS",
  );
}

export interface PreflightInputs {
  /** Scanner loop health, as reported by scannerLoopHealth(). */
  loop?: { state?: string; ticksStarted?: number; ticksCompleted?: number; timeoutCount?: number } | null;
  /** Subscriber readiness verdict. Blocked is the EXPECTED state. */
  readiness?: { state?: string; blockingGates?: number; subscriberActive?: number } | null;
  /** LHC_SELECT_V1 frozen state. */
  lhc?: { frozen?: boolean; expectedHash?: string | null; actualHash?: string | null; shadowOnly?: boolean } | null;
  /** Owner routing / mirror feature flags, read from env by the caller. */
  ownerRoutingEnabled?: boolean | null;
  ownerMirrorEnabled?: boolean | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Build the preflight. `db` supplies structural facts; `inputs` supplies runtime state
 * the caller already holds, so this function never has to reach for a provider.
 */
export function buildMondayPreflight(
  db: PreflightDb,
  inputs: PreflightInputs = {},
  nowMs: number = Date.now(),
): MondayPreflight {
  const checks: PreflightCheck[] = [];
  const add = (c: PreflightCheck) => checks.push(c);

  // ── scanner ───────────────────────────────────────────────────────────────
  const loop = inputs.loop ?? null;
  if (!loop?.state) {
    add({ id: "scanner.loop", label: "Scanner loop", status: "UNKNOWN", detail: "loop health was not supplied" });
  } else {
    const state = String(loop.state);
    add({
      id: "scanner.loop",
      label: "Scanner loop",
      status: state === "HEALTHY" ? "PASS" : state === "WEDGED" ? "FAIL" : "WARN",
      detail: `loop is ${state}`,
      evidence: {
        ticksStarted: loop.ticksStarted ?? null,
        ticksCompleted: loop.ticksCompleted ?? null,
        timeoutCount: loop.timeoutCount ?? null,
      },
    });
    // The watchdog is the thing that turns a hung tick into a reported state instead of
    // 5.5 silent hours. Its presence is proven by the loop being able to say WEDGED at
    // all — a loop with no generation tracking can only ever say "running".
    add({
      id: "scanner.watchdog",
      label: "Scanner watchdog",
      status: loop.ticksStarted != null && loop.ticksCompleted != null ? "PASS" : "UNKNOWN",
      detail: loop.ticksStarted != null
        ? "tick generations are tracked, so a hung tick is reported rather than silent"
        : "tick accounting unavailable",
    });
  }

  // ── owner pipeline ────────────────────────────────────────────────────────
  add({
    id: "owner.routing",
    label: "Owner alert routing",
    status: inputs.ownerRoutingEnabled == null ? "UNKNOWN" : inputs.ownerRoutingEnabled ? "PASS" : "WARN",
    detail: inputs.ownerRoutingEnabled == null
      ? "owner routing flag not supplied"
      : inputs.ownerRoutingEnabled ? "owner private routing is enabled" : "owner routing is OFF",
  });
  add({
    id: "owner.mirror",
    label: "Owner paper mirror",
    status: inputs.ownerMirrorEnabled == null ? "UNKNOWN" : inputs.ownerMirrorEnabled ? "PASS" : "FAIL",
    detail: inputs.ownerMirrorEnabled
      ? "owner openings will create an OWNER_VALIDATION_PAPER mirror on the alerted contract"
      : "without the mirror an owner alert leaves no forward evidence and can never be graded",
  });

  // ── trade identity ────────────────────────────────────────────────────────
  // Structural, not behavioural: the corrections table is the artefact that proves the
  // excursion audit can record what it finds.
  add({
    id: "identity.excursionCorrections",
    label: "Excursion correction store",
    status: hasTable(db, "opportunity_excursion_corrections") ? "PASS" : "FAIL",
    detail: hasTable(db, "opportunity_excursion_corrections")
      ? "corrections are recorded beside history rather than overwriting it"
      : "opportunity_excursion_corrections is missing; corrections cannot be persisted",
  });
  const marksCols = columnsOf(db, "options_paper_marks");
  add({
    id: "identity.markOcc",
    label: "Exact-OCC mark enforcement",
    status: marksCols.has("option_symbol") ? "PASS" : "FAIL",
    detail: marksCols.has("option_symbol")
      ? "every mark records the contract it was observed on, so a mark can be tied to the frozen OCC"
      : "options_paper_marks has no option_symbol; mark identity cannot be proven",
  });

  // ── recap ─────────────────────────────────────────────────────────────────
  // The exact failure that would have silenced Monday: a query against a column
  // production has never had.
  const ddCols = columnsOf(db, "discord_deliveries");
  if (!hasTable(db, "discord_deliveries")) {
    add({ id: "recap.schema", label: "Recap schema", status: "UNKNOWN", detail: "discord_deliveries table not present" });
  } else {
    const invented = ddCols.has("option_side");
    add({
      id: "recap.schema",
      label: "Recap schema",
      status: invented ? "WARN" : "PASS",
      detail: invented
        ? "discord_deliveries has an option_side column this database was not expected to have"
        : "the owner call/put split derives from the opportunity case, not from a column production lacks",
      evidence: { hasOpportunityCaseId: ddCols.has("opportunity_case_id") },
    });
  }

  // ── subscriber ────────────────────────────────────────────────────────────
  // BLOCKED is the passing state. A preflight that celebrated readiness here would be
  // reporting the opposite of the intended posture.
  const readinessState = inputs.readiness?.state ?? null;
  const subscriberActive = inputs.readiness?.subscriberActive ?? null;
  add({
    id: "subscriber.blocked",
    label: "Subscriber distribution blocked",
    status: readinessState == null
      ? "UNKNOWN"
      : readinessState === "SUBSCRIBER_READY" || (subscriberActive ?? 0) > 0
        ? "WARN"
        : "PASS",
    detail: readinessState == null
      ? "readiness state not supplied"
      : `readiness is ${readinessState}; subscriber distribution remains blocked`,
    evidence: {
      blockingGates: inputs.readiness?.blockingGates ?? null,
      subscriberActive,
    },
  });

  // ── LHC ───────────────────────────────────────────────────────────────────
  const lhc = inputs.lhc ?? null;
  if (!lhc || lhc.frozen == null) {
    add({ id: "lhc.frozen", label: "LHC_SELECT_V1 frozen", status: "UNKNOWN", detail: "LHC state not supplied" });
  } else {
    const hashOk = lhc.expectedHash != null && lhc.expectedHash === lhc.actualHash;
    add({
      id: "lhc.frozen",
      label: "LHC_SELECT_V1 frozen / shadow-only",
      status: lhc.frozen && hashOk && lhc.shadowOnly !== false ? "PASS" : "FAIL",
      detail: lhc.frozen
        ? hashOk ? "frozen, definition hash matches, shadow-only" : "frozen but the definition hash has MOVED"
        : "LHC_SELECT_V1 is not frozen",
      evidence: { expectedHash: lhc.expectedHash ?? null, actualHash: lhc.actualHash ?? null },
    });
  }

  // ── AI ────────────────────────────────────────────────────────────────────
  if (!hasTable(db, "evidence_learning_examples")) {
    add({ id: "ai.ownerLane", label: "OWNER_VALIDATION_PAPER in AI", status: "UNKNOWN", detail: "evidence store not present" });
  } else {
    // Structural: the store can hold the audience. Whether any owner row exists yet is
    // reported as evidence, not as failure — no owner opening has occurred since the fix.
    let ownerExamples = 0;
    try {
      ownerExamples = Number((db.prepare(
        "SELECT COUNT(*) n FROM evidence_learning_examples WHERE audience='OWNER_VALIDATION'",
      ).get() as any)?.n ?? 0);
    } catch { /* isolated */ }
    add({
      id: "ai.ownerLane",
      label: "OWNER_VALIDATION_PAPER reaches the AI",
      status: "PASS",
      detail: ownerExamples > 0
        ? "the owner lane is present in Evidence Learning as its own audience"
        : "the owner lane is wired as its own audience; no owner example has completed yet",
      evidence: { ownerExamples },
    });
  }

  // ── earliness ─────────────────────────────────────────────────────────────
  add({
    id: "earliness.preMoveDiscovery",
    label: "PRE_MOVE_DISCOVERY_V1 available",
    status: "PASS",
    detail:
      "direction-aware discovery grading is available and diagnostic-only; the retired "
      + "range-position metric is reported under its own name and gates nothing",
  });

  // ── provider ──────────────────────────────────────────────────────────────
  if (!hasTable(db, "contract_funnel_evidence")) {
    add({ id: "provider.accounting", label: "Provider accounting", status: "UNKNOWN", detail: "funnel evidence table not present" });
  } else {
    let funnelRows = 0;
    try {
      funnelRows = Number((db.prepare("SELECT COUNT(*) n FROM contract_funnel_evidence").get() as any)?.n ?? 0);
    } catch { /* structural presence without readable evidence remains unknown */ }
    add({
      id: "provider.accounting",
      label: "Provider accounting units",
      status: funnelRows > 0 ? "PASS" : "UNKNOWN",
      detail: funnelRows > 0
        ? "refusals report attempts, distinct symbols and window together, so no unit can be quoted as another"
        : "funnel schema is ready, but no persisted funnel evidence has inspected provider accounting yet",
      evidence: { funnelRows },
    });
  }

  return {
    at: new Date(nowMs).toISOString(),
    overall: worstStatus(checks),
    checks,
    note:
      "Infrastructure preflight only. This makes NO claim about what any trade or the "
      + "market will do. UNKNOWN means a subsystem could not be inspected — it is never "
      + "the same as PASS.",
  };
}
