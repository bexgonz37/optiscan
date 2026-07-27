/**
 * Ranked "Highest-quality setups now" for Command Center.
 * Derived from delivery decisions + READY alerts — never invents buy instructions.
 */

export type SystemAction = "SEND" | "WATCH" | "BLOCK" | "RESEARCH";

export interface RankedSetup {
  rank: number;
  symbol: string;
  side: "call" | "put" | string;
  contract: string | null;
  strategy: string | null;
  systemAction: SystemAction;
  confidenceScore: number | null;
  entryQualityState: string | null;
  riskLevel: "LOW" | "MED" | "HIGH" | "UNKNOWN";
  freshnessMs: number | null;
  freshnessLabel: string;
  entryZone: number | null;
  target: number | null;
  stop: number | null;
  reason: string | null;
  mainRisk: string | null;
  realExecutableQuote: boolean;
  alertId: string | null;
  opportunityCaseId: string | null;
  href: string;
  /** 0–100 signal strength (quality-derived). Not a win probability. */
  signalScore: number | null;
  /** READY | THIN | UNAVAILABLE — contract/quote readiness */
  contractReadiness: "READY" | "THIN" | "UNAVAILABLE";
  /** ENTRY state for UI strip */
  entryState: "ACTIONABLE" | "WAIT" | "BLOCK" | "UNKNOWN";
  /** Final action score 0–100 after contract/entry gates */
  actionScore: number | null;
  spreadPct: number | null;
  underlyingSpark: number[];
  premiumSpark: number[];
}

type RankDb = {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
};

function hasTable(db: RankDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function hasCol(db: RankDb, table: string, col: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.some((r) => r.name === col);
  } catch {
    return false;
  }
}

function actionFromOutcome(outcome: string | null, researchOnly: number | null, state: string | null): SystemAction {
  const o = String(outcome ?? "").toUpperCase();
  if (o.includes("DELIVER") || o === "SEND") return "SEND";
  if (o.includes("REJECT") || o.includes("BLOCK")) return "BLOCK";
  if (researchOnly === 1 || o.includes("RESEARCH")) return "RESEARCH";
  if (String(state ?? "").toUpperCase() === "READY") return "WATCH";
  return "WATCH";
}

function riskFromQuality(q: number | null, spreadPct: number | null): "LOW" | "MED" | "HIGH" | "UNKNOWN" {
  if (q == null && spreadPct == null) return "UNKNOWN";
  if ((q != null && q >= 0.75) && (spreadPct == null || spreadPct <= 8)) return "LOW";
  if ((q != null && q < 0.55) || (spreadPct != null && spreadPct > 15)) return "HIGH";
  return "MED";
}

function ageLabel(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "stale/unknown";
  if (ms < 15_000) return "live";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return "stale";
}

function scoreStates(input: {
  quality: number | null;
  executable: boolean;
  entry: number | null;
  systemAction: SystemAction;
  spreadPct: number | null;
}): Pick<RankedSetup, "signalScore" | "contractReadiness" | "entryState" | "actionScore"> {
  const signalScore =
    input.quality != null && Number.isFinite(input.quality)
      ? Math.round(Math.max(0, Math.min(1, input.quality)) * 100)
      : null;
  let contractReadiness: RankedSetup["contractReadiness"] = "UNAVAILABLE";
  if (input.executable) {
    contractReadiness = input.spreadPct != null && input.spreadPct > 12 ? "THIN" : "READY";
  }
  let entryState: RankedSetup["entryState"] = "UNKNOWN";
  if (input.systemAction === "BLOCK") entryState = "BLOCK";
  else if (!input.executable || input.entry == null) entryState = "WAIT";
  else if (input.systemAction === "SEND") entryState = "ACTIONABLE";
  else entryState = "WAIT";

  // Final action cannot stay high when contract/entry missing.
  let actionScore: number | null = signalScore;
  if (contractReadiness === "UNAVAILABLE") actionScore = signalScore == null ? null : Math.min(signalScore, 25);
  else if (contractReadiness === "THIN") actionScore = signalScore == null ? null : Math.min(signalScore, 45);
  if (entryState === "BLOCK") actionScore = Math.min(actionScore ?? 0, 15);
  if (entryState === "WAIT" && actionScore != null) actionScore = Math.min(actionScore, 55);
  if (input.systemAction === "SEND" && contractReadiness === "READY" && signalScore != null) {
    actionScore = Math.max(actionScore ?? 0, Math.round(signalScore * 0.9));
  }
  return { signalScore, contractReadiness, entryState, actionScore };
}

/** Pull recent underlying prints from alerts — DB cache only, no Massive. */
function underlyingSparkFromDb(db: RankDb, symbol: string): number[] {
  if (!hasTable(db, "options_alerts")) return [];
  try {
    const rows = db.prepare(
      `SELECT delivered_underlying p FROM options_alerts
       WHERE candidate_symbol=? AND delivered_underlying IS NOT NULL
       ORDER BY COALESCE(sent_at_ms, updated_at_ms) ASC LIMIT 24`,
    ).all(symbol) as { p: number }[];
    return rows.map((r) => Number(r.p)).filter(Number.isFinite);
  } catch {
    return [];
  }
}

/** Premium path from paper marks for a contract — DB only. */
function premiumSparkFromDb(db: RankDb, contract: string | null, alertId: string | null): number[] {
  if (!hasTable(db, "options_paper_marks")) return [];
  try {
    if (alertId && hasTable(db, "options_paper_trades")) {
      const trade = db.prepare(
        `SELECT id FROM options_paper_trades WHERE alert_id=? ORDER BY id DESC LIMIT 1`,
      ).get(alertId) as { id: number } | undefined;
      if (trade?.id != null) {
        const marks = db.prepare(
          `SELECT COALESCE(exit_fill, (bid+ask)/2.0) m FROM options_paper_marks
           WHERE trade_id=? ORDER BY mark_at_ms ASC LIMIT 24`,
        ).all(trade.id) as { m: number }[];
        const vals = marks.map((r) => Number(r.m)).filter(Number.isFinite);
        if (vals.length >= 2) return vals;
      }
    }
    if (contract) {
      const marks = db.prepare(
        `SELECT COALESCE(exit_fill, (bid+ask)/2.0) m FROM options_paper_marks
         WHERE option_symbol=? ORDER BY mark_at_ms ASC LIMIT 24`,
      ).all(contract) as { m: number }[];
      return marks.map((r) => Number(r.m)).filter(Number.isFinite);
    }
  } catch { /* */ }
  return [];
}

function parseComponents(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw)) as Record<string, unknown>; } catch { return {}; }
}

/**
 * Build ranked setups from recent delivery decisions + READY alerts.
 * Prefer decisions with quality; fall back to READY alerts. Cap at `limit`.
 */
export function buildRankedSetupsNow(db: RankDb, nowMs = Date.now(), limit = 12): RankedSetup[] {
  const out: RankedSetup[] = [];
  const since = nowMs - 4 * 3600_000;

  if (hasTable(db, "options_delivery_decisions")) {
    const rows = db.prepare(
      `SELECT id, symbol, strategy, side, outcome, reason, quality, rank, alert_id, components_json, created_at_ms,
              final_delivery_outcome, final_delivery_reason
       FROM options_delivery_decisions
       WHERE created_at_ms >= ?
       ORDER BY COALESCE(quality, 0) DESC, created_at_ms DESC
       LIMIT 40`,
    ).all(since) as Record<string, unknown>[];

    for (const r of rows) {
      const comps = parseComponents(r.components_json);
      const quality = r.quality != null ? Number(r.quality) : null;
      const spread = comps.spreadPct != null ? Number(comps.spreadPct) : (comps.spread_pct != null ? Number(comps.spread_pct) : null);
      const bid = comps.bid != null ? Number(comps.bid) : null;
      const ask = comps.ask != null ? Number(comps.ask) : null;
      const entry = comps.entryMid != null ? Number(comps.entryMid) : (comps.entry_mid != null ? Number(comps.entry_mid) : null);
      const target = comps.targetT1 != null ? Number(comps.targetT1) : (comps.t1 != null ? Number(comps.t1) : null);
      const stop = comps.targetStop != null ? Number(comps.targetStop) : (comps.stop != null ? Number(comps.stop) : null);
      const contract = comps.optionSymbol != null ? String(comps.optionSymbol) : (comps.option_symbol != null ? String(comps.option_symbol) : null);
      const alertId = r.alert_id != null ? String(r.alert_id) : null;
      let opportunityCaseId: string | null = null;
      let alertEntry: number | null = entry;
      let alertTarget: number | null = target;
      let alertStop: number | null = stop;
      let alertContract = contract;
      let entryQuality: string | null = comps.entryQuality != null ? String(comps.entryQuality) : null;
      if (alertId && hasTable(db, "options_alerts")) {
        try {
          const a = db.prepare(
            `SELECT opportunity_case_id, entry_mid, target_t1, target_stop, option_symbol, research_only, state
             FROM options_alerts WHERE alert_id=?`,
          ).get(alertId) as Record<string, unknown> | undefined;
          if (a) {
            opportunityCaseId = a.opportunity_case_id != null ? String(a.opportunity_case_id) : null;
            alertEntry = alertEntry ?? (a.entry_mid != null ? Number(a.entry_mid) : null);
            alertTarget = alertTarget ?? (a.target_t1 != null ? Number(a.target_t1) : null);
            alertStop = alertStop ?? (a.target_stop != null ? Number(a.target_stop) : null);
            alertContract = alertContract ?? (a.option_symbol != null ? String(a.option_symbol) : null);
          }
        } catch { /* optional cols */ }
      }
      const freshnessMs = r.created_at_ms != null ? Math.max(0, nowMs - Number(r.created_at_ms)) : null;
      const systemAction = actionFromOutcome(
        String(r.final_delivery_outcome ?? r.outcome ?? ""),
        null,
        null,
      );
      const href = opportunityCaseId
        ? `/intelligence/${encodeURIComponent(opportunityCaseId)}`
        : alertId
          ? `/callouts?alert=${encodeURIComponent(alertId)}`
          : `/pipeline-health?symbol=${encodeURIComponent(String(r.symbol ?? ""))}`;

      const executable = Boolean(alertContract && ((bid != null && ask != null && bid > 0 && ask > 0) || alertEntry != null));
      const states = scoreStates({
        quality,
        executable,
        entry: alertEntry,
        systemAction,
        spreadPct: spread,
      });

      out.push({
        rank: 0,
        symbol: String(r.symbol ?? "—").toUpperCase(),
        side: String(r.side ?? "call").toLowerCase() === "put" ? "put" : "call",
        contract: alertContract,
        strategy: r.strategy != null ? String(r.strategy) : null,
        systemAction,
        confidenceScore: quality != null && Number.isFinite(quality) ? +quality.toFixed(3) : null,
        entryQualityState: entryQuality ?? (quality != null ? (quality >= 0.7 ? "PASS" : quality >= 0.55 ? "MARGINAL" : "FAIL") : null),
        riskLevel: riskFromQuality(quality, spread),
        freshnessMs,
        freshnessLabel: ageLabel(freshnessMs),
        entryZone: alertEntry,
        target: alertTarget,
        stop: alertStop,
        reason: r.final_delivery_reason != null ? String(r.final_delivery_reason) : (r.reason != null ? String(r.reason) : null),
        mainRisk: spread != null && spread > 10 ? `Wide spread ${spread.toFixed(1)}%` : (systemAction === "BLOCK" ? "Blocked by gate" : "Premium decay / chase"),
        realExecutableQuote: executable,
        alertId,
        opportunityCaseId,
        href,
        ...states,
        spreadPct: spread,
        underlyingSpark: underlyingSparkFromDb(db, String(r.symbol ?? "").toUpperCase()),
        premiumSpark: premiumSparkFromDb(db, alertContract, alertId),
      });
    }
  }

  // Supplement with READY alerts not already represented.
  if (hasTable(db, "options_alerts") && out.length < limit) {
    const seen = new Set(out.map((s) => s.alertId).filter(Boolean));
    const readySql = hasCol(db, "options_alerts", "opportunity_case_id")
      ? `SELECT alert_id, candidate_symbol, strategy, side, option_symbol, state, research_only,
                entry_mid, target_t1, target_stop, opportunity_case_id, created_at_ms, updated_at_ms
         FROM options_alerts WHERE state='READY' AND created_at_ms >= ? ORDER BY updated_at_ms DESC LIMIT 20`
      : `SELECT alert_id, candidate_symbol, strategy, side, option_symbol, state, research_only,
                entry_mid, target_t1, target_stop, created_at_ms, updated_at_ms
         FROM options_alerts WHERE state='READY' AND created_at_ms >= ? ORDER BY updated_at_ms DESC LIMIT 20`;
    try {
      const rows = db.prepare(readySql).all(since) as Record<string, unknown>[];
      for (const a of rows) {
        const id = String(a.alert_id);
        if (seen.has(id)) continue;
        const freshnessMs = a.updated_at_ms != null ? Math.max(0, nowMs - Number(a.updated_at_ms)) : null;
        const researchOnly = Number(a.research_only ?? 0);
        const opp = a.opportunity_case_id != null ? String(a.opportunity_case_id) : null;
        const systemAction = actionFromOutcome(null, researchOnly, String(a.state));
        const entry = a.entry_mid != null ? Number(a.entry_mid) : null;
        const executable = Boolean(a.option_symbol && entry != null);
        const states = scoreStates({
          quality: null,
          executable,
          entry,
          systemAction,
          spreadPct: null,
        });
        out.push({
          rank: 0,
          symbol: String(a.candidate_symbol ?? "—").toUpperCase(),
          side: String(a.side ?? "call").toLowerCase() === "put" ? "put" : "call",
          contract: a.option_symbol != null ? String(a.option_symbol) : null,
          strategy: a.strategy != null ? String(a.strategy) : null,
          systemAction,
          confidenceScore: null,
          entryQualityState: "READY",
          riskLevel: "UNKNOWN",
          freshnessMs,
          freshnessLabel: ageLabel(freshnessMs),
          entryZone: entry,
          target: a.target_t1 != null ? Number(a.target_t1) : null,
          stop: a.target_stop != null ? Number(a.target_stop) : null,
          reason: researchOnly ? "Research lane — not subscriber deliver" : "READY — awaiting portfolio selection",
          mainRisk: "Timing / liquidity",
          realExecutableQuote: executable,
          alertId: id,
          opportunityCaseId: opp,
          href: opp ? `/intelligence/${encodeURIComponent(opp)}` : `/callouts?alert=${encodeURIComponent(id)}`,
          ...states,
          spreadPct: null,
          underlyingSpark: underlyingSparkFromDb(db, String(a.candidate_symbol ?? "").toUpperCase()),
          premiumSpark: premiumSparkFromDb(db, a.option_symbol != null ? String(a.option_symbol) : null, id),
        });
      }
    } catch { /* schema drift */ }
  }

  // Sort: SEND first, then by confidence, then freshness.
  const actionRank: Record<SystemAction, number> = { SEND: 0, WATCH: 1, RESEARCH: 2, BLOCK: 3 };
  out.sort((a, b) => {
    const ar = actionRank[a.systemAction] - actionRank[b.systemAction];
    if (ar !== 0) return ar;
    const cq = (b.confidenceScore ?? -1) - (a.confidenceScore ?? -1);
    if (cq !== 0) return cq;
    return (a.freshnessMs ?? 1e15) - (b.freshnessMs ?? 1e15);
  });

  return out.slice(0, limit).map((s, i) => ({ ...s, rank: i + 1 }));
}
