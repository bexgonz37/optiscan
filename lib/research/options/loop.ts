/**
 * lib/research/options/loop.ts — the independent Options discovery ORCHESTRATOR. PURE evaluator +
 * a flag-gated, fire-and-forget persist that runs the deterministic path FIRST and enqueues AI/analog
 * shadow AFTERWARD (never on the callout critical path). It does NOT call the stock radar, does NOT
 * send Discord, and cannot affect the live scanner. Puts stay RESEARCH_ONLY.
 */
import { researchFlags } from "../flags.ts";
import { selectOptionsStrategy, type OptionsCandidateInput, type StrategySelection } from "./discovery.ts";
import { getStrategy } from "./strategy-catalog.ts";
import { evaluateCallout, type CalloutContract, type CalloutResult } from "./callout.ts";
import { buildRealOptionEntry, persistRealOptionPaperOnDb, canOpenRealOptionPaper, type OptionQuote, type RealOptionEntry } from "./paper.ts";
import { persistCaseFromOptionsLive } from "../../opportunity-case/orchestrate.ts";
import { buildOpportunityIdentity, opportunityFingerprint } from "../../opportunity-case/identity.ts";
import { attachEvidenceToOpportunityOnDb, findActiveOpportunityByFingerprintOnDb } from "../../opportunity-case/live.ts";
import { buildCandidateInstrumentation, persistCandidateInstrumentation, isReadyCandidateExpired } from "./instrumentation.ts";
import { sessionState } from "./session-state.ts";
import { assertSubscriberDeliveryAllowed, isSameTradingSession } from "../../market-session-guard.ts";
import { incrementInstrumentationFallbackInserts } from "../../db-legacy-columns.ts";

export interface ChainContract { optionSymbol: string; side: "call" | "put"; strike: number; expiration: string; dte: number; bid: number | null; ask: number | null; spreadPct: number | null; volume: number | null; openInterest: number | null; iv: number | null; delta: number | null; providerTimestamp: number | null }

/** Pick the contract nearest the strategy's preferred |delta| within the preferred DTE band. */
export function selectContractFromChain(chain: ChainContract[], side: "call" | "put", strategyKey: string, nowMs: number): ChainContract | null {
  const strat = getStrategy(strategyKey); if (!strat) return null;
  const [dLo, dHi] = strat.preferredDelta;
  const dteBands = new Set(strat.preferredDte);
  const dteOk = (dte: number) => dteBands.has(dte <= 0 ? "0dte" : dte <= 7 ? "1-7dte" : dte <= 14 ? "8-14dte" : dte <= 30 ? "15-30dte" : dte <= 90 ? "31-90dte" : "longer");
  const target = (dLo + dHi) / 2;
  const cand = chain.filter((c) => c.side === side && (c.bid ?? 0) > 0 && dteOk(c.dte) && c.delta != null);
  if (cand.length === 0) return null;
  return cand.sort((a, b) => Math.abs(Math.abs(a.delta!) - target) - Math.abs(Math.abs(b.delta!) - target))[0];
}

export interface OptionsEvalResult {
  selection: StrategySelection;
  contract: ChainContract | null;
  callout: CalloutResult | null;
  paperEntry: RealOptionEntry | null;
  state: string;
}

/** PURE: run the full deterministic evaluation for one candidate given a fetched chain. */
export function evaluateOptionsCandidate(input: OptionsCandidateInput, chain: ChainContract[], opts: { bearishActionable?: boolean; currentUnderlyingPrice?: number; currentAtMs?: number; entryZone?: [number, number] | null; targets?: [number, number] | null } = {}): OptionsEvalResult {
  const selection = selectOptionsStrategy(input, { bearishActionable: opts.bearishActionable });
  if (!selection.selected) return { selection, contract: null, callout: null, paperEntry: null, state: "REJECTED" };
  const side = selection.selected.side;
  const contract = selectContractFromChain(chain, side, selection.selected.key, input.nowMs);
  if (!contract) return { selection, contract: null, callout: { state: "REJECTED", message: null, reason: "no eligible contract in the preferred delta/DTE band", freshness: null, entry: null }, paperEntry: null, state: "REJECTED" };

  const cc: CalloutContract = { optionSymbol: contract.optionSymbol, side: contract.side, strike: contract.strike, expiration: contract.expiration, dte: contract.dte, bid: contract.bid, ask: contract.ask, spreadPct: contract.spreadPct, quoteAgeMs: contract.providerTimestamp != null ? input.nowMs - contract.providerTimestamp : null, openInterest: contract.openInterest, volume: contract.volume };
  const strat = getStrategy(selection.selected.key)!;
  // The chart level the setup is playing, as an ABSOLUTE underlying price (for the educational message
  // only — never a stop). nearResistancePct is the % distance to the nearest level above price; convert
  // it back to a price. Null when levels aren't wired → the message simply omits the "watching" line.
  const uPrice = input.underlying.price ?? 0;
  const nearPct = input.underlying.nearResistancePct;
  const keyLevel = uPrice > 0 && nearPct != null && Number.isFinite(nearPct) ? +(uPrice * (1 + nearPct / 100)).toFixed(2) : null;
  const callout = evaluateCallout({
    symbol: input.symbol, strategyKey: selection.selected.key, researchOnly: selection.selected.researchOnly, contract: cc,
    observedUnderlyingPrice: input.underlying.price ?? 0, observedAtMs: input.nowMs,
    currentUnderlyingPrice: opts.currentUnderlyingPrice ?? input.underlying.price ?? 0, currentAtMs: opts.currentAtMs ?? input.nowMs,
    entryZone: opts.entryZone ?? null, targets: opts.targets ?? null, keyLevel,
    why: `${strat.label.toLowerCase()} with ${selection.selected.side} setup`, ttlMs: strat.freshnessMaxMs * 4, ageMs: 0,
  });

  let paperEntry: RealOptionEntry | null = null;
  if (callout.state === "READY") {
    const q: OptionQuote = { optionSymbol: contract.optionSymbol, side: contract.side, strike: contract.strike, expiration: contract.expiration, dte: contract.dte, bid: contract.bid, ask: contract.ask, volume: contract.volume, openInterest: contract.openInterest, iv: contract.iv, delta: contract.delta, quoteAgeMs: cc.quoteAgeMs, providerTimestamp: contract.providerTimestamp };
    paperEntry = buildRealOptionEntry({ quote: q, underlyingPrice: input.underlying.price ?? 0, strategy: selection.selected.key, target: opts.targets?.[0] ?? null, invalidation: null });
  }
  return { selection, contract, callout, paperEntry, state: callout.state };
}

interface LoopDb { prepare(sql: string): { run: (...a: any[]) => { changes: number } } }
const liveDb = () => require("@/lib/db").getDb(); // eslint-disable-line @typescript-eslint/no-require-imports

export interface OptionsCandidateExtra {
  featureSnapshot?: unknown; earlinessPhase?: string | null; escalatedBy?: string | null; coreBroad?: string | null;
  /** Portfolio delivery mode: instead of firing Discord immediately, hand the ready-to-send payload +
   *  quality inputs to the cycle's collector so ALL READY candidates compete before delivery. */
  collectDelivery?: (submission: import("./delivery-decision.ts").DeliverySubmission) => void;
  rankTier?: 0 | 1 | 2;
  fractionMove?: number | null;
}

/** Fire-and-forget: run the candidate, persist it (with the enriched decision-time snapshot the AI/
 *  analog shadow consume), and enqueue AI/analog shadow AFTERWARD. HARD no-op unless
 *  INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1. Never throws into the caller. */
export function runOptionsCandidate(input: OptionsCandidateInput, chain: ChainContract[], deps: { getDb?: () => LoopDb } = {}, env: NodeJS.ProcessEnv = process.env, extra: OptionsCandidateExtra = {}): OptionsEvalResult | null {
  if (!researchFlags(env).independentOptionsDiscovery) return null;
  const res = evaluateOptionsCandidate(input, chain, { bearishActionable: env.BEARISH_ACTIONABLE === "1" });
  const snapJson = extra.featureSnapshot !== undefined ? JSON.stringify(extra.featureSnapshot) : null;
  try {
    const db = (deps.getDb ?? liveDb)();
    const inst = buildCandidateInstrumentation({
      nowMs: input.nowMs,
      underlyingPrice: input.underlying.price ?? null,
      optionMid: res.contract ? ((res.contract.bid ?? 0) + (res.contract.ask ?? 0)) / 2 : null,
      session: input.session,
      sessionState: sessionState(input.nowMs, env),
      featureSnapshot: extra.featureSnapshot,
      state: res.state,
    }, env);
    let candidateId = 0;
    try {
      const insert = db.prepare(
        `INSERT INTO options_candidates (symbol, tier, session, selected_strategy, direction, side, research_only, score, considered_json, state, why, option_symbol, freshness_state, callout_message, earliness_phase, escalated_by, feature_snapshot_json, first_detected_at_ms, underlying_at_first_detection, option_at_first_detection, session_state_at_detection, trading_session_date, market_structure_snapshot_json, first_ready_at_ms, underlying_at_ready, option_at_ready, ready_expires_at_ms, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const info = insert.run(
        input.symbol, input.tier, input.session, res.selection.selected?.key ?? null, res.selection.direction, res.selection.selected?.side ?? null, res.selection.selected?.researchOnly ? 1 : 0, res.selection.selected?.score ?? null, JSON.stringify(res.selection.considered.slice(0, 8)), res.state, res.callout?.reason ?? res.selection.reason, res.contract?.optionSymbol ?? null, res.callout?.freshness ?? null, res.callout?.message ?? null, extra.earlinessPhase ?? null, extra.escalatedBy ?? null, snapJson,
        inst.firstDetectedAtMs, inst.underlyingAtFirstDetection, inst.optionAtFirstDetection, inst.sessionStateAtDetection, inst.tradingSessionDate, inst.marketStructureSnapshotJson,
        inst.firstReadyAtMs ?? null, inst.underlyingAtReady ?? null, inst.optionAtReady ?? null, inst.readyExpiresAtMs ?? null,
        input.nowMs,
      ) as { lastInsertRowid?: number | bigint };
      candidateId = Number(info.lastInsertRowid ?? 0);
    } catch {
      incrementInstrumentationFallbackInserts();
      const info = db.prepare(
        `INSERT INTO options_candidates (symbol, tier, session, selected_strategy, direction, side, research_only, score, considered_json, state, why, option_symbol, freshness_state, callout_message, earliness_phase, escalated_by, feature_snapshot_json, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        input.symbol, input.tier, input.session, res.selection.selected?.key ?? null, res.selection.direction, res.selection.selected?.side ?? null, res.selection.selected?.researchOnly ? 1 : 0, res.selection.selected?.score ?? null, JSON.stringify(res.selection.considered.slice(0, 8)), res.state, res.callout?.reason ?? res.selection.reason, res.contract?.optionSymbol ?? null, res.callout?.freshness ?? null, res.callout?.message ?? null, extra.earlinessPhase ?? null, extra.escalatedBy ?? null, snapJson, input.nowMs,
      ) as { lastInsertRowid?: number | bigint };
      candidateId = Number(info.lastInsertRowid ?? 0);
    }
    if (candidateId > 0) persistCandidateInstrumentation(db, candidateId, inst);
    // Living Opportunity Case: if an active opportunity already matches, attach evidence and do not
    // submit another opening delivery. Audit capture still runs (bound to the living case id).
    let livingOpportunityCaseId: string | null = null;
    let suppressOpeningAsDuplicate = false;
    if (env.OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED !== "0" && res.contract && res.selection.selected) {
      try {
        const fp = opportunityFingerprint(buildOpportunityIdentity({
          symbol: input.symbol,
          side: res.contract.side,
          expiration: res.contract.expiration,
          strike: res.contract.strike,
          strategyKey: res.selection.selected.key,
          nowMs: input.nowMs,
          direction: res.selection.direction,
        }));
        const active = findActiveOpportunityByFingerprintOnDb(db, fp);
        if (active) {
          livingOpportunityCaseId = active.opportunityCaseId;
          suppressOpeningAsDuplicate = true;
          attachEvidenceToOpportunityOnDb(db, {
            opportunityCaseId: active.opportunityCaseId,
            nowMs: input.nowMs,
            source: "options_loop",
            signalType: res.state === "READY" ? "repeat_ready_signal" : "repeat_evaluation",
            score: res.selection.selected.score ?? null,
            details: {
              state: res.state,
              optionSymbol: res.contract.optionSymbol,
              strategy: res.selection.selected.key,
              matched: res.selection.considered.find((c) => c.key === res.selection.selected!.key)?.matched ?? [],
            },
            strengthen: res.state === "READY",
          });
        }
      } catch { /* isolated */ }
    }
    // Enterprise Opportunity Case audit (additive, isolated — never blocks the live path).
    if (env.OPPORTUNITY_CASE_CAPTURE_ENABLED !== "0") {
      try {
        persistCaseFromOptionsLive(db, { input, evalResult: res, chainLength: chain.length, livingOpportunityCaseId });
      } catch { /* audit is best-effort */ }
    }
    // Real-option paper (separate flag). Public callout DELIVERY is NOT wired here (manual/gated).
    // Options-market-hours only (never open from a stale prior-session quote), and gated on
    // dedup / max-concurrent / per-symbol exposure. A fresh executable quote is enforced by the
    // entry gate (quoteAgeMs) inside buildRealOptionEntry.
    let paperOptionSymbol: string | null = null;
    if (res.state === "READY" && res.paperEntry?.ok && researchFlags(env).realOptionPaper && input.session === "regular") {
      const gate = canOpenRealOptionPaper(db, { optionSymbol: res.paperEntry.optionSymbol, strategy: res.paperEntry.strategy, nowMs: input.nowMs });
      // The monitor's auto-open is a RESEARCH_ONLY_PAPER shadow (subscribers never see it). The
      // subscriber MIRROR (DELIVERED_ALERT_PAPER) is created ONLY on a real Discord SEND, inside
      // deliverOptionsCallout — so it exists iff an alert was actually delivered.
      if (gate.ok) { persistRealOptionPaperOnDb(db, res.paperEntry, input.nowMs, { session: input.session, coreBroad: extra.coreBroad ?? (input.tier === 1 ? "core" : "broad"), featureSnapshotJson: snapJson ?? undefined, paperKind: "RESEARCH_ONLY_PAPER", entrySource: "monitor_shadow" }); paperOptionSymbol = res.paperEntry.optionSymbol; }
    }
    // GATED private-beta Discord delivery — fire-and-forget, fully isolated. HARD no-op unless
    // EARLY_OPTIONS_CALLOUTS_ENABLED=1 (delivery re-checks the flag + freshness/chase). The linked
    // paper trade (if any) uses the EXACT same OCC contract as the callout.
    if (res.state === "READY" && res.contract && res.callout?.message && researchFlags(env).earlyOptionsCallouts) {
      const guard = assertSubscriberDeliveryAllowed(input.nowMs, env);
      const guardMode = String(env.MARKET_SESSION_GUARD ?? "shadow").toLowerCase();
      if (!guard.ok && guardMode !== "shadow" && guardMode !== "0") {
        // Subscriber lane blocked outside allowed session — research paper may still run above.
      } else if (inst.readyExpiresAtMs != null && isReadyCandidateExpired(inst.readyExpiresAtMs, input.nowMs)) {
        // READY TTL expired before batch collection.
      } else if (!isSameTradingSession(inst.tradingSessionDate, input.nowMs)) {
        // Prior-session READY candidate — do not revive for delivery.
      } else if (suppressOpeningAsDuplicate) {
        // Active Opportunity Case already owns this fingerprint — evidence attached above; no new open.
      } else {
      const strat = getStrategy(res.selection.selected!.key);
      const px = input.underlying.price ?? 0;
      const deliveryInput = {
        candidateSymbol: input.symbol, strategy: res.selection.selected!.key, researchOnly: res.selection.selected!.researchOnly,
        contract: { optionSymbol: res.contract.optionSymbol, side: res.contract.side, strike: res.contract.strike, expiration: res.contract.expiration, bid: res.contract.bid, ask: res.contract.ask, spreadPct: res.contract.spreadPct, quoteAgeMs: res.contract.providerTimestamp != null ? input.nowMs - res.contract.providerTimestamp : null, dte: res.contract.dte, volume: res.contract.volume, openInterest: res.contract.openInterest, iv: res.contract.iv, delta: res.contract.delta, providerTimestamp: res.contract.providerTimestamp },
        message: res.callout.message, observedUnderlyingPrice: px, currentUnderlyingPrice: px, chaseLimitPct: strat?.chaseLimitPct ?? 0.6, underlyingPrice: px, decisionMs: input.nowMs, session: input.session, entry: res.callout.entry, tier: input.tier, paperOptionSymbol,
        firstDetectedAtMs: inst.firstDetectedAtMs,
        underlyingAtFirstDetection: inst.underlyingAtFirstDetection,
        optionAtFirstDetection: inst.optionAtFirstDetection,
        firstReadyAtMs: inst.firstReadyAtMs,
        readyExpiresAtMs: inst.readyExpiresAtMs,
        tradingSessionDate: inst.tradingSessionDate,
        featureSnapshot: (extra.featureSnapshot && typeof extra.featureSnapshot === "object") ? extra.featureSnapshot as Record<string, unknown> : null,
      };
      if (extra.collectDelivery) {
        // Portfolio delivery: submit into the cycle batch so every READY candidate competes before Discord.
        const sel = res.selection.selected!;
        const considered = res.selection.considered.find((c) => c.key === sel.key);
        try {
          extra.collectDelivery({
            deliveryInput, symbol: input.symbol, side: sel.side, strategy: sel.key, researchOnly: sel.researchOnly,
            tier: extra.rankTier ?? input.tier,
            matchedSignals: considered?.matched.length ?? 0, requiredSignals: strat?.earlySignals.length ?? 0, strategyScore: sel.score,
            spreadPct: res.callout.entry?.spreadPct ?? res.contract.spreadPct, openInterest: res.contract.openInterest, volume: res.contract.volume,
            fractionMove: extra.fractionMove ?? null, levelProximityPct: input.underlying.nearResistancePct,
            nowMs: input.nowMs,
          });
        } catch { /* isolated */ }
      } else {
        console.error("[options-delivery] refusing immediate subscriber delivery: portfolio delivery collector is required");
      }
      }
    }
  } catch { /* isolated: options discovery never affects the live path */ }
  return res;
}
