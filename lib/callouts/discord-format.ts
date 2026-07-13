/**
 * callouts/discord-format.ts — deterministic Discord embed builder (Phase 6).
 * PURE. Renders a callout in the required section order with research-only /
 * non-guarantee language and NO banned phrases. It builds only the payload; the
 * existing delivery ledger (idempotency, retries, freshness blocks, role mentions,
 * routing) does the sending.
 */
import { containsBannedLanguage, type Callout } from "./callout.ts";

const STATUS_EMOJI: Record<string, string> = {
  ACTIONABLE_NOW: "🟢", NEAR_TRIGGER: "🟡", DEVELOPING: "🔵", WAIT_FOR_PULLBACK: "🟠",
  EXTENDED: "⚪", RESEARCH_ONLY: "🔬", INVALIDATED: "⛔", NO_VALID_CONTRACT: "⚠",
  DATA_STALE: "⌛", MODEL_EXPERIMENTAL: "🧪", MODEL_INACTIVE: "◻", INSUFFICIENT_EVIDENCE: "ℹ",
};

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

/** Build the Discord payload for one callout (order: header→why→trigger→contract→risk→evidence→model→advanced→disclaimer). */
export function formatCalloutDiscord(c: Callout): DiscordCalloutPayload {
  const emoji = STATUS_EMOJI[c.status] ?? "•";
  const dirWord = c.direction === "bearish" ? "PUT (research)" : "CALL";
  const title = `${emoji} ${c.ticker} ${dirWord} · ${c.horizon} · ${c.status.replace(/_/g, " ")}`;

  const fields: DiscordCalloutPayload["embed"]["fields"] = [];
  // 2. Why now
  fields.push({ name: "Why now", value: c.reason || "—" });
  // 3. Trigger
  if (c.trigger) fields.push({ name: "Trigger", value: c.trigger });
  // 4. Contract
  if (c.contract) {
    fields.push({
      name: "Contract",
      value: [
        c.contract.optionSymbol ?? "—",
        `${c.contract.side ?? ""} ${fmtNum(c.contract.strike)} exp ${c.contract.expiration ?? "—"} (${c.contract.dte ?? "—"}DTE)`,
        `bid ${fmtNum(c.contract.bid)} / ask ${fmtNum(c.contract.ask)} / mid ${fmtNum(c.contract.mid)} · spread ${fmtNum(c.contract.spreadPct, 1)}%`,
        `Δ ${fmtNum(c.contract.delta)} · IV ${fmtNum(c.contract.iv)} · OI ${c.contract.openInterest ?? "—"} · vol ${c.contract.volume ?? "—"} · BE ${fmtNum(c.contract.breakevenPct, 2)}%`,
        c.estimatedFillNote ?? "",
      ].filter(Boolean).join("\n"),
    });
  } else {
    fields.push({ name: "Contract", value: c.primaryBlockingReason ?? "No valid contract in this horizon." });
  }
  // 5. Risk / invalidation
  fields.push({ name: "Risk / invalidation", value: [
    c.riskVerdict?.allowed === false ? `Risk veto: ${c.riskVerdict.failures.join("; ")}` : "Risk checks passed",
    c.invalidation ?? "Invalidation: setup thesis break.",
  ].join("\n") });
  // 6. Evidence
  fields.push({ name: "Evidence", value: `${c.evidenceStatus.replace(/_/g, " ")} · sample ${c.sampleSize}${c.expectancy != null ? ` · expectancy ${fmtNum(c.expectancy)}` : ""}${c.profitFactor != null ? ` · PF ${fmtNum(c.profitFactor)}` : ""}` });
  // 7. Model state / probability. An experimental probability MUST carry the
  //    EXPERIMENTAL — LIMITED DATA — RESEARCH ONLY label; when no model is active
  //    we show the setup score under the SETUP SCORE — NOT A PROBABILITY label.
  if (c.probability != null) {
    const pct = fmtNum(c.probability * 100, 1);
    const meta = `v${c.modelVersion ?? "?"}, ${c.calibration ?? "calib n/a"}`;
    const value = c.probabilityIsExperimental
      ? `${c.modelLabel} · p(win) ${pct}% (${meta}) — not a validated probability`
      : `${c.modelState.replace(/_/g, " ")} · p(win) ${pct}% (${meta})`;
    fields.push({ name: "Model", value });
  } else {
    const label = c.modelLabel ?? "SETUP SCORE — NOT A PROBABILITY";
    fields.push({ name: "Model", value: `${c.modelState.replace(/_/g, " ")} — ${label}; no probability shown (setup score ${c.contractScore ?? "—"}).` });
  }
  // 8. Advanced (compact)
  fields.push({ name: "Advanced", value: `score ${c.contractScore ?? "—"} · freshness ${c.quoteFreshness} · agent ${c.strategyAgent}`, inline: true });

  // 9. Research-only / non-guarantee language
  const disclaimerBits = [
    c.researchOnlyWarning,
    c.insufficientEvidenceWarning,
    "Research/paper simulation — outcomes are uncertain and never assured.",
  ].filter(Boolean);

  const color = c.direction === "bearish" ? 0x9b59b6 : c.status === "ACTIONABLE_NOW" ? 0x2ecc71 : c.status === "INVALIDATED" ? 0xe74c3c : 0x3498db;

  const payload: DiscordCalloutPayload = {
    content: `${emoji} ${c.ticker} ${c.horizon} ${c.status.replace(/_/g, " ")}`,
    embed: {
      title,
      description: disclaimerBits.join(" "),
      color,
      fields,
      footer: { text: `${c.strategyAgent} · ${new Date(c.timestamp).toISOString()}` },
    },
  };

  // Safety: a callout must never contain banned/guarantee language.
  const all = JSON.stringify(payload).toLowerCase();
  if (containsBannedLanguage(all)) {
    payload.embed.fields = payload.embed.fields.map((f) => ({ ...f, value: "[redacted: non-compliant language]" }));
  }
  return payload;
}
