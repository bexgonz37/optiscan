#!/usr/bin/env node
/**
 * Replay last-week subscriber alerts through proposed entry-quality + session gates.
 * Input: scripts/tmp-forensic-week-audit-output.json (19 production supervisor callouts).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateEntryQuality, entryQualityConfig, evaluate0DteSessionCutoff } from "../lib/entry-quality-gate.ts";
import { evaluateMarketSessionGuard } from "../lib/market-session-guard.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = join(root, "scripts/tmp-forensic-week-audit-output.json");
const raw = JSON.parse(readFileSync(inputPath, "utf8"));
const env = {
  ...process.env,
  ENTRY_QUALITY_GATE: "enforce",
  MARKET_SESSION_GUARD: "enforce",
  OPTIONS_0DTE_DELIVERY_CUTOFF_MINUTES: process.env.OPTIONS_0DTE_DELIVERY_CUTOFF_MINUTES ?? "60",
  OPTIONS_0DTE_CHASE_LIMIT_PCT: process.env.OPTIONS_0DTE_CHASE_LIMIT_PCT ?? "0.4",
};

function parseSentMs(alert) {
  const t = Date.parse(alert.sent_at_utc);
  return Number.isFinite(t) ? t : null;
}

function sideFromAlert(alert) {
  return String(alert.side ?? "CALL").toLowerCase() === "put" ? "put" : "call";
}

function dteFromStrategy(strategy) {
  return String(strategy ?? "").toUpperCase().includes("0DTE") ? 0 : 1;
}

function winnerAt60(alert) {
  const o60 = alert.option_returns_pct?.o60m;
  return typeof o60 === "number" && o60 > 0;
}

function loserAt60(alert) {
  const o60 = alert.option_returns_pct?.o60m;
  return typeof o60 === "number" && o60 <= 0;
}

const rows = [];
for (const alert of raw.alerts ?? []) {
  const nowMs = parseSentMs(alert);
  if (nowMs == null) continue;
  const side = sideFromAlert(alert);
  const underlyingNow = Number(alert.underlying_at_delivery ?? 0);
  const optionNow = Number(alert.frozen_option_entry ?? 0);
  const guard = evaluateMarketSessionGuard(nowMs, env);
  const eq = evaluateEntryQuality(
    {
      side,
      dte: dteFromStrategy(alert.strategy),
      nowMs,
      underlyingNow,
      optionNow,
      underlyingMove60m: alert.pre_move_underlying_60m_pct ?? alert.pct_underlying_move_before_delivery ?? null,
      optionMove30m: alert.pre_move_option_30m_pct ?? alert.pct_option_move_before_delivery ?? null,
      spreadPct: null,
      quoteAgeMs: alert.quote_age_sec != null ? Number(alert.quote_age_sec) * 1000 : null,
      minutesToSessionClose: Math.round((guard.regularCloseMs - nowMs) / 60000),
      sessionState: guard.optionsSessionState,
    },
    env,
  );
  const proposedWouldSend = guard.subscriberDeliveryAllowed && eq.composite.subscriberAction === "SEND";
  const falseNegative = !proposedWouldSend && winnerAt60(alert);
  const falsePositivePrevented = !proposedWouldSend && loserAt60(alert);
  rows.push({
    symbol: alert.symbol,
    sent_at_et: alert.sent_at_et,
    side: alert.side,
    strategy: alert.strategy,
    earliness_class: alert.earliness_class,
    option_o60_pct: alert.option_returns_pct?.o60m ?? null,
    supervisor_sent: true,
    independent_would_send: null,
    proposed_would_send: proposedWouldSend,
    rejection_reason: proposedWouldSend ? null : [...(guard.subscriberDeliveryAllowed ? [] : [guard.reason]), ...eq.composite.reasons].join("; "),
    entry_quality_verdict: eq.composite.primaryVerdict,
    entry_quality_dimensions: eq.dimensions,
    session_guard_state: guard.state,
    false_negative: falseNegative,
    false_positive_prevented: falsePositivePrevented,
  });
}

const gridConfigs = [];
for (const et of ["12:30", "13:00", "13:30", "14:00"]) {
  for (const mins of [60, 90, 120]) {
    const gridEnv = { ...env, OPTIONS_0DTE_LATEST_ENTRY_ET: et, OPTIONS_0DTE_MIN_MINUTES_TO_CLOSE: String(mins) };
    let wouldSend = 0;
    let winnersBlocked = 0;
    let lossesPrevented = 0;
    for (const alert of raw.alerts ?? []) {
      const nowMs = parseSentMs(alert);
      if (nowMs == null) continue;
      const side = sideFromAlert(alert);
      const guard = evaluateMarketSessionGuard(nowMs, gridEnv);
      const eq = evaluateEntryQuality({
        side,
        dte: dteFromStrategy(alert.strategy),
        nowMs,
        underlyingNow: Number(alert.underlying_at_delivery ?? 0),
        optionNow: Number(alert.frozen_option_entry ?? 0),
        underlyingMove60m: alert.pre_move_underlying_60m_pct ?? alert.pct_underlying_move_before_delivery ?? null,
        optionMove30m: alert.pre_move_option_30m_pct ?? alert.pct_option_move_before_delivery ?? null,
        spreadPct: null,
        quoteAgeMs: alert.quote_age_sec != null ? Number(alert.quote_age_sec) * 1000 : null,
        minutesToSessionClose: Math.round((guard.regularCloseMs - nowMs) / 60000),
        sessionState: guard.optionsSessionState,
      }, gridEnv);
      const send = guard.subscriberDeliveryAllowed && eq.composite.subscriberAction === "SEND";
      if (send) wouldSend += 1;
      else if (winnerAt60(alert)) winnersBlocked += 1;
      else if (loserAt60(alert)) lossesPrevented += 1;
    }
    gridConfigs.push({ et, mins, wouldSend, winnersBlocked, lossesPrevented });
  }
}

const proposedSent = rows.filter((r) => r.proposed_would_send);
const chasedLateLosers = rows.filter((r) => !r.proposed_would_send && ["Chased", "Late"].includes(String(r.earliness_class)));
const earlyTimelyWinners = rows.filter((r) => r.proposed_would_send && ["Early", "Timely"].includes(String(r.earliness_class)));
const falseNegatives = rows.filter((r) => r.false_negative);
const falsePositivesPrevented = rows.filter((r) => r.false_positive_prevented);

const summary = {
  total: rows.length,
  proposed_would_send: proposedSent.length,
  proposed_would_block: rows.length - proposedSent.length,
  chased_late_losers_blocked: chasedLateLosers.length,
  early_timely_winners_preserved: earlyTimelyWinners.length,
  false_negatives: falseNegatives.length,
  false_positives_prevented: falsePositivesPrevented.length,
  median_option_o60_proposed_sent: (() => {
    const vals = proposedSent.map((r) => r.option_o60_pct).filter((v) => typeof v === "number").sort((a, b) => a - b);
    if (!vals.length) return null;
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  })(),
  entry_quality_config: entryQualityConfig(env),
  grid_configs: gridConfigs,
};

const outPath = join(root, "scripts/replay-subscriber-week-output.json");
writeFileSync(outPath, JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`Wrote ${outPath}`);
