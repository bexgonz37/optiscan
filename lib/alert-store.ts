/**
 * alert-store.ts — all SQL for Alert Lab in one place. Route handlers and the
 * tracker call these; nothing else should touch the DB directly.
 *
 * Research/logging only: rows describe scanner alerts and their measured
 * follow-through. Nothing here places or suggests trades.
 */

import { getDb } from "@/lib/db";

export interface NewAlert {
  ticker: string;
  source: "momentum" | "unusual" | "manual";
  alertType?: string | null;
  direction: string | null;
  optionSymbol: string | null;
  optionSide: string | null;
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  alertTime: string; // ISO
  tradingDay: string; // YYYY-MM-DD ET
  priceAtAlert: number | null;
  percentMoveAtAlert: number | null;
  volume: number | null;
  relativeVolume: number | null;
  catalystType: string | null;
  catalystQuality: string | null;
  catalystSummary: string | null;
  catalystSource: string | null;
  signalScore: number | null;
  riskScore: number | null;
  optionsLiquidityScore: number | null;
  scannerScore: number | null;
  scoreBreakdownJson?: string | null;
  aiExplanation?: string | null;
  publicExplanation?: string | null;
  privateLabel?: string | null;
  publicLabel?: string | null;
  // 0DTE fields
  tradeBias?: string | null;
  moveStatus?: string | null;
  optionWorthScore?: number | null;
  worthVerdict?: string | null;
  chaseRisk?: string | null;
  ivRisk?: string | null;
  spreadRisk?: string | null;
  continuationScore?: number | null;
  exhaustionScore?: number | null;
  longCallScore?: number | null;
  longPutScore?: number | null;
  zeroDteContractScore?: number | null;
  riskFlags?: string[] | null;
  shortRateAtAlert?: number | null;
  volumeSurgeAtAlert?: number | null;
  /** 'trade' = live loop with speed proof; 'research' = slow scan, history only. */
  alertTier?: "trade" | "research" | null;
  optionsPressureLabel?: string | null;
  optionsPressureJson?: string | null;
  snapshot?: {
    optionSymbol: string | null;
    bid: number | null; ask: number | null; mid: number | null;
    spreadPct: number | null; volume: number | null;
    openInterest: number | null; iv: number | null; delta: number | null;
  } | null;
  catalystRecords?: Array<{
    headline: string; publisher: string | null; publishedAt: string | null;
    url: string | null; catalystType: string; quality: string; matchedKeywords: string;
  }>;
}

export function alertExists(ticker: string, source: string, optionSymbol: string | null, day: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM alerts WHERE ticker=? AND source=? AND coalesce(option_symbol,'')=? AND trading_day=?")
    .get(ticker, source, optionSymbol ?? "", day);
  return Boolean(row);
}

/** Insert alert + at-alert snapshot + catalyst records + score breakdown in
 * one transaction. Returns new id, or null when the dedup index rejects it. */
export function insertAlert(a: NewAlert): number | null {
  const db = getDb();
  const tx = db.transaction((alert: NewAlert): number | null => {
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO alerts (
          ticker, source, alert_type, direction, option_symbol, option_side, strike, expiration, dte,
          alert_time, trading_day, price_at_alert, percent_move_at_alert, volume, relative_volume,
          catalyst_type, catalyst_quality, catalyst_summary, catalyst_source,
          signal_score, risk_score, options_liquidity_score, scanner_score,
          score_breakdown_json, ai_explanation, public_explanation, private_label, public_label,
          trade_bias, move_status, option_worth_score, worth_verdict, chase_risk, iv_risk, spread_risk,
          continuation_score, exhaustion_score, long_call_score, long_put_score, zero_dte_contract_score, risk_flags,
          options_pressure_label, options_pressure_json, short_rate_at_alert, volume_surge_at_alert, alert_tier, status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'tracking')`,
      )
      .run(
        alert.ticker, alert.source, alert.alertType ?? null, alert.direction, alert.optionSymbol, alert.optionSide,
        alert.strike, alert.expiration, alert.dte, alert.alertTime, alert.tradingDay,
        alert.priceAtAlert, alert.percentMoveAtAlert, alert.volume, alert.relativeVolume,
        alert.catalystType, alert.catalystQuality, alert.catalystSummary, alert.catalystSource,
        alert.signalScore, alert.riskScore, alert.optionsLiquidityScore, alert.scannerScore,
        alert.scoreBreakdownJson ?? null, alert.aiExplanation ?? null, alert.publicExplanation ?? null,
        alert.privateLabel ?? null, alert.publicLabel ?? null,
        alert.tradeBias ?? null, alert.moveStatus ?? null, alert.optionWorthScore ?? null, alert.worthVerdict ?? null,
        alert.chaseRisk ?? null, alert.ivRisk ?? null, alert.spreadRisk ?? null,
        alert.continuationScore ?? null, alert.exhaustionScore ?? null,
        alert.longCallScore ?? null, alert.longPutScore ?? null, alert.zeroDteContractScore ?? null,
        alert.riskFlags ? JSON.stringify(alert.riskFlags) : null,
        alert.optionsPressureLabel ?? null, alert.optionsPressureJson ?? null,
        alert.shortRateAtAlert ?? null, alert.volumeSurgeAtAlert ?? null,
        alert.alertTier ?? null,
      );
    if (res.changes === 0) return null;
    const id = Number(res.lastInsertRowid);

    if (alert.scoreBreakdownJson) {
      db.prepare("INSERT INTO score_breakdowns (alert_id, breakdown_json) VALUES (?,?)").run(id, alert.scoreBreakdownJson);
    }
    if (alert.snapshot) {
      db.prepare(
        `INSERT INTO options_snapshots (alert_id, taken_at, checkpoint, option_symbol, bid, ask, mid, spread_pct, volume, open_interest, iv, delta)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, alert.alertTime, "alert", alert.snapshot.optionSymbol, alert.snapshot.bid, alert.snapshot.ask,
        alert.snapshot.mid, alert.snapshot.spreadPct, alert.snapshot.volume, alert.snapshot.openInterest,
        alert.snapshot.iv, alert.snapshot.delta,
      );
    }
    for (const c of alert.catalystRecords ?? []) {
      db.prepare(
        `INSERT INTO catalyst_records (alert_id, ticker, headline, publisher, published_at, url, catalyst_type, quality, matched_keywords)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(id, alert.ticker, c.headline, c.publisher, c.publishedAt, c.url, c.catalystType, c.quality, c.matchedKeywords);
    }
    return id;
  });
  return tx(a);
}

export interface AlertFilters {
  ticker?: string;
  date?: string; // trading_day
  catalystType?: string;
  minSignal?: number;
  maxRisk?: number;
  minLiquidity?: number;
  falsePositive?: boolean;
  tradeTaken?: boolean;
  status?: string;
  minId?: number; // for popup polling: only alerts newer than this id
  limit?: number;
  offset?: number;
}

export function listAlerts(f: AlertFilters = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.ticker) { where.push("a.ticker = ?"); params.push(String(f.ticker).toUpperCase()); }
  if (f.date) { where.push("a.trading_day = ?"); params.push(f.date); }
  if (f.catalystType) { where.push("a.catalyst_type = ?"); params.push(f.catalystType); }
  if (f.minSignal != null) { where.push("a.signal_score >= ?"); params.push(f.minSignal); }
  if (f.maxRisk != null) { where.push("a.risk_score <= ?"); params.push(f.maxRisk); }
  if (f.minLiquidity != null) { where.push("a.options_liquidity_score >= ?"); params.push(f.minLiquidity); }
  if (f.falsePositive != null) where.push(f.falsePositive ? "a.is_false_positive = 1" : "(a.is_false_positive = 0 OR a.is_false_positive IS NULL)");
  if (f.tradeTaken != null) where.push(`${f.tradeTaken ? "" : "NOT "}EXISTS (SELECT 1 FROM trade_journal j WHERE j.alert_id = a.id)`);
  if (f.status) { where.push("a.status = ?"); params.push(f.status); }
  if (f.minId != null) { where.push("a.id > ?"); params.push(f.minId); }

  const sql = `
    SELECT a.*,
      (SELECT max_percent_move_after_alert FROM alert_performance p WHERE p.alert_id=a.id ORDER BY p.checked_at DESC LIMIT 1) AS latest_max_move,
      (SELECT percent_move_from_alert FROM alert_performance p WHERE p.alert_id=a.id AND p.checkpoint='eod') AS eod_move,
      EXISTS (SELECT 1 FROM trade_journal j WHERE j.alert_id = a.id) AS trade_taken
    FROM alerts a
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY a.id DESC
    LIMIT ? OFFSET ?`;
  params.push(Math.min(Number(f.limit ?? 200), 1000), Number(f.offset ?? 0));
  return getDb().prepare(sql).all(...params);
}

export function getAlertDetail(id: number) {
  const db = getDb();
  const alert = db.prepare("SELECT * FROM alerts WHERE id = ?").get(id);
  if (!alert) return null;
  return {
    alert,
    performance: db.prepare("SELECT * FROM alert_performance WHERE alert_id=? ORDER BY checked_at").all(id),
    snapshots: db.prepare("SELECT * FROM options_snapshots WHERE alert_id=? ORDER BY taken_at").all(id),
    catalysts: db.prepare("SELECT * FROM catalyst_records WHERE alert_id=? ORDER BY published_at DESC").all(id),
    journal: db.prepare("SELECT * FROM trade_journal WHERE alert_id=? ORDER BY created_at").all(id),
    breakdowns: db.prepare("SELECT * FROM score_breakdowns WHERE alert_id=?").all(id),
  };
}

export function listPerformance(f: { date?: string; ticker?: string; limit?: number } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.date) { where.push("a.trading_day = ?"); params.push(f.date); }
  if (f.ticker) { where.push("a.ticker = ?"); params.push(String(f.ticker).toUpperCase()); }
  const sql = `
    SELECT p.*, a.ticker, a.source, a.direction, a.signal_score, a.risk_score, a.trading_day
    FROM alert_performance p JOIN alerts a ON a.id = p.alert_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY p.checked_at DESC LIMIT ?`;
  params.push(Math.min(Number(f.limit ?? 500), 2000));
  return getDb().prepare(sql).all(...params);
}

export function trackingAlerts() {
  return getDb().prepare("SELECT * FROM alerts WHERE status = 'tracking' ORDER BY alert_time").all();
}

export function existingCheckpoints(alertId: number): string[] {
  return getDb().prepare("SELECT checkpoint FROM alert_performance WHERE alert_id=?").all(alertId).map((r: any) => r.checkpoint);
}

export function recordCheckpoint(row: {
  alertId: number; checkpoint: string; checkedAt: string;
  priceAtCheckpoint: number | null; percentMoveFromAlert: number | null;
  maxPriceAfterAlert: number | null; maxPercentMoveAfterAlert: number | null;
  drawdownAfterAlert: number | null; isFalsePositive: boolean | null;
}) {
  getDb().prepare(
    `INSERT INTO alert_performance (alert_id, checkpoint, checked_at, price_at_checkpoint, percent_move_from_alert,
       max_price_after_alert, max_percent_move_after_alert, drawdown_after_alert, is_false_positive)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(alert_id, checkpoint) DO UPDATE SET
       checked_at=excluded.checked_at, price_at_checkpoint=excluded.price_at_checkpoint,
       percent_move_from_alert=excluded.percent_move_from_alert, max_price_after_alert=excluded.max_price_after_alert,
       max_percent_move_after_alert=excluded.max_percent_move_after_alert, drawdown_after_alert=excluded.drawdown_after_alert,
       is_false_positive=excluded.is_false_positive`,
  ).run(
    row.alertId, row.checkpoint, row.checkedAt, row.priceAtCheckpoint, row.percentMoveFromAlert,
    row.maxPriceAfterAlert, row.maxPercentMoveAfterAlert, row.drawdownAfterAlert,
    row.isFalsePositive == null ? null : row.isFalsePositive ? 1 : 0,
  );
}

/** Late catalyst attach — news is fetched AFTER the alert exists so it can
 * never delay or block a momentum alert (spec: catalysts are context only). */
export function updateAlertCatalyst(alertId: number, cat: {
  type: string; quality: string; summary: string | null; source: string | null;
  records?: Array<{ headline: string; publisher: string | null; publishedAt: string | null; url: string | null; catalystType: string; quality: string; matchedKeywords: string }>;
}, ticker: string) {
  const db = getDb();
  db.prepare("UPDATE alerts SET catalyst_type=?, catalyst_quality=?, catalyst_summary=?, catalyst_source=? WHERE id=?")
    .run(cat.type, cat.quality, cat.summary, cat.source, alertId);
  for (const c of cat.records ?? []) {
    db.prepare(
      `INSERT INTO catalyst_records (alert_id, ticker, headline, publisher, published_at, url, catalyst_type, quality, matched_keywords)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(alertId, ticker, c.headline, c.publisher, c.publishedAt, c.url, c.catalystType, c.quality, c.matchedKeywords);
  }
}

export function finalizeAlert(alertId: number, isFalsePositive: boolean) {
  getDb().prepare("UPDATE alerts SET status='complete', is_false_positive=? WHERE id=?").run(isFalsePositive ? 1 : 0, alertId);
}

/** EOD outcome facts the Alert Lab measures beyond price checkpoints:
 * did the call side work, did the put side work (>= threshold favorable move
 * in that direction at any point), did the tracked contract's spread widen
 * materially vs the alert snapshot, and did the move reverse. */
export function recordAlertOutcomes(alertId: number, o: {
  callSideWorked: boolean | null; putSideWorked: boolean | null;
  spreadWidened: boolean | null; reversed: boolean | null;
}) {
  const b = (v: boolean | null) => (v == null ? null : v ? 1 : 0);
  getDb().prepare("UPDATE alerts SET call_side_worked=?, put_side_worked=?, spread_widened=?, reversed=? WHERE id=?")
    .run(b(o.callSideWorked), b(o.putSideWorked), b(o.spreadWidened), b(o.reversed), alertId);
}

/** Spread comparison inputs for outcome measurement. */
export function alertSpreadHistory(alertId: number): { atAlert: number | null; maxLive: number | null } {
  const db = getDb();
  const first: any = db.prepare("SELECT spread_pct FROM options_snapshots WHERE alert_id=? AND checkpoint='alert' LIMIT 1").get(alertId);
  const live: any = db.prepare("SELECT MAX(spread_pct) AS m FROM options_snapshots WHERE alert_id=? AND checkpoint='live'").get(alertId);
  return { atAlert: first?.spread_pct ?? null, maxLive: live?.m ?? null };
}

/** All mid quotes for an alert's contract, for option-P&L measurement. */
export function alertOptionSnapshots(alertId: number): { checkpoint: string; mid: number | null }[] {
  return getDb().prepare(
    "SELECT checkpoint, mid FROM options_snapshots WHERE alert_id=? ORDER BY taken_at",
  ).all(alertId) as any[];
}

/** Persist the contract P&L outcome (computed at EOD finalize). */
export function recordOptionOutcome(alertId: number, returnPct: number | null, win: boolean | null) {
  getDb().prepare("UPDATE alerts SET option_return_pct=?, option_outcome_win=? WHERE id=?")
    .run(returnPct, win == null ? null : win ? 1 : 0, alertId);
}

/** One more contract quote row (used by the tracker for the EOD checkpoint). */
export function insertOptionSnapshot(alertId: number, checkpoint: string, c: {
  optionSymbol?: string | null; bid?: number | null; ask?: number | null; mid?: number | null;
  spreadPct?: number | null; volume?: number | null; openInterest?: number | null;
  iv?: number | null; delta?: number | null;
}, takenAt = new Date().toISOString()) {
  getDb().prepare(
    `INSERT INTO options_snapshots (alert_id, taken_at, checkpoint, option_symbol, bid, ask, mid, spread_pct, volume, open_interest, iv, delta)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(alertId, takenAt, checkpoint, c.optionSymbol ?? null, c.bid ?? null, c.ask ?? null, c.mid ?? null,
    c.spreadPct ?? null, c.volume ?? null, c.openInterest ?? null, c.iv ?? null, c.delta ?? null);
}

/** Aggregate stats for the Alert Lab dashboard. */
export function statsSummary(day?: string) {
  const db = getDb();
  const dayClause = day ? "WHERE trading_day = ?" : "";
  const dayParams = day ? [day] : [];
  const totals: any = db.prepare(
    `SELECT COUNT(*) AS total,
            AVG(signal_score) AS avg_signal,
            AVG(risk_score) AS avg_risk,
            AVG(options_liquidity_score) AS avg_liquidity,
            SUM(CASE WHEN is_false_positive = 1 THEN 1 ELSE 0 END) AS false_positives,
            SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed
     FROM alerts ${dayClause}`,
  ).get(...dayParams);

  const avgMove: any = db.prepare(
    `SELECT AVG(p.max_percent_move_after_alert) AS avg_max_move,
            AVG(p.percent_move_from_alert) AS avg_eod_move
     FROM alert_performance p JOIN alerts a ON a.id = p.alert_id
     WHERE p.checkpoint = 'eod' ${day ? "AND a.trading_day = ?" : ""}`,
  ).get(...dayParams);

  const byCatalyst = db.prepare(
    `SELECT a.catalyst_type AS type, COUNT(*) AS alerts,
            AVG(p.max_percent_move_after_alert) AS avg_max_move,
            AVG(CASE WHEN p.is_false_positive = 1 THEN 1.0 ELSE 0.0 END) AS fp_rate
     FROM alerts a LEFT JOIN alert_performance p ON p.alert_id = a.id AND p.checkpoint = 'eod'
     ${dayClause}
     GROUP BY a.catalyst_type ORDER BY avg_max_move DESC`,
  ).all(...dayParams);

  const bySource = db.prepare(
    `SELECT a.source, COUNT(*) AS alerts, AVG(a.signal_score) AS avg_signal,
            AVG(p.max_percent_move_after_alert) AS avg_max_move
     FROM alerts a LEFT JOIN alert_performance p ON p.alert_id = a.id AND p.checkpoint = 'eod'
     ${dayClause}
     GROUP BY a.source`,
  ).all(...dayParams);

  return { totals, avgMove, byCatalyst, bySource };
}

/** BUY CALL/PUT signal accuracy — trade-tier alerts with measured outcomes. */
export function tradeSignalAccuracy(opts: { days?: number; limit?: number } = {}) {
  const db = getDb();
  const days = Math.max(1, Number(opts.days ?? 14));
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const limit = Math.min(Number(opts.limit ?? 50), 200);

  const summary: any = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN a.status = 'complete' AND a.is_false_positive = 0 THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN a.status = 'complete' AND a.is_false_positive = 1 THEN 1 ELSE 0 END) AS losses,
            SUM(CASE WHEN a.status = 'tracking' THEN 1 ELSE 0 END) AS tracking,
            AVG(CASE WHEN p.checkpoint = 'eod' THEN p.max_percent_move_after_alert END) AS avg_max_move,
            AVG(CASE WHEN p.checkpoint = 'eod' THEN p.percent_move_from_alert END) AS avg_eod_move,
            SUM(CASE WHEN a.option_outcome_win = 1 THEN 1 ELSE 0 END) AS option_wins,
            SUM(CASE WHEN a.option_outcome_win = 0 THEN 1 ELSE 0 END) AS option_losses,
            AVG(a.option_return_pct) AS avg_option_return
     FROM alerts a
     LEFT JOIN alert_performance p ON p.alert_id = a.id AND p.checkpoint = 'eod'
     WHERE a.trading_day >= ? AND a.alert_tier = 'trade'`,
  ).get(since);

  const completed = (summary?.wins ?? 0) + (summary?.losses ?? 0);
  const hitRate = completed > 0 ? (summary.wins ?? 0) / completed : null;
  const optionCompleted = (summary?.option_wins ?? 0) + (summary?.option_losses ?? 0);
  const optionWinRate = optionCompleted > 0 ? (summary.option_wins ?? 0) / optionCompleted : null;

  const bySide = db.prepare(
    `SELECT a.option_side AS side, COUNT(*) AS total,
            SUM(CASE WHEN a.is_false_positive = 0 THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN a.is_false_positive = 1 THEN 1 ELSE 0 END) AS losses
     FROM alerts a
     WHERE a.trading_day >= ? AND a.alert_tier = 'trade' AND a.status = 'complete'
     GROUP BY a.option_side`,
  ).all(since);

  const recent = db.prepare(
    `SELECT a.id, a.ticker, a.option_side, a.strike, a.dte, a.alert_time, a.trading_day,
            a.direction, a.signal_score, a.short_rate_at_alert, a.percent_move_at_alert,
            a.status, a.is_false_positive, a.option_return_pct, a.option_outcome_win,
            (SELECT s.mid FROM options_snapshots s
             WHERE s.alert_id = a.id AND s.checkpoint = 'alert' LIMIT 1) AS entry_mid,
            (SELECT MAX(s.mid) FROM options_snapshots s
             WHERE s.alert_id = a.id AND s.checkpoint IN ('live','eod')) AS best_mid,
            (SELECT p.max_percent_move_after_alert FROM alert_performance p
             WHERE p.alert_id = a.id ORDER BY p.checked_at DESC LIMIT 1) AS latest_max_move,
            (SELECT p.percent_move_from_alert FROM alert_performance p
             WHERE p.alert_id = a.id AND p.checkpoint = 'eod') AS eod_move,
            EXISTS (SELECT 1 FROM notification_events n
                    WHERE n.alert_id = a.id AND n.channel = 'discord_webhook' AND n.status = 'sent') AS discord_sent
     FROM alerts a
     WHERE a.trading_day >= ? AND a.alert_tier = 'trade'
     ORDER BY a.id DESC LIMIT ?`,
  ).all(since, limit);

  return {
    since,
    days,
    total: summary?.total ?? 0,
    wins: summary?.wins ?? 0,
    losses: summary?.losses ?? 0,
    tracking: summary?.tracking ?? 0,
    hitRate,
    avgMaxMove: summary?.avg_max_move ?? null,
    avgEodMove: summary?.avg_eod_move ?? null,
    optionWins: summary?.option_wins ?? 0,
    optionLosses: summary?.option_losses ?? 0,
    optionWinRate,
    avgOptionReturn: summary?.avg_option_return ?? null,
    bySide,
    recent,
    note: "Tracks trade-tier BUY signals only. Stock win = favorable move ≥ threshold by EOD. Option win = contract mid gained ≥ 15% from entry.",
  };
}

/** Weekly report: last 7 trading days of measured scanner output. */
export function weeklyReport() {
  const db = getDb();
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const totals: any = db.prepare(
    `SELECT COUNT(*) AS total_alerts, AVG(signal_score) AS avg_signal_score,
            SUM(CASE WHEN is_false_positive = 1 THEN 1 ELSE 0 END) AS false_positives,
            SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed
     FROM alerts WHERE trading_day >= ?`,
  ).get(since);

  const moves: any = db.prepare(
    `SELECT AVG(p.max_percent_move_after_alert) AS avg_max_move
     FROM alert_performance p JOIN alerts a ON a.id = p.alert_id
     WHERE p.checkpoint = 'eod' AND a.trading_day >= ?`,
  ).get(since);

  const catalystRank = db.prepare(
    `SELECT a.catalyst_type AS type, COUNT(*) AS alerts,
            AVG(p.max_percent_move_after_alert) AS avg_max_move,
            AVG(CASE WHEN p.is_false_positive = 1 THEN 1.0 ELSE 0.0 END) AS fp_rate
     FROM alerts a JOIN alert_performance p ON p.alert_id = a.id AND p.checkpoint = 'eod'
     WHERE a.trading_day >= ?
     GROUP BY a.catalyst_type HAVING COUNT(*) >= 2 ORDER BY avg_max_move DESC`,
  ).all(since) as any[];

  // "Missed opportunities": biggest favorable follow-through where no journal
  // entry exists — i.e. the scanner flagged it and it ran, per the data.
  const missed = db.prepare(
    `SELECT a.id, a.ticker, a.source, a.trading_day, a.signal_score, a.catalyst_type,
            p.max_percent_move_after_alert AS max_move
     FROM alerts a JOIN alert_performance p ON p.alert_id = a.id AND p.checkpoint = 'eod'
     WHERE a.trading_day >= ? AND (a.is_false_positive = 0 OR a.is_false_positive IS NULL)
       AND NOT EXISTS (SELECT 1 FROM trade_journal j WHERE j.alert_id = a.id)
     ORDER BY p.max_percent_move_after_alert DESC LIMIT 10`,
  ).all(since);

  const topQuality = db.prepare(
    `SELECT a.id, a.ticker, a.source, a.trading_day, a.signal_score, a.risk_score,
            a.catalyst_type, a.catalyst_quality,
            (SELECT p.max_percent_move_after_alert FROM alert_performance p WHERE p.alert_id=a.id AND p.checkpoint='eod') AS max_move
     FROM alerts a WHERE a.trading_day >= ?
     ORDER BY a.signal_score DESC LIMIT 10`,
  ).all(since);

  const journal: any = db.prepare(
    `SELECT COUNT(*) AS entries,
            SUM(CASE WHEN outcome_pct > 0 THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN outcome_pct <= 0 THEN 1 ELSE 0 END) AS losses,
            AVG(outcome_pct) AS avg_outcome_pct
     FROM trade_journal WHERE created_at >= ? AND outcome_pct IS NOT NULL`,
  ).get(since);

  return {
    since,
    totalAlerts: totals?.total_alerts ?? 0,
    avgSignalScore: totals?.avg_signal_score ?? null,
    avgMaxMoveAfterAlert: moves?.avg_max_move ?? null,
    falsePositiveRate: totals?.completed ? (totals.false_positives ?? 0) / totals.completed : null,
    bestCatalystType: catalystRank[0] ?? null,
    worstCatalystType: catalystRank.length ? catalystRank[catalystRank.length - 1] : null,
    missedOpportunities: missed,
    topQualityAlerts: topQuality,
    journalWinRate: journal?.entries ? (journal.wins ?? 0) / journal.entries : null,
    journalEntries: journal?.entries ?? 0,
    note: "Measured scanner output for research — max_move is the best favorable print after the alert, not a realized result.",
  };
}

// ── Trade journal ────────────────────────────────────────────────────────────

const JOURNAL_FIELDS: Record<string, string> = {
  alertId: "alert_id", side: "side", contract: "contract",
  entryPrice: "entry_price", exitPrice: "exit_price", quantity: "quantity",
  openedAt: "opened_at", closedAt: "closed_at", outcomePct: "outcome_pct", pnl: "pnl",
  entryReason: "entry_reason", exitReason: "exit_reason", mistakeNotes: "mistake_notes",
  screenshotUrl: "screenshot_url", emotionTag: "emotion_tag", lesson: "lesson", notes: "notes",
};

export function insertJournal(j: Record<string, unknown> & { ticker: string }) {
  const cols = ["ticker"];
  const vals: unknown[] = [String(j.ticker).toUpperCase()];
  for (const [k, col] of Object.entries(JOURNAL_FIELDS)) {
    if (k in j && j[k] !== undefined) { cols.push(col); vals.push(j[k] ?? null); }
  }
  const res = getDb().prepare(
    `INSERT INTO trade_journal (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...vals);
  return getDb().prepare("SELECT * FROM trade_journal WHERE id=?").get(Number(res.lastInsertRowid));
}

export function updateJournal(id: number, patch: Record<string, unknown>) {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, col] of Object.entries(JOURNAL_FIELDS)) {
    if (k in patch) { sets.push(`${col} = ?`); params.push(patch[k] ?? null); }
  }
  if (!sets.length) return getDb().prepare("SELECT * FROM trade_journal WHERE id=?").get(id) ?? null;
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  params.push(id);
  const res = getDb().prepare(`UPDATE trade_journal SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  if (res.changes === 0) return null;
  return getDb().prepare("SELECT * FROM trade_journal WHERE id=?").get(id);
}

export function listJournal(limit = 100) {
  return getDb().prepare(
    `SELECT j.*, a.signal_score, a.catalyst_type FROM trade_journal j
     LEFT JOIN alerts a ON a.id = j.alert_id ORDER BY j.created_at DESC LIMIT ?`,
  ).all(Math.min(limit, 500));
}

// ── Scanner settings (key/value overrides, editable from /settings) ─────────

export function getSetting(key: string): string | null {
  const row: any = getDb().prepare("SELECT value FROM scanner_settings WHERE key=?").get(key);
  return row?.value ?? null;
}

export function getSettingNum(key: string, fallback: number): number {
  const v = getSetting(key);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function setSetting(key: string, value: string) {
  getDb().prepare(
    `INSERT INTO scanner_settings (key, value) VALUES (?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(key, value);
}

export function allSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of getDb().prepare("SELECT key, value FROM scanner_settings").all() as any[]) out[r.key] = r.value;
  return out;
}

// ── Notification settings + events ──────────────────────────────────────────

export function getNotificationSettings() {
  return getDb().prepare("SELECT * FROM notification_settings WHERE id=1").get() as any;
}

const NOTIF_FIELDS: Record<string, string> = {
  browserPopupEnabled: "browser_popup_enabled",
  desktopNotificationEnabled: "desktop_notification_enabled",
  soundEnabled: "sound_enabled",
  discordEnabled: "discord_enabled",
  discordRequiresManualConfirm: "discord_requires_manual_confirm",
  publicModeRequiredForDiscord: "public_mode_required_for_discord",
};

export function updateNotificationSettings(patch: Record<string, unknown>) {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, col] of Object.entries(NOTIF_FIELDS)) {
    if (k in patch) { sets.push(`${col} = ?`); params.push(patch[k] ? 1 : 0); }
  }
  if (sets.length) {
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    getDb().prepare(`UPDATE notification_settings SET ${sets.join(", ")} WHERE id=1`).run(...params);
  }
  return getNotificationSettings();
}

export function logPopupEvent(alertId: number | null, ticker: string | null, action: string) {
  getDb().prepare("INSERT INTO popup_events (alert_id, ticker, action) VALUES (?,?,?)").run(alertId, ticker, action);
}

export function insertNotificationEvent(e: {
  alertId: number | null; channel: string; status: string;
  payloadJson?: string | null; error?: string | null; sentAt?: string | null;
}): number {
  const res = getDb().prepare(
    "INSERT INTO notification_events (alert_id, channel, status, payload_json, error, sent_at) VALUES (?,?,?,?,?,?)",
  ).run(e.alertId, e.channel, e.status, e.payloadJson ?? null, e.error ?? null, e.sentAt ?? null);
  return Number(res.lastInsertRowid);
}

export function pendingDiscordEvents() {
  return getDb().prepare(
    `SELECT n.*, a.ticker FROM notification_events n LEFT JOIN alerts a ON a.id = n.alert_id
     WHERE n.channel='discord_webhook' AND n.status='pending_confirm' ORDER BY n.created_at DESC LIMIT 50`,
  ).all();
}

/** Drop queued manual-confirm rows (e.g. after enabling auto-send). */
export function discardAllPendingDiscord(reason = "superseded: auto-send enabled"): number {
  const res = getDb().prepare(
    `UPDATE notification_events SET status='skipped', error=?
     WHERE channel='discord_webhook' AND status='pending_confirm'`,
  ).run(reason);
  return res.changes;
}

export function getNotificationEvent(id: number) {
  return getDb().prepare("SELECT * FROM notification_events WHERE id=?").get(id) as any;
}

export function markNotificationEvent(id: number, status: string, error?: string | null) {
  getDb().prepare(
    "UPDATE notification_events SET status=?, error=?, sent_at=CASE WHEN ?='sent' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE sent_at END WHERE id=?",
  ).run(status, error ?? null, status, id);
}
