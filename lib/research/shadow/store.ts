/**
 * lib/research/shadow/store.ts — OnDb persistence for the shadow layers + a read-only report.
 * All writes are SHADOW-ONLY; nothing here emits an alert or changes a threshold. The live hooks
 * are HARD no-ops unless their flag is set.
 */
import { researchFlags } from "../flags.ts";
import type { MergedCandidate } from "../discovery/discover.ts";
import type { AnalogShadowResult } from "./analog-bridge.ts";
import type { MarketContext } from "../context/market-context.ts";

interface ShadowDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number } } }

export function persistDiscoveryShadowOnDb(db: ShadowDb, cands: MergedCandidate[], nowMs: number = Date.now()): number {
  const ins = db.prepare(
    `INSERT INTO discovery_shadow (symbol, sources_json, price, change_pct, rel_volume, dollar_volume, eligible, exclusions_json, options_checked, observed_at_ms, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let n = 0;
  for (const c of cands) { ins.run(c.symbol, JSON.stringify(c.sources), c.price, c.changePctFromPrevClose, c.relVolume, c.dayDollarVolume, c.eligible ? 1 : 0, JSON.stringify(c.exclusions), c.optionsChecked ? 1 : 0, c.observedAtMs, nowMs); n++; }
  return n;
}

export function persistAnalogShadowOnDb(db: ShadowDb, r: AnalogShadowResult, nowMs: number = Date.now()): void {
  db.prepare(
    `INSERT INTO analog_shadow (symbol, t0_ms, tag, abstain, abstain_reason, comparable_count, effective_sample, confidence, win_rate, dispersion, contradiction, fwd_p10, fwd_p50, fwd_p90, nearest_distance, agrees_with_live, agreement, lookup_ms, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(r.symbol, r.t0Ms, r.tag, r.abstain ? 1 : 0, r.abstainReason, r.comparableCount, r.effectiveSample, r.confidence, r.winRate, r.dispersion, r.contradiction, r.forwardReturn.p10, r.forwardReturn.p50, r.forwardReturn.p90, r.nearestDistance, r.agreesWithLive == null ? null : r.agreesWithLive ? 1 : 0, r.agreement, r.lookupMs, nowMs);
}

export function persistMarketContextShadowOnDb(db: ShadowDb, symbol: string | null, c: MarketContext, nowMs: number = Date.now()): void {
  db.prepare(
    `INSERT INTO market_context_shadow (symbol, as_of_ms, regime, vol_regime, spy_trend, qqq_trend, iwm_trend, sector, industry, sector_rel_strength, breadth, catalyst_category, earnings_in_days, session, missing_json, context_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(symbol, c.asOfMs, c.regime, c.volRegime, c.indexTrend.spy, c.indexTrend.qqq, c.indexTrend.iwm, c.sector, c.industry, c.sectorRelStrengthPct, c.breadthAdvDeclRatio, c.catalystCategory, c.earningsInDays, c.session, JSON.stringify(c.missing), JSON.stringify(c), nowMs);
}

// ── flag-gated live hooks (HARD no-ops unless the flag is set) ────────────────
export function recordDiscoveryShadow(cands: MergedCandidate[], nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): { recorded: number; reason: string | null } {
  if (!researchFlags(env).broadDiscoveryShadow) return { recorded: 0, reason: "BROAD_DISCOVERY_SHADOW_ENABLED!=1" };
  try { const db = require("@/lib/db").getDb(); return { recorded: persistDiscoveryShadowOnDb(db, cands, nowMs), reason: null }; } // eslint-disable-line @typescript-eslint/no-require-imports
  catch (e: any) { return { recorded: 0, reason: `isolated: ${String(e?.message ?? e).slice(0, 100)}` }; }
}
export function recordAnalogShadow(r: AnalogShadowResult, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): { recorded: boolean; reason: string | null } {
  if (!researchFlags(env).analogLiveShadow) return { recorded: false, reason: "ANALOG_LIVE_SHADOW_ENABLED!=1" };
  try { persistAnalogShadowOnDb(require("@/lib/db").getDb(), r, nowMs); return { recorded: true, reason: null }; } // eslint-disable-line @typescript-eslint/no-require-imports
  catch (e: any) { return { recorded: false, reason: `isolated: ${String(e?.message ?? e).slice(0, 100)}` }; }
}
export function recordMarketContextShadow(symbol: string | null, c: MarketContext, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): { recorded: boolean; reason: string | null } {
  if (!researchFlags(env).marketContextCapture) return { recorded: false, reason: "MARKET_CONTEXT_CAPTURE_ENABLED!=1" };
  try { persistMarketContextShadowOnDb(require("@/lib/db").getDb(), symbol, c, nowMs); return { recorded: true, reason: null }; } // eslint-disable-line @typescript-eslint/no-require-imports
  catch (e: any) { return { recorded: false, reason: `isolated: ${String(e?.message ?? e).slice(0, 100)}` }; }
}

// ── read-only shadow report ──────────────────────────────────────────────────
const has = (db: ShadowDb, t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
export interface ShadowReport {
  status: "COLLECTING_DATA" | "HAS_SAMPLE";
  discovery: { total: number; eligible: number; rejected: number; topExclusions: { reason: string; n: number }[] };
  analog: { total: number; agree: number; disagree: number; abstain: number; avgLookupMs: number | null };
  marketContext: { total: number; byRegime: Record<string, number> };
  note: string;
}

export function readShadowReportOnDb(db: ShadowDb): ShadowReport {
  const n = (sql: string) => Number((db.prepare(sql).get() as any)?.n ?? 0);
  const discovery = has(db, "discovery_shadow")
    ? { total: n("SELECT COUNT(*) n FROM discovery_shadow"), eligible: n("SELECT COUNT(*) n FROM discovery_shadow WHERE eligible=1"), rejected: n("SELECT COUNT(*) n FROM discovery_shadow WHERE eligible=0"),
        topExclusions: (db.prepare("SELECT exclusions_json FROM discovery_shadow WHERE eligible=0").all() as any[]).flatMap((r) => { try { return JSON.parse(r.exclusions_json) ?? []; } catch { return []; } }).reduce((m: Map<string, number>, e: string) => m.set(e, (m.get(e) ?? 0) + 1), new Map<string, number>()) }
    : { total: 0, eligible: 0, rejected: 0, topExclusions: new Map<string, number>() };
  const topExclusions = [...(discovery.topExclusions as Map<string, number>).entries()].map(([reason, nn]) => ({ reason, n: nn })).sort((a, b) => b.n - a.n).slice(0, 10);
  const analog = has(db, "analog_shadow")
    ? { total: n("SELECT COUNT(*) n FROM analog_shadow"), agree: n("SELECT COUNT(*) n FROM analog_shadow WHERE agrees_with_live=1"), disagree: n("SELECT COUNT(*) n FROM analog_shadow WHERE agrees_with_live=0"), abstain: n("SELECT COUNT(*) n FROM analog_shadow WHERE abstain=1"), avgLookupMs: (db.prepare("SELECT AVG(lookup_ms) a FROM analog_shadow").get() as any)?.a ?? null }
    : { total: 0, agree: 0, disagree: 0, abstain: 0, avgLookupMs: null };
  const byRegime: Record<string, number> = {};
  if (has(db, "market_context_shadow")) for (const r of db.prepare("SELECT regime, COUNT(*) c FROM market_context_shadow GROUP BY regime").all() as any[]) byRegime[r.regime ?? "null"] = r.c;
  const mcTotal = has(db, "market_context_shadow") ? n("SELECT COUNT(*) n FROM market_context_shadow") : 0;
  return {
    status: discovery.total + analog.total + mcTotal > 0 ? "HAS_SAMPLE" : "COLLECTING_DATA",
    discovery: { total: discovery.total, eligible: discovery.eligible, rejected: discovery.rejected, topExclusions },
    analog: { total: analog.total, agree: analog.agree, disagree: analog.disagree, abstain: analog.abstain, avgLookupMs: analog.avgLookupMs == null ? null : +Number(analog.avgLookupMs).toFixed(2) },
    marketContext: { total: mcTotal, byRegime },
    note: "SHADOW-ONLY. Records candidates / analog evidence / market context. No alerts, no threshold changes, analog NOT actionable.",
  };
}
