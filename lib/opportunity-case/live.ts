/**
 * Living Opportunity Case runtime — claim, suppress duplicates, attach evidence,
 * refresh Opportunity Summary, emit lifecycle/content events.
 * Deterministic only. AI must never modify these records.
 */
import { setupSentence } from "../research/options/format.ts";
import {
  buildOpportunityIdentity,
  opportunityCaseIdForOpen,
  opportunityFingerprint,
  isActiveLifecycleStatus,
  type OpportunityIdentity,
} from "./identity.ts";
import {
  nextLifecycleStatus,
  type LifecycleEventType,
  type OpportunityLifecycleStatus,
} from "./lifecycle.ts";
import { buildEvidenceEvent, listEvidenceForCaseOnDb, persistEvidenceEventOnDb } from "./evidence.ts";
import {
  contentEventId,
  contentEventTypeFromLifecycle,
  persistContentEventOnDb,
  type OpportunityContentEvent,
} from "./content-events.ts";
import {
  claimMilestoneDeliveryOnDb,
  evaluateReturnMilestones,
  listMilestonesForCaseOnDb,
  markMilestoneDeliveredOnDb,
  persistReachedMilestoneOnDb,
  releaseMilestoneClaimOnDb,
  returnMilestonesFromEnv,
  statusAfterReturn,
} from "./milestones.ts";
import {
  emptyOpportunitySummary,
  rebuildOpportunitySummary,
  type OpportunitySummary,
} from "./summary.ts";
import { parseCase, serializeCase, type OpportunityCase } from "./schema.ts";
import { persistOpportunityCaseOnDb } from "./store.ts";

export interface LiveDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run: (...a: any[]) => { changes: number };
  };
  exec?: (sql: string) => void;
  transaction?: <T>(fn: () => T) => () => T;
}

function hasTable(db: LiveDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

export function opportunityLifecycleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED !== "0";
}

export function opportunityLifecycleSchemaReady(db: LiveDb): boolean {
  return hasTable(db, "opportunity_active_index") && hasTable(db, "opportunity_cases");
}

export function findActiveOpportunityByFingerprintOnDb(
  db: LiveDb,
  fingerprint: string,
): { opportunityCaseId: string; lifecycleStatus: string } | null {
  if (!hasTable(db, "opportunity_active_index")) return null;
  try {
    const row = db.prepare(
      `SELECT opportunity_case_id, lifecycle_status FROM opportunity_active_index WHERE opportunity_fingerprint=?`,
    ).get(fingerprint) as { opportunity_case_id?: string; lifecycle_status?: string } | undefined;
    if (!row?.opportunity_case_id) return null;
    if (!isActiveLifecycleStatus(row.lifecycle_status)) return null;
    return { opportunityCaseId: String(row.opportunity_case_id), lifecycleStatus: String(row.lifecycle_status) };
  } catch {
    return null;
  }
}

export function loadCaseJsonOnDb(db: LiveDb, opportunityCaseId: string): OpportunityCase | null {
  if (!hasTable(db, "opportunity_cases")) return null;
  try {
    const row = db.prepare("SELECT case_json FROM opportunity_cases WHERE opportunity_id=?").get(opportunityCaseId) as { case_json?: string } | undefined;
    if (!row?.case_json) return null;
    return parseCase(row.case_json);
  } catch {
    return null;
  }
}

function bumpMetric(db: LiveDb, key: string, by = 1): void {
  if (!hasTable(db, "options_runtime")) return;
  try {
    const now = Date.now();
    const cur = db.prepare("SELECT value FROM options_runtime WHERE key=?").get(key) as { value?: string } | undefined;
    const n = Number(cur?.value ?? 0);
    const next = (Number.isFinite(n) ? n : 0) + by;
    db.prepare(
      `INSERT INTO options_runtime (key, value, updated_at_ms) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at_ms=excluded.updated_at_ms`,
    ).run(key, String(next), now);
  } catch { /* isolated */ }
}

export function logSuppressionOnDb(
  db: LiveDb,
  row: {
    symbol: string;
    strategy?: string | null;
    fingerprint: string;
    existingOpportunityCaseId: string | null;
    reason: string;
    decision: string;
    latestReturnPercent?: number | null;
    nextUndeliveredMilestone?: number | null;
    details?: Record<string, unknown>;
    nowMs: number;
  },
): void {
  if (!hasTable(db, "opportunity_suppression_log")) return;
  try {
    db.prepare(
      `INSERT INTO opportunity_suppression_log
        (symbol, strategy, fingerprint, existing_opportunity_case_id, decision, reason,
         latest_return_percent, next_undelivered_milestone, details_json, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.symbol,
      row.strategy ?? null,
      row.fingerprint,
      row.existingOpportunityCaseId,
      row.decision,
      row.reason,
      row.latestReturnPercent ?? null,
      row.nextUndeliveredMilestone ?? null,
      JSON.stringify(row.details ?? {}),
      row.nowMs,
    );
    bumpMetric(db, "lifecycle.duplicateOpeningAlertsSuppressed");
  } catch { /* isolated */ }
}

function thesisForStrategy(strategyKey: string, why?: string | null): string[] {
  const lines = [setupSentence(strategyKey)];
  if (why && why.trim() && !lines.includes(why.trim())) lines.push(why.trim());
  return lines;
}

export interface ClaimOpenResult {
  claimed: boolean;
  opportunityCaseId: string;
  fingerprint: string;
  identity: OpportunityIdentity;
  existing: boolean;
  reason: string;
}

/** Atomic open claim. Only the winner may send the opening Discord alert. */
export function claimOpportunityOpenOnDb(
  db: LiveDb,
  input: {
    symbol: string;
    side: "call" | "put";
    expiration: string;
    strike: number;
    strategyKey: string;
    nowMs: number;
    direction?: "bullish" | "bearish" | "neutral" | null;
    quality?: number | null;
    why?: string | null;
    frozenEntry?: number | null;
    optionSymbol?: string | null;
    alertId?: string | null;
  },
): ClaimOpenResult {
  const identity = buildOpportunityIdentity(input);
  const fingerprint = opportunityFingerprint(identity);
  const existing = findActiveOpportunityByFingerprintOnDb(db, fingerprint);
  if (existing) {
    return {
      claimed: false,
      opportunityCaseId: existing.opportunityCaseId,
      fingerprint,
      identity,
      existing: true,
      reason: "MATCHING_ACTIVE_OPPORTUNITY",
    };
  }

  const opportunityCaseId = opportunityCaseIdForOpen(fingerprint, input.nowMs);
  if (!opportunityLifecycleSchemaReady(db)) {
    // Schema not migrated yet — caller must fall back to legacy alertId/setup dedup.
    return {
      claimed: false,
      opportunityCaseId,
      fingerprint,
      identity,
      existing: false,
      reason: "SCHEMA_UNAVAILABLE",
    };
  }

  try {
    const ins = db.prepare(
      `INSERT INTO opportunity_active_index
        (opportunity_fingerprint, opportunity_case_id, symbol, session_date, strategy_key,
         lifecycle_status, opened_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      fingerprint,
      opportunityCaseId,
      identity.symbol,
      identity.sessionDate,
      identity.strategyKey,
      "CREATED",
      input.nowMs,
      input.nowMs,
    );
    if (Number(ins.changes ?? 0) <= 0) {
      const again = findActiveOpportunityByFingerprintOnDb(db, fingerprint);
      return {
        claimed: false,
        opportunityCaseId: again?.opportunityCaseId ?? opportunityCaseId,
        fingerprint,
        identity,
        existing: true,
        reason: "MATCHING_ACTIVE_OPPORTUNITY",
      };
    }
  } catch {
    const again = findActiveOpportunityByFingerprintOnDb(db, fingerprint);
    if (again) {
      return {
        claimed: false,
        opportunityCaseId: again.opportunityCaseId,
        fingerprint,
        identity,
        existing: true,
        reason: "MATCHING_ACTIVE_OPPORTUNITY",
      };
    }
  }

  const summary = rebuildOpportunitySummary({
    status: "CREATED",
    originalThesis: thesisForStrategy(identity.strategyKey, input.why),
    frozenEntry: input.frozenEntry ?? null,
    evidence: [],
    milestones: [],
    currentConfidence: input.quality ?? null,
    openedAtMs: input.nowMs,
    nowMs: input.nowMs,
    returnMilestones: returnMilestonesFromEnv(),
  });

  const oc: OpportunityCase = {
    schemaVersion: 1,
    opportunityId: opportunityCaseId,
    underlyingSymbol: identity.symbol,
    direction: identity.direction === "BEARISH" ? "bearish" : "bullish",
    setupFamily: identity.strategyKey,
    detectedAtMs: input.nowMs,
    marketSession: "regular",
    sourcePath: "options_live",
    underlyingQuote: { price: null, velPct: null, relVolume: null, quoteTimestampMs: null, freshnessState: "missing" },
    chainMetadata: { fetched: false, contractCount: null, fetchTimestampMs: null, freshnessState: "missing" },
    selectedContract: input.optionSymbol
      ? {
          optionSymbol: input.optionSymbol,
          side: input.side,
          strike: identity.strike,
          expiration: identity.expiration,
          dte: 0,
          bid: null,
          ask: null,
          spreadPct: null,
          delta: null,
          openInterest: null,
          volume: null,
          selectionReason: "delivered_contract",
        }
      : null,
    rejectedContracts: [],
    frozenTrade: input.frozenEntry != null
      ? {
          entryMid: input.frozenEntry,
          targetT1: 0,
          targetT2: 0,
          stop: 0,
          bid: input.frozenEntry,
          ask: input.frozenEntry,
          spreadPct: 0,
          methodology: "frozen_delivery_entry",
          frozenAtMs: input.nowMs,
          immutable: true,
        }
      : null,
    invalidation: null,
    expectedHorizon: null,
    marketRegime: { label: null, reasonCodes: [], timestampMs: null, uncertainty: null, configVersion: "1", freshnessState: "missing" },
    strategyEvaluations: [],
    ensembleDecision: null,
    hardGateResults: [],
    probabilities: [],
    rank: null,
    rankExplanation: null,
    acceptanceDecision: "accepted",
    rejectionReasonCodes: [],
    deliveryDecision: "pending",
    deliveryReason: null,
    alertId: input.alertId ?? null,
    explanationPayload: null,
    dataLineage: ["options_live_delivery"],
    configVersions: { opportunityLifecycle: "1" },
    discordDeliveryStatus: null,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    opportunityFingerprint: fingerprint,
    sessionDate: identity.sessionDate,
    lifecycleStatus: "CREATED",
    summary,
    discord: {
      channelId: null,
      messageId: null,
      threadId: null,
      deliveredAt: null,
    },
    originalThesis: summary.originalThesis,
  };

  try {
    persistOpportunityCaseOnDb(db as any, oc);
    // also set columnar fields when present
    try {
      db.prepare(
        `UPDATE opportunity_cases
         SET opportunity_fingerprint=?, session_date=?, lifecycle_status=?, summary_json=?, updated_at_ms=?
         WHERE opportunity_id=?`,
      ).run(fingerprint, identity.sessionDate, "CREATED", JSON.stringify(summary), input.nowMs, opportunityCaseId);
    } catch { /* columns may lag on first boot before migrate */ }
    bumpMetric(db, "lifecycle.newOpportunitiesCreated");
  } catch { /* isolated */ }

  return { claimed: true, opportunityCaseId, fingerprint, identity, existing: false, reason: "opportunity_created" };
}

export function attachEvidenceToOpportunityOnDb(
  db: LiveDb,
  input: {
    opportunityCaseId: string;
    nowMs: number;
    source: string;
    signalType: string;
    score?: number | null;
    details?: Record<string, unknown>;
    strengthen?: boolean;
    weaken?: boolean;
  },
): { attached: boolean; eventType?: LifecycleEventType } {
  const ev = buildEvidenceEvent({
    opportunityCaseId: input.opportunityCaseId,
    observedAtMs: input.nowMs,
    source: input.source,
    signalType: input.signalType,
    score: input.score,
    details: input.details,
  });
  const attached = persistEvidenceEventOnDb(db as any, ev);
  if (!attached) return { attached: false };

  const oc = loadCaseJsonOnDb(db, input.opportunityCaseId);
  if (oc) {
    let status = (oc.lifecycleStatus ?? oc.summary?.currentStatus ?? "CREATED") as OpportunityLifecycleStatus;
    let eventType: LifecycleEventType | undefined;
    if (input.strengthen) {
      eventType = "THESIS_STRENGTHENED";
      status = nextLifecycleStatus({ current: status, event: eventType });
      persistReachedMilestoneOnDb(db as any, {
        opportunityCaseId: input.opportunityCaseId,
        eventType,
        reachedAtMs: input.nowMs,
        details: { signalType: input.signalType, score: input.score ?? null },
      });
    } else if (input.weaken) {
      eventType = "THESIS_WEAKENING";
      persistReachedMilestoneOnDb(db as any, {
        opportunityCaseId: input.opportunityCaseId,
        eventType,
        reachedAtMs: input.nowMs,
        details: { signalType: input.signalType, score: input.score ?? null },
      });
    }
    refreshCaseSummaryOnDb(db, input.opportunityCaseId, {
      status,
      nowMs: input.nowMs,
      currentConfidence: input.score ?? oc.summary?.currentConfidence ?? null,
    });
    if (eventType) {
      emitContentEventForCase(db, input.opportunityCaseId, eventType, input.nowMs);
    }
    bumpMetric(db, "lifecycle.evidenceEventsAttached");
    return { attached: true, eventType };
  }
  bumpMetric(db, "lifecycle.evidenceEventsAttached");
  return { attached: true };
}

export function markOpportunityOpenedDeliveredOnDb(
  db: LiveDb,
  input: {
    opportunityCaseId: string;
    alertId: string;
    discordMessageId: string | null;
    frozenEntry: number | null;
    nowMs: number;
    quality?: number | null;
  },
): void {
  const oc = loadCaseJsonOnDb(db, input.opportunityCaseId);
  if (!oc) return;
  oc.alertId = input.alertId;
  oc.deliveryDecision = "delivered";
  oc.discordDeliveryStatus = "DELIVERED";
  oc.lifecycleStatus = "CREATED";
  oc.discord = {
    channelId: null,
    messageId: input.discordMessageId,
    threadId: null,
    deliveredAt: new Date(input.nowMs).toISOString(),
  };
  if (input.frozenEntry != null && oc.frozenTrade) {
    oc.frozenTrade = { ...oc.frozenTrade, entryMid: input.frozenEntry, immutable: true };
  } else if (input.frozenEntry != null) {
    oc.frozenTrade = {
      entryMid: input.frozenEntry,
      targetT1: 0,
      targetT2: 0,
      stop: 0,
      bid: input.frozenEntry,
      ask: input.frozenEntry,
      spreadPct: 0,
      methodology: "frozen_delivery_entry",
      frozenAtMs: input.nowMs,
      immutable: true,
    };
  }
  persistReachedMilestoneOnDb(db as any, {
    opportunityCaseId: input.opportunityCaseId,
    eventType: "OPPORTUNITY_OPENED",
    reachedAtMs: input.nowMs,
    contractMark: input.frozenEntry,
    returnPercent: 0,
  });
  markMilestoneDeliveredOnDb(db as any, input.opportunityCaseId, "OPPORTUNITY_OPENED", null, input.discordMessageId, input.nowMs);

  oc.summary = refreshCaseSummaryOnDb(db, input.opportunityCaseId, {
    status: "CREATED",
    nowMs: input.nowMs,
    frozenEntry: input.frozenEntry,
    currentMark: input.frozenEntry,
    currentReturnPct: 0,
    maxReturnPct: 0,
    currentConfidence: input.quality ?? oc.summary?.currentConfidence ?? null,
    openedAtMs: input.nowMs,
  }) ?? oc.summary ?? emptyOpportunitySummary("CREATED", input.nowMs);

  oc.updatedAtMs = input.nowMs;
  try {
    persistOpportunityCaseOnDb(db as any, oc);
    db.prepare(
      `UPDATE opportunity_cases
       SET alert_id=?, delivery_decision='delivered', lifecycle_status='CREATED',
           discord_message_id=?, opening_delivered_at_ms=?, summary_json=?, updated_at_ms=?
       WHERE opportunity_id=?`,
    ).run(
      input.alertId,
      input.discordMessageId,
      input.nowMs,
      JSON.stringify(oc.summary),
      input.nowMs,
      input.opportunityCaseId,
    );
  } catch { /* isolated */ }

  emitContentEventForCase(db, input.opportunityCaseId, "OPPORTUNITY_OPENED", input.nowMs);
}

export function refreshCaseSummaryOnDb(
  db: LiveDb,
  opportunityCaseId: string,
  patch: {
    status?: OpportunityLifecycleStatus;
    nowMs: number;
    frozenEntry?: number | null;
    currentMark?: number | null;
    currentReturnPct?: number | null;
    maxReturnPct?: number | null;
    currentConfidence?: number | null;
    openedAtMs?: number | null;
  },
): OpportunitySummary | null {
  const oc = loadCaseJsonOnDb(db, opportunityCaseId);
  if (!oc) return null;
  const evidence = listEvidenceForCaseOnDb(db as any, opportunityCaseId, 100);
  const milestones = listMilestonesForCaseOnDb(db as any, opportunityCaseId);
  const status = patch.status ?? (oc.lifecycleStatus as OpportunityLifecycleStatus) ?? "CREATED";
  const priorMax = oc.summary?.maxReturnPct ?? null;
  const maxReturn = patch.maxReturnPct != null
    ? patch.maxReturnPct
    : (patch.currentReturnPct != null
      ? Math.max(priorMax ?? patch.currentReturnPct, patch.currentReturnPct)
      : priorMax);
  const summary = rebuildOpportunitySummary({
    status,
    originalThesis: oc.originalThesis ?? oc.summary?.originalThesis ?? thesisForStrategy(oc.setupFamily ?? "unknown"),
    frozenEntry: patch.frozenEntry ?? oc.summary?.frozenEntry ?? oc.frozenTrade?.entryMid ?? null,
    currentMark: patch.currentMark ?? oc.summary?.currentMark ?? null,
    currentReturnPct: patch.currentReturnPct ?? oc.summary?.currentReturnPct ?? null,
    maxReturnPct: maxReturn,
    evidence,
    milestones,
    currentConfidence: patch.currentConfidence ?? oc.summary?.currentConfidence ?? null,
    openedAtMs: patch.openedAtMs ?? oc.summary?.openedAtMs ?? oc.detectedAtMs,
    nowMs: patch.nowMs,
    returnMilestones: returnMilestonesFromEnv(),
  });
  oc.summary = summary;
  oc.lifecycleStatus = status;
  oc.originalThesis = summary.originalThesis;
  oc.updatedAtMs = patch.nowMs;
  try {
    persistOpportunityCaseOnDb(db as any, oc);
    db.prepare(
      `UPDATE opportunity_cases SET lifecycle_status=?, summary_json=?, updated_at_ms=? WHERE opportunity_id=?`,
    ).run(status, JSON.stringify(summary), patch.nowMs, opportunityCaseId);
    if (hasTable(db, "opportunity_active_index") && isActiveLifecycleStatus(status)) {
      db.prepare(
        `UPDATE opportunity_active_index SET lifecycle_status=?, updated_at_ms=? WHERE opportunity_case_id=?`,
      ).run(status, patch.nowMs, opportunityCaseId);
    }
  } catch { /* isolated */ }
  return summary;
}

export function emitContentEventForCase(
  db: LiveDb,
  opportunityCaseId: string,
  event: LifecycleEventType,
  nowMs: number,
  extra?: { milestonePercent?: number | null; label?: string | null },
): boolean {
  try {
    const oc = loadCaseJsonOnDb(db, opportunityCaseId);
    if (!oc) return false;
    const s = oc.summary ?? emptyOpportunitySummary();
    const evType = contentEventTypeFromLifecycle(event);
    const disc = `${event}|${extra?.milestonePercent ?? "none"}|${nowMs}`;
    const payload: OpportunityContentEvent = {
      id: contentEventId(opportunityCaseId, evType, disc),
      opportunityCaseId,
      eventType: evType,
      symbol: oc.underlyingSymbol,
      occurredAt: new Date(nowMs).toISOString(),
      frozenEntry: s.frozenEntry,
      currentMark: s.currentMark,
      returnPercent: s.currentReturnPct,
      milestonePercent: extra?.milestonePercent ?? null,
      maxReturnPercent: s.maxReturnPct,
      direction: oc.direction,
      optionType: oc.selectedContract?.side?.toUpperCase() ?? "",
      strike: oc.selectedContract?.strike ?? null,
      expiration: oc.selectedContract?.expiration ?? null,
      originalThesis: s.originalThesis,
      evidenceSummary: s.latestEvidence
        ? [`${s.latestEvidence.signalType} @ ${s.latestEvidence.observedAt}`]
        : [],
      strategyKey: oc.setupFamily,
      contentStatus: "PENDING",
      createdAt: new Date(nowMs).toISOString(),
      label: extra?.label ?? null,
    };
    const ok = persistContentEventOnDb(db as any, payload);
    if (ok) bumpMetric(db, "lifecycle.contentEventsCreated");
    return ok;
  } catch {
    return false;
  }
}

export interface MarkUpdateResult {
  summary: OpportunitySummary | null;
  deliverReturnMilestone: number | null;
  newHigh: boolean;
  claimed: boolean;
  claimToken: string | null;
}

/** Apply a fresh mark to the living Opportunity Case. Claims at most one Discord milestone. */
export function applyOpportunityMarkOnDb(
  db: LiveDb,
  input: {
    opportunityCaseId: string;
    frozenEntry: number;
    currentMark: number;
    returnPct: number;
    nowMs: number;
    env?: NodeJS.ProcessEnv;
  },
): MarkUpdateResult {
  const levels = returnMilestonesFromEnv(input.env);
  const prior = listMilestonesForCaseOnDb(db as any, input.opportunityCaseId)
    .filter((m) => m.eventType === "RETURN_MILESTONE" && m.milestonePercent != null)
    .map((m) => m.milestonePercent as number);
  const { crossed, deliverPercent } = evaluateReturnMilestones({
    returnPct: input.returnPct,
    priorReached: prior,
    levels,
  });

  for (const p of crossed) {
    persistReachedMilestoneOnDb(db as any, {
      opportunityCaseId: input.opportunityCaseId,
      eventType: "RETURN_MILESTONE",
      milestonePercent: p,
      reachedAtMs: input.nowMs,
      contractMark: input.currentMark,
      returnPercent: input.returnPct,
    });
    bumpMetric(db, "lifecycle.milestonesReached");
  }

  const oc = loadCaseJsonOnDb(db, input.opportunityCaseId);
  const prevMax = oc?.summary?.maxReturnPct ?? null;
  const newHigh = prevMax == null || input.returnPct > prevMax + 1e-9;
  if (newHigh && input.returnPct > 0) {
    persistReachedMilestoneOnDb(db as any, {
      opportunityCaseId: input.opportunityCaseId,
      eventType: "NEW_HIGH",
      reachedAtMs: input.nowMs,
      contractMark: input.currentMark,
      returnPercent: input.returnPct,
      details: { previousMax: prevMax },
    });
  }

  const status = statusAfterReturn(
    (oc?.lifecycleStatus as OpportunityLifecycleStatus) ?? "CREATED",
    input.returnPct,
  );
  const summary = refreshCaseSummaryOnDb(db, input.opportunityCaseId, {
    status,
    nowMs: input.nowMs,
    frozenEntry: input.frozenEntry,
    currentMark: input.currentMark,
    currentReturnPct: input.returnPct,
    maxReturnPct: newHigh ? input.returnPct : (prevMax ?? input.returnPct),
  });

  let claimed = false;
  let claimToken: string | null = null;
  if (deliverPercent != null) {
    claimToken = `claim_${input.opportunityCaseId}_${deliverPercent}_${input.nowMs}`;
    claimed = claimMilestoneDeliveryOnDb(
      db as any,
      input.opportunityCaseId,
      "RETURN_MILESTONE",
      deliverPercent,
      claimToken,
      input.nowMs,
    );
    if (claimed) bumpMetric(db, "lifecycle.milestoneDeliveryClaimed");
  }

  return { summary, deliverReturnMilestone: claimed ? deliverPercent : null, newHigh, claimed, claimToken };
}

export function completeMilestoneDeliveryOnDb(
  db: LiveDb,
  input: {
    opportunityCaseId: string;
    milestonePercent: number;
    discordMessageId: string | null;
    nowMs: number;
    ok: boolean;
    claimToken: string | null;
  },
): void {
  if (input.ok) {
    markMilestoneDeliveredOnDb(
      db as any,
      input.opportunityCaseId,
      "RETURN_MILESTONE",
      input.milestonePercent,
      input.discordMessageId,
      input.nowMs,
    );
    refreshCaseSummaryOnDb(db, input.opportunityCaseId, { nowMs: input.nowMs });
    emitContentEventForCase(db, input.opportunityCaseId, "RETURN_MILESTONE", input.nowMs, {
      milestonePercent: input.milestonePercent,
      label: `+${input.milestonePercent}%`,
    });
    bumpMetric(db, "lifecycle.milestoneUpdatesDelivered");
  } else {
    if (input.claimToken) {
      releaseMilestoneClaimOnDb(
        db as any,
        input.opportunityCaseId,
        "RETURN_MILESTONE",
        input.milestonePercent,
        input.claimToken,
        input.nowMs,
      );
    }
    bumpMetric(db, "lifecycle.milestoneDeliveryFailures");
  }
}

export function closeOpportunityOnDb(
  db: LiveDb,
  input: {
    opportunityCaseId: string;
    nowMs: number;
    exitReason?: string | null;
    returnPct?: number | null;
    currentMark?: number | null;
    invalidated?: boolean;
  },
): void {
  const event: LifecycleEventType = input.invalidated ? "OPPORTUNITY_CLOSED" : "EXIT_HIT";
  const status: OpportunityLifecycleStatus = input.invalidated ? "INVALIDATED" : "CLOSED";
  persistReachedMilestoneOnDb(db as any, {
    opportunityCaseId: input.opportunityCaseId,
    eventType: event,
    reachedAtMs: input.nowMs,
    contractMark: input.currentMark ?? null,
    returnPercent: input.returnPct ?? null,
    details: { exitReason: input.exitReason ?? null },
  });
  markMilestoneDeliveredOnDb(db as any, input.opportunityCaseId, event, null, null, input.nowMs);
  persistReachedMilestoneOnDb(db as any, {
    opportunityCaseId: input.opportunityCaseId,
    eventType: "OPPORTUNITY_CLOSED",
    reachedAtMs: input.nowMs,
    contractMark: input.currentMark ?? null,
    returnPercent: input.returnPct ?? null,
  });
  markMilestoneDeliveredOnDb(db as any, input.opportunityCaseId, "OPPORTUNITY_CLOSED", null, null, input.nowMs);
  persistReachedMilestoneOnDb(db as any, {
    opportunityCaseId: input.opportunityCaseId,
    eventType: "REPORT_CARD_READY",
    reachedAtMs: input.nowMs,
    returnPercent: input.returnPct ?? null,
  });

  refreshCaseSummaryOnDb(db, input.opportunityCaseId, {
    status,
    nowMs: input.nowMs,
    currentMark: input.currentMark,
    currentReturnPct: input.returnPct,
  });

  if (hasTable(db, "opportunity_active_index")) {
    try {
      db.prepare("DELETE FROM opportunity_active_index WHERE opportunity_case_id=?").run(input.opportunityCaseId);
    } catch { /* isolated */ }
  }

  emitContentEventForCase(db, input.opportunityCaseId, event, input.nowMs);
  emitContentEventForCase(db, input.opportunityCaseId, "OPPORTUNITY_CLOSED", input.nowMs);
  emitContentEventForCase(db, input.opportunityCaseId, "REPORT_CARD_READY", input.nowMs);
  bumpMetric(db, "lifecycle.opportunitiesClosed");
}

export function findOpportunityCaseIdByAlertOnDb(db: LiveDb, alertId: string): string | null {
  if (!hasTable(db, "opportunity_cases")) return null;
  try {
    const row = db.prepare("SELECT opportunity_id FROM opportunity_cases WHERE alert_id=? ORDER BY updated_at_ms DESC LIMIT 1").get(alertId) as { opportunity_id?: string } | undefined;
    return row?.opportunity_id ? String(row.opportunity_id) : null;
  } catch {
    return null;
  }
}

export function readLifecycleMetricsOnDb(db: LiveDb): Record<string, number> {
  const keys = [
    "lifecycle.newOpportunitiesCreated",
    "lifecycle.duplicateOpeningAlertsSuppressed",
    "lifecycle.evidenceEventsAttached",
    "lifecycle.milestonesReached",
    "lifecycle.milestoneDeliveryClaimed",
    "lifecycle.milestoneUpdatesDelivered",
    "lifecycle.milestoneDeliveryFailures",
    "lifecycle.contentEventsCreated",
    "lifecycle.opportunitiesClosed",
  ];
  const out: Record<string, number> = {};
  if (!hasTable(db, "options_runtime")) {
    for (const k of keys) out[k.split(".")[1]] = 0;
    return out;
  }
  for (const k of keys) {
    try {
      const v = Number((db.prepare("SELECT value FROM options_runtime WHERE key=?").get(k) as any)?.value ?? 0);
      out[k.split(".")[1]] = Number.isFinite(v) ? v : 0;
    } catch {
      out[k.split(".")[1]] = 0;
    }
  }
  try {
    out.activeOpportunities = hasTable(db, "opportunity_active_index")
      ? Number((db.prepare("SELECT COUNT(*) n FROM opportunity_active_index").get() as any)?.n ?? 0)
      : 0;
  } catch {
    out.activeOpportunities = 0;
  }
  try {
    out.contentEventsPending = hasTable(db, "opportunity_content_events")
      ? Number((db.prepare("SELECT COUNT(*) n FROM opportunity_content_events WHERE content_status='PENDING'").get() as any)?.n ?? 0)
      : 0;
  } catch {
    out.contentEventsPending = 0;
  }
  return out;
}

export function recentSuppressionsOnDb(db: LiveDb, limit = 20): Record<string, unknown>[] {
  if (!hasTable(db, "opportunity_suppression_log")) return [];
  try {
    return (db.prepare(
      `SELECT symbol, strategy, fingerprint, existing_opportunity_case_id AS existingOpportunityCaseId,
              decision, reason, latest_return_percent AS latestReturnPercent,
              next_undelivered_milestone AS nextUndeliveredMilestone, created_at_ms AS createdAtMs
       FROM opportunity_suppression_log ORDER BY created_at_ms DESC LIMIT ?`,
    ).all(limit) as any[]).map((r) => ({ ...r }));
  } catch {
    return [];
  }
}

export { serializeCase };
