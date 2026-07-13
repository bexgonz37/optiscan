/**
 * callouts/discord-format.ts — deterministic, TRADER-FIRST Discord embed builder.
 * PURE. It answers, in order: what trade, why now, the underlying trigger, the
 * option entry (bid/ask/mid/spread + estimated fill), invalidation, expected
 * holding horizon, and risk — with the heavy statistics kept below. It NEVER
 * headlines the raw OCC option symbol, never fabricates a target, and never emits
 * banned/guarantee language. It only builds the payload; the delivery ledger
 * (idempotency, retries, routing, role mentions) does the sending.
 */
import { containsBannedLanguage, type Callout } from "./callout.ts";

const STATUS_EMOJI: Record<string, string> = {
  ACTIONABLE_NOW: "🟢", NEAR_TRIGGER: "🟡", DEVELOPING: "🔵", WAIT_FOR_PULLBACK: "🟠",
  EXTENDED: "⚪", RESEARCH_ONLY: "🔬", INVALIDATED: "⛔", NO_VALID_CONTRACT: "⚠",
  DATA_STALE: "⌛", MODEL_EXPERIMENTAL: "🧪", MODEL_INACTIVE: "◻", INSUFFICIENT_EVIDENCE: "ℹ", WATCH: "👁",
};

function fmtNum(v: number | null | undefined, dp = 2): string {
  return v == null || !Number.isFinite(v) ? "—" : Number(v).toFixed(dp);
}

/** "2026-07-14" → "Jul 14"; falls back to the raw value. */
function expiryLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function dteWord(dte: number | null | undefined): string {
  if (dte == null) return "";
  if (dte <= 0) return "0DTE (expires today)";
  if (dte === 1) return "1DTE (expires tomorrow)";
  return `${dte}DTE`;
}

/** Plain-English trade line, e.g. "SPY $755 CALL · exp Jul 14 · 0DTE (expires today)". */
function tradeHeadline(c: Callout): string {
  const side = (c.contract?.side ?? (c.direction === "bearish" ? "put" : "call")).toUpperCase();
  const strike = c.contract?.strike != null ? `$${c.contract.strike}` : "";
  const bits = [`${c.ticker} ${strike} ${side}`.replace(/\s+/g, " ").trim()];
  if (c.contract?.expiration) bits.push(`exp ${expiryLabel(c.contract.expiration)}`);
  const d = dteWord(c.contract?.dte);
  if (d) bits.push(d);
  return bits.join(" · ");
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

/** Build the trader-first Discord payload for one callout. */
export function formatCalloutDiscord(c: Callout): DiscordCalloutPayload {
  const emoji = STATUS_EMOJI[c.status] ?? "•";
  const sideWord = c.direction === "bearish" ? "PUT" : "CALL";
  // Title leads with the human trade, NEVER the OCC symbol.
  const title = `${emoji} ${c.ticker} ${sideWord} · ${c.horizon} · ${c.status.replace(/_/g, " ")}`;

  const hasEntry = c.actionable && Boolean(c.contract) && c.quoteFreshness === "fresh";
  const fields: DiscordCalloutPayload["embed"]["fields"] = [];

  // 1. WHAT TRADE
  fields.push({ name: "Trade", value: tradeHeadline(c) });

  // 2. WHY NOW
  fields.push({ name: "Why now", value: c.reason || "—" });

  // 3. UNDERLYING TRIGGER (kept separate from the option entry)
  fields.push({ name: "Underlying trigger", value: c.trigger || "No specific level given." });

  // 4. OPTION ENTRY — ideal entry + live bid/ask/mid + estimated fill; or a clear
  //    "no entry window" state. Targets are NOT fabricated.
  if (!hasEntry) {
    const why = !c.contract ? (c.primaryBlockingReason ?? "no valid contract")
      : c.quoteFreshness !== "fresh" ? "quote not fresh"
      : "not an actionable entry right now";
    fields.push({ name: "Option entry", value: `WAIT — NO VALID ENTRY WINDOW (${why}).` });
  } else {
    const k = c.contract!;
    fields.push({
      name: "Option entry",
      value: [
        `bid ${fmtNum(k.bid)} / ask ${fmtNum(k.ask)} / mid ${fmtNum(k.mid)} · spread ${fmtNum(k.spreadPct, 1)}%`,
        c.estimatedFillNote ?? "Estimated paper fill ≈ ask + bounded slippage (simulated, not a real fill).",
      ].join("\n"),
    });
  }

  // 5. INVALIDATION
  fields.push({ name: "Invalidation", value: c.invalidation || "Thesis break / structure change." });

  // 6. EXPECTED HOLDING HORIZON
  fields.push({ name: "Horizon", value: `${c.horizon}${c.contract?.dte != null ? ` · ${dteWord(c.contract.dte)}` : ""}`, inline: true });

  // 7. RISK
  fields.push({
    name: "Risk",
    value: c.riskVerdict?.allowed === false ? `Risk veto: ${c.riskVerdict.failures.join("; ")}` : "Risk checks passed",
    inline: true,
  });

  // Management guidance ONLY when genuinely supported (never fabricated).
  if (c.management) fields.push({ name: "Management", value: c.management });
  // Thesis-reconciliation note (portfolio layer), when present.
  if (c.thesisNote) fields.push({ name: "Note", value: c.thesisNote });

  // ── Advanced statistics below ──────────────────────────────────────────────
  fields.push({ name: "Evidence", value: `${c.evidenceStatus.replace(/_/g, " ")} · sample ${c.sampleSize}${c.expectancy != null ? ` · expectancy ${fmtNum(c.expectancy)}` : ""}${c.profitFactor != null ? ` · PF ${fmtNum(c.profitFactor)}` : ""}`, inline: true });

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
    name: "Advanced",
    value: `contract ${c.contract?.optionSymbol ?? "—"} · Δ ${fmtNum(c.contract?.delta)} · IV ${fmtNum(c.contract?.iv)} · OI ${c.contract?.openInterest ?? "—"} · vol ${c.contract?.volume ?? "—"} · score ${c.contractScore ?? "—"}${c.portfolioRank != null ? ` · rank ${fmtNum(c.portfolioRank, 1)}` : ""} · agent ${c.strategyAgent}`,
  });

  const disclaimerBits = [
    c.researchOnlyWarning,
    c.insufficientEvidenceWarning,
    "Research/paper simulation — outcomes are uncertain and never assured.",
  ].filter(Boolean);

  const color = c.direction === "bearish"
    ? (c.status === "ACTIONABLE_NOW" ? 0xe67e22 : 0x9b59b6)
    : c.status === "ACTIONABLE_NOW" ? 0x2ecc71 : c.status === "INVALIDATED" ? 0xe74c3c : 0x3498db;

  const payload: DiscordCalloutPayload = {
    content: `${emoji} ${c.ticker} ${sideWord} ${c.horizon} · ${c.status.replace(/_/g, " ")}`,
    embed: { title, description: disclaimerBits.join(" "), color, fields, footer: { text: `${c.strategyAgent} · ${new Date(c.timestamp).toISOString()}` } },
  };

  // Safety: a callout must never contain banned/guarantee language.
  if (containsBannedLanguage(JSON.stringify(payload).toLowerCase())) {
    payload.embed.fields = payload.embed.fields.map((f) => ({ ...f, value: "[redacted: non-compliant language]" }));
  }
  return payload;
}
