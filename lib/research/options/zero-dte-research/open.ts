/**
 * Open Aggressive 0DTE Research paper trades — never Discord, never readiness.
 */

import { buildRealOptionEntry, type OptionQuote } from "../paper.ts";
import { computeOptionTargets } from "../targets.ts";
import { zeroDteResearchConfig, type ExitPolicyVersion } from "./config.ts";
import { researchFingerprint, timeBucketEt, tradingSessionDateEt, type StrategyFamily } from "./families.ts";
import { ensureZeroDteAccountState, recomputeZeroDteEquity } from "./ledger.ts";
import { canOpenZeroDteResearch, fingerprintTaken, proposeRiskUsd, readRiskSnapshot } from "./risk.ts";
import { selectZeroDteContracts, type ChainContract } from "./contracts.ts";
import { dualWriteAfterOptionsPaperEntry } from "../../../broker/dual-write.ts";
import type { BrokerDb } from "../../../broker/audit.ts";

export interface OpenDb {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes: number; lastInsertRowid?: number | bigint };
  };
}

export interface OpenZeroDteInput {
  symbol: string;
  side: "call" | "put";
  family: StrategyFamily;
  chain: ChainContract[];
  underlyingPrice: number;
  qualityScore: number;
  marketRegime?: string | null;
  session?: string | null;
  nowMs?: number;
}

const INSERT_COLS = [
  "option_symbol", "side", "strike", "expiration", "dte", "result_class",
  "bid", "ask", "mid", "spread_pct", "entry_fill", "volume", "open_interest", "iv", "delta",
  "underlying_price", "strategy", "target", "invalidation", "provenance", "status",
  "session", "core_broad", "feature_snapshot_json",
  "paper_kind", "alert_id", "entry_source", "experiment_id", "experiment_variant",
  "strategy_family", "exit_policy_version", "time_bucket", "market_regime",
  "contract_moneyness", "delta_band", "account_risk_usd", "fingerprint", "contract_alts_json",
  "entered_at_ms", "created_at_ms", "updated_at_ms",
].join(", ");

function pickExitPolicy(policies: ExitPolicyVersion[], nowMs: number): ExitPolicyVersion {
  // Deterministic rotation — never change after assignment.
  const idx = Math.abs(Math.floor(nowMs / 60_000)) % policies.length;
  return policies[idx] ?? "fixed_r";
}

export function openZeroDteResearchTrade(
  db: OpenDb,
  input: OpenZeroDteInput,
  env: NodeJS.ProcessEnv = process.env,
): { opened: boolean; reason: string | null; tradeId: number | null } {
  const cfg = zeroDteResearchConfig(env);
  if (!cfg.enabled) return { opened: false, reason: "PAPER_0DTE_RESEARCH_ENABLED!=1", tradeId: null };
  if (input.qualityScore < cfg.qualityBar) return { opened: false, reason: "below_research_quality_bar", tradeId: null };

  const nowMs = input.nowMs ?? Date.now();
  const sessionDate = tradingSessionDateEt(nowMs);
  const bucket = timeBucketEt(nowMs);
  const fingerprint = researchFingerprint({
    symbol: input.symbol,
    family: input.family,
    side: input.side,
    sessionDate,
    timeBucket: bucket,
  });
  if (fingerprintTaken(db, fingerprint)) return { opened: false, reason: "duplicate_fingerprint", tradeId: null };

  const picked = selectZeroDteContracts({
    chain: input.chain,
    side: input.side,
    underlyingPrice: input.underlyingPrice,
  });
  if (!picked.primary) return { opened: false, reason: picked.reason ?? "no_contract", tradeId: null };

  const q = picked.primary;
  const quote: OptionQuote = {
    optionSymbol: q.optionSymbol,
    side: q.side,
    strike: q.strike,
    expiration: q.expiration,
    dte: q.dte,
    bid: q.bid,
    ask: q.ask,
    volume: q.volume ?? null,
    openInterest: q.openInterest ?? null,
    iv: q.iv ?? null,
    delta: q.delta,
    quoteAgeMs: q.quoteAgeMs ?? null,
    providerTimestamp: q.providerTimestamp ?? null,
  };
  const entry = buildRealOptionEntry({
    quote,
    underlyingPrice: input.underlyingPrice,
    strategy: input.family,
    provenance: "zero_dte_research:polygon",
  }, env);
  if (!entry.ok) return { opened: false, reason: `entry_gate:${entry.rejections.join(",")}`, tradeId: null };

  const targets = computeOptionTargets(entry.mid, input.family, env);
  entry.target = targets.t1;
  entry.invalidation = targets.stop;

  const account = ensureZeroDteAccountState(db, env, nowMs);
  const equity = recomputeZeroDteEquity(db, nowMs) || account.equityUsd;
  const riskUsd = proposeRiskUsd(equity, cfg);
  const exposureUsd = entry.entryFill * 100;
  const snap = readRiskSnapshot(db, input.symbol, equity, nowMs);
  const gate = canOpenZeroDteResearch(snap, input.symbol, riskUsd, exposureUsd, cfg);
  if (!gate.ok) return { opened: false, reason: gate.reason, tradeId: null };

  const exitPolicy = pickExitPolicy(cfg.exitPolicies, nowMs);
  const feature = JSON.stringify({
    qualityScore: input.qualityScore,
    altsLogged: cfg.contractExperiment === "alts_logged",
    researchLane: "aggressive_0dte",
    label: "Aggressive 0DTE Research — simulated only",
    entryTrigger: `${input.family}:${input.side}`,
    t1: targets.t1,
    t2: targets.t2,
    stop: targets.stop,
    methodology: targets.methodology,
  });

  const cols = INSERT_COLS.split(",").map((c) => c.trim());
  const r = db.prepare(
    `INSERT INTO options_paper_trades (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(
    entry.optionSymbol, entry.side, entry.strike, entry.expiration, entry.dte, entry.class,
    entry.bid, entry.ask, entry.mid, entry.spreadPct, entry.entryFill, entry.volume, entry.openInterest, entry.iv, entry.delta,
    entry.underlyingPrice, input.family, entry.target, entry.invalidation, entry.provenance, "ENTERED",
    input.session ?? null, null, feature,
    "ZERO_DTE_RESEARCH_PAPER", null, "zero_dte_research", null, exitPolicy,
    input.family, exitPolicy, bucket, input.marketRegime ?? null,
    picked.moneyness, picked.deltaBand, riskUsd, fingerprint, JSON.stringify(picked.alts),
    nowMs, nowMs, nowMs,
  );
  const tradeId = Number(r.lastInsertRowid ?? 0);
  if (tradeId > 0) {
    try { dualWriteAfterOptionsPaperEntry(db as unknown as BrokerDb, tradeId); } catch { /* best-effort */ }
  }
  return { opened: tradeId > 0, reason: tradeId > 0 ? null : "insert_failed", tradeId: tradeId || null };
}
