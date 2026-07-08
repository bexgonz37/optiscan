/**
 * meta-bar.ts — META #436 reference profile + UI checklist (display/ranking only).
 * Does not change capture math; mirrors callout-quality thresholds for transparency.
 */

export const META_REFERENCE = {
  ticker: "META",
  alertId: 436,
  setup: 93,
  speed: 0.35,
  surge: 4.0,
  moveStatus: "early",
  worth: 90,
  contract: 90,
  liquidity: 81,
  sideGap: 42,
  efficiency: 0.45,
  note: "Audit winner: +0.78% stock @5m, +82% option mid, TRADE, zero blockers",
} as const;

export function goldTradeThresholds() {
  return {
    minSetup: Number(process.env.GOLD_TRADE_MIN_SETUP ?? 84),
    minSpeed: Number(process.env.GOLD_TRADE_MIN_SPEED ?? 0.22),
    minSurge: Number(process.env.GOLD_TRADE_MIN_SURGE ?? 2.2),
    minWorth: Number(process.env.GOLD_TRADE_MIN_WORTH ?? 76),
    minContract: Number(process.env.GOLD_TRADE_MIN_CONTRACT ?? 68),
    minLiquidity: Number(process.env.GOLD_TRADE_MIN_LIQUIDITY ?? 60),
    minSideGap: Number(process.env.GOLD_TRADE_MIN_SIDE_GAP ?? 18),
    minEfficiency: 0.28,
  };
}

export interface MetaBarRow {
  key: string;
  label: string;
  pass: boolean;
  actual: string;
  target: string;
}

function parseBreakdown(a: {
  score_breakdown_json?: string | null;
  long_call_score?: number | null;
  long_put_score?: number | null;
}): Record<string, unknown> {
  if (!a.score_breakdown_json) return {};
  try {
    return JSON.parse(a.score_breakdown_json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function sideGapFromAlert(a: {
  direction?: string | null;
  long_call_score?: number | null;
  long_put_score?: number | null;
}): number {
  const call = Number(a.long_call_score ?? 0);
  const put = Number(a.long_put_score ?? 0);
  if (a.direction === "bearish") return put - call;
  if (a.direction === "bullish") return call - put;
  return Math.abs(call - put);
}

/** Fast-mover shape like META #436 — strong speed + volume even if capture tier is WAIT. */
export function isMetaShapedAlert(a: {
  asset_class?: string | null;
  signal_score?: number | null;
  short_rate_at_alert?: number | null;
  volume_surge_at_alert?: number | null;
  move_status?: string | null;
  entry_spread_pct?: number | null;
  zero_dte_contract_score?: number | null;
  option_worth_score?: number | null;
} | null | undefined): boolean {
  if (!a || a.asset_class === "stock") return false;
  const t = goldTradeThresholds();
  const speed = Math.abs(Number(a.short_rate_at_alert ?? 0));
  const surge = Number(a.volume_surge_at_alert ?? 0);
  const setup = Number(a.signal_score ?? 0);
  const spread = a.entry_spread_pct;
  const moveOk = !a.move_status || !["exhausted", "extended_risky"].includes(a.move_status);
  return (
    speed >= t.minSpeed
    && surge >= t.minSurge
    && setup >= t.minSetup - 4
    && moveOk
    && (spread == null || spread <= 5)
  );
}

/** Rank fresher alerts — META-shaped and TRADE float to the hero. */
export function rankAlertForHero(a: {
  capture_action?: string | null;
  signal_score?: number | null;
  short_rate_at_alert?: number | null;
  volume_surge_at_alert?: number | null;
  entry_spread_pct?: number | null;
  asset_class?: string | null;
  ticker?: string | null;
  move_status?: string | null;
  option_worth_score?: number | null;
  zero_dte_contract_score?: number | null;
}): number {
  let score = Number(a.signal_score ?? 0);
  if (String(a.capture_action ?? "").toUpperCase() === "TRADE") score += 120;
  if (isMetaShapedAlert(a)) score += 80;
  const speed = Math.abs(Number(a.short_rate_at_alert ?? 0));
  const surge = Number(a.volume_surge_at_alert ?? 0);
  if (speed >= META_REFERENCE.speed * 0.85) score += 40;
  if (surge >= META_REFERENCE.surge * 0.85) score += 30;
  if (a.entry_spread_pct != null && a.entry_spread_pct <= 3) score += 15;
  return score;
}

export function metaBarChecklist(a: {
  signal_score?: number | null;
  short_rate_at_alert?: number | null;
  volume_surge_at_alert?: number | null;
  move_status?: string | null;
  option_worth_score?: number | null;
  zero_dte_contract_score?: number | null;
  options_liquidity_score?: number | null;
  direction?: string | null;
  long_call_score?: number | null;
  long_put_score?: number | null;
  entry_spread_pct?: number | null;
  score_breakdown_json?: string | null;
  capture_action?: string | null;
} | null | undefined): MetaBarRow[] {
  if (!a) return [];
  const t = goldTradeThresholds();
  const bd = parseBreakdown(a);
  const speed = Math.abs(Number(a.short_rate_at_alert ?? 0));
  const surge = Number(a.volume_surge_at_alert ?? 0);
  const setup = Number(a.signal_score ?? 0);
  const worth = Number(a.option_worth_score ?? 0);
  const contract = Number(a.zero_dte_contract_score ?? 0);
  const liq = Number(a.options_liquidity_score ?? 0);
  const gap = sideGapFromAlert(a);
  const spread = a.entry_spread_pct;
  const goldFailures = Array.isArray(bd.goldFailures) ? (bd.goldFailures as string[]) : [];
  const blockers = Array.isArray(bd.tradeBlockers) ? (bd.tradeBlockers as string[]) : [];

  const rows: MetaBarRow[] = [
    {
      key: "speed",
      label: "Speed",
      pass: speed >= t.minSpeed,
      actual: `${speed.toFixed(2)}%/min`,
      target: `≥ ${t.minSpeed} (META ${META_REFERENCE.speed})`,
    },
    {
      key: "surge",
      label: "Volume surge",
      pass: surge >= t.minSurge,
      actual: `${surge.toFixed(1)}×`,
      target: `≥ ${t.minSurge}× (META ${META_REFERENCE.surge}×)`,
    },
    {
      key: "setup",
      label: "Setup score",
      pass: setup >= t.minSetup,
      actual: `${Math.round(setup)}/100`,
      target: `≥ ${t.minSetup} (META ${META_REFERENCE.setup})`,
    },
    {
      key: "worth",
      label: "Worth-it",
      pass: worth >= t.minWorth,
      actual: `${Math.round(worth)}/100`,
      target: `≥ ${t.minWorth}`,
    },
    {
      key: "contract",
      label: "Contract",
      pass: contract >= t.minContract,
      actual: `${Math.round(contract)}/100`,
      target: `≥ ${t.minContract}`,
    },
    {
      key: "spread",
      label: "Spread",
      pass: spread == null || spread <= 5,
      actual: spread != null ? `${Number(spread).toFixed(1)}%` : "—",
      target: "≤ 5% fillable",
    },
    {
      key: "gap",
      label: "Side conviction",
      pass: gap >= t.minSideGap,
      actual: `${Math.round(gap)} pts`,
      target: `≥ ${t.minSideGap} (META ~${META_REFERENCE.sideGap})`,
    },
    {
      key: "move",
      label: "Move phase",
      pass: !a.move_status || !["exhausted", "extended_risky"].includes(a.move_status),
      actual: a.move_status ?? "—",
      target: "early / continuing / tradable",
    },
  ];

  if (goldFailures.length) {
    rows.push({
      key: "gold",
      label: "META bar miss",
      pass: false,
      actual: goldFailures[0] ?? "below TRADE bar",
      target: "all gates green → BUY CALL/PUT",
    });
  }
  if (blockers.length) {
    rows.push({
      key: "blocker",
      label: "Order gate",
      pass: false,
      actual: blockers[0] ?? "blocked",
      target: "clear for TRADE tier",
    });
  }
  if (String(a.capture_action ?? "").toUpperCase() === "TRADE") {
    rows.push({
      key: "trade",
      label: "Capture tier",
      pass: true,
      actual: "TRADE · BUY CALL/PUT",
      target: "META-grade",
    });
  }

  return rows;
}

export function metaBarPassCount(rows: MetaBarRow[]): { pass: number; total: number } {
  const core = rows.filter((r) => !["gold", "blocker", "trade"].includes(r.key));
  return {
    pass: core.filter((r) => r.pass).length,
    total: core.length,
  };
}
