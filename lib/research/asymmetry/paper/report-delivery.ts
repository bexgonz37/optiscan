/**
 * report-delivery.ts — owner-private delivery of the daily paper report.
 *
 * THE REPORT IS PERSISTED BEFORE THIS FILE IS EVER CALLED. Delivery is the last
 * and least important step: a Discord outage, a missing webhook, or a refused
 * send costs a message and nothing else. The measured report is already in the
 * database and already visible through diagnostics.
 *
 * NO SUBSCRIBER FALLBACK EXISTS. If the recap webhook is unavailable the status
 * is BLOCKED_CONFIG and the report stays where it is. There is deliberately no
 * code path from here to the alerts or watchlist webhooks — putting a research
 * P&L report in a subscriber channel would be worse than not delivering it.
 *
 * PURE except for the injected sender. No AI.
 */
import type { AsymmetryPaperReport } from "../eod-review.ts";

export const REPORT_WEBHOOK_ENV = "DISCORD_WEBHOOK_RECAP";

/**
 * Webhooks this path must never use. The recap webhook is checked against them
 * because an operator could paste the same URL into two variables, and the
 * value — not the variable name — is what decides where a message lands.
 */
export const FORBIDDEN_REPORT_WEBHOOK_ENV = Object.freeze([
  "DISCORD_WEBHOOK_URL",
  "DISCORD_WEBHOOK_OPTIONS",
  "DISCORD_WEBHOOK_STOCKS",
  "DISCORD_WEBHOOK_WATCHLIST",
  "HIGH_ASYMMETRY_PRIVATE_WEBHOOK",
]);

export type ReportDeliveryStatus = "BLOCKED_CONFIG" | "SENT" | "FAILED" | "PENDING";

export interface ReportDeliveryConfig {
  webhook: string | null;
  /** Set when the configured value collides with a subscriber channel. */
  refusedReason: string | null;
}

/** Resolve the delivery target. Never returns a value to a caller that logs. */
export function resolveReportDelivery(env: NodeJS.ProcessEnv = process.env): ReportDeliveryConfig {
  const raw = String(env[REPORT_WEBHOOK_ENV] ?? "").trim();
  const webhook = raw ? raw : null;
  if (!webhook) return { webhook: null, refusedReason: null };
  for (const name of FORBIDDEN_REPORT_WEBHOOK_ENV) {
    const other = String(env[name] ?? "").trim();
    if (other && other === webhook) {
      return { webhook: null, refusedReason: `${REPORT_WEBHOOK_ENV} is the same value as ${name}` };
    }
  }
  return { webhook, refusedReason: null };
}

const pct = (n: number | null | undefined): string => (n == null ? "unavailable" : `${n.toFixed(1)}%`);
const usd = (n: number | null | undefined): string => (n == null ? "unavailable" : `$${n.toFixed(2)}`);

/**
 * Deterministic message. Every number comes from the persisted report and
 * "unavailable" is printed wherever a value is genuinely unknown — an unknown
 * is never rendered as 0, 0%, or $0.00.
 */
export function buildPaperReportMessage(sessionDate: string, r: AsymmetryPaperReport): string {
  const lines: string[] = [
    `**HIGH-ASYMMETRY PAPER RESEARCH — ${sessionDate}**`,
    `Simulated only. No real order was placed and no subscriber alert was created.`,
    `Rules version: ${r.rulesVersion}`,
    "",
    `Cases captured: ${r.casesCaptured} · paper trades opened: ${r.tradesOpened} · skipped: ${r.tradesSkipped}`,
    `Open: ${r.openPositions} · closed: ${r.closedPositions} · unverified outcomes: ${r.unverifiedOutcomes}`,
    `Wins: ${r.wins} · losses: ${r.losses}`,
    "",
    `Simulated P&L (configured size): ${usd(r.totalSimulatedPnlUsd)}`,
    `Normalized P&L (one contract): ${usd(r.normalizedOneContractPnlUsd)}`,
    `Median MFE ${pct(r.medianMfePct)} · median MAE ${pct(r.medianMaePct)}`,
    `Milestones: ${Object.entries(r.milestoneDistribution).map(([k, v]) => `${k}:${v}`).join(" · ")}`,
  ];

  lines.push(
    r.largestWinner
      ? `Largest winner: ${r.largestWinner.symbol} ${r.largestWinner.optionSymbol} ${pct(r.largestWinner.returnPct)}`
      : "Largest winner: none",
    r.largestLoss
      ? `Largest loss: ${r.largestLoss.symbol} ${r.largestLoss.optionSymbol} ${pct(r.largestLoss.returnPct)}`
      : "Largest loss: none",
    r.bestMissedOpportunity
      ? `Best missed: ${r.bestMissedOpportunity.symbol} peaked ${pct(r.bestMissedOpportunity.mfePct)} — ${r.bestMissedOpportunity.reason}`
      : "Best missed: none identified",
  );

  lines.push(
    "",
    `Scanner comparison: ${r.normalScannerComparison.positionsAlsoAlerted} also alerted · ${r.normalScannerComparison.positionsNeverAlerted} never alerted`,
    `Median lead: ${r.normalScannerComparison.medianLeadMs == null ? "unavailable" : `${Math.round(r.normalScannerComparison.medianLeadMs / 60000)} min`}`,
    `Median premium avoided: ${pct(r.normalScannerComparison.medianPremiumAvoidedPct)}`,
  );

  if (r.skipReasons.length) {
    lines.push("", `Skips: ${r.skipReasons.map((s) => `${s.reason}×${s.count}`).join(" · ")}`);
  }
  if (r.quoteAndProviderErrors.length) {
    lines.push(`Quote/provider errors: ${r.quoteAndProviderErrors.map((s) => `${s.reason}×${s.count}`).join(" · ")}`);
  }
  if (r.minimumSampleWarnings.length) {
    lines.push("", `**Sample warnings**`, ...r.minimumSampleWarnings.slice(0, 6).map((w) => `- ${w}`));
  }
  const proposals = r.quant?.proposals ?? [];
  if (proposals.length) {
    lines.push("", `**Quant proposals (PROPOSED — none implemented)**`, ...proposals.slice(0, 3).map((p) => `- ${p.observation}`));
  }
  lines.push("", "Research only. This lane cannot send a subscriber alert, size a real trade, or place an order.");
  return lines.join("\n").slice(0, 1900);
}

export interface DeliverReportResult {
  status: ReportDeliveryStatus;
  reason: string | null;
  /** Never the webhook value. Presence only. */
  webhookConfigured: boolean;
}

export interface DeliverReportDeps {
  send?: (webhook: string, content: string) => Promise<{ ok: boolean; reason?: string }>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Attempt delivery. Never throws — a delivery fault is a returned status.
 * The report has already been persisted by the time this runs.
 */
export async function deliverPaperReport(
  sessionDate: string,
  report: AsymmetryPaperReport,
  deps: DeliverReportDeps,
): Promise<DeliverReportResult> {
  try {
    const env = deps.env ?? process.env;
    const cfg = resolveReportDelivery(env);
    if (cfg.refusedReason) {
      return { status: "BLOCKED_CONFIG", reason: cfg.refusedReason, webhookConfigured: false };
    }
    if (!cfg.webhook) {
      return {
        status: "BLOCKED_CONFIG",
        reason: `${REPORT_WEBHOOK_ENV} is not configured. The report is persisted and readable through diagnostics; there is no subscriber fallback.`,
        webhookConfigured: false,
      };
    }
    if (!deps.send) {
      return { status: "BLOCKED_CONFIG", reason: "no sender injected", webhookConfigured: true };
    }
    const res = await deps.send(cfg.webhook, buildPaperReportMessage(sessionDate, report));
    return res.ok
      ? { status: "SENT", reason: null, webhookConfigured: true }
      : { status: "FAILED", reason: res.reason ?? "send failed", webhookConfigured: true };
  } catch (err: any) {
    return { status: "FAILED", reason: String(err?.message ?? err), webhookConfigured: false };
  }
}
