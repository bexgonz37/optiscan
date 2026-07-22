/**
 * Evidence Learning Engine.
 *
 * Deterministic, advisory-only learning surface over completed OptiScan evidence.
 * It materializes completed delivered/research option mirrors and replay labels into
 * durable examples, then aggregates long-term patterns. Nothing here is imported by
 * live scanners, strategy gates, thresholds, or Discord delivery.
 */

type Row = Record<string, any>;

export interface EvidenceDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run: (...a: any[]) => { changes?: number; lastInsertRowid?: number | bigint };
  };
}

export interface EvidenceLearningRefresh {
  status: "OK" | "SKIPPED";
  examplesMaterialized: number;
  patternsMaterialized: number;
  sourceWatermark: number;
  skippedReason?: string;
}

export interface EvidenceLearningSnapshot {
  available: boolean;
  advisoryOnly: true;
  productionAuthority: "none";
  examples: {
    total: number;
    delivered: number;
    researchOnly: number;
    replayUnderlyingForward: number;
    latestCompletedAtMs: number | null;
  };
  patterns: {
    total: number;
    actionableRecommendations: number;
    byConfidence: Record<string, number>;
    top: Row[];
  };
  missingFields: Record<string, number>;
  disclaimer: string;
}

const EXAMPLE_INSERT = `
INSERT INTO evidence_learning_examples
  (source_kind, source_table, source_id, source_ref, audience, symbol, sector, strategy, side,
   time_bucket, market_regime, spy_direction, qqq_direction, relative_volume, vwap_distance_pct,
   level_interactions_json, quality_score, quality_band, trigger_reason, trigger_components_json,
   feature_json, option_spread_pct, liquidity, contract_symbol, entry_price, target_price, stop_price,
   mfe_pct, mae_pct, final_return_pct, final_outcome, time_to_outcome_ms, grading_basis,
   missing_fields_json, completed_at_ms, created_at_ms, updated_at_ms)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(source_kind, source_id) DO UPDATE SET
  source_ref=excluded.source_ref,
  audience=excluded.audience,
  sector=excluded.sector,
  time_bucket=excluded.time_bucket,
  market_regime=excluded.market_regime,
  spy_direction=excluded.spy_direction,
  qqq_direction=excluded.qqq_direction,
  relative_volume=excluded.relative_volume,
  vwap_distance_pct=excluded.vwap_distance_pct,
  level_interactions_json=excluded.level_interactions_json,
  quality_score=excluded.quality_score,
  quality_band=excluded.quality_band,
  trigger_reason=excluded.trigger_reason,
  trigger_components_json=excluded.trigger_components_json,
  feature_json=excluded.feature_json,
  option_spread_pct=excluded.option_spread_pct,
  liquidity=excluded.liquidity,
  entry_price=excluded.entry_price,
  target_price=excluded.target_price,
  stop_price=excluded.stop_price,
  mfe_pct=excluded.mfe_pct,
  mae_pct=excluded.mae_pct,
  final_return_pct=excluded.final_return_pct,
  final_outcome=excluded.final_outcome,
  time_to_outcome_ms=excluded.time_to_outcome_ms,
  grading_basis=excluded.grading_basis,
  missing_fields_json=excluded.missing_fields_json,
  completed_at_ms=excluded.completed_at_ms,
  updated_at_ms=excluded.updated_at_ms`;

function tableExists(db: EvidenceDb, table: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(table)); } catch { return false; }
}

function cols(db: EvidenceDb, table: string): Set<string> {
  try { return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((r) => String(r.name))); } catch { return new Set(); }
}

function parseJson(s: any): any {
  try { return s ? JSON.parse(String(s)) : null; } catch { return null; }
}

function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v: number | null, places = 4): number | null {
  return v == null ? null : +v.toFixed(places);
}

function occUnderlying(occ: string | null | undefined): string | null {
  const m = String(occ ?? "").match(/^O:([A-Z]+)/);
  return m ? m[1] : null;
}

function etParts(ms: number | null): { hour: number | null; minute: number | null } {
  if (ms == null || !Number.isFinite(ms)) return { hour: null, minute: null };
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(ms)) p[part.type] = part.value;
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  return { hour: Number.isFinite(hour) ? hour : null, minute: Number.isFinite(minute) ? minute : null };
}

export function timeBucket(ms: number | null): string | null {
  const { hour, minute } = etParts(ms);
  if (hour == null || minute == null) return null;
  const m = hour * 60 + minute;
  if (m >= 9 * 60 + 30 && m < 9 * 60 + 50) return "09:30-09:50";
  if (m >= 9 * 60 + 50 && m < 10 * 60 + 20) return "09:50-10:20";
  if (m >= 10 * 60 + 20 && m < 12 * 60) return "10:20-12:00";
  if (m >= 12 * 60 && m < 15 * 60) return "12:00-15:00";
  if (m >= 15 * 60 && m < 16 * 60) return "15:00-16:00";
  return "outside-rth";
}

export function qualityBand(q: number | null): string | null {
  if (q == null) return null;
  if (q < 0.45) return "q<0.45";
  if (q < 0.55) return "0.45-0.55";
  if (q < 0.62) return "0.55-0.62";
  if (q < 0.70) return "0.62-0.70";
  if (q < 0.80) return "0.70-0.80";
  if (q < 0.90) return "0.80-0.90";
  return "q>=0.90";
}

function finalOutcome(returnPct: number | null): string {
  if (returnPct == null) return "UNGRADABLE";
  if (returnPct > 0) return "WIN";
  if (returnPct < 0) return "LOSS";
  return "BREAKEVEN";
}

function pickFeature(feature: any, ...paths: string[]): number | null {
  for (const path of paths) {
    let cur = feature;
    for (const key of path.split(".")) cur = cur?.[key];
    const n = num(cur);
    if (n != null) return n;
  }
  return null;
}

function levelInteractions(feature: any): Record<string, unknown> {
  const u = feature?.underlying ?? feature ?? {};
  return {
    aboveVwap: u.aboveVwap ?? null,
    hodBreak: u.hodBreak ?? null,
    nearResistancePct: u.nearResistancePct ?? null,
    compressionPct: u.compressionPct ?? null,
    openingRange: u.openingRange ?? null,
    premarketLevelTest: u.premarketLevelTest ?? null,
    fractionMove: feature?.fractionMove ?? null,
    earlinessPhase: feature?.earlinessPhase ?? null,
  };
}

function marketContext(db: EvidenceDb, symbol: string | null, atMs: number | null): Row {
  if (!symbol || atMs == null || !tableExists(db, "market_context_shadow")) return {};
  try {
    return db.prepare(
      "SELECT sector, regime, spy_trend, qqq_trend FROM market_context_shadow WHERE symbol=? AND as_of_ms<=? ORDER BY as_of_ms DESC LIMIT 1",
    ).get(symbol, atMs) ?? {};
  } catch { return {}; }
}

function decisionContext(db: EvidenceDb, p: Row, symbol: string | null): Row | null {
  if (!tableExists(db, "options_delivery_decisions")) return null;
  try {
    if (p.alert_id) {
      const byAlert = db.prepare("SELECT * FROM options_delivery_decisions WHERE alert_id=? ORDER BY created_at_ms DESC LIMIT 1").get(p.alert_id);
      if (byAlert) return byAlert;
    }
    if (symbol && p.strategy && p.entered_at_ms != null) {
      return db.prepare(
        `SELECT * FROM options_delivery_decisions
          WHERE symbol=? AND strategy=? AND created_at_ms BETWEEN ? AND ?
          ORDER BY ABS(created_at_ms - ?) ASC LIMIT 1`,
      ).get(symbol, p.strategy, p.entered_at_ms - 10 * 60_000, p.entered_at_ms + 10 * 60_000, p.entered_at_ms) ?? null;
    }
  } catch { return null; }
  return null;
}

function paperSelect(db: EvidenceDb): string {
  const c = cols(db, "options_paper_trades");
  const field = (name: string) => c.has(name) ? name : `NULL AS ${name}`;
  return [
    "id", "option_symbol", "side", "strike", "expiration", "dte", "result_class", "bid", "ask", "mid",
    "spread_pct", "entry_fill", "volume", "open_interest", "iv", "delta", "underlying_price",
    "strategy", "target", "invalidation", "provenance", "status", "exit_fill", "pnl", "return_pct",
    field("mfe_pct"), field("mae_pct"), "exit_reason", "entered_at_ms", "exit_at_ms", field("session"),
    field("core_broad"), field("feature_snapshot_json"), field("paper_kind"), field("alert_id"),
    field("entry_source"), "created_at_ms", "updated_at_ms",
  ].join(", ");
}

function missingMap(fields: Record<string, unknown>): string[] {
  return Object.entries(fields).filter(([, v]) => v == null || v === "").map(([k]) => k).sort();
}

function materializePaperExamples(db: EvidenceDb, nowMs: number, limit: number): number {
  if (!tableExists(db, "options_paper_trades")) return 0;
  const rows = db.prepare(
    `SELECT ${paperSelect(db)} FROM options_paper_trades
      WHERE status='EXITED' AND result_class='REAL_OPTION_PAPER'
        AND COALESCE(paper_kind,'LEGACY_UNCLASSIFIED') IN ('DELIVERED_ALERT_PAPER','RESEARCH_ONLY_PAPER')
        AND NOT EXISTS (
          SELECT 1 FROM evidence_learning_examples e
           WHERE e.source_kind=CASE
             WHEN COALESCE(options_paper_trades.paper_kind,'')='DELIVERED_ALERT_PAPER' THEN 'delivered_alert'
             ELSE 'research_only'
           END
             AND e.source_id=CAST(options_paper_trades.id AS TEXT)
        )
      ORDER BY COALESCE(exit_at_ms, updated_at_ms, created_at_ms) ASC LIMIT ?`,
  ).all(limit) as Row[];
  let count = 0;
  const insert = db.prepare(EXAMPLE_INSERT);
  for (const p of rows) {
    const symbol = occUnderlying(p.option_symbol);
    const feature = parseJson(p.feature_snapshot_json) ?? {};
    const decision = decisionContext(db, p, symbol);
    const mctx = marketContext(db, symbol, p.entered_at_ms ?? p.created_at_ms);
    const q = num(decision?.quality);
    const relVol = pickFeature(feature, "underlying.relVolume", "relVolume");
    const vwapDist = pickFeature(feature, "underlying.vwapDistPct", "vwapDistPct");
    const returnPct = num(p.return_pct);
    const audience = p.paper_kind === "DELIVERED_ALERT_PAPER" ? "DELIVERED" : "RESEARCH_ONLY";
    const components = parseJson(decision?.components_json) ?? {};
    const levels = levelInteractions(feature);
    const missing = missingMap({
      sector: mctx.sector,
      marketRegime: mctx.regime,
      spyDirection: mctx.spy_trend,
      qqqDirection: mctx.qqq_trend,
      qualityScore: q,
      relativeVolume: relVol,
      vwapDistancePct: vwapDist,
      mfePct: p.mfe_pct,
      maePct: p.mae_pct,
    });
    insert.run(
      audience === "DELIVERED" ? "delivered_alert" : "research_only",
      "options_paper_trades",
      String(p.id),
      p.alert_id ?? p.option_symbol ?? null,
      audience,
      symbol,
      mctx.sector ?? null,
      p.strategy ?? null,
      p.side ?? null,
      timeBucket(num(p.entered_at_ms)),
      mctx.regime ?? null,
      mctx.spy_trend ?? null,
      mctx.qqq_trend ?? null,
      round(relVol),
      round(vwapDist),
      JSON.stringify(levels),
      round(q),
      qualityBand(q),
      decision?.reason ?? p.exit_reason ?? null,
      JSON.stringify({ decisionComponents: components, levelInteractions: levels }),
      JSON.stringify(feature),
      round(num(p.spread_pct)),
      round(num(p.open_interest) ?? num(p.volume)),
      p.option_symbol ?? null,
      round(num(p.entry_fill)),
      round(num(p.target)),
      round(num(p.invalidation)),
      round(num(p.mfe_pct)),
      round(num(p.mae_pct)),
      round(returnPct),
      finalOutcome(returnPct),
      p.entered_at_ms != null && p.exit_at_ms != null ? Math.max(0, Number(p.exit_at_ms) - Number(p.entered_at_ms)) : null,
      "REAL_OPTION_PAPER",
      JSON.stringify(missing),
      p.exit_at_ms ?? p.updated_at_ms ?? p.created_at_ms ?? null,
      nowMs,
      nowMs,
    );
    count += 1;
  }
  return count;
}

function materializeReplayExamples(db: EvidenceDb, nowMs: number, limit: number): number {
  if (!tableExists(db, "options_replay_candidates")) return 0;
  const rows = db.prepare(
    `SELECT id, run_id, t_ms, symbol, strategy, side, research_only, quality, strategy_score,
            matched_signals, required_signals, fraction_move, hour_et, fwd60_pct, grading_basis, created_at_ms
       FROM options_replay_candidates
      WHERE fwd60_pct IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM evidence_learning_examples e
           WHERE e.source_kind='historical_replay'
             AND e.source_id=CAST(options_replay_candidates.id AS TEXT)
        )
      ORDER BY id ASC LIMIT ?`,
  ).all(limit) as Row[];
  let count = 0;
  const insert = db.prepare(EXAMPLE_INSERT);
  for (const r of rows) {
    const ret = num(r.fwd60_pct);
    const q = num(r.quality);
    const components = {
      strategyScore: num(r.strategy_score),
      matchedSignals: num(r.matched_signals),
      requiredSignals: num(r.required_signals),
      fractionMove: num(r.fraction_move),
      hourEt: num(r.hour_et),
    };
    insert.run(
      "historical_replay",
      "options_replay_candidates",
      String(r.id),
      `replay:${r.run_id}`,
      "REPLAY_UNDERLYING_FORWARD",
      r.symbol ?? null,
      null,
      r.strategy ?? null,
      r.side ?? null,
      timeBucket(num(r.t_ms)),
      null,
      null,
      null,
      null,
      null,
      JSON.stringify({ fractionMove: components.fractionMove }),
      round(q),
      qualityBand(q),
      "production detection replay candidate",
      JSON.stringify(components),
      JSON.stringify(components),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      round(ret),
      finalOutcome(ret),
      60 * 60_000,
      r.grading_basis ?? "UNDERLYING_FORWARD",
      JSON.stringify(["sector", "marketRegime", "optionSpreadPct", "liquidity", "contractSymbol", "entryPrice", "mfePct", "maePct"]),
      r.t_ms ?? r.created_at_ms ?? null,
      nowMs,
      nowMs,
    );
    count += 1;
  }
  return count;
}

interface ExampleRow {
  id: number; audience: string; strategy: string | null; side: string | null; time_bucket: string | null;
  quality_band: string | null; relative_volume: number | null; vwap_distance_pct: number | null;
  level_interactions_json: string | null; final_return_pct: number | null; final_outcome: string | null;
}

function stats(rows: ExampleRow[]) {
  const returns = rows.map((r) => num(r.final_return_pct)).filter((x): x is number => x != null);
  const wins = returns.filter((x) => x > 0).length;
  const losses = returns.length - wins;
  const sum = returns.reduce((a, x) => a + x, 0);
  return {
    n: rows.length,
    observed: returns.length,
    wins,
    losses,
    winRate: returns.length ? round(wins / returns.length) : null,
    avgReturnPct: returns.length ? round(sum / returns.length) : null,
  };
}

function confidence(n: number, lift: number | null): "LOW" | "MEDIUM" | "HIGH" {
  if (n >= 100 && lift != null && Math.abs(lift) >= 0.08) return "HIGH";
  if (n >= 30 && lift != null && Math.abs(lift) >= 0.05) return "MEDIUM";
  return "LOW";
}

function overfittingRisk(n: number): "HIGH" | "MEDIUM" | "LOW" {
  if (n < 30) return "HIGH";
  if (n < 100) return "MEDIUM";
  return "LOW";
}

function recommendation(label: string, s: ReturnType<typeof stats>, base: ReturnType<typeof stats>, minSample: number) {
  const lift = s.winRate != null && base.winRate != null ? round(s.winRate - base.winRate) : null;
  const enough = s.observed >= minSample;
  if (!enough) return { type: "OBSERVE", text: `Keep collecting evidence for ${label}; sample ${s.observed} is below the ${minSample} minimum.`, lift };
  if (lift != null && lift <= -0.08) return { type: "INVESTIGATE_REDUCE_CONFIDENCE", text: `Human review recommended: ${label} is underperforming the evidence baseline. Do not change production automatically.`, lift };
  if (lift != null && lift >= 0.08) return { type: "INVESTIGATE_INCREASE_CONFIDENCE", text: `Human review recommended: ${label} is outperforming the evidence baseline. Validate with replay/shadow before any production change.`, lift };
  return { type: "OBSERVE", text: `${label} is near the current evidence baseline; no production change is supported.`, lift };
}

function addGroup(groups: Map<string, { kind: string; label: string; rows: ExampleRow[] }>, kind: string, label: string, rows: ExampleRow[]) {
  if (rows.length) groups.set(`${kind}|${label}`, { kind, label, rows });
}

function componentGroups(rows: ExampleRow[], groups: Map<string, { kind: string; label: string; rows: ExampleRow[] }>) {
  addGroup(groups, "trigger_component", "relative_volume>=2", rows.filter((r) => (r.relative_volume ?? 0) >= 2));
  addGroup(groups, "trigger_component", "vwap_extension>2pct", rows.filter((r) => Math.abs(r.vwap_distance_pct ?? 0) > 2));
  addGroup(groups, "trigger_component", "near_vwap<=0.5pct", rows.filter((r) => Math.abs(r.vwap_distance_pct ?? 999) <= 0.5));
  addGroup(groups, "trigger_component", "hod_break", rows.filter((r) => parseJson(r.level_interactions_json)?.hodBreak === true));
  addGroup(groups, "trigger_component", "opening_range", rows.filter((r) => parseJson(r.level_interactions_json)?.openingRange === true));
}

function rebuildPatterns(db: EvidenceDb, nowMs: number, minSample: number): number {
  const rows = db.prepare(
    `SELECT id, audience, strategy, side, time_bucket, quality_band, relative_volume, vwap_distance_pct,
            level_interactions_json, final_return_pct, final_outcome
       FROM evidence_learning_examples
      WHERE final_return_pct IS NOT NULL`,
  ).all() as ExampleRow[];
  db.prepare("DELETE FROM evidence_learning_patterns").run();
  if (!rows.length) return 0;
  const base = stats(rows);
  const groups = new Map<string, { kind: string; label: string; rows: ExampleRow[] }>();
  addGroup(groups, "overall", "all completed evidence", rows);
  for (const key of new Set(rows.map((r) => r.strategy).filter(Boolean) as string[])) addGroup(groups, "strategy", key, rows.filter((r) => r.strategy === key));
  for (const key of new Set(rows.map((r) => r.time_bucket).filter(Boolean) as string[])) addGroup(groups, "time_bucket", key, rows.filter((r) => r.time_bucket === key));
  for (const key of new Set(rows.map((r) => r.quality_band).filter(Boolean) as string[])) addGroup(groups, "quality_band", key, rows.filter((r) => r.quality_band === key));
  for (const s of new Set(rows.map((r) => r.strategy).filter(Boolean) as string[])) {
    for (const t of new Set(rows.map((r) => r.time_bucket).filter(Boolean) as string[])) {
      const combo = rows.filter((r) => r.strategy === s && r.time_bucket === t);
      addGroup(groups, "combination", `${s} + ${t}`, combo);
    }
  }
  componentGroups(rows, groups);
  const delivered = rows.filter((r) => r.audience === "DELIVERED");
  const research = rows.filter((r) => r.audience === "RESEARCH_ONLY");
  addGroup(groups, "audience_comparison", "delivered vs research", [...delivered, ...research]);

  const insert = db.prepare(
    `INSERT INTO evidence_learning_patterns
      (pattern_key, pattern_kind, label, sample_size, delivered_sample_size, research_sample_size,
       wins, losses, win_rate, avg_return_pct, expectancy_pct, delivered_win_rate, research_win_rate,
       delivered_vs_research_lift, confidence, statistical_support_json, overfitting_risk,
       recommendation, recommendation_type, evidence_refs_json, source_watermark, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const watermark = Number((db.prepare("SELECT COALESCE(MAX(id),0) n FROM evidence_learning_examples").get() as any)?.n ?? 0);
  let count = 0;
  for (const [key, g] of groups) {
    const s = stats(g.rows);
    const d = stats(g.rows.filter((r) => r.audience === "DELIVERED"));
    const r = stats(g.rows.filter((x) => x.audience === "RESEARCH_ONLY"));
    const rec = recommendation(g.label, s, base, minSample);
    const conf = confidence(s.observed, rec.lift);
    insert.run(
      key, g.kind, g.label, s.observed, d.observed, r.observed, s.wins, s.losses,
      s.winRate, s.avgReturnPct, s.avgReturnPct, d.winRate, r.winRate,
      d.winRate != null && r.winRate != null ? round(d.winRate - r.winRate) : null,
      conf,
      JSON.stringify({ baselineWinRate: base.winRate, liftVsBaseline: rec.lift, minSample, method: "deterministic aggregate lift; no p-value claimed" }),
      overfittingRisk(s.observed),
      rec.text,
      rec.type,
      JSON.stringify(g.rows.slice(0, 20).map((x) => x.id)),
      watermark,
      nowMs,
    );
    count += 1;
  }
  return count;
}

export function refreshEvidenceLearningOnDb(db: EvidenceDb, opts: { nowMs?: number; limit?: number; minSample?: number } = {}): EvidenceLearningRefresh {
  if (!tableExists(db, "evidence_learning_examples") || !tableExists(db, "evidence_learning_patterns")) {
    return { status: "SKIPPED", examplesMaterialized: 0, patternsMaterialized: 0, sourceWatermark: 0, skippedReason: "evidence learning tables missing" };
  }
  const nowMs = opts.nowMs ?? Date.now();
  const limit = Math.max(1, Math.floor(opts.limit ?? 5000));
  const minSample = Math.max(3, Math.floor(opts.minSample ?? 20));
  let examples = 0;
  examples += materializePaperExamples(db, nowMs, limit);
  examples += materializeReplayExamples(db, nowMs, limit);
  const patterns = rebuildPatterns(db, nowMs, minSample);
  const watermark = Number((db.prepare("SELECT COALESCE(MAX(id),0) n FROM evidence_learning_examples").get() as any)?.n ?? 0);
  try {
    db.prepare("INSERT INTO evidence_learning_runs (status, examples_materialized, patterns_materialized, source_watermark, created_at_ms) VALUES (?,?,?,?,?)")
      .run("OK", examples, patterns, watermark, nowMs);
  } catch { /* isolated */ }
  return { status: "OK", examplesMaterialized: examples, patternsMaterialized: patterns, sourceWatermark: watermark };
}

export function evidenceLearningSnapshotOnDb(db: EvidenceDb): EvidenceLearningSnapshot {
  if (!tableExists(db, "evidence_learning_examples") || !tableExists(db, "evidence_learning_patterns")) {
    return {
      available: false, advisoryOnly: true, productionAuthority: "none",
      examples: { total: 0, delivered: 0, researchOnly: 0, replayUnderlyingForward: 0, latestCompletedAtMs: null },
      patterns: { total: 0, actionableRecommendations: 0, byConfidence: {}, top: [] },
      missingFields: {},
      disclaimer: "Evidence Learning is advisory-only and never modifies production trading logic.",
    };
  }
  const n = (sql: string, ...a: any[]) => Number((db.prepare(sql).get(...a) as any)?.n ?? 0);
  const latest = (db.prepare("SELECT MAX(completed_at_ms) n FROM evidence_learning_examples").get() as any)?.n ?? null;
  const byConfidence: Record<string, number> = {};
  for (const r of db.prepare("SELECT confidence k, COUNT(*) n FROM evidence_learning_patterns GROUP BY confidence").all() as Row[]) byConfidence[String(r.k)] = Number(r.n);
  const missingFields: Record<string, number> = {};
  for (const r of db.prepare("SELECT missing_fields_json m FROM evidence_learning_examples").all() as Row[]) {
    for (const f of parseJson(r.m) ?? []) missingFields[f] = (missingFields[f] ?? 0) + 1;
  }
  const top = db.prepare(
    `SELECT pattern_key, pattern_kind, label, sample_size, win_rate, avg_return_pct, delivered_win_rate,
            research_win_rate, delivered_vs_research_lift, confidence, overfitting_risk,
            recommendation_type, recommendation, statistical_support_json
       FROM evidence_learning_patterns
      ORDER BY CASE recommendation_type WHEN 'OBSERVE' THEN 1 ELSE 0 END ASC,
               CASE confidence WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END ASC,
               sample_size DESC
      LIMIT 12`,
  ).all() as Row[];
  return {
    available: true,
    advisoryOnly: true,
    productionAuthority: "none",
    examples: {
      total: n("SELECT COUNT(*) n FROM evidence_learning_examples"),
      delivered: n("SELECT COUNT(*) n FROM evidence_learning_examples WHERE audience='DELIVERED'"),
      researchOnly: n("SELECT COUNT(*) n FROM evidence_learning_examples WHERE audience='RESEARCH_ONLY'"),
      replayUnderlyingForward: n("SELECT COUNT(*) n FROM evidence_learning_examples WHERE audience='REPLAY_UNDERLYING_FORWARD'"),
      latestCompletedAtMs: latest == null ? null : Number(latest),
    },
    patterns: {
      total: n("SELECT COUNT(*) n FROM evidence_learning_patterns"),
      actionableRecommendations: n("SELECT COUNT(*) n FROM evidence_learning_patterns WHERE recommendation_type!='OBSERVE'"),
      byConfidence,
      top: top.map((r) => ({ ...r, statisticalSupport: parseJson(r.statistical_support_json), statistical_support_json: undefined })),
    },
    missingFields,
    disclaimer: "Evidence Learning explains why alerts won/lost and ranks human-review recommendations; it never changes thresholds, strategies, gates, Discord delivery, or production trading logic automatically.",
  };
}
