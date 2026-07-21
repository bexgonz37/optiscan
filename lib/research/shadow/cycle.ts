/**
 * lib/research/shadow/cycle.ts — the ONE fire-and-forget entry the live scanner calls. It submits
 * shadow work to the bounded queue and returns immediately. NOTHING here can block, delay, suppress,
 * create, edit, or cancel a Discord alert; change confidence/ranking/thresholds/contract selection/
 * hard-gate results; override bearish-gate.ts; or make puts actionable. Every task is isolated:
 * a throw or a DB failure is caught inside the queue and never reaches the caller.
 *
 * Each layer is independently flag-gated (all OFF by default). Enabling a flag makes that layer
 * RECORD from live candidate events; analog/context still record an honest ABSTAIN / missing[] when
 * their data dependency (a fitted corpus / a context provider) is absent.
 */
import { researchFlags } from "../flags.ts";
import { shadowQueue, shadowKey } from "./queue.ts";
import { mergeAndGate, type SourcedCandidate } from "../discovery/discover.ts";
import { persistDiscoveryShadowOnDb, persistAnalogShadowOnDb, persistMarketContextShadowOnDb } from "./store.ts";
import { queryAnalogShadow, type ShadowScorer, type LiveDecisionFeatures } from "./analog-bridge.ts";
import { buildMarketContext, type MarketContextInput } from "../context/market-context.ts";

export interface ShadowCycleInput {
  nowMs: number;
  quotes: Array<{ symbol: string; price: number | null; changePercent?: number | null; volume?: number | null; relVolume?: number | null; observedAtMs?: number }>;
  extraCandidates?: SourcedCandidate[]; // earnings / options-activity candidates already classified
}
export interface ShadowCycleDeps {
  getDb?: () => any;
  scorer?: ShadowScorer | null;                 // fitted AnalogScorer, when available
  featuresFor?: (symbol: string) => LiveDecisionFeatures | null;
  liveDecisionFor?: (symbol: string) => { actionable: boolean; direction: "bullish" | "bearish" } | null;
  contextFor?: (symbol: string) => MarketContextInput | null;
}

const liveDb = () => require("@/lib/db").getDb(); // eslint-disable-line @typescript-eslint/no-require-imports

/** Fire-and-forget: enqueue shadow recording for this discovery cycle. Returns immediately. */
export function enqueueShadowCycle(input: ShadowCycleInput, deps: ShadowCycleDeps = {}, env: NodeJS.ProcessEnv = process.env): void {
  const f = researchFlags(env);
  if (!f.broadDiscoveryShadow && !f.analogLiveShadow && !f.marketContextCapture) return; // nothing enabled
  const q = shadowQueue();
  const getDb = deps.getDb ?? liveDb;

  // 1. broad discovery shadow — record the decision-time candidate set + rejection reasons
  if (f.broadDiscoveryShadow) {
    q.submit(shadowKey("_cycle", "discovery", "cycle", input.nowMs), async () => {
      const sourced: SourcedCandidate[] = input.quotes.filter((qq) => qq.symbol).map((qq) => ({
        symbol: qq.symbol, source: "market_snapshot", price: qq.price, dayDollarVolume: (qq.price ?? 0) * (qq.volume ?? 0),
        changePctFromPrevClose: qq.changePercent ?? null, relVolume: qq.relVolume ?? null, observedAtMs: qq.observedAtMs ?? input.nowMs,
      }));
      const merged = mergeAndGate([...sourced, ...(input.extraCandidates ?? [])]);
      persistDiscoveryShadowOnDb(getDb(), merged, input.nowMs);
    });
  }

  // 2 + 3. per eligible candidate: analog shadow + market-context capture
  const perSymbol = input.quotes.filter((qq) => qq.symbol).slice(0, Number(env.SHADOW_MAX_SYMBOLS_PER_CYCLE ?? 50));
  for (const qq of perSymbol) {
    const symbol = qq.symbol;
    if (f.analogLiveShadow) {
      q.submit(shadowKey(symbol, "analog", "shadow", input.nowMs), async () => {
        const feats = deps.featuresFor?.(symbol);
        const live = deps.liveDecisionFor?.(symbol) ?? { actionable: true, direction: "bullish" as const };
        if (!feats || !deps.scorer) {
          // honest record: no fitted corpus / no features ⇒ abstain (still a record so the flag "works")
          persistAnalogShadowOnDb(getDb(), { tag: "ANALOG_SHADOW_ONLY", symbol, t0Ms: input.nowMs, abstain: true, abstainReason: !deps.scorer ? "no fitted analog corpus" : "no decision-time features", comparableCount: 0, effectiveSample: 0, confidence: 0, winRate: 0, dispersion: 0, contradiction: 0, forwardReturn: { p10: 0, p50: 0, p90: 0 }, nearestDistance: null, agreesWithLive: null, agreement: "abstain", lookupMs: 0 }, input.nowMs);
          return;
        }
        const r = queryAnalogShadow(deps.scorer, feats, input.nowMs, live);
        persistAnalogShadowOnDb(getDb(), r, input.nowMs);
      });
    }
    if (f.marketContextCapture) {
      q.submit(shadowKey(symbol, "context", "shadow", input.nowMs), async () => {
        const ci = deps.contextFor?.(symbol);
        if (!ci) return; // no context provider wired yet ⇒ nothing to record (never fabricate)
        persistMarketContextShadowOnDb(getDb(), symbol, buildMarketContext(ci), input.nowMs);
      });
    }
  }
}
