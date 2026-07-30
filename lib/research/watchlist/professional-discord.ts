/**
 * professional-discord.ts — PURE Discord rendering for the professional Watchlist.
 *
 * Concise and mobile-friendly: grouped by setup type, at most a dozen tickers,
 * one disclaimer at the end. Never renders a confidence score, an internal
 * pipeline name, a raw market-context object, an unavailable-data warning, or an
 * exact OCC contract overnight.
 */
import { groupRowsBySetup, type WatchlistPlan, type WatchlistRow } from "./professional-plan.ts";

const DISCLAIMER = "Educational research only. Not financial advice. Options carry risk of total loss.";
const VERIFY_NOTE = "Verify exact options contracts after the market opens.";

const money = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

function renderRow(row: WatchlistRow): string {
  const lines: string[] = [`**${row.symbol}**`];
  if (row.callAbove) lines.push(`CALLS ABOVE ${money(row.callAbove.price)} (${row.callAbove.sourceLevelName})`);
  if (row.putBelow) lines.push(`PUTS BELOW ${money(row.putBelow.price)} (${row.putBelow.sourceLevelName})`);
  lines.push(row.reason);
  if (row.catalyst) lines.push(`Catalyst: ${row.catalyst}`);
  if (row.changedSinceOvernight && row.changes.length) lines.push(`Changed: ${row.changes.join("; ")}`);
  lines.push(`As of: ${row.freshness}`);
  return lines.join("\n");
}

/** Overnight plan. Never contains an exact contract. */
export function formatOvernightWatchlist(plan: WatchlistPlan): string {
  if (!plan.rows.length) {
    return [
      `**OVERNIGHT PLAN — ${plan.tradingDay}**`,
      "",
      "No setups met the evidence bar tonight.",
      "",
      "A premarket update runs before the open.",
      "",
      DISCLAIMER,
    ].join("\n");
  }
  const groups = groupRowsBySetup(plan.rows);
  const body = groups.map((g) => [`__${g.setupType}__`, "", ...g.rows.map(renderRow)].join("\n")).join("\n\n");
  return [
    `**OVERNIGHT PLAN — ${plan.tradingDay}**`,
    plan.marketAlignment ? `Market: ${plan.marketAlignment}` : null,
    "",
    body,
    "",
    VERIFY_NOTE,
    "",
    DISCLAIMER,
  ].filter((l) => l !== null).join("\n");
}

/** Premarket update. States what changed since the overnight plan. */
export function formatPremarketWatchlistUpdate(plan: WatchlistPlan): string {
  const header = [`**PREMARKET UPDATE — ${plan.tradingDay}**`];
  if (plan.marketAlignment) header.push(`Market: ${plan.marketAlignment}`);

  if (!plan.rows.length) {
    return [
      ...header,
      "",
      "No setups met the evidence bar this morning.",
      "",
      DISCLAIMER,
    ].join("\n");
  }

  const groups = groupRowsBySetup(plan.rows);
  const body = groups.map((g) => [`__${g.setupType}__`, "", ...g.rows.map(renderRow)].join("\n")).join("\n\n");
  const changeLines: string[] = [];
  if (plan.newlyQualified.length) changeLines.push(`Newly qualified: ${plan.newlyQualified.join(", ")}`);
  if (plan.invalidated.length) changeLines.push(`Invalidated: ${plan.invalidated.map((i) => i.symbol).join(", ")}`);

  return [
    ...header,
    "",
    body,
    "",
    ...(changeLines.length ? [changeLines.join("\n"), ""] : []),
    VERIFY_NOTE,
    "",
    DISCLAIMER,
  ].join("\n");
}

/**
 * Copy screen. A published message must never leak internal vocabulary, a
 * generic filler row, a confidence score, or an overnight OCC selection.
 */
const FORBIDDEN_COPY: Array<{ re: RegExp; reason: string }> = [
  { re: /structure_watch/i, reason: "structure_watch filler" },
  { re: /verify at open/i, reason: "VERIFY AT OPEN used as a trigger" },
  { re: /\bconfidence\b\s*[:=]?\s*\d/i, reason: "generic confidence score" },
  { re: /\b(planStatus|openReadinessScore|thesisScore|marketContext|needsMoreData|evidenceCompleteness|payload_json|alert_type)\b/, reason: "internal pipeline name" },
  { re: /\b(unavailable|not available|no data|missing)\b/i, reason: "unavailable-data warning in subscriber copy" },
  { re: /\bO:[A-Z]{1,6}\d{6}[CP]\d{8}\b/, reason: "exact OCC contract" },
  { re: /\{\s*"/, reason: "raw object" },
];

export function screenWatchlistCopy(
  content: string,
  opts: { allowExactContract?: boolean } = {},
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const { re, reason } of FORBIDDEN_COPY) {
    if (opts.allowExactContract && reason === "exact OCC contract") continue;
    if (re.test(content)) violations.push(reason);
  }
  return { ok: violations.length === 0, violations };
}
