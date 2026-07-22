/**
 * lib/research/options/diagnostic.ts — EVIDENCE-ONLY Tier-1 rejection diagnostic. Runs the EXACT
 * enrichment path (getBars → computeOptionsFeatures → featuresToUnderlying → scoreStrategies) for
 * every Tier-1 symbol and reports why each did/didn't reach Stage 2. It creates NO candidate, NO
 * paper trade, and NO Discord message. Read-only. It never fabricates a candidate.
 */
import { researchFlags } from "../flags.ts";
import { optionsTier1, scoreStrategies, selectOptionsStrategy, type OptionsCandidateInput, type Session } from "./discovery.ts";
import { OPTIONS_STRATEGIES } from "./strategy-catalog.ts";
import { computeOptionsFeatures, featuresToUnderlying, type Bar, type FeatureContext } from "./features.ts";
import { optionsCooldownRemainingMs } from "./monitor.ts";

export interface OptionsDiagDeps {
  getUnderlyingBatch: (symbols: string[]) => Promise<Map<string, { price: number | null; dayDollarVolume: number | null }>>;
  getBars: (symbol: string) => Promise<Bar[]>;
  levelContext?: (symbol: string) => Partial<FeatureContext> | null;
  now?: () => number;
  session?: () => Session;
  maxBarAgeMs?: number;
}

export interface StrategyDiag { key: string; label: string; score: number; applicable: boolean; matched: string[]; required: string[]; missing: string[]; disqualifier: string | null; nearMissSignals: number }
export interface SymbolDiag {
  symbol: string; snapshotPresent: boolean;
  bars: { count: number; firstMs: number | null; lastMs: number | null; lastBarAgeMs: number | null }; stale: boolean;
  features: Record<string, number | boolean | null>; featureNullReasons: Record<string, string>; missing: string[];
  strategies: StrategyDiag[]; chosenSide: string | null; wouldReachStage2: boolean; cooldownRemainingMs: number; finalRejection: string;
}
export interface OptionsDiagnostic {
  session: Session; marketOpenForOptions: boolean; nowMs: number;
  flags: { independentOptionsDiscovery: boolean; optionsActivityDiscovery: boolean };
  summary: { symbols: number; stale: number; wouldReachStage2: number; withFreshBars: number };
  note: string; symbols: SymbolDiag[];
}

const MIN_MATCH = 0.5;

function nullReasons(f: ReturnType<typeof computeOptionsFeatures>): Record<string, string> {
  const r: Record<string, string> = {};
  if (f.price == null) r.price = "no bars";
  if (f.relVolume == null) r.relVolume = "no time-of-day volume baseline wired (needs a baseline feed)";
  if (f.vwapDistPct == null) r.vwapDistPct = "no volume/bars to compute VWAP";
  if (f.compressionScore == null) r.compressionScore = "insufficient bars to compute ATR";
  if (f.expansionScore == null) r.expansionScore = "insufficient bars to compute ATR";
  if (f.nearestResistanceDistPct == null) r.nearestResistanceDistPct = "no resistance level above price (only HOD known; price at/above HOD or levels not wired)";
  if (f.gapPct == null) r.gapPct = "no prevClose level wired";
  if (f.realizedVolExpanding == null) r.realizedVolExpanding = "fewer than 10 return bars";
  return r;
}

export async function optionsTier1Diagnostic(deps: OptionsDiagDeps, env: NodeJS.ProcessEnv = process.env): Promise<OptionsDiagnostic> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const session = (deps.session ?? (() => "regular" as Session))();
  const flags = researchFlags(env);
  const symbols = optionsTier1(env);
  const snaps = await deps.getUnderlyingBatch(symbols).catch(() => new Map());

  const out: SymbolDiag[] = [];
  for (const symbol of symbols) {
    const snap = snaps.get(symbol) ?? null;
    let bars: Bar[] = [];
    try { bars = await deps.getBars(symbol); } catch { bars = []; }
    const ctx: FeatureContext = { nowMs, session, maxBarAgeMs: deps.maxBarAgeMs, ...(deps.levelContext?.(symbol) ?? {}) };
    const f = computeOptionsFeatures(bars, ctx);
    const sorted = [...bars].sort((a, b) => a.t - b.t);
    const lastBarAgeMs = sorted.length ? nowMs - sorted[sorted.length - 1].t : null;
    const u = featuresToUnderlying(f);
    const input: OptionsCandidateInput = { symbol, nowMs, session, tier: 1, underlying: u, optionsActivity: null, earnings: null };
    const scored = scoreStrategies(input, MIN_MATCH);
    const anyApplicable = scored.some((x) => x.applicable);
    const sel = selectOptionsStrategy(input, { bearishActionable: env.BEARISH_ACTIONABLE === "1" });

    const strategies: StrategyDiag[] = scored.map((sc) => {
      const def = OPTIONS_STRATEGIES.find((d) => d.key === sc.key)!;
      const required = def.earlySignals;
      const missing = required.filter((sig) => !sc.matched.includes(sig));
      const needToPass = Math.max(0, Math.ceil(MIN_MATCH * required.length) - sc.matched.length);
      return { key: sc.key, label: sc.label, score: sc.score, applicable: sc.applicable, matched: sc.matched, required, missing, disqualifier: sc.rejection, nearMissSignals: needToPass };
    }).sort((a, b) => b.score - a.score);

    let finalRejection: string;
    if (!snap || snap.price == null) finalRejection = "stage1: missing underlying snapshot/price";
    else if ((snap.dayDollarVolume ?? 0) < 5_000_000) finalRejection = "stage1: insufficient underlying dollar volume";
    else if (bars.length === 0) finalRejection = "stage1.5: no bars returned (market closed or provider empty)";
    else if (f.stale) finalRejection = `stage1.5: stale bars (last bar ${lastBarAgeMs}ms old > ${ctx.maxBarAgeMs ?? 300_000}ms; market likely closed)`;
    else if (!anyApplicable && !flags.optionsActivityDiscovery) finalRejection = "stage1.5 gate: no strategy applicable and OPTIONS_ACTIVITY_DISCOVERY_ENABLED is off (no escalation)";
    else if (!anyApplicable) finalRejection = "stage1.5 gate: no strategy applicable (would attempt options-activity escalation at Stage 2)";
    else finalRejection = "would reach Stage 2 (a strategy is applicable)";

    out.push({
      symbol, snapshotPresent: Boolean(snap && snap.price != null),
      bars: { count: sorted.length, firstMs: sorted[0]?.t ?? null, lastMs: sorted[sorted.length - 1]?.t ?? null, lastBarAgeMs }, stale: f.stale,
      features: {
        price: f.price, relVolume: u.relVolume, vwap: f.vwap, vwapDistPct: f.vwapDistPct, aboveVwap: f.aboveVwap, hodBreak: f.hodBreak,
        compressionScore: f.compressionScore, expansionScore: f.expansionScore, momentumPct: f.shortMomentumPct, velPct: f.velPct, accelPct: f.accelPct,
        realizedVol: f.realizedVol, realizedVolExpanding: f.realizedVolExpanding, atrPct: f.atrPct, gapPct: f.gapPct, nearestResistanceDistPct: f.nearestResistanceDistPct,
      },
      featureNullReasons: nullReasons(f), missing: f.missing,
      strategies, chosenSide: sel.selected?.side ?? null,
      wouldReachStage2: anyApplicable || (flags.optionsActivityDiscovery && !f.stale && bars.length > 0),
      cooldownRemainingMs: optionsCooldownRemainingMs(symbol, nowMs), finalRejection,
    });
  }

  const stale = out.filter((s) => s.stale || s.bars.count === 0).length;
  const withFresh = out.filter((s) => !s.stale && s.bars.count > 0).length;
  return {
    session, marketOpenForOptions: session === "regular", nowMs,
    flags: { independentOptionsDiscovery: flags.independentOptionsDiscovery, optionsActivityDiscovery: flags.optionsActivityDiscovery },
    summary: { symbols: out.length, stale, wouldReachStage2: out.filter((s) => s.wouldReachStage2).length, withFreshBars: withFresh },
    note: session === "regular"
      ? "Regular options-market hours: symbols with fresh bars are evaluated; a symbol is only rejected on real strategy conditions."
      : `Session '${session}' — listed-options are NOT in regular hours, so bars are typically stale/absent and every symbol rejects at Stage 1.5. This is EXPECTED; re-run during regular hours (marketOpenForOptions=true) to see live evaluation.`,
    symbols: out,
  };
}
