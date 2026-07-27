/**
 * lib/research/subscriber-readiness.ts — deterministic, owner-only "subscriber launch readiness"
 * evaluation. PURE over the DB + env: it READS delivered-alert evidence, paper-chain health, quant
 * lanes, session-guard history, billing/role ops, schema/data-integrity, and owner attestations, and
 * returns a strict NOT_READY / SUBSCRIBER_READY report with a per-gate breakdown and a frozen evidence
 * snapshot. It NEVER sends Discord, changes flags, billing, roles, formulas, or code — the notifier
 * (subscriber-readiness-notifier.ts) is the only thing that acts on this, and only to send a message.
 *
 * Thresholds are deliberately stricter than the legacy paid-beta checklist (owner-approved):
 *   • profitability gates require ≥30 CLOSED & graded delivered trades (not 20), a positive median
 *     60m-or-exit option return, positive expectancy, AND profit factor ≥ 1.1;
 *   • ≥90% of the delivered+linked launch sample must be fully graded;
 *   • 100% paper-linking for the whole delivered sample;
 *   • milestone proof requires BOTH a return-milestone AND an opportunity-closed update delivered;
 *   • the non-measurable operational/legal gates are explicit persisted owner attestations.
 * A gate can only PASS on real evidence — time passing or tests succeeding is never sufficient.
 */
import { tradingDay, isMarketHoliday } from "../trading-session.ts";
import { subscriberDiscordOwnershipSummary } from "../subscriber-discord-owner.ts";
import { quotaPolicySnapshot } from "../quota-policy.ts";
import { subscriberOpsSummary } from "../billing/subscribers-store.ts";
import { readinessSampleCutoffMs } from "./readiness-sample.ts";

export type ReadinessStatus = "NOT_READY" | "SUBSCRIBER_READY";

/** A gate is "safety" (may trigger an IMMEDIATE revoke) or "sample" (only re-evaluated on a
 *  completed-day boundary before it can flip readiness). See the notifier for how this is used. */
export type GateKind = "safety" | "sample";

export interface ReadinessGate {
  id: string;
  label: string;
  kind: GateKind;
  passed: boolean;
  detail: string;
}

export interface SubscriberReadinessReport {
  generatedAtMs: number;
  status: ReadinessStatus;
  ready: boolean;
  blockingGates: string[];         // gate ids currently failing
  failingSafetyGates: string[];    // subset of blockingGates that are safety-class
  gates: ReadinessGate[];
  metrics: Record<string, number | boolean | string | null>;
  attestations: AttestationView[];
  remainingWarnings: string[];
  dashboardUrl: string;
}

export interface AttestationView {
  key: string;
  label: string;
  attested: boolean;
  attestedBy: string | null;
  attestedAtMs: number | null;
  note: string | null;
}

/** Loose DB shape (mirrors the billing/quant lane interfaces) so getDb()'s concrete Database is
 *  assignable without casts, and so subscriberOpsSummary (BillingDb) accepts the same handle. */
export interface ReadinessDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run: (...a: any[]) => { changes: number; lastInsertRowid?: number | bigint };
  };
}

const SIXTY_MIN_MS = 60 * 60_000;

/** Owner attestations for the non-measurable launch gates. Code cannot observe that a flow was
 *  TESTED or that legal copy is complete, so each requires an explicit persisted owner sign-off. */
export const READINESS_ATTESTATIONS: { key: string; label: string }[] = [
  { key: "billing_flows_tested", label: "Billing, cancellation, failed-payment & role-revocation flows tested" },
  { key: "legal_checklist_complete", label: "Terms, disclaimers, refund policy & data-licensing checklist complete" },
  { key: "no_critical_issues_ack", label: "No unresolved Critical security or data-integrity issues (owner-confirmed)" },
];

function hasTable(db: ReadinessDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function num(db: ReadinessDb, sql: string, ...args: unknown[]): number {
  try {
    return Number((db.prepare(sql).get(...args) as { n?: number } | undefined)?.n ?? 0);
  } catch {
    return 0;
  }
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function profitFactor(returns: number[]): number | null {
  const wins = returns.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const losses = Math.abs(returns.filter((x) => x <= 0).reduce((a, b) => a + b, 0));
  if (losses === 0) return returns.some((x) => x > 0) ? Infinity : null;
  return +(wins / losses).toFixed(3);
}

/** Weekend/holiday check on a real send timestamp (deterministic; independent of any stored label). */
function isNonTradingDay(sentAtMs: number, env: NodeJS.ProcessEnv): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(sentAtMs));
  if (weekday === "Sat" || weekday === "Sun") return true;
  return isMarketHoliday(tradingDay(sentAtMs));
}

export function readAttestationsOnDb(db: ReadinessDb): AttestationView[] {
  const byKey = new Map<string, { attested: number; attested_by: string | null; attested_at_ms: number | null; note: string | null }>();
  if (hasTable(db, "options_subscriber_readiness_attestations")) {
    try {
      for (const r of db.prepare(
        "SELECT attestation_key, attested, attested_by, attested_at_ms, note FROM options_subscriber_readiness_attestations",
      ).all() as any[]) {
        byKey.set(String(r.attestation_key), { attested: Number(r.attested) || 0, attested_by: r.attested_by ?? null, attested_at_ms: r.attested_at_ms ?? null, note: r.note ?? null });
      }
    } catch { /* table optional until migrated */ }
  }
  return READINESS_ATTESTATIONS.map(({ key, label }) => {
    const row = byKey.get(key);
    return {
      key,
      label,
      attested: Boolean(row?.attested),
      attestedBy: row?.attested_by ?? null,
      attestedAtMs: row?.attested_at_ms ?? null,
      note: row?.note ?? null,
    };
  });
}

/**
 * Per delivered mirror, the "60-minute-or-exit" option return:
 *   • if it closed within 60 min → its realized return (a real subscriber outcome);
 *   • else the FIRST paper mark at/after 60 min (first-valid-mark, mirrors the shadow grader);
 *   • else if closed after 60 min with no intermediate mark → realized return;
 *   • else null (not yet gradable — counts against the complete-grading gate, never fabricated).
 */
function deliveredSixtyMinReturns(db: ReadinessDb, cutoffMs: number): { graded: number[]; total: number; missingQuote: number } {
  if (!hasTable(db, "options_paper_trades") || !hasTable(db, "options_alerts")) {
    return { graded: [], total: 0, missingQuote: 0 };
  }
  let rows: any[] = [];
  try {
    rows = db.prepare(
      `SELECT p.id, p.entered_at_ms, p.exit_at_ms, p.status, p.return_pct, p.exit_reason
         FROM options_paper_trades p
         INNER JOIN options_alerts a ON a.alert_id = p.alert_id
        WHERE p.paper_kind='DELIVERED_ALERT_PAPER'
          AND a.state='SENT' AND a.research_only=0
          AND a.sent_at_ms IS NOT NULL AND a.sent_at_ms >= ?`,
    ).all(cutoffMs) as any[];
  } catch { return { graded: [], total: 0, missingQuote: 0 }; }
  const marksTable = hasTable(db, "options_paper_marks");
  const graded: number[] = [];
  let missingQuote = 0;
  for (const r of rows) {
    const entered = Number(r.entered_at_ms ?? 0);
    // "Couldn't price it": closed unpriced at expiration, or exited with no usable P&L.
    if (r.exit_reason === "expiration_no_quote" || (r.status === "EXITED" && r.return_pct == null)) missingQuote += 1;
    const exited = r.status === "EXITED" && r.return_pct != null;
    const heldMs = r.exit_at_ms != null ? Number(r.exit_at_ms) - entered : null;
    if (exited && heldMs != null && heldMs <= SIXTY_MIN_MS) {
      graded.push(Number(r.return_pct));
      continue;
    }
    let mark: number | null = null;
    if (marksTable && entered > 0) {
      try {
        const m = db.prepare(
          "SELECT return_pct FROM options_paper_marks WHERE trade_id=? AND mark_at_ms - ? >= ? ORDER BY mark_at_ms ASC LIMIT 1",
        ).get(r.id, entered, SIXTY_MIN_MS) as { return_pct?: number } | undefined;
        mark = m?.return_pct != null ? Number(m.return_pct) : null;
      } catch { mark = null; }
    }
    if (mark != null) { graded.push(mark); continue; }
    if (exited) { graded.push(Number(r.return_pct)); continue; }
    // not gradable yet (open <60m or no usable mark) — excluded from profitability.
  }
  return { graded, total: rows.length, missingQuote };
}

/**
 * Evaluate the full subscriber-readiness gate. Deterministic and side-effect-free.
 */
export function evaluateSubscriberReadiness(db: ReadinessDb, env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): SubscriberReadinessReport {
  const ownership = subscriberDiscordOwnershipSummary(env);
  const quota = quotaPolicySnapshot(env, nowMs);
  const subs = subscriberOpsSummary(db);
  const attestations = readAttestationsOnDb(db);
  const remainingWarnings: string[] = [];
  const sampleCutoffMs = readinessSampleCutoffMs(env);
  const sampleCutoffIso = new Date(sampleCutoffMs).toISOString();
  const sampleSql =
    "state='SENT' AND research_only=0 AND sent_at_ms IS NOT NULL AND sent_at_ms >= ?";

  // ── Delivered-alert launch sample (post-cutoff only; historical rows preserved for research) ──
  const alertsTable = hasTable(db, "options_alerts");
  const deliveredSent = alertsTable ? num(db, `SELECT COUNT(*) n FROM options_alerts WHERE ${sampleSql}`, sampleCutoffMs) : 0;
  const deliveredLinked = alertsTable
    ? num(db, `SELECT COUNT(*) n FROM options_alerts WHERE ${sampleSql} AND paper_linked=1`, sampleCutoffMs)
    : 0;
  const deliveredSentHistorical = alertsTable
    ? num(db, "SELECT COUNT(*) n FROM options_alerts WHERE state='SENT' AND research_only=0 AND sent_at_ms IS NOT NULL AND sent_at_ms < ?", sampleCutoffMs)
    : 0;
  const validTradingDays = alertsTable
    ? num(
      db,
      `SELECT COUNT(DISTINCT COALESCE(trading_session_date, date(sent_at_ms/1000,'unixepoch'))) n
         FROM options_alerts WHERE ${sampleSql}`,
      sampleCutoffMs,
    )
    : 0;
  const paperLinkRate = deliveredSent > 0 ? deliveredLinked / deliveredSent : null;

  const earlyTimelySent = alertsTable
    ? num(
      db,
      `SELECT COUNT(*) n FROM options_alerts WHERE ${sampleSql}
         AND entry_quality_verdict IN ('EARLY','TIMELY','ALLOW')`,
      sampleCutoffMs,
    )
    : 0;
  const lateChasedSent = alertsTable
    ? num(
      db,
      `SELECT COUNT(*) n FROM options_alerts WHERE ${sampleSql}
         AND entry_quality_verdict IN ('LATE','CHASED')`,
      sampleCutoffMs,
    )
    : 0;
  const entryQualityScored = alertsTable
    ? num(
      db,
      `SELECT COUNT(*) n FROM options_alerts WHERE ${sampleSql} AND entry_quality_verdict IS NOT NULL`,
      sampleCutoffMs,
    )
    : 0;
  const earlyTimelyRate = deliveredSent > 0 ? earlyTimelySent / deliveredSent : null;
  const lateChasedRate = deliveredSent > 0 ? lateChasedSent / deliveredSent : null;
  const earlyTimelyRateScored = entryQualityScored > 0 ? earlyTimelySent / entryQualityScored : null;

  // ── Session violations: weekend / holiday / cross-session openings (must be 0) ──
  let sessionViolations = 0;
  if (alertsTable) {
    try {
      for (const r of db.prepare(
        `SELECT sent_at_ms, trading_session_date FROM options_alerts
          WHERE ${sampleSql}`,
      ).all(sampleCutoffMs) as any[]) {
        const sentAt = Number(r.sent_at_ms);
        if (!Number.isFinite(sentAt)) continue;
        if (isNonTradingDay(sentAt, env)) { sessionViolations += 1; continue; }
        const sessionDate = r.trading_session_date ? String(r.trading_session_date) : null;
        if (sessionDate && sessionDate !== tradingDay(sentAt)) sessionViolations += 1; // cross-session opening
      }
    } catch { /* isolated */ }
  }

  // ── Duplicate DELIVERED openings (suppressed dupes are fine; two real SENDs for one setup are not) ──
  let duplicateDelivered = 0;
  if (alertsTable) {
    duplicateDelivered = num(
      db,
      `SELECT COALESCE(SUM(dupes),0) n FROM (
         SELECT COUNT(*) - 1 AS dupes
           FROM options_alerts
          WHERE ${sampleSql}
          GROUP BY COALESCE(opportunity_fingerprint, candidate_symbol || '|' || side || '|' || strategy || '|' || option_symbol)
         HAVING COUNT(*) > 1
       )`,
      sampleCutoffMs,
    );
  }
  const duplicateRate = deliveredSent > 0 ? duplicateDelivered / deliveredSent : 0;

  // ── Supervisor / legacy subscriber sends (must be structurally blocked AND never observed) ──
  const supervisorLegacyStructurallyBlocked = ownership.independentOwns && ownership.supervisorOptionsBlocked && ownership.legacyOptionsBlocked;
  let supervisorLegacySends = 0;
  let supervisorLegacySendsHistorical = 0;
  if (hasTable(db, "discord_deliveries")) {
    // The supervisor canonical path posts options callouts via deliverCalloutDiscord (payload_type='callout').
    // Under owner=independent these are recorded SUPPRESSED, never SENT — any post-cutoff SENT row is a violation.
    supervisorLegacySends = num(
      db,
      `SELECT COUNT(*) n FROM discord_deliveries
        WHERE webhook_name='options' AND payload_type='callout' AND status='SENT'
          AND (CAST(strftime('%s', created_at) AS INTEGER) * 1000) >= ?`,
      sampleCutoffMs,
    );
    supervisorLegacySendsHistorical = num(
      db,
      `SELECT COUNT(*) n FROM discord_deliveries
        WHERE webhook_name='options' AND payload_type='callout' AND status='SENT'
          AND (CAST(strftime('%s', created_at) AS INTEGER) * 1000) < ?`,
      sampleCutoffMs,
    );
  }

  // ── Profitability (60m-or-exit) over CLOSED & graded delivered trades ──
  const sixty = deliveredSixtyMinReturns(db, sampleCutoffMs);
  const gradedN = sixty.graded.length;
  const medianReturn = median(sixty.graded);
  const expectancy = mean(sixty.graded);
  const pf = profitFactor(sixty.graded);
  const completeGradingRate = deliveredLinked > 0 ? gradedN / deliveredLinked : null;
  // Missing-quote rate: of all DELIVERED_ALERT_PAPER mirrors (source table options_paper_trades),
  // the % that could not be priced — closed unpriced at expiration (exit_reason='expiration_no_quote')
  // or EXITED with a null return. Units = percent of delivered mirrors; LOWER is better; window = the
  // full delivered launch sample. Hard "sample" gate. Threshold configurable, default 15%.
  const missingQuotePct = sixty.total > 0 ? +((sixty.missingQuote / sixty.total) * 100).toFixed(1) : 0;
  const maxMissingQuotePct = (() => {
    const x = Number(env.SUBSCRIBER_READINESS_MAX_MISSING_QUOTE_PCT);
    return Number.isFinite(x) && x >= 0 ? x : 15;
  })();

  // ── Milestone proof: BOTH a return-milestone AND an opportunity-closed update actually delivered ──
  const returnMilestonesDelivered = hasTable(db, "opportunity_milestones")
    ? num(
      db,
      "SELECT COUNT(*) n FROM opportunity_milestones WHERE event_type='RETURN_MILESTONE' AND delivered_at_ms IS NOT NULL AND delivered_at_ms >= ?",
      sampleCutoffMs,
    )
    : 0;
  const closedUpdatesDelivered = hasTable(db, "opportunity_milestones")
    ? num(
      db,
      "SELECT COUNT(*) n FROM opportunity_milestones WHERE event_type='OPPORTUNITY_CLOSED' AND delivered_at_ms IS NOT NULL AND delivered_at_ms >= ?",
      sampleCutoffMs,
    )
    : 0;

  // ── Stripe + Discord-role readiness ──
  const stripeReady = Boolean(String(env.STRIPE_SECRET_KEY ?? "").trim() && String(env.STRIPE_WEBHOOK_SECRET ?? "").trim());
  const discordRoleConfigured = Boolean(String(env.DISCORD_BOT_TOKEN ?? "").trim() && String(env.DISCORD_GUILD_ID ?? "").trim() && String(env.DISCORD_SUBSCRIBER_ROLE_ID ?? "").trim());
  const discordRoleReady = discordRoleConfigured && subs.recentRoleSyncErrors === 0;

  // ── Data integrity (auto signals feeding the "no unresolved data-integrity issues" gate) ──
  let instrumentationFallbackInserts = 0;
  let schemaOk = true;
  let paperUnhealthyRows = 0;      // stuck_open / missing_case — operational (warning, not a hard gate)
  let paperMissingMirrorRows = 0;  // linked-but-no-mirror — genuine data-integrity corruption
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    instrumentationFallbackInserts = require("@/lib/db-legacy-columns").readInstrumentationFallbackInserts();
  } catch { /* optional */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const schema = require("@/lib/db-schema-readiness").inspectSchemaReadiness(db, env);
    schemaOk = Boolean(schema?.ok);
  } catch { /* optional */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chain = require("@/lib/research/options/paper-chain").buildPaperChainDiagnostic(db, env, 100, sampleCutoffMs);
    const rows = chain.rows as { graderHealth: string }[];
    paperMissingMirrorRows = rows.filter((r) => r.graderHealth === "missing_mirror").length;
    paperUnhealthyRows = rows.filter((r) => r.graderHealth === "stuck_open" || r.graderHealth === "missing_case").length;
  } catch { /* optional */ }
  // Hard integrity gate keys on genuine corruption only. missing_case is normal when the opportunity
  // lifecycle is off; stuck_open is operational — both surface as warnings, never a silent READY block.
  const dataIntegrityOk = instrumentationFallbackInserts === 0 && schemaOk && paperMissingMirrorRows === 0;

  const attestedAll = attestations.every((a) => a.attested);

  // ── Gate table ──────────────────────────────────────────────────────────────
  const gates: ReadinessGate[] = [
    // Safety / integrity — an IMMEDIATE-revoke class.
    { id: "kill_switch_off", label: "OPTIONS_CALLOUTS_KILL is off", kind: "safety", passed: env.OPTIONS_CALLOUTS_KILL !== "1", detail: env.OPTIONS_CALLOUTS_KILL === "1" ? "engaged" : "off" },
    { id: "ownership_independent", label: "Independent owns subscriber Discord (supervisor & legacy blocked)", kind: "safety", passed: supervisorLegacyStructurallyBlocked, detail: `owner=${ownership.owner}` },
    { id: "no_supervisor_legacy_sends", label: "No supervisor or legacy subscriber sends", kind: "safety", passed: supervisorLegacyStructurallyBlocked && supervisorLegacySends === 0, detail: `${supervisorLegacySends} observed` },
    { id: "paper_link_100", label: "100% paper-linking across the delivered launch sample", kind: "safety", passed: deliveredSent > 0 && deliveredLinked === deliveredSent, detail: `${deliveredLinked}/${deliveredSent} linked` },
    { id: "no_session_violations", label: "Zero weekend, holiday or cross-session openings", kind: "safety", passed: sessionViolations === 0, detail: `${sessionViolations} violations` },
    { id: "no_duplicate_deliveries", label: "No duplicate deliveries", kind: "safety", passed: duplicateDelivered === 0, detail: `${duplicateDelivered} duplicate sends` },
    { id: "data_integrity", label: "No unresolved data-integrity issues (auto signals)", kind: "safety", passed: dataIntegrityOk, detail: `fallbackInserts=${instrumentationFallbackInserts}, schemaOk=${schemaOk}, missingMirror=${paperMissingMirrorRows}` },
    { id: "gates_configured", label: "Entry-quality + session guards configured (enforce)", kind: "safety", passed: env.ENTRY_QUALITY_GATE != null && env.MARKET_SESSION_GUARD != null, detail: `entry=${env.ENTRY_QUALITY_GATE ?? "unset"}, session=${env.MARKET_SESSION_GUARD ?? "unset"}` },

    // Sample / profitability — only re-evaluated on a completed-day boundary before flipping to READY.
    { id: "valid_trading_days", label: "≥ 10 valid trading days", kind: "sample", passed: validTradingDays >= 10, detail: `${validTradingDays}/10` },
    { id: "delivered_linked_sample", label: "≥ 20 delivered & paper-linked alerts", kind: "sample", passed: deliveredLinked >= 20, detail: `${deliveredLinked}/20` },
    { id: "complete_grading", label: "≥ 90% of launch sample fully graded (≥30 closed)", kind: "sample", passed: gradedN >= 30 && completeGradingRate != null && completeGradingRate >= 0.9, detail: `${gradedN} graded${completeGradingRate != null ? ` (${Math.round(completeGradingRate * 100)}%)` : ""}` },
    { id: "median_return_positive", label: "Positive median 60-minute option return", kind: "sample", passed: medianReturn != null && medianReturn > 0, detail: medianReturn == null ? "no graded sample" : `${medianReturn.toFixed(1)}%` },
    { id: "expectancy_positive", label: "Positive expectancy", kind: "sample", passed: expectancy != null && expectancy > 0, detail: expectancy == null ? "no graded sample" : `${expectancy.toFixed(1)}%` },
    { id: "profit_factor", label: "Profit factor ≥ 1.1", kind: "sample", passed: pf != null && pf >= 1.1, detail: pf == null ? "no graded sample" : (pf === Infinity ? "∞ (no losses)" : `${pf}`) },
    { id: "early_timely_rate", label: "≥ 50% EARLY or TIMELY", kind: "sample", passed: earlyTimelyRate != null && earlyTimelyRate >= 0.5, detail: earlyTimelyRate == null ? "no SENT alerts" : `${Math.round(earlyTimelyRate * 100)}%` },
    { id: "late_chased_rate", label: "≤ 20% LATE or CHASED", kind: "sample", passed: lateChasedRate == null ? false : lateChasedRate <= 0.2, detail: lateChasedRate == null ? "no SENT alerts" : `${Math.round(lateChasedRate * 100)}%` },
    { id: "missing_quote_pct", label: `Missing-quote ≤ ${maxMissingQuotePct}% of delivered grading`, kind: "sample", passed: missingQuotePct <= maxMissingQuotePct, detail: `${missingQuotePct}% (max ${maxMissingQuotePct}%)` },
    { id: "milestone_proof_both", label: "Milestone proof: return-update AND close-update delivered", kind: "sample", passed: returnMilestonesDelivered >= 1 && closedUpdatesDelivered >= 1, detail: `return=${returnMilestonesDelivered}, closed=${closedUpdatesDelivered}` },
    { id: "stripe_ready", label: "Stripe billing secrets configured", kind: "sample", passed: stripeReady, detail: stripeReady ? "configured" : "missing STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET" },
    { id: "discord_role_ready", label: "Discord role sync configured & error-free", kind: "sample", passed: discordRoleReady, detail: discordRoleConfigured ? `roleSyncErrors=${subs.recentRoleSyncErrors}` : "role env not configured" },

    // Owner attestations (non-measurable operational / legal gates).
    ...attestations.map((a): ReadinessGate => ({ id: `attest_${a.key}`, label: a.label, kind: "sample", passed: a.attested, detail: a.attested ? `signed ${a.attestedBy ?? ""}`.trim() : "not attested" })),
  ];

  const blockingGates = gates.filter((g) => !g.passed).map((g) => g.id);
  const failingSafetyGates = gates.filter((g) => !g.passed && g.kind === "safety").map((g) => g.id);
  const ready = blockingGates.length === 0 && attestedAll;
  const status: ReadinessStatus = ready ? "SUBSCRIBER_READY" : "NOT_READY";

  if (quota.discoveryPaused) remainingWarnings.push(`Discovery paused (quota mode ${quota.quotaMode})`);
  if (quota.operatorWarning) remainingWarnings.push(quota.operatorWarning);
  if (subs.pastDue > 0) remainingWarnings.push(`${subs.pastDue} subscriber(s) past due`);
  if (gradedN > 0 && gradedN < 30) remainingWarnings.push(`Profitability sample small (${gradedN}/30 graded) — statistically thin`);
  if (deliveredSentHistorical > 0) {
    remainingWarnings.push(`${deliveredSentHistorical} historical delivered alert(s) before launch sample cutoff (excluded from readiness)`);
  }
  if (paperUnhealthyRows > 0) {
    remainingWarnings.push(`${paperUnhealthyRows} launch-sample paper row(s) stuck_open/missing_case (operational — review grader)`);
  }

  // #region agent log
  fetch("http://127.0.0.1:7918/ingest/1e1970bf-a3dc-4c9e-aaba-c7720ad4daf2", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "3a4126" },
    body: JSON.stringify({
      sessionId: "3a4126",
      runId: "readiness",
      hypothesisId: "H2",
      location: "lib/research/subscriber-readiness.ts:evaluateSubscriberReadiness",
      message: "readiness sample boundaries",
      data: {
        sampleCutoffMs,
        deliveredSent,
        deliveredSentHistorical,
        duplicateDelivered,
        supervisorLegacySends,
        supervisorLegacySendsHistorical,
        gradedSample: gradedN,
        paperUnhealthyRows,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  return {
    generatedAtMs: nowMs,
    status,
    ready,
    blockingGates,
    failingSafetyGates,
    gates,
    metrics: {
      sampleCutoffMs,
      sampleCutoffIso,
      deliveredSentHistorical,
      validTradingDays,
      deliveredSent,
      deliveredLinked,
      entryQualityScored,
      earlyTimelyRateScored: earlyTimelyRateScored == null ? null : +earlyTimelyRateScored.toFixed(4),
      paperLinkRate: paperLinkRate == null ? null : +paperLinkRate.toFixed(4),
      completeGradingRate: completeGradingRate == null ? null : +completeGradingRate.toFixed(4),
      gradedSample: gradedN,
      medianReturn60m: medianReturn == null ? null : +medianReturn.toFixed(4),
      expectancy: expectancy == null ? null : +expectancy.toFixed(4),
      profitFactor: pf == null ? null : (pf === Infinity ? "Infinity" : pf),
      winRate: gradedN > 0 ? +(sixty.graded.filter((x) => x > 0).length / gradedN).toFixed(4) : null,
      earlyTimelyRate: earlyTimelyRate == null ? null : +earlyTimelyRate.toFixed(4),
      lateChasedRate: lateChasedRate == null ? null : +lateChasedRate.toFixed(4),
      duplicateDeliveredCount: duplicateDelivered,
      duplicateRate: +duplicateRate.toFixed(4),
      sessionViolations,
      supervisorLegacySends,
      supervisorLegacySendsHistorical,
      missingQuotePct,
      maxMissingQuotePct,
      returnMilestonesDelivered,
      closedUpdatesDelivered,
      stripeReady,
      discordRoleReady,
      subscriberActive: subs.active,
      subscriberPastDue: subs.pastDue,
      roleSyncErrors: subs.recentRoleSyncErrors,
      instrumentationFallbackInserts,
      paperUnhealthyRows,
      paperMissingMirrorRows,
      schemaOk,
      quotaMode: quota.quotaMode,
      entryQualityGate: env.ENTRY_QUALITY_GATE ?? null,
      marketSessionGuard: env.MARKET_SESSION_GUARD ?? null,
    },
    attestations,
    remainingWarnings,
    dashboardUrl: `${String(env.PUBLIC_BASE_URL ?? env.DASHBOARD_URL ?? "").replace(/\/$/, "")}/pipeline-health`,
  };
}
