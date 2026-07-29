export type ResearchQuestionPipeline =
  | "INDEPENDENT_OPTIONS"
  | "SUPERVISOR_OPTIONS"
  | "STOCK_MOMENTUM"
  | "DELIVERED_ALERT_PAPER"
  | "ZERO_DTE_RESEARCH"
  | "SHADOW_REPLAY"
  | "LEGACY_AUDIT";

export interface ResearchQuestionDefinition {
  id: string;
  question: string;
  exactRule: string;
  ownerFile: string;
  pipeline: ResearchQuestionPipeline;
  requiredEvidence: string[];
  outputMetrics: string[];
  minimumSample: number;
  experimentType: "REPLAY" | "SHADOW" | "DATA_AUDIT" | "OBSERVE_ONLY";
}

export const RESEARCH_QUESTION_REGISTRY: ResearchQuestionDefinition[] = [
  {
    id: "stock-discovery-ranking-strictness",
    question: "Was Discovery Ranking too strict?",
    exactRule: "broadStockEligibility + rank/promotion thresholds before a stock can enter fast-mover consideration",
    ownerFile: "lib/stock-momentum-policy.ts",
    pipeline: "STOCK_MOMENTUM",
    requiredEvidence: ["momentum_diagnostics rank/promotion timestamps", "near-miss decisions", "sent decisions"],
    outputMetrics: ["unique missed fast movers", "late discoveries", "promotion latency"],
    minimumSample: 30,
    experimentType: "REPLAY",
  },
  {
    id: "stock-acceleration-too-strict",
    question: "Were acceleration thresholds too strict?",
    exactRule: "fastStockMomentumEligibility return/velocity/acceleration floors",
    ownerFile: "lib/stock-momentum-policy.ts",
    pipeline: "STOCK_MOMENTUM",
    requiredEvidence: ["ret_10s_pct", "ret_30s_pct", "ret_60s_pct", "velocity_pct_min", "decision"],
    outputMetrics: ["blocked winners", "false-positive change", "late-alert change"],
    minimumSample: 50,
    experimentType: "REPLAY",
  },
  {
    id: "stock-acceleration-too-loose",
    question: "Were acceleration thresholds too loose?",
    exactRule: "fastStockMomentumEligibility acceleration and velocity pass conditions",
    ownerFile: "lib/stock-momentum-policy.ts",
    pipeline: "STOCK_MOMENTUM",
    requiredEvidence: ["sent decisions", "graded outcomes", "late/exhausted classifications"],
    outputMetrics: ["false positive rate", "late/exhausted rate", "loss rate"],
    minimumSample: 30,
    experimentType: "REPLAY",
  },
  {
    id: "quote-freshness-limits",
    question: "Were quote freshness limits appropriate?",
    exactRule: "stock quote age and option quote freshness gates",
    ownerFile: "lib/entry-quality-gate.ts",
    pipeline: "INDEPENDENT_OPTIONS",
    requiredEvidence: ["quote_ts_ms", "created_at_ms", "quote_age_ms", "freshness_state", "delivery decisions"],
    outputMetrics: ["stale rejection count", "invalid latency count", "delivered quote age"],
    minimumSample: 30,
    experimentType: "DATA_AUDIT",
  },
  {
    id: "vwap-rejection-appropriate",
    question: "Was VWAP rejection appropriate?",
    exactRule: "entry and stock momentum VWAP extension gates",
    ownerFile: "lib/entry-quality-gate.ts",
    pipeline: "INDEPENDENT_OPTIONS",
    requiredEvidence: ["vwap_dist_pct", "entry_state", "rejection reason", "outcome"],
    outputMetrics: ["VWAP rejected winners", "premium chased avoids", "late/exhausted rate"],
    minimumSample: 30,
    experimentType: "SHADOW",
  },
  {
    id: "option-liquidity-strictness",
    question: "Was liquidity filtering too strict?",
    exactRule: "option volume/open-interest/liquidity requirements in contract entry gates",
    ownerFile: "lib/entry-quality-gate.ts",
    pipeline: "INDEPENDENT_OPTIONS",
    requiredEvidence: ["volume", "open_interest", "spread_pct", "rejection reason", "outcome"],
    outputMetrics: ["liquidity rejects", "blocked winners", "delivered slippage risk"],
    minimumSample: 30,
    experimentType: "SHADOW",
  },
  {
    id: "option-spread-strictness",
    question: "Were options spreads too strict?",
    exactRule: "ENTRY_MAX_SPREAD_PCT and final delivery spread validation",
    ownerFile: "lib/entry-quality-gate.ts",
    pipeline: "INDEPENDENT_OPTIONS",
    requiredEvidence: ["delivered_spread_pct", "option_spread_pct", "bid", "ask", "rejection reason"],
    outputMetrics: ["spread rejects", "blocked winners", "delivered spread distribution"],
    minimumSample: 30,
    experimentType: "SHADOW",
  },
  {
    id: "option-chain-filter-strictness",
    question: "Were chain filters too strict?",
    exactRule: "contract selector DTE/delta/moneyness/two-sided quote filters",
    ownerFile: "lib/contract-selector.ts",
    pipeline: "INDEPENDENT_OPTIONS",
    requiredEvidence: ["option_symbol", "dte", "delta", "bid/ask", "chain freshness"],
    outputMetrics: ["no contract count", "chain stale count", "contract-ready rate"],
    minimumSample: 30,
    experimentType: "DATA_AUDIT",
  },
  {
    id: "calls-outperforming-puts",
    question: "Were calls outperforming puts?",
    exactRule: "DELIVERED_ALERT_PAPER outcomes split by CALL side versus PUT side",
    ownerFile: "lib/ai/nightly-summary.ts",
    pipeline: "DELIVERED_ALERT_PAPER",
    requiredEvidence: ["callsVsPuts.call.n", "callsVsPuts.put.n", "winRate", "avgReturnPct"],
    outputMetrics: ["call sample", "put sample", "win-rate difference", "return difference"],
    minimumSample: 10,
    experimentType: "OBSERVE_ONLY",
  },
  {
    id: "puts-outperforming-calls",
    question: "Were puts outperforming calls?",
    exactRule: "DELIVERED_ALERT_PAPER outcomes split by PUT side versus CALL side",
    ownerFile: "lib/ai/nightly-summary.ts",
    pipeline: "DELIVERED_ALERT_PAPER",
    requiredEvidence: ["callsVsPuts.put.n", "callsVsPuts.call.n", "winRate", "avgReturnPct"],
    outputMetrics: ["put sample", "call sample", "win-rate difference", "return difference"],
    minimumSample: 10,
    experimentType: "OBSERVE_ONLY",
  },
  {
    id: "premarket-rules",
    question: "Were premarket rules appropriate?",
    exactRule: "session-aware entry and watchlist handling before regular options open",
    ownerFile: "lib/trading-session.ts",
    pipeline: "INDEPENDENT_OPTIONS",
    requiredEvidence: ["session_state", "entry_state", "delivery decision", "outcome"],
    outputMetrics: ["premarket rejects", "market-open revalidation pass rate"],
    minimumSample: 20,
    experimentType: "SHADOW",
  },
  {
    id: "after-hours-rules",
    question: "Were after-hours rules appropriate?",
    exactRule: "closed-session guard that prevents executable option language after hours",
    ownerFile: "lib/trading-session.ts",
    pipeline: "INDEPENDENT_OPTIONS",
    requiredEvidence: ["session_state", "watchlist version", "delivery decision"],
    outputMetrics: ["after-hours watch count", "after-hours blocked send count"],
    minimumSample: 20,
    experimentType: "OBSERVE_ONLY",
  },
  {
    id: "exit-too-early",
    question: "Were exits occurring too early?",
    exactRule: "T1/T2/stop lifecycle and conservative exit grading",
    ownerFile: "lib/paper-lifecycle.ts",
    pipeline: "DELIVERED_ALERT_PAPER",
    requiredEvidence: ["terminalKind", "mfe_pct", "mae_pct", "return_pct", "target hits"],
    outputMetrics: ["MFE captured", "T1 rate", "T2 rate", "stop rate"],
    minimumSample: 20,
    experimentType: "SHADOW",
  },
  {
    id: "exit-too-late",
    question: "Were exits occurring too late?",
    exactRule: "stop/exit lifecycle and opportunity HIT with realized LOSS separation",
    ownerFile: "lib/paper-lifecycle.ts",
    pipeline: "DELIVERED_ALERT_PAPER",
    requiredEvidence: ["opportunityGrade", "terminalKind", "return_pct", "mfe_pct"],
    outputMetrics: ["signal-correct exit-failed count", "drawdown after target", "stop rate"],
    minimumSample: 20,
    experimentType: "SHADOW",
  },
];

export function listResearchQuestions(): ResearchQuestionDefinition[] {
  return RESEARCH_QUESTION_REGISTRY;
}
