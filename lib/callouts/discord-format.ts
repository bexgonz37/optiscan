/**
 * callouts/discord-format.ts — deterministic COMPACT-TRADE-CARD Discord builder.
 * PURE. The DEFAULT payload is a compact card: ticker + direction + confidence
 * tier, the exact contract (strike / expiration / DTE), the underlying price and
 * the live option bid/ask/mid at alert time, a realistic estimated entry, a plain
 * entry status, the horizon, and the alert time. Nothing is fabricated; the raw
 * OCC symbol is never the headline; no banned/guarantee language is ever emitted.
 *
 * All the technical detail (OCC symbol, greeks, OI/volume, spread%, contract
 * score/rank, agent, evidence, model state, risk, VWAP/relVol/accel, reasons,
 * prior context) stays available but moves BELOW a compact divider — and is only
 * appended when DISCORD_ADVANCED_DETAILS=1 (default off). It only builds the
 * payload; the delivery ledger does the sending.
 */
import { containsBannedLanguage, type Callout } from "./callout.ts";
import { compactCard, discordAdvancedEnabled } from "./confidence.ts";

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
  embed: {
    title: string;
    description: string;
    color: number;
    fields: { name: string; value: string; inline?: boolean }[];
    footer: { text: string };
  };
}

/** Build the compact-card Discord payload for one callout. */
export function formatCalloutDiscord(c: Callout, env: NodeJS.ProcessEnv = process.env): DiscordCalloutPayload {
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
  const fields: DiscordCalloutPayload["embed"]["fields"] = [];
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
  if (containsBannedLanguage(JSON.stringify(payload).toLowerCase())) {
    payload.embed.description = "[redacted: non-compliant language]";
    payload.embed.fields = payload.embed.fields.map((f) => ({ ...f, value: "[redacted: non-compliant language]" }));
  }
  return payload;
}
