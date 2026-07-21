/**
 * lib/research/shadow/earliness.ts — measure whether broad discovery + analog evidence improve
 * EARLY detection (Broad Discovery + Analog Shadow Bridge, measurement layer). PURE.
 *
 * EARLINESS = how much of the move was still ahead when we detected it, plus the price/time lead
 * versus a simple momentum-only baseline. Nothing here claims superiority; it just computes the
 * metrics so forward evidence can decide.
 */
export interface EarlinessInput {
  preMovePrice: number;        // underlying just before the move began
  detectPrice: number;         // price when this lane detected the setup
  breakoutLevel: number;       // intended breakout/entry level
  peakPrice: number;           // max favorable price reached after detection (MFE peak)
  troughPrice: number;         // max adverse price after detection (MAE trough)
  side: "call" | "put";
  detectAtMs: number;
  firstExpansionAtMs: number;  // when the first volatility/velocity expansion threshold hit
  momentumBaselineDetectPrice: number | null; // price a momentum-only baseline would have entered at
}

export interface EarlinessResult {
  fractionOfMoveComplete: number;   // 0 = detected before any move, 1 = at the peak
  distanceToBreakoutPct: number;    // signed % from detect price to the breakout level (+ = below breakout)
  timeLeadMs: number;               // firstExpansion − detect (+ = detected BEFORE expansion)
  mfePct: number; maePct: number;   // side-aware excursions from detect price
  priceImprovementPct: number | null; // how much better than the momentum-only baseline entry
  phase: "before" | "during" | "after";
}

export function computeEarliness(i: EarlinessInput): EarlinessResult {
  const bullish = i.side === "call";
  const span = i.peakPrice - i.preMovePrice;
  const done = span !== 0 ? (i.detectPrice - i.preMovePrice) / span : 0;
  const fractionOfMoveComplete = +Math.max(0, Math.min(1, bullish ? done : 1 - (i.detectPrice - i.preMovePrice) / (span || 1))).toFixed(4);
  const distanceToBreakoutPct = i.detectPrice > 0 ? +(((i.breakoutLevel - i.detectPrice) / i.detectPrice) * 100 * (bullish ? 1 : -1)).toFixed(4) : 0;
  const timeLeadMs = i.firstExpansionAtMs - i.detectAtMs;
  const mfePct = i.detectPrice > 0 ? +(((bullish ? i.peakPrice - i.detectPrice : i.detectPrice - i.troughPrice) / i.detectPrice) * 100).toFixed(4) : 0;
  const maePct = i.detectPrice > 0 ? +(((bullish ? i.troughPrice - i.detectPrice : i.detectPrice - i.peakPrice) / i.detectPrice) * 100).toFixed(4) : 0;
  const priceImprovementPct = i.momentumBaselineDetectPrice != null && i.momentumBaselineDetectPrice > 0
    ? +((((i.momentumBaselineDetectPrice - i.detectPrice) / i.momentumBaselineDetectPrice) * 100) * (bullish ? 1 : -1)).toFixed(4) : null;
  const phase: EarlinessResult["phase"] = timeLeadMs > 0 ? "before" : fractionOfMoveComplete >= 0.75 ? "after" : "during";
  return { fractionOfMoveComplete, distanceToBreakoutPct, timeLeadMs, mfePct, maePct, priceImprovementPct, phase };
}

// ── 3-way lane comparison ────────────────────────────────────────────────────
export type Lane = "baseline" | "broad_only" | "broad_plus_analog";
export interface LaneObservation {
  symbol: string;
  detectedByBaseline: boolean;
  detectedByBroad: boolean;
  analogImprovedRank: boolean | null; // vs broad-only ranking; null = analog abstained
  tooLate: boolean;
  falsePositive: boolean;
  analogLookupMs: number | null;
}

export interface LaneComparison {
  n: number;
  pctFoundOnlyByBroad: number;      // valid opportunities the baseline missed
  pctAnalogImprovedRank: number;
  pctAnalogWorsenedRank: number;
  tooLateRate: number;
  falsePositiveRate: number;
  avgAnalogLookupMs: number | null;
}

export function compareLanes(obs: LaneObservation[]): LaneComparison {
  const n = obs.length;
  const pct = (c: number) => (n ? +((c / n) * 100).toFixed(2) : 0);
  const lat = obs.map((o) => o.analogLookupMs).filter((x): x is number => x != null);
  return {
    n,
    pctFoundOnlyByBroad: pct(obs.filter((o) => o.detectedByBroad && !o.detectedByBaseline).length),
    pctAnalogImprovedRank: pct(obs.filter((o) => o.analogImprovedRank === true).length),
    pctAnalogWorsenedRank: pct(obs.filter((o) => o.analogImprovedRank === false).length),
    tooLateRate: pct(obs.filter((o) => o.tooLate).length),
    falsePositiveRate: pct(obs.filter((o) => o.falsePositive).length),
    avgAnalogLookupMs: lat.length ? +(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(2) : null,
  };
}
