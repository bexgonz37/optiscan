/**
 * callouts/discord-format.ts — deterministic Discord builder. PURE.
 *
 * OPTIONS callouts render as ONE canonical line and nothing else, e.g.
 *   "$NVDA 18 JUL 26 $180 CALL $3.25"
 * — the exact contract OptiScan selected (the same contract the paper bridge
 * trades). No greeks, confidence, targets, entry zones, setup names, or free text
 * (lib/callouts/option-line.ts). When the exact contract cannot be verified the
 * line is null and the delivery gate withholds the alert.
 *
 * STOCK/momentum callouts (routed to the stocks webhook) keep the existing compact
 * card unchanged. Nothing is fabricated; no banned/guarantee language is emitted.
 * This module only builds the payload; the delivery ledger does the sending.
 */
import { containsBannedLanguage, type Callout } from "./callout.ts";
import { compactCard, discordAdvancedEnabled } from "./confidence.ts";
import { calloutWebhook } from "./routing.ts";
import { optionContractLine } from "./option-line.ts";

const STATUS_EMOJI: Record<string, string> = {
  ACTIONABLE_NOW: "🟢", NEAR_TRIGGER: "🟡", DEVELOPING: "🔵", WAIT_FOR_PULLBACK: "🟠",
  EXTENDED: "⚪", MISSED: "🚫", RESEARCH_ONLY: "🔬", INVALIDATED: "⛔", NO_VALID_CONTRACT: "⚠",
  DATA_STALE: "⌛", MODEL_EXPERIMENTAL: "🧪", MODEL_INACTIVE: "◻", INSUFFICIENT_EVIDENCE: "ℹ", WATCH: "👁",
};

const TIER_EMOJI: Record<string, string> = { HIGH: "🟢", MEDIUM: "🟡", LOW: "⚪" };

function fmtNum(v: number | null | undefined, dp = 2): string {
  return v == null || !Number.isFinite(v) ? "—" : Number(v).toFixed(dp);
}

export interface DiscordCalloutPayload {
  content: string;
  /** Present only for stock/momentum callouts; options are a single content line. */
  embed?: {
    title: string;
    description: string;
    color: number;
    fields: { name: string; value: string; inline?: boolean }[];
    footer: { text: string };
  };
}

/**
 * Single canonical options line, e.g. "$NVDA 18 JUL 26 $180 CALL $3.25". When the
 * exact contract cannot be verified this returns a payload whose content flags the
 * gap; that payload is never delivered (the runtime delivery gate independently
 * blocks options alerts without a verified contract — never a generic alert).
 */
function formatOptionsLine(c: Callout): DiscordCalloutPayload {
  const line = optionContractLine(c);
  const content = line ?? `${STATUS_EMOJI.NO_VALID_CONTRACT} ${c.ticker} — options contract data incomplete; alert withheld`;
  const safe = containsBannedLanguage(content.toLowerCase()) ? "[redacted: non-compliant language]" : content;
  return { content: safe };
}

/** Build the Discord payload for one callout (options → single line; stock → card). */
export function formatCalloutDiscord(c: Callout, env: NodeJS.ProcessEnv = process.env): DiscordCalloutPayload {
  // OPTIONS: one canonical contract line, nothing else.
  if (calloutWebhook(c) === "options") return formatOptionsLine(c);

  // STOCK/momentum: the existing compact card (unchanged).
  const card = compactCard(c, env);
  const emoji = STATUS_EMOJI[c.status] ?? TIER_EMOJI[card.tier] ?? "•";

  // Title = the human trade + confidence tier, e.g. "🟢 NVDA CALL · HIGH CONFIDENCE".
  const title = `${emoji} ${card.headline}`;

  // DEFAULT compact card — the exact contract + real prices at alert time.
  const cardLines = [
    `Contract: ${card.contract}`,
    `Expiration: ${card.expiration}`,
    `DTE: ${card.dte}`,
    `Stock: ${card.stock}`,
    `Option: ${card.optionQuote} (mid ${card.optionMid})`,
    `Estimated entry: ${card.estimatedEntry}`,
    `Status: ${card.status}`,
    `Horizon: ${card.horizon}`,
    `Time: ${card.time}`,
  ];
  if (card.setupScoreLine) cardLines.push("", card.setupScoreLine);

  const disclaimerBits = [
    c.researchOnlyWarning,
    "Research/paper simulation — outcomes are uncertain and never assured.",
  ].filter(Boolean);
  cardLines.push("", disclaimerBits.join(" "));

  const description = cardLines.join("\n");

  // ── Advanced (below the divider) — appended ONLY when explicitly enabled. ────
  const fields: NonNullable<DiscordCalloutPayload["embed"]>["fields"] = [];
  if (discordAdvancedEnabled(env)) {
    const k = c.contract;
    fields.push({ name: "──────── Advanced ────────", value: "Technical detail (not needed to read the trade)." });
    fields.push({
      name: "Contract detail",
      value: `${k?.optionSymbol ?? "—"} · Δ ${fmtNum(k?.delta)} · IV ${fmtNum(k?.iv)} · OI ${k?.openInterest ?? "—"} · vol ${k?.volume ?? "—"} · spread ${fmtNum(k?.spreadPct, 1)}%`,
    });
    fields.push({
      name: "Ranking",
      value: `setup score ${c.contractScore ?? "—"}${c.portfolioRank != null ? ` · rank ${fmtNum(c.portfolioRank, 1)}` : ""} · agent ${c.strategyAgent}`,
      inline: true,
    });
    fields.push({
      name: "Evidence",
      value: `${c.evidenceStatus.replace(/_/g, " ")} · sample ${c.sampleSize}${c.expectancy != null ? ` · expectancy ${fmtNum(c.expectancy)}` : ""}${c.profitFactor != null ? ` · PF ${fmtNum(c.profitFactor)}` : ""}`,
      inline: true,
    });
    if (c.probability != null) {
      const pct = fmtNum(c.probability * 100, 1);
      const meta = `v${c.modelVersion ?? "?"}, ${c.calibration ?? "calib n/a"}`;
      fields.push({
        name: "Model",
        value: c.probabilityIsExperimental
          ? `${c.modelLabel} · p(win) ${pct}% (${meta}) — not a validated probability`
          : `${c.modelState.replace(/_/g, " ")} · p(win) ${pct}% (${meta})`,
        inline: true,
      });
    } else {
      const label = c.modelLabel ?? "SETUP SCORE — NOT A PROBABILITY";
      fields.push({ name: "Model", value: `${c.modelState.replace(/_/g, " ")} — ${label}; no probability (setup score ${c.contractScore ?? "—"}).`, inline: true });
    }
    fields.push({
      name: "Risk",
      value: c.riskVerdict?.allowed === false ? `Risk veto: ${c.riskVerdict.failures.join("; ")}` : "Risk checks passed",
      inline: true,
    });
    if (c.waitFor) fields.push({ name: "Next required condition", value: c.waitFor });
    if (c.doNotEnter || c.invalidation) fields.push({ name: "Do not enter if", value: c.doNotEnter || c.invalidation || "—" });
    if (c.currently) fields.push({ name: "Currently", value: c.currently });
    if (c.alreadyHappened) fields.push({ name: "Already happened (context only)", value: c.alreadyHappened });
    if (c.thesisNote) fields.push({ name: "Note", value: c.thesisNote });
  }

  const color = c.direction === "bearish"
    ? (c.status === "ACTIONABLE_NOW" ? 0xe67e22 : 0x9b59b6)
    : c.status === "ACTIONABLE_NOW" ? 0x2ecc71 : c.status === "INVALIDATED" ? 0xe74c3c : 0x3498db;

  const payload: DiscordCalloutPayload = {
    content: `${emoji} ${card.headline} · ${card.status}`,
    embed: { title, description, color, fields, footer: { text: `${c.strategyAgent} · ${new Date(c.timestamp).toISOString()}` } },
  };

  // Safety: a callout must never contain banned/guarantee language.
  if (payload.embed && containsBannedLanguage(JSON.stringify(payload).toLowerCase())) {
    payload.embed.description = "[redacted: non-compliant language]";
    payload.embed.fields = payload.embed.fields.map((f) => ({ ...f, value: "[redacted: non-compliant language]" }));
  }
  return payload;
}
