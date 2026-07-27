/**
 * lib/research/subscriber-readiness-notifier.ts — the ONLY actor on subscriber readiness. It owns the
 * NOT_READY ⇄ SUBSCRIBER_READY state machine and sends exactly one owner-only Discord message to the
 * private recap channel on each real edge:
 *   • NOT_READY → SUBSCRIBER_READY  → "SUBSCRIBER READINESS ACHIEVED"
 *   • SUBSCRIBER_READY → NOT_READY  → "SUBSCRIBER READINESS REVOKED" (names the failing gate)
 *
 * Anti-spam guarantees:
 *   • The transition (new status + incremented transition_id + frozen evidence snapshot) is persisted
 *     BEFORE the Discord send, so a crash/restart mid-send never causes a resend.
 *   • A message is "owed" only while last_notification_status ∈ {PENDING,FAILED,SKIPPED_NO_WEBHOOK}
 *     for the CURRENT transition_id; on success we stamp {ready,revoked}_notified_transition_id and it
 *     is never sent again. A failed send is retried on the next run WITHOUT needing a new edge.
 *   • READY promotions only happen on a completed-day boundary (or a manual re-evaluate); a safety /
 *     integrity breach REVOKES immediately on any trigger. This prevents intraday flapping.
 *
 * It NEVER enables billing, invites subscribers, changes Discord permissions, publishes marketing,
 * changes trading formulas, or deploys code. It only tells the owner the measurable bar was met and a
 * final human review is due.
 */
import { evaluateMarketSessionGuard } from "../market-session-guard.ts";
import {
  evaluateSubscriberReadiness,
  READINESS_ATTESTATIONS,
  type ReadinessDb,
  type ReadinessStatus,
  type SubscriberReadinessReport,
} from "./subscriber-readiness.ts";

export type TransitionTrigger = "intraday" | "day_boundary" | "manual";
export type NotificationStatus = "PENDING" | "SENT" | "FAILED" | "SKIPPED_NO_WEBHOOK" | "NONE";

export interface ReadinessStateRow {
  status: ReadinessStatus;
  transitionId: number;
  lastEvaluatedAtMs: number | null;
  lastTransitionAtMs: number | null;
  lastFailingGate: string | null;
  evidenceSnapshot: SubscriberReadinessReport | null;
  readyNotifiedTransitionId: number | null;
  revokedNotifiedTransitionId: number | null;
  lastNotificationKind: "READY" | "REVOKED" | null;
  lastNotificationStatus: NotificationStatus;
  lastNotificationError: string | null;
  lastNotificationMessageId: string | null;
  lastNotificationAtMs: number | null;
}

export interface NotifierSendResult { ok: boolean; messageId: string | null; error: string | null }
export interface ReadinessNotifierDeps {
  /** Send to the private recap/owner channel. Defaults to postToDiscord(webhook:"recap"). */
  send?: (content: string) => Promise<NotifierSendResult>;
  /** True when a recap webhook is configured. Defaults to reading DISCORD_WEBHOOK_RECAP. */
  webhookConfigured?: () => boolean;
  now?: () => number;
}

export interface TransitionResult {
  report: SubscriberReadinessReport;
  state: ReadinessStateRow;
  transitioned: boolean;
  notificationSent: boolean;
  notificationKind: "READY" | "REVOKED" | null;
}

const IN_SESSION = new Set(["OPENING_DISCOVERY", "REGULAR_SESSION", "EARLY_CLOSE", "POWER_HOUR", "CLOSING_WINDOW"]);

function hasTable(db: ReadinessDb, name: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); } catch { return false; }
}

function defaultSend(env: NodeJS.ProcessEnv): (content: string) => Promise<NotifierSendResult> {
  return async (content: string) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { postToDiscord } = require("@/lib/notifications");
      const r = await postToDiscord({ content }, { webhook: "recap", skipPublicCheck: true });
      return { ok: true, messageId: r.messageId ?? null, error: null };
    } catch (e: any) {
      return { ok: false, messageId: null, error: String(e?.message ?? e).slice(0, 300) };
    }
  };
}

export function readReadinessStateOnDb(db: ReadinessDb): ReadinessStateRow | null {
  if (!hasTable(db, "options_subscriber_readiness_state")) return null;
  try {
    const r = db.prepare("SELECT * FROM options_subscriber_readiness_state WHERE id=1").get() as any;
    if (!r) return null;
    let snapshot: SubscriberReadinessReport | null = null;
    try { snapshot = r.evidence_snapshot_json ? JSON.parse(r.evidence_snapshot_json) : null; } catch { snapshot = null; }
    return {
      status: (r.status as ReadinessStatus) ?? "NOT_READY",
      transitionId: Number(r.transition_id ?? 0),
      lastEvaluatedAtMs: r.last_evaluated_at_ms ?? null,
      lastTransitionAtMs: r.last_transition_at_ms ?? null,
      lastFailingGate: r.last_failing_gate ?? null,
      evidenceSnapshot: snapshot,
      readyNotifiedTransitionId: r.ready_notified_transition_id ?? null,
      revokedNotifiedTransitionId: r.revoked_notified_transition_id ?? null,
      lastNotificationKind: (r.last_notification_kind as "READY" | "REVOKED" | null) ?? null,
      lastNotificationStatus: (r.last_notification_status as NotificationStatus) ?? "NONE",
      lastNotificationError: r.last_notification_error ?? null,
      lastNotificationMessageId: r.last_notification_message_id ?? null,
      lastNotificationAtMs: r.last_notification_at_ms ?? null,
    };
  } catch { return null; }
}

function writeState(db: ReadinessDb, s: ReadinessStateRow, nowMs: number): void {
  db.prepare(
    `INSERT INTO options_subscriber_readiness_state
       (id, status, transition_id, last_evaluated_at_ms, last_transition_at_ms, last_failing_gate,
        evidence_snapshot_json, ready_notified_transition_id, revoked_notified_transition_id,
        last_notification_kind, last_notification_status, last_notification_error,
        last_notification_message_id, last_notification_at_ms, created_at_ms, updated_at_ms)
     VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       status=excluded.status, transition_id=excluded.transition_id,
       last_evaluated_at_ms=excluded.last_evaluated_at_ms, last_transition_at_ms=excluded.last_transition_at_ms,
       last_failing_gate=excluded.last_failing_gate, evidence_snapshot_json=excluded.evidence_snapshot_json,
       ready_notified_transition_id=excluded.ready_notified_transition_id,
       revoked_notified_transition_id=excluded.revoked_notified_transition_id,
       last_notification_kind=excluded.last_notification_kind, last_notification_status=excluded.last_notification_status,
       last_notification_error=excluded.last_notification_error, last_notification_message_id=excluded.last_notification_message_id,
       last_notification_at_ms=excluded.last_notification_at_ms, updated_at_ms=excluded.updated_at_ms`,
  ).run(
    s.status, s.transitionId, s.lastEvaluatedAtMs, s.lastTransitionAtMs, s.lastFailingGate,
    s.evidenceSnapshot ? JSON.stringify(s.evidenceSnapshot) : null,
    s.readyNotifiedTransitionId, s.revokedNotifiedTransitionId,
    s.lastNotificationKind, s.lastNotificationStatus, s.lastNotificationError,
    s.lastNotificationMessageId, s.lastNotificationAtMs, nowMs, nowMs,
  );
}

function pct(x: number | null | undefined): string {
  return x == null ? "n/a" : `${Math.round(Number(x) * 100)}%`;
}
function n2(x: number | string | boolean | null | undefined, suffix = ""): string {
  if (x == null) return "n/a";
  return `${x}${suffix}`;
}

/** Human-readable label for a gate id, for the REVOKED message. */
function gateLabel(report: SubscriberReadinessReport, id: string | null): string {
  if (!id) return "unknown gate";
  const g = report.gates.find((x) => x.id === id);
  return g ? `${g.label} (${g.detail})` : id;
}

export function formatReadinessMessage(kind: "READY" | "REVOKED", report: SubscriberReadinessReport, failingGate?: string | null): string {
  const m = report.metrics;
  const lines: string[] = [];
  if (kind === "READY") {
    lines.push("✅ **SUBSCRIBER READINESS ACHIEVED** — measurable launch requirements passed.");
    lines.push("_Owner action required: perform the final human review before enabling anything._");
  } else {
    lines.push("⛔ **SUBSCRIBER READINESS REVOKED** — a launch requirement is no longer satisfied.");
    lines.push(`**Failing gate:** ${gateLabel(report, failingGate ?? report.blockingGates[0] ?? null)}`);
  }
  lines.push("");
  lines.push(`• Trading days observed: ${n2(m.validTradingDays)}`);
  lines.push(`• Real independent delivered alerts: ${n2(m.deliveredSent)} (paper-linked ${n2(m.deliveredLinked)})`);
  lines.push(`• Paper-link rate: ${pct(m.paperLinkRate as number | null)}`);
  lines.push(`• Complete grading rate: ${pct(m.completeGradingRate as number | null)} (${n2(m.gradedSample)} graded)`);
  lines.push(`• Median 60m option return: ${n2(m.medianReturn60m, "%")}`);
  lines.push(`• Expectancy: ${n2(m.expectancy, "%")}`);
  lines.push(`• Win rate: ${pct(m.winRate as number | null)}`);
  lines.push(`• Profit factor: ${n2(m.profitFactor)}`);
  lines.push(`• Early/Timely: ${pct(m.earlyTimelyRate as number | null)} · Late/Chased: ${pct(m.lateChasedRate as number | null)}`);
  lines.push(`• Duplicate-delivery rate: ${pct(m.duplicateRate as number | null)} (${n2(m.duplicateDeliveredCount)} sends)`);
  lines.push(`• Session violations: ${n2(m.sessionViolations)} · Supervisor/legacy sends: ${n2(m.supervisorLegacySends)}`);
  lines.push(`• Missing-quote: ${n2(m.missingQuotePct, "%")}`);
  lines.push(`• Milestone proof: return=${n2(m.returnMilestonesDelivered)}, closed=${n2(m.closedUpdatesDelivered)}`);
  lines.push(`• Stripe ready: ${m.stripeReady ? "yes" : "no"} · Discord role ready: ${m.discordRoleReady ? "yes" : "no"}`);
  const attestSummary = report.attestations.map((a) => `${a.attested ? "✓" : "✗"} ${a.key}`).join(", ");
  lines.push(`• Attestations: ${attestSummary}`);
  if (report.remainingWarnings.length) lines.push(`• Remaining warnings: ${report.remainingWarnings.join("; ")}`);
  else lines.push("• Remaining warnings: none");
  lines.push("");
  lines.push(`Readiness dashboard: ${report.dashboardUrl || "/pipeline-health"}`);
  lines.push("");
  lines.push("_This notice does NOT enable billing, invite subscribers, change Discord permissions, publish any claim, change trading formulas, or deploy code._");
  return lines.join("\n");
}

/** Is the market currently inside an active delivery session (so READY should wait for day boundary)? */
function inActiveSession(nowMs: number, env: NodeJS.ProcessEnv): boolean {
  try { return IN_SESSION.has(evaluateMarketSessionGuard(nowMs, env).state); } catch { return false; }
}

/**
 * Evaluate readiness and advance the state machine, sending at most one Discord message per edge.
 * Safe to call on every scheduler beat, on a manual re-evaluate, and after any restart.
 */
export async function runReadinessTransition(
  db: ReadinessDb,
  deps: ReadinessNotifierDeps = {},
  env: NodeJS.ProcessEnv = process.env,
  opts: { trigger?: TransitionTrigger; nowMs?: number } = {},
): Promise<TransitionResult> {
  const now = deps.now ?? Date.now;
  const nowMs = opts.nowMs ?? now();
  const trigger: TransitionTrigger = opts.trigger ?? "intraday";
  const send = deps.send ?? defaultSend(env);
  const webhookConfigured = deps.webhookConfigured ?? (() => Boolean(String(env.DISCORD_WEBHOOK_RECAP ?? "").trim()));

  const report = evaluateSubscriberReadiness(db, env, nowMs);
  const prior = readReadinessStateOnDb(db);
  const currentStatus: ReadinessStatus = prior?.status ?? "NOT_READY";

  const dayBoundary = trigger === "manual" || trigger === "day_boundary" || !inActiveSession(nowMs, env);
  const toReadyAllowed = dayBoundary; // never promote mid-session on a transient
  const revokeForSafety = report.failingSafetyGates.length > 0; // immediate on any trigger
  const toRevokeAllowed = revokeForSafety || dayBoundary;

  // Carry prior notification bookkeeping forward.
  let state: ReadinessStateRow = {
    status: currentStatus,
    transitionId: prior?.transitionId ?? 0,
    lastEvaluatedAtMs: nowMs,
    lastTransitionAtMs: prior?.lastTransitionAtMs ?? null,
    lastFailingGate: prior?.lastFailingGate ?? null,
    evidenceSnapshot: prior?.evidenceSnapshot ?? null,
    readyNotifiedTransitionId: prior?.readyNotifiedTransitionId ?? null,
    revokedNotifiedTransitionId: prior?.revokedNotifiedTransitionId ?? null,
    lastNotificationKind: prior?.lastNotificationKind ?? null,
    lastNotificationStatus: prior?.lastNotificationStatus ?? "NONE",
    lastNotificationError: prior?.lastNotificationError ?? null,
    lastNotificationMessageId: prior?.lastNotificationMessageId ?? null,
    lastNotificationAtMs: prior?.lastNotificationAtMs ?? null,
  };

  let transitioned = false;
  let transitionKind: "READY" | "REVOKED" | null = null;

  if (currentStatus === "NOT_READY" && report.ready && toReadyAllowed) {
    transitioned = true;
    transitionKind = "READY";
    state.status = "SUBSCRIBER_READY";
    state.transitionId += 1;
    state.lastTransitionAtMs = nowMs;
    state.lastFailingGate = null;
    state.evidenceSnapshot = report;          // freeze the exact evidence at the transition
    state.lastNotificationKind = "READY";
    state.lastNotificationStatus = "PENDING";
    state.lastNotificationError = null;
  } else if (currentStatus === "SUBSCRIBER_READY" && !report.ready && toRevokeAllowed) {
    transitioned = true;
    transitionKind = "REVOKED";
    state.status = "NOT_READY";
    state.transitionId += 1;
    state.lastTransitionAtMs = nowMs;
    state.lastFailingGate = report.failingSafetyGates[0] ?? report.blockingGates[0] ?? null;
    state.evidenceSnapshot = report;
    state.lastNotificationKind = "REVOKED";
    state.lastNotificationStatus = "PENDING";
    state.lastNotificationError = null;
  }

  // Persist the (possibly transitioned) state BEFORE any Discord send. A restart here never resends:
  // the owed-notification check below is idempotent against transition_id.
  writeState(db, state, nowMs);

  // Deliver any owed notification for the CURRENT transition (covers first attempt AND failed retries).
  const notifiedForThis = state.lastNotificationKind === "READY"
    ? state.readyNotifiedTransitionId === state.transitionId
    : state.lastNotificationKind === "REVOKED"
      ? state.revokedNotifiedTransitionId === state.transitionId
      : true;
  const owed = !notifiedForThis
    && state.lastNotificationKind != null
    && (state.lastNotificationStatus === "PENDING" || state.lastNotificationStatus === "FAILED" || state.lastNotificationStatus === "SKIPPED_NO_WEBHOOK")
    // guard against a stale owed record after a later transition flipped status back:
    && ((state.lastNotificationKind === "READY" && state.status === "SUBSCRIBER_READY")
      || (state.lastNotificationKind === "REVOKED" && state.status === "NOT_READY"));

  let notificationSent = false;
  if (owed) {
    if (!webhookConfigured()) {
      state.lastNotificationStatus = "SKIPPED_NO_WEBHOOK";
      state.lastNotificationError = "DISCORD_WEBHOOK_RECAP not configured";
      state.lastNotificationAtMs = nowMs;
      writeState(db, state, nowMs);
    } else {
      const snapshot = state.evidenceSnapshot ?? report;
      const content = formatReadinessMessage(state.lastNotificationKind!, snapshot, state.lastFailingGate);
      const res = await send(content);
      state.lastNotificationAtMs = now();
      if (res.ok) {
        state.lastNotificationStatus = "SENT";
        state.lastNotificationMessageId = res.messageId;
        state.lastNotificationError = null;
        if (state.lastNotificationKind === "READY") state.readyNotifiedTransitionId = state.transitionId;
        else state.revokedNotifiedTransitionId = state.transitionId;
        notificationSent = true;
      } else {
        state.lastNotificationStatus = "FAILED";
        state.lastNotificationError = res.error;
      }
      writeState(db, state, now());
    }
  }

  return { report, state, transitioned, notificationSent, notificationKind: transitionKind };
}

/** Owner attestation set/clear. Never touches readiness state directly — the next evaluation reflects it. */
export function setReadinessAttestationOnDb(
  db: ReadinessDb,
  key: string,
  attested: boolean,
  opts: { attestedBy?: string | null; note?: string | null; nowMs?: number } = {},
): { ok: boolean; error?: string } {
  if (!READINESS_ATTESTATIONS.some((a) => a.key === key)) return { ok: false, error: `unknown attestation key: ${key}` };
  if (!hasTable(db, "options_subscriber_readiness_attestations")) return { ok: false, error: "attestations table not migrated" };
  const nowMs = opts.nowMs ?? Date.now();
  try {
    db.prepare(
      `INSERT INTO options_subscriber_readiness_attestations (attestation_key, attested, attested_by, note, attested_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(attestation_key) DO UPDATE SET
         attested=excluded.attested, attested_by=excluded.attested_by, note=excluded.note,
         attested_at_ms=excluded.attested_at_ms, updated_at_ms=excluded.updated_at_ms`,
    ).run(key, attested ? 1 : 0, opts.attestedBy ?? null, opts.note ?? null, attested ? nowMs : null, nowMs);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** A clearly-labeled TEST notification that NEVER reads or writes readiness state. */
export async function sendReadinessTestNotificationOnDb(
  db: ReadinessDb,
  deps: ReadinessNotifierDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; messageId: string | null; error: string | null; configured: boolean }> {
  const webhookConfigured = deps.webhookConfigured ?? (() => Boolean(String(env.DISCORD_WEBHOOK_RECAP ?? "").trim()));
  if (!webhookConfigured()) return { ok: false, messageId: null, error: "DISCORD_WEBHOOK_RECAP not configured", configured: false };
  const send = deps.send ?? defaultSend(env);
  const report = evaluateSubscriberReadiness(db, env, deps.now?.() ?? Date.now());
  const content = [
    "🧪 **TEST — SUBSCRIBER READINESS NOTIFICATION (state unchanged)**",
    "This is a connectivity/format test of the owner readiness notifier. It does NOT change readiness state and is NOT a launch signal.",
    "",
    `Current computed status: ${report.status}`,
    `Blocking gates: ${report.blockingGates.length ? report.blockingGates.join(", ") : "none"}`,
    `Readiness dashboard: ${report.dashboardUrl || "/pipeline-health"}`,
  ].join("\n");
  const res = await send(content);
  return { ok: res.ok, messageId: res.messageId, error: res.error, configured: true };
}
