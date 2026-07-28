/**
 * alert-store.ts — all SQL for Alert Lab in one place. Route handlers and the
 * tracker call these; nothing else should touch the DB directly.
 *
 * Research/logging only: rows describe scanner alerts and their measured
 * follow-through. Nothing here places or suggests trades.
 */

import { getDb } from "@/lib/db";
import { tradingDay } from "@/lib/trading-session";
import { formatOnTrackRatio, mapDailyTrendRow, onTrackPct } from "./accuracy-ratios";
import {
  EARLY_1M_ON_TRACK_MIN_PCT,
  EARLY_MOVE_WIN_PCT,
  EARLY_ON_TRACK_MIN_PCT,
} from "./early-accuracy";
import {
  deliveryAlertIdSql,
  deliveryDiscordMessageIdSql,
  deliveryOpportunityCaseIdSql,
  deliveryPaperTradeIdSql,
  verifiedSubscriberDeliverySql,
} from "./alert-delivery-proof";
import { classifyAlertDossier, type AlertDossierProofItem } from "./alert-detail-classification";

const SQL_MOVE_1M = `(SELECT p.percent_move_from_alert FROM alert_performance p WHERE p.alert_id = a.id AND p.checkpoint = '1m')`;
const SQL_MOVE_3M = `(SELECT p.percent_move_from_alert FROM alert_performance p WHERE p.alert_id = a.id AND p.checkpoint = '3m')`;
const SQL_MOVE_5M = `(SELECT p.percent_move_from_alert FROM alert_performance p WHERE p.alert_id = a.id AND p.checkpoint = '5m')`;

function sqlEarlyOnTrack(): string {
  const peakFav = `(SELECT MAX(p.max_percent_move_after_alert) FROM alert_performance p WHERE p.alert_id = a.id)`;
  return `(
    COALESCE(${SQL_MOVE_5M}, -999) >= ${EARLY_ON_TRACK_MIN_PCT}
    OR (${SQL_MOVE_5M} IS NULL AND COALESCE(${SQL_MOVE_1M}, -999) >= ${EARLY_1M_ON_TRACK_MIN_PCT})
    OR (a.status = 'tracking' AND COALESCE(${peakFav}, -999) >= ${EARLY_1M_ON_TRACK_MIN_PCT})
  )`;
}

const SQL_WINNER = `(
  (a.status = 'complete' AND a.is_false_positive = 0)
  OR COALESCE(${SQL_MOVE_5M}, -999) >= ${EARLY_MOVE_WIN_PCT}
  OR a.option_outcome_win = 1
)`;

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
  /** Verdict at capture time: TRADE | WAIT | SKIP */
  captureAction?: string | null;
  captureConfidence?: number | null;
  /** 'options' (default) = 0DTE contract callout; 'stock' = underlying-only callout. */
  assetClass?: "options" | "stock" | null;
  /** Session the alert fired in: premarket | regular | afterhours */
  session?: string | null;
  /** Live timing audit fields for "fresh now" vs old/daily context. */
  moveClassification?: string | null;
  signalDetectedAt?: string | null;
  lastConfirmedAt?: string | null;
  moveBeganAt?: string | null;
  dataTimestamp?: string | null;
  expiresAt?: string | null;
  lastValidatedAt?: string | null;
  lastTriggerEventAt?: string | null;
  invalidationReason?: string | null;
  vwapAtAlert?: number | null;
  vwapDistPctAtAlert?: number | null;
  aboveVwap?: boolean | null;
  optionsPressureLabel?: string | null;
  optionsPressureJson?: string | null;
  snapshot?: {
    optionSymbol: string | null;
    bid: number | null; ask: number | null; mid: number | null;
    spreadPct: number | null; volume: number | null;
    openInterest: number | null; iv: number | null; delta: number | null;
    realizedVol?: number | null; ivPremium?: number | null;
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

/** Block re-firing the same ticker too soon; allow a new row after the window (or on direction flip). */
export function alertRecentDuplicate(
  ticker: string,
  source: string,
  day: string,
  direction: string | null | undefined,
  windowMs = 10 * 60_000,
  nowMs = Date.now(),
): boolean {
  const row: any = getDb()
    .prepare(
      `SELECT alert_time, direction FROM alerts
       WHERE ticker=? AND source=? AND trading_day=?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(ticker, source, day);
  if (!row?.alert_time) return false;
  const t = Date.parse(row.alert_time);
  if (!Number.isFinite(t) || nowMs - t >= windowMs) return false;
  if (direction && row.direction && row.direction !== direction) return false;
  return true;
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
          options_pressure_label, options_pressure_json, short_rate_at_alert, volume_surge_at_alert, alert_tier, capture_action, capture_confidence, asset_class, session,
          move_classification, signal_detected_at, last_confirmed_at, move_began_at, data_timestamp, expires_at, last_validated_at, last_trigger_event_at, invalidation_reason,
          vwap_at_alert, vwap_dist_pct_at_alert, above_vwap,
          status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'tracking')`,
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
        alert.captureAction ?? null, alert.captureConfidence ?? null,
        alert.assetClass ?? "options", alert.session ?? null,
        alert.moveClassification ?? null,
        alert.signalDetectedAt ?? null,
        alert.lastConfirmedAt ?? null,
        alert.moveBeganAt ?? null,
        alert.dataTimestamp ?? null,
        alert.expiresAt ?? null,
        alert.lastValidatedAt ?? null,
        alert.lastTriggerEventAt ?? null,
        alert.invalidationReason ?? null,
        alert.vwapAtAlert ?? null,
        alert.vwapDistPctAtAlert ?? null,
        alert.aboveVwap == null ? null : (alert.aboveVwap ? 1 : 0),
      );
    if (res.changes === 0) return null;
    const id = Number(res.lastInsertRowid);

    if (alert.scoreBreakdownJson) {
      db.prepare("INSERT INTO score_breakdowns (alert_id, breakdown_json) VALUES (?,?)").run(id, alert.scoreBreakdownJson);
    }
    if (alert.snapshot) {
      db.prepare(
        `INSERT INTO options_snapshots (alert_id, taken_at, checkpoint, option_symbol, bid, ask, mid, spread_pct, volume, open_interest, iv, delta, realized_vol, iv_premium)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, alert.alertTime, "alert", alert.snapshot.optionSymbol, alert.snapshot.bid, alert.snapshot.ask,
        alert.snapshot.mid, alert.snapshot.spreadPct, alert.snapshot.volume, alert.snapshot.openInterest,
        alert.snapshot.iv, alert.snapshot.delta,
        alert.snapshot.realizedVol ?? null, alert.snapshot.ivPremium ?? null,
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
  assetClass?: "options" | "stock"; // omit = all
  minId?: number; // for popup polling: only alerts newer than this id
  limit?: number;
  offset?: number;
}

/** Latest options alert capture fields — keeps chart verdict locked after BUY fires. */
/** True when the OPPOSITE side of this ticker was a TRADE callout within windowMs. */
export function recentOppositeTradeExists(ticker: string, side: "call" | "put", day: string, nowMs: number, windowMs = 30 * 60_000): boolean {
  const opposite = side === "call" ? "put" : "call";
  const sinceIso = new Date(nowMs - windowMs).toISOString();
  const row = getDb().prepare(
    `SELECT 1 FROM alerts WHERE ticker=? AND trading_day=? AND capture_action='TRADE'
       AND option_side=? AND alert_time>=? LIMIT 1`,
  ).get(ticker, day, opposite, sinceIso);
  return Boolean(row);
}

export function getLatestAlertCapture(ticker: string) {
  const row: any = getDb().prepare(
    `SELECT capture_action, capture_confidence, alert_time, short_rate_at_alert, volume_surge_at_alert,
            alert_tier, option_side, strike, expiration, dte, trade_bias, direction, signal_score,
            option_worth_score, worth_verdict, zero_dte_contract_score, options_liquidity_score,
            move_status, risk_flags, risk_score, long_call_score, long_put_score
     FROM alerts
     WHERE ticker = ? AND coalesce(asset_class, 'options') = 'options'
     ORDER BY id DESC LIMIT 1`,
  ).get(String(ticker).toUpperCase());
  if (!row) return null;
  return {
    capture_action: row.capture_action ?? null,
    capture_confidence: row.capture_confidence ?? null,
    alert_time: row.alert_time ?? null,
    short_rate_at_alert: row.short_rate_at_alert ?? null,
    volume_surge_at_alert: row.volume_surge_at_alert ?? null,
    alert_tier: row.alert_tier ?? null,
    option_side: row.option_side ?? null,
    strike: row.strike ?? null,
    expiration: row.expiration ?? null,
    dte: row.dte ?? null,
    trade_bias: row.trade_bias ?? null,
    direction: row.direction ?? null,
    signal_score: row.signal_score ?? null,
    option_worth_score: row.option_worth_score ?? null,
    worth_verdict: row.worth_verdict ?? null,
    zero_dte_contract_score: row.zero_dte_contract_score ?? null,
    options_liquidity_score: row.options_liquidity_score ?? null,
    move_status: row.move_status ?? null,
    risk_flags: row.risk_flags ?? null,
    risk_score: row.risk_score ?? null,
    long_call_score: row.long_call_score ?? null,
    long_put_score: row.long_put_score ?? null,
  };
}

export function listAlerts(f: AlertFilters = {}) {
  const db = getDb();
  ensureAlertQueryCompatColumns(db);
  const deliverySql = alertDeliveryProofSqlForDb(db, "a");
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
  if (f.assetClass) { where.push("coalesce(a.asset_class,'options') = ?"); params.push(f.assetClass); }
  if (f.minId != null) { where.push("a.id > ?"); params.push(f.minId); }

  const sql = `
    SELECT a.*,
      (SELECT p.percent_move_from_alert FROM alert_performance p WHERE p.alert_id=a.id AND p.checkpoint='5m') AS move_5m,
      (SELECT s.mid FROM options_snapshots s WHERE s.alert_id=a.id AND s.checkpoint='alert' AND s.mid>0 LIMIT 1) AS entry_mid,
      (SELECT s.spread_pct FROM options_snapshots s WHERE s.alert_id=a.id AND s.checkpoint='alert' LIMIT 1) AS entry_spread_pct,
      (SELECT s.delta FROM options_snapshots s WHERE s.alert_id=a.id AND s.checkpoint='alert' LIMIT 1) AS entry_delta,
      (SELECT s.mid FROM options_snapshots s WHERE s.alert_id=a.id AND s.checkpoint IN ('live','eod') AND s.mid>0 ORDER BY s.taken_at DESC LIMIT 1) AS live_option_mid,
      (SELECT MAX(s.mid) FROM options_snapshots s WHERE s.alert_id=a.id AND s.checkpoint IN ('live','eod') AND s.mid>0) AS best_mid,
      (SELECT max_percent_move_after_alert FROM alert_performance p WHERE p.alert_id=a.id ORDER BY p.checked_at DESC LIMIT 1) AS latest_max_move,
      (SELECT percent_move_from_alert FROM alert_performance p WHERE p.alert_id=a.id AND p.checkpoint='eod') AS eod_move,
      CASE WHEN coalesce(a.asset_class,'options') = 'options' AND ${deliverySql.verified} THEN 1 ELSE 0 END AS subscriber_delivered,
      ${deliverySql.deliveryAlertId} AS delivery_alert_id,
      ${deliverySql.discordMessageId} AS discord_message_id,
      ${deliverySql.opportunityCaseId} AS opportunity_case_id,
      ${deliverySql.paperTradeId} AS delivered_paper_trade_id,
      EXISTS (SELECT 1 FROM trade_journal j WHERE j.alert_id = a.id) AS trade_taken
    FROM alerts a
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY a.id DESC
    LIMIT ? OFFSET ?`;
  params.push(Math.min(Number(f.limit ?? 200), 1000), Number(f.offset ?? 0));
  return db.prepare(sql).all(...params);
}

type DbReader = {
  prepare(sql: string): {
    get?: (...args: any[]) => any;
    all?: (...args: any[]) => any[];
  };
};

function tableExistsOnDb(db: DbReader, table: string): boolean {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name=?").get?.(table);
    return Boolean(row);
  } catch {
    return false;
  }
}

function columnSetOnDb(db: DbReader, table: string): Set<string> {
  try {
    return new Set((db.prepare(`PRAGMA table_info(${table})`).all?.() ?? []).map((r: any) => String(r.name)));
  } catch {
    return new Set();
  }
}

function ensureAlertQueryCompatColumns(db: DbReader): void {
  if (!tableExistsOnDb(db, "alerts")) return;
  const cols = columnSetOnDb(db, "alerts");
  const migrations: [string, string][] = [
    ["source", "ALTER TABLE alerts ADD COLUMN source TEXT NOT NULL DEFAULT 'scanner'"],
    ["direction", "ALTER TABLE alerts ADD COLUMN direction TEXT NOT NULL DEFAULT 'neutral'"],
    ["option_symbol", "ALTER TABLE alerts ADD COLUMN option_symbol TEXT"],
    ["option_side", "ALTER TABLE alerts ADD COLUMN option_side TEXT"],
    ["alert_time", "ALTER TABLE alerts ADD COLUMN alert_time TEXT"],
    ["trading_day", "ALTER TABLE alerts ADD COLUMN trading_day TEXT"],
    ["status", "ALTER TABLE alerts ADD COLUMN status TEXT NOT NULL DEFAULT 'tracking'"],
  ];
  for (const [col, sql] of migrations) {
    if (cols.has(col)) continue;
    try {
      db.prepare(sql).get?.();
    } catch {
      try { (db as any).exec?.(sql); } catch { /* best-effort compatibility guard */ }
    }
    cols.add(col);
  }
}

function alertDeliveryProofSqlForDb(db: DbReader, alias = "a"): {
  verified: string;
  deliveryAlertId: string;
  discordMessageId: string;
  opportunityCaseId: string;
  paperTradeId: string;
} {
  const cols = columnSetOnDb(db, "alerts");
  const required = ["id", "ticker", "option_symbol", "option_side", "alert_time"];
  if (!required.every((col) => cols.has(col))) {
    return {
      verified: "0",
      deliveryAlertId: "NULL",
      discordMessageId: "NULL",
      opportunityCaseId: "NULL",
      paperTradeId: "NULL",
    };
  }
  return {
    verified: verifiedSubscriberDeliverySql(alias),
    deliveryAlertId: deliveryAlertIdSql(alias),
    discordMessageId: deliveryDiscordMessageIdSql(alias),
    opportunityCaseId: deliveryOpportunityCaseIdSql(alias),
    paperTradeId: deliveryPaperTradeIdSql(alias),
  };
}

function safeAll(db: DbReader, table: string, sql: string, params: any[] = []): any[] {
  if (!tableExistsOnDb(db, table)) return [];
  try {
    return db.prepare(sql).all?.(...params) ?? [];
  } catch {
    return [];
  }
}

function safeGet(db: DbReader, table: string, sql: string, params: any[] = []): any | null {
  if (!tableExistsOnDb(db, table)) return null;
  try {
    return db.prepare(sql).get?.(...params) ?? null;
  } catch {
    return null;
  }
}

function parseJsonSafe(value: unknown): any | null {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toNum(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timeMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(value);
  if (Number.isFinite(n) && n > 1_000_000_000) return n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTime(value: unknown): string | null {
  const ms = timeMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

function pctReturn(entry: number | null, exit: number | null): number | null {
  if (entry == null || exit == null || entry <= 0) return null;
  return ((exit - entry) / entry) * 100;
}

function money(value: number | null): number | null {
  return value == null ? null : Number((value * 100).toFixed(2));
}

function nearestRowsByTime(rows: any[], timestamp: string | null, limit = 5): any[] {
  const target = timeMs(timestamp) ?? 0;
  return [...rows]
    .sort((a, b) => Math.abs((timeMs(a.created_at_ms ?? a.alert_time ?? a.taken_at) ?? 0) - target)
      - Math.abs((timeMs(b.created_at_ms ?? b.alert_time ?? b.taken_at) ?? 0) - target))
    .slice(0, limit);
}

function pickSnapshot(snapshots: any[], checkpoints: string[]): any | null {
  for (const checkpoint of checkpoints) {
    const rows = snapshots.filter((s) => String(s.checkpoint ?? "").toLowerCase() === checkpoint);
    if (rows.length) return rows[0];
  }
  return null;
}

function latestSnapshot(snapshots: any[]): any | null {
  return [...snapshots]
    .filter((s) => toNum(s.mid) != null || toNum(s.bid) != null || toNum(s.ask) != null)
    .sort((a, b) => (timeMs(b.taken_at) ?? 0) - (timeMs(a.taken_at) ?? 0))[0] ?? null;
}

function maxSnapshotBy(snapshots: any[], field: "bid" | "mid" | "ask"): any | null {
  return [...snapshots]
    .filter((s) => toNum(s[field]) != null)
    .sort((a, b) => (toNum(b[field]) ?? -Infinity) - (toNum(a[field]) ?? -Infinity))[0] ?? null;
}

function minSnapshotBy(snapshots: any[], field: "bid" | "mid" | "ask"): any | null {
  return [...snapshots]
    .filter((s) => toNum(s[field]) != null)
    .sort((a, b) => (toNum(a[field]) ?? Infinity) - (toNum(b[field]) ?? Infinity))[0] ?? null;
}

function messageIdFromNotification(row: any): string | null {
  const payload = parseJsonSafe(row?.payload_json);
  return payload?.messageId ?? payload?.message_id ?? payload?.id ?? payload?.discordMessageId ?? null;
}

function payloadText(payload: any): string | null {
  if (!payload) return null;
  if (typeof payload.content === "string") return payload.content;
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.payload?.content === "string") return payload.payload.content;
  if (typeof payload.body?.content === "string") return payload.body.content;
  return null;
}

function proofRow(label: string, pass: boolean | null, source: string, detail: string): AlertDossierProofItem & { source: string; detail: string } {
  return {
    label,
    status: pass == null ? "MISSING" : pass ? "PASS" : "FAIL",
    pass,
    source,
    detail,
  };
}

function returnRow(label: string, entry: number | null, exit: number | null, entryAt: unknown, exitAt: unknown, convention: string) {
  const pct = pctReturn(entry, exit);
  return {
    label,
    convention,
    entry,
    exit,
    returnPct: pct == null ? null : Number(pct.toFixed(2)),
    formula: entry != null && exit != null ? `(${exit} - ${entry}) / ${entry} * 100` : null,
    oneContractEntryDebit: money(entry),
    oneContractExitValue: money(exit),
    oneContractPnl: entry != null && exit != null ? Number(((exit - entry) * 100).toFixed(2)) : null,
    entryAt: isoTime(entryAt),
    exitAt: isoTime(exitAt),
  };
}

function makeTimelineEvent(timestamp: unknown, source: string, label: string, detail: string, payload?: any) {
  return {
    timestamp: isoTime(timestamp),
    timestampMs: timeMs(timestamp),
    source,
    label,
    detail,
    payload: payload ?? null,
  };
}

export function getAlertDetailOnDb(db: DbReader, id: number) {
  const alert = db.prepare("SELECT * FROM alerts WHERE id = ?").get?.(id);
  if (!alert) return null;
  const occ = alert.option_symbol ?? null;
  const side = String(alert.option_side ?? alert.direction ?? "").toLowerCase().startsWith("p") ? "put"
    : String(alert.option_side ?? "").toLowerCase().startsWith("c") ? "call"
    : null;
  const alertMs = timeMs(alert.alert_time);
  const fromMs = alertMs == null ? 0 : alertMs - 20 * 60_000;
  const toMs = alertMs == null ? Number.MAX_SAFE_INTEGER : alertMs + 20 * 60_000;

  const performance = safeAll(db, "alert_performance", "SELECT * FROM alert_performance WHERE alert_id=? ORDER BY checked_at", [id]);
  const snapshots = safeAll(db, "options_snapshots", "SELECT * FROM options_snapshots WHERE alert_id=? ORDER BY taken_at", [id]);
  const catalysts = safeAll(db, "catalyst_records", "SELECT * FROM catalyst_records WHERE alert_id=? ORDER BY published_at DESC", [id]);
  const journal = safeAll(db, "trade_journal", "SELECT * FROM trade_journal WHERE alert_id=? ORDER BY created_at", [id]);
  const breakdowns = safeAll(db, "score_breakdowns", "SELECT * FROM score_breakdowns WHERE alert_id=?", [id]);
  const feedback = safeAll(db, "alert_feedback", "SELECT * FROM alert_feedback WHERE alert_id=? ORDER BY submitted_at DESC", [id]);
  const notifications = safeAll(db, "notification_events", "SELECT * FROM notification_events WHERE alert_id=? ORDER BY created_at DESC", [id]);
  const discordDeliveries = safeAll(db, "discord_deliveries", "SELECT * FROM discord_deliveries WHERE alert_id=? ORDER BY created_at DESC", [id]);

  const optionsAlertsCols = columnSetOnDb(db, "options_alerts");
  const optionAlerts = optionsAlertsCols.size
    ? safeAll(
      db,
      "options_alerts",
      `SELECT * FROM options_alerts
       WHERE candidate_symbol=?
         AND (? IS NULL OR option_symbol=?)
         AND (? IS NULL OR side=?)
         AND created_at_ms BETWEEN ? AND ?
       ORDER BY CASE WHEN state='SENT' THEN 0 ELSE 1 END, ABS(created_at_ms - ?) ASC
       LIMIT 10`,
      [String(alert.ticker).toUpperCase(), occ, occ, side, side, fromMs, toMs, alertMs ?? 0],
    )
    : [];
  const primaryOptionAlert = optionAlerts[0] ?? null;
  const optionAlertId = primaryOptionAlert?.alert_id ?? null;
  const opportunityCaseId = primaryOptionAlert?.opportunity_case_id ?? null;
  const opportunityFingerprint = primaryOptionAlert?.opportunity_fingerprint ?? null;

  const paperTrades = safeAll(
    db,
    "options_paper_trades",
    `SELECT * FROM options_paper_trades
     WHERE (? IS NULL OR option_symbol=?)
       AND (? IS NULL OR alert_id=?)
       AND entered_at_ms BETWEEN ? AND ?
     ORDER BY CASE WHEN paper_kind='DELIVERED_ALERT_PAPER' THEN 0 ELSE 1 END, entered_at_ms ASC
     LIMIT 20`,
    [occ, occ, optionAlertId, optionAlertId, fromMs, toMs + 8 * 60 * 60_000],
  );
  const paperMirror = paperTrades.find((p) => p.paper_kind === "DELIVERED_ALERT_PAPER" && (!occ || p.option_symbol === occ)) ?? null;
  const paperTradeId = paperMirror?.id ?? primaryOptionAlert?.paper_trade_id ?? null;
  const paperMarks = paperTradeId
    ? safeAll(db, "options_paper_marks", "SELECT * FROM options_paper_marks WHERE trade_id=? ORDER BY marked_at_ms", [paperTradeId])
    : [];

  const candidates = safeAll(
    db,
    "options_candidates",
    `SELECT * FROM options_candidates
     WHERE symbol=? AND (? IS NULL OR option_symbol=?)
       AND created_at_ms BETWEEN ? AND ?
     ORDER BY ABS(created_at_ms - ?) ASC LIMIT 20`,
    [String(alert.ticker).toUpperCase(), occ, occ, fromMs, toMs, alertMs ?? 0],
  );
  const deliveryDecisions = safeAll(
    db,
    "options_delivery_decisions",
    `SELECT * FROM options_delivery_decisions
     WHERE symbol=? AND (? IS NULL OR side=?)
       AND created_at_ms BETWEEN ? AND ?
     ORDER BY created_at_ms ASC LIMIT 20`,
    [String(alert.ticker).toUpperCase(), side, side, fromMs, toMs],
  );
  const bearishEscalations = safeAll(
    db,
    "options_bearish_escalations",
    `SELECT * FROM options_bearish_escalations
     WHERE legacy_alert_id=? OR (? IS NOT NULL AND occ=?)
     ORDER BY created_at_ms DESC`,
    [id, occ, occ],
  );

  const opportunityCase = opportunityCaseId
    ? safeGet(db, "opportunity_cases", "SELECT * FROM opportunity_cases WHERE opportunity_id=? OR case_id=? OR id=? LIMIT 1", [opportunityCaseId, opportunityCaseId, opportunityCaseId])
    : null;
  const opportunityRows = opportunityCaseId
    ? {
      milestones: safeAll(db, "opportunity_milestones", "SELECT * FROM opportunity_milestones WHERE opportunity_id=? OR case_id=? ORDER BY created_at_ms", [opportunityCaseId, opportunityCaseId]),
      evidence: safeAll(db, "opportunity_evidence_events", "SELECT * FROM opportunity_evidence_events WHERE opportunity_id=? OR case_id=? ORDER BY created_at_ms", [opportunityCaseId, opportunityCaseId]),
      content: safeAll(db, "opportunity_content_events", "SELECT * FROM opportunity_content_events WHERE opportunity_id=? OR case_id=? ORDER BY created_at_ms", [opportunityCaseId, opportunityCaseId]),
    }
    : { milestones: [], evidence: [], content: [] };

  const sentNotification = notifications.find((n) => String(n.status).toLowerCase() === "sent" && messageIdFromNotification(n));
  const sentDelivery = discordDeliveries.find((d) => String(d.status).toUpperCase() === "SENT");
  const discordMessageId = primaryOptionAlert?.discord_message_id ?? messageIdFromNotification(sentNotification) ?? sentDelivery?.discord_message_id ?? null;
  const discordHttpStatus = primaryOptionAlert?.discord_status ?? sentDelivery?.http_status ?? null;
  const notificationPayload = sentNotification ? parseJsonSafe(sentNotification.payload_json) : null;
  const deliveryPayload = sentDelivery ? parseJsonSafe(sentDelivery.payload_json) : null;
  const exactDiscordPayload = notificationPayload ?? deliveryPayload ?? (primaryOptionAlert?.state === "SENT" ? primaryOptionAlert.message : null);

  const entrySnapshot = pickSnapshot(snapshots, ["alert", "entry"]) ?? snapshots[0] ?? null;
  const eodSnapshot = pickSnapshot(snapshots, ["eod", "close"]) ?? latestSnapshot(snapshots);
  const bestMidSnapshot = maxSnapshotBy(snapshots, "mid");
  const bestBidSnapshot = maxSnapshotBy(snapshots, "bid");
  const worstMidSnapshot = minSnapshotBy(snapshots, "mid");
  const frozenEntry = toNum(primaryOptionAlert?.entry_mid) ?? toNum(entrySnapshot?.mid) ?? toNum(alert.entry_mid);
  const frozenBid = toNum(entrySnapshot?.bid) ?? toNum(primaryOptionAlert?.delivered_bid);
  const frozenAsk = toNum(entrySnapshot?.ask) ?? toNum(primaryOptionAlert?.delivered_ask);
  const exitMid = toNum(eodSnapshot?.mid) ?? toNum(bestMidSnapshot?.mid);
  const exitBid = toNum(eodSnapshot?.bid) ?? toNum(bestBidSnapshot?.bid);

  const proof = [
    proofRow("Independent options alert row", primaryOptionAlert ? true : null, "options_alerts", primaryOptionAlert ? String(optionAlertId) : "No matching independent row in alert window"),
    proofRow("Subscriber SEND state", primaryOptionAlert ? primaryOptionAlert.state === "SENT" : null, "options_alerts.state", primaryOptionAlert?.state ?? "Missing"),
    proofRow("Discord message ID", discordMessageId ? true : null, "discord", discordMessageId ?? "Missing"),
    proofRow("Discord HTTP success", discordHttpStatus == null ? null : Number(discordHttpStatus) >= 200 && Number(discordHttpStatus) < 300, "discord", discordHttpStatus == null ? "Missing" : String(discordHttpStatus)),
    proofRow("Opportunity case ID", opportunityCaseId ? true : null, "options_alerts/opportunity_cases", opportunityCaseId ?? "Missing"),
    proofRow("Paper mirror linkage", primaryOptionAlert ? (primaryOptionAlert.paper_linked === 1 || primaryOptionAlert.paper_linked === true) && Boolean(paperMirror) : null, "options_paper_trades", paperMirror ? `paper trade ${paperMirror.id}` : "Missing delivered-alert paper mirror"),
    proofRow("Matching OCC contract", primaryOptionAlert ? primaryOptionAlert.option_symbol === occ : null, "alerts/options_alerts", primaryOptionAlert?.option_symbol ?? "Missing"),
    proofRow("Frozen entry", frozenEntry != null && frozenEntry > 0, "options_snapshots/options_alerts", frozenEntry == null ? "Missing" : String(frozenEntry)),
    proofRow("Valid grading marks", exitMid != null || exitBid != null || paperMarks.length > 0, "options_snapshots/options_paper_marks", exitMid != null ? `mid ${exitMid}` : exitBid != null ? `bid ${exitBid}` : "Missing"),
  ];
  const hasOwnerOnly = notifications.some((n) => String(n.channel ?? "").includes("owner") || String(n.payload_json ?? "").toLowerCase().includes("owner"));
  const researchOnly = Boolean(primaryOptionAlert?.research_only || deliveryDecisions.some((d) => String(d.outcome ?? d.final_delivery_outcome ?? "").toUpperCase().includes("RESEARCH")));
  const shadow = deliveryDecisions.some((d) => String(d.reason ?? "").toLowerCase().includes("shadow"));
  const auditOnly = Boolean(bearishEscalations.length || notifications.some((n) => String(n.status).toLowerCase() === "skipped"));
  const classification = classifyAlertDossier({
    proof,
    paperTradeCount: paperTrades.length,
    hasOwnerOnly,
    researchOnly,
    shadow,
    auditOnly,
  });
  const verifiedDelivered = classification.verifiedDelivered;
  const badge = classification.badge;

  const firstSuppression =
    primaryOptionAlert?.failure_reason ??
    deliveryDecisions.find((d) => d.reason || d.final_delivery_reason)?.reason ??
    deliveryDecisions.find((d) => d.final_delivery_reason)?.final_delivery_reason ??
    notifications.find((n) => String(n.status).toLowerCase() !== "sent")?.error ??
    bearishEscalations[0]?.suppression_reason ??
    null;

  const timeline = [
    makeTimelineEvent(alert.alert_time, "legacy scanner", "Scanner detected setup", `${alert.ticker} ${String(alert.option_side ?? side ?? "").toUpperCase()} score ${alert.signal_score ?? "n/a"}`),
    ...snapshots.map((s) => makeTimelineEvent(s.taken_at, "options snapshots", `${s.checkpoint ?? "snapshot"} mark`, `bid ${s.bid ?? "n/a"} ask ${s.ask ?? "n/a"} mid ${s.mid ?? "n/a"}`)),
    ...candidates.map((c) => makeTimelineEvent(c.created_at_ms, "options candidates", "Candidate created", `${c.selected_strategy ?? c.strategy ?? "unknown"} ${c.state ?? ""} ${c.why ?? ""}`.trim(), parseJsonSafe(c.feature_snapshot_json))),
    ...deliveryDecisions.map((d) => makeTimelineEvent(d.created_at_ms, "delivery decision", d.outcome ?? d.final_delivery_outcome ?? "decision", d.reason ?? d.final_delivery_reason ?? "No reason recorded", parseJsonSafe(d.components_json))),
    ...optionAlerts.map((oa) => makeTimelineEvent(oa.created_at_ms ?? oa.attempted_at_ms, "independent options alert", oa.state ?? "alert row", oa.failure_reason ?? oa.message_hash ?? oa.alert_id ?? "No detail", oa)),
    ...notifications.map((n) => makeTimelineEvent(n.created_at ?? n.sent_at, "notification event", n.status ?? "notification", n.error ?? n.channel ?? "No detail", parseJsonSafe(n.payload_json))),
    ...discordDeliveries.map((d) => makeTimelineEvent(d.created_at ?? d.sent_at ?? d.attempted_at, "discord delivery", d.status ?? "delivery", d.failure_reason ?? d.response_body_safe ?? d.delivery_id ?? "No detail", parseJsonSafe(d.payload_json))),
    ...paperTrades.map((p) => makeTimelineEvent(p.entered_at_ms ?? p.created_at_ms, "paper mirror", p.paper_kind ?? p.status ?? "paper trade", `entry ${p.entry_fill ?? "n/a"} exit ${p.exit_fill ?? "open"} return ${p.return_pct ?? "n/a"}`, p)),
    ...paperMarks.map((m) => makeTimelineEvent(m.marked_at_ms, "paper mark", m.mark_type ?? "paper mark", `bid ${m.bid ?? "n/a"} ask ${m.ask ?? "n/a"} mid ${m.mid ?? "n/a"}`)),
    ...performance.map((p) => makeTimelineEvent(p.checked_at, "legacy grading", p.checkpoint ?? "checkpoint", `move ${p.percent_move_from_alert ?? "n/a"} max ${p.max_percent_move_after_alert ?? "n/a"}`)),
    ...opportunityRows.milestones.map((m) => makeTimelineEvent(m.created_at_ms, "opportunity lifecycle", m.kind ?? m.type ?? "milestone", m.note ?? m.reason ?? "")),
    ...opportunityRows.evidence.map((e) => makeTimelineEvent(e.created_at_ms, "opportunity evidence", e.kind ?? e.type ?? "evidence", e.summary ?? e.reason ?? "")),
    ...opportunityRows.content.map((c) => makeTimelineEvent(c.created_at_ms, "opportunity content", c.kind ?? c.type ?? "content", c.summary ?? c.reason ?? "")),
  ].filter((e) => e.timestamp || e.timestampMs != null)
    .sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));

  const returnCalculations = [
    returnRow("Legacy mid-to-mid", frozenEntry, exitMid, entrySnapshot?.taken_at ?? alert.alert_time, eodSnapshot?.taken_at ?? bestMidSnapshot?.taken_at, "Displayed research grading convention"),
    returnRow("Conservative ask-to-bid", frozenAsk, exitBid, entrySnapshot?.taken_at ?? alert.alert_time, eodSnapshot?.taken_at ?? bestBidSnapshot?.taken_at, "Subscriber realistic buy ask, sell bid"),
    returnRow("Best mid MFE", frozenEntry, toNum(bestMidSnapshot?.mid), entrySnapshot?.taken_at ?? alert.alert_time, bestMidSnapshot?.taken_at, "Maximum favorable mid after detection"),
    returnRow("Worst mid MAE", frozenEntry, toNum(worstMidSnapshot?.mid), entrySnapshot?.taken_at ?? alert.alert_time, worstMidSnapshot?.taken_at, "Worst marked mid after detection"),
    returnRow("Paper mirror", toNum(paperMirror?.entry_fill), toNum(paperMirror?.exit_fill), paperMirror?.entered_at_ms, paperMirror?.exit_at_ms, "Actual delivered-alert paper trade, when present"),
  ];

  return {
    alert,
    metadata: {
      alertId: id,
      detailRoute: `/alerts/${id}`,
      symbol: alert.ticker,
      side,
      optionSymbol: occ,
      strike: alert.strike ?? null,
      expiration: alert.expiration ?? null,
      dte: alert.dte ?? null,
      setupFamily: primaryOptionAlert?.strategy ?? alert.source ?? null,
      direction: alert.direction ?? null,
      finalStatus: classification.finalStatus,
      lane: verifiedDelivered ? "Delivered performance" : badge,
      confidence: alert.capture_confidence ?? alert.signal_score ?? null,
      opportunityCaseId,
      opportunityFingerprint,
      independentAlertId: optionAlertId,
      paperTradeId,
      discordMessageId,
    },
    classification: {
      badge,
      verifiedDelivered,
      finalStatus: classification.finalStatus,
      lane: classification.lane,
      suppressionReason: firstSuppression,
    },
    proofSummary: {
      verifiedDelivered,
      status: classification.finalStatus,
      missing: classification.missing,
      failed: classification.failed,
    },
    deliveryProof: proof,
    timeline,
    entryDetails: {
      frozenEntry,
      frozenBid,
      frozenAsk,
      entrySnapshot,
      optionAlertEntryMid: primaryOptionAlert?.entry_mid ?? null,
      entrySource: primaryOptionAlert?.entry_source ?? paperMirror?.entry_source ?? "legacy_snapshot_or_independent_alert",
    },
    pricePath: {
      snapshots,
      paperMarks,
      bestMid: bestMidSnapshot,
      bestBid: bestBidSnapshot,
      worstMid: worstMidSnapshot,
      eod: eodSnapshot,
    },
    returnCalculations,
    realisticValues: returnCalculations.filter((r) => r.label === "Conservative ask-to-bid" || r.label === "Paper mirror"),
    discord: {
      sent: verifiedDelivered,
      note: verifiedDelivered ? "Verified Discord delivery proof present." : "NO VERIFIED DISCORD DELIVERY",
      messageId: discordMessageId,
      httpStatus: discordHttpStatus,
      payload: verifiedDelivered ? exactDiscordPayload : null,
      payloadText: verifiedDelivered ? payloadText(exactDiscordPayload) ?? (typeof exactDiscordPayload === "string" ? exactDiscordPayload : null) : null,
      suppressionReason: firstSuppression,
    },
    suppression: {
      reason: firstSuppression,
      deliveryDecision: primaryOptionAlert?.state ?? deliveryDecisions[0]?.outcome ?? null,
      actionableReason: deliveryDecisions[0]?.reason ?? deliveryDecisions[0]?.final_delivery_reason ?? null,
      invalidation: primaryOptionAlert?.failure_reason ?? null,
    },
    missedOpportunity: {
      isMissed: !verifiedDelivered && Boolean(snapshots.length || alert.option_return_pct != null || bearishEscalations.length),
      explanation: verifiedDelivered
        ? "This row has hard subscriber Discord delivery proof."
        : "This row is preserved for audit/research because it lacks hard subscriber Discord delivery proof.",
    },
    performance,
    snapshots,
    catalysts,
    journal,
    breakdowns,
    feedback,
    notifications,
    discordDeliveries,
    optionAlerts,
    deliveryDecisions,
    candidates: nearestRowsByTime(candidates, alert.alert_time, 20),
    paperTrades,
    paperMirror,
    opportunityCase,
    opportunityRows,
    bearishEscalations,
  };
}

export function getAlertDetail(id: number) {
  return getAlertDetailOnDb(getDb(), id);
}

export function insertAlertFeedback(e: {
  alertId: number;
  userFeedback: string;
  feedbackReason?: string | null;
  notes?: string | null;
}): number {
  const res = getDb().prepare(
    `INSERT INTO alert_feedback (alert_id, user_feedback, feedback_reason, notes)
     VALUES (?,?,?,?)`,
  ).run(e.alertId, e.userFeedback, e.feedbackReason ?? null, e.notes ?? null);
  return Number(res.lastInsertRowid);
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
  const db = getDb();
  db.prepare("UPDATE alerts SET status='complete', is_false_positive=? WHERE id=?").run(isFalsePositive ? 1 : 0, alertId);
  if (!isFalsePositive) return;
  try {
    const row = db.prepare("SELECT ticker FROM alerts WHERE id=?").get(alertId) as { ticker?: string } | undefined;
    if (!row?.ticker) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { maybeApplyStreakLock, maybeApplyLowQualityLock } = require("@/lib/protections");
    const now = Date.now();
    maybeApplyStreakLock(db, row.ticker, now, process.env);
    maybeApplyLowQualityLock(db, row.ticker, now, process.env);
  } catch { /* protections optional */ }
}

/**
 * Downgrade an alert whose delivery-time revalidation failed: it stays in the lab
 * for measurement but is no longer TRADE-tier, so neither Discord nor the paper
 * auto-entry path treats it as actionable. The exact reason is persisted.
 */
export function suppressAlertDelivery(alertId: number, reason: string) {
  getDb().prepare(
    "UPDATE alerts SET capture_action='WAIT', alert_tier='research', invalidation_reason=? WHERE id=?",
  ).run(reason, alertId);
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
export function tradeSignalAccuracy(opts: { days?: number; limit?: number; asset?: "options" | "stock" } = {}) {
  const db = getDb();
  ensureAlertQueryCompatColumns(db);
  const deliverySql = alertDeliveryProofSqlForDb(db, "a");
  // Validated literal (never user text) — appended to every per-tier WHERE so
  // options and stock callouts grade separately when asked.
  const assetClause =
    opts.asset === "stock" ? " AND coalesce(a.asset_class,'options') = 'stock'"
    : opts.asset === "options" ? " AND coalesce(a.asset_class,'options') = 'options'"
    : "";
  const deliveryProofClause = opts.asset === "stock" ? "" : ` AND ${deliverySql.verified}`;
  const days = Math.max(1, Number(opts.days ?? 14));
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const today = tradingDay();
  const limit = Math.min(Number(opts.limit ?? 50), 200);
  const discordSentCountSql = opts.asset === "stock"
    ? `SUM(CASE WHEN EXISTS (
              SELECT 1 FROM notification_events n
              WHERE n.alert_id = a.id AND n.channel = 'discord_webhook' AND n.status = 'sent'
            ) THEN 1 ELSE 0 END)`
    : "COUNT(*)";

  const summary: any = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN a.trading_day = ? THEN 1 ELSE 0 END) AS today_total,
            SUM(CASE WHEN a.trading_day = ? AND a.status = 'tracking' THEN 1 ELSE 0 END) AS today_tracking,
            SUM(CASE WHEN a.status = 'complete' AND a.is_false_positive = 0 THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN a.status = 'complete' AND a.is_false_positive = 1 THEN 1 ELSE 0 END) AS losses,
            SUM(CASE WHEN a.status = 'tracking' THEN 1 ELSE 0 END) AS tracking,
            SUM(CASE WHEN a.status = 'tracking' AND ${sqlEarlyOnTrack()} THEN 1 ELSE 0 END) AS live_on_track,
            SUM(CASE WHEN ${SQL_MOVE_5M} >= ${EARLY_MOVE_WIN_PCT} THEN 1 ELSE 0 END) AS early_wins,
            SUM(CASE WHEN ${SQL_MOVE_5M} IS NOT NULL AND ${SQL_MOVE_5M} < ${EARLY_MOVE_WIN_PCT} THEN 1 ELSE 0 END) AS early_losses,
            SUM(CASE WHEN ${SQL_MOVE_5M} IS NOT NULL THEN 1 ELSE 0 END) AS early_graded,
            SUM(CASE WHEN a.capture_action = 'TRADE' AND ${SQL_MOVE_5M} >= ${EARLY_MOVE_WIN_PCT} THEN 1 ELSE 0 END) AS trade_capture_early_wins,
            SUM(CASE WHEN a.capture_action = 'TRADE' AND ${SQL_MOVE_5M} IS NOT NULL AND ${SQL_MOVE_5M} < ${EARLY_MOVE_WIN_PCT} THEN 1 ELSE 0 END) AS trade_capture_early_losses,
            SUM(CASE WHEN a.capture_action = 'TRADE' AND ${SQL_MOVE_5M} IS NOT NULL THEN 1 ELSE 0 END) AS trade_capture_early_graded,
            SUM(CASE WHEN a.capture_action = 'TRADE' THEN 1 ELSE 0 END) AS trade_capture_total,
            AVG(CASE WHEN ${SQL_MOVE_5M} IS NOT NULL THEN ${SQL_MOVE_5M} END) AS avg_move_5m,
            AVG(CASE WHEN p.checkpoint = 'eod' THEN p.max_percent_move_after_alert END) AS avg_max_move,
            AVG(CASE WHEN p.checkpoint = 'eod' THEN p.percent_move_from_alert END) AS avg_eod_move,
            SUM(CASE WHEN a.option_outcome_win = 1 THEN 1 ELSE 0 END) AS option_wins,
            SUM(CASE WHEN a.option_outcome_win = 0 THEN 1 ELSE 0 END) AS option_losses,
            AVG(a.option_return_pct) AS avg_option_return,
            ${discordSentCountSql} AS discord_sent_count
     FROM alerts a
     LEFT JOIN alert_performance p ON p.alert_id = a.id AND p.checkpoint = 'eod'
     WHERE a.trading_day >= ? AND a.alert_tier = 'trade'${assetClause}${deliveryProofClause}`,
  ).get(today, today, since);

  const completed = (summary?.wins ?? 0) + (summary?.losses ?? 0);
  const hitRate = completed > 0 ? (summary.wins ?? 0) / completed : null;
  const optionCompleted = (summary?.option_wins ?? 0) + (summary?.option_losses ?? 0);
  const optionWinRate = optionCompleted > 0 ? (summary.option_wins ?? 0) / optionCompleted : null;

  const bySide = db.prepare(
    `SELECT a.option_side AS side, COUNT(*) AS total,
            SUM(CASE WHEN a.is_false_positive = 0 THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN a.is_false_positive = 1 THEN 1 ELSE 0 END) AS losses
     FROM alerts a
     WHERE a.trading_day >= ? AND a.alert_tier = 'trade'${assetClause}${deliveryProofClause} AND a.status = 'complete'
     GROUP BY a.option_side`,
  ).all(since);

  const recent = db.prepare(
    `SELECT a.id, a.ticker, a.option_side, a.strike, a.dte, a.alert_time, a.trading_day,
            a.direction, a.signal_score, a.short_rate_at_alert, a.percent_move_at_alert,
            coalesce(a.asset_class,'options') AS asset_class, a.session,
            a.status, a.is_false_positive, a.option_return_pct, a.option_outcome_win,
            (SELECT s.mid FROM options_snapshots s
             WHERE s.alert_id = a.id AND s.checkpoint = 'alert' LIMIT 1) AS entry_mid,
            (SELECT MAX(s.mid) FROM options_snapshots s
             WHERE s.alert_id = a.id AND s.checkpoint IN ('live','eod')) AS best_mid,
            (SELECT p.max_percent_move_after_alert FROM alert_performance p
             WHERE p.alert_id = a.id ORDER BY p.checked_at DESC LIMIT 1) AS latest_max_move,
            ${SQL_MOVE_1M} AS move_1m,
            ${SQL_MOVE_3M} AS move_3m,
            ${SQL_MOVE_5M} AS move_5m,
            CASE WHEN ${sqlEarlyOnTrack()} THEN 1 ELSE 0 END AS live_on_track,
            (SELECT p.percent_move_from_alert FROM alert_performance p
             WHERE p.alert_id = a.id AND p.checkpoint = 'eod') AS eod_move,
            (SELECT n.status FROM notification_events n
             WHERE n.alert_id = a.id AND n.channel = 'discord_webhook'
             ORDER BY n.id DESC LIMIT 1) AS discord_status,
            (SELECT n.error FROM notification_events n
             WHERE n.alert_id = a.id AND n.channel = 'discord_webhook'
             ORDER BY n.id DESC LIMIT 1) AS discord_note,
            1 AS discord_sent,
            1 AS subscriber_delivered,
            ${deliverySql.deliveryAlertId} AS delivery_alert_id,
            ${deliverySql.discordMessageId} AS discord_message_id,
            ${deliverySql.opportunityCaseId} AS opportunity_case_id,
            ${deliverySql.paperTradeId} AS delivered_paper_trade_id
     FROM alerts a
     WHERE a.trading_day >= ? AND a.alert_tier = 'trade'${assetClause}${deliveryProofClause}
     ORDER BY a.id DESC LIMIT ?`,
  ).all(since, limit);

  const recentWinners = db.prepare(
    `SELECT a.id, a.ticker, a.option_side, a.strike, a.dte, a.alert_time, a.trading_day,
            a.direction, a.signal_score, a.capture_action,
            a.status, a.is_false_positive, a.option_return_pct, a.option_outcome_win,
            (SELECT p.max_percent_move_after_alert FROM alert_performance p
             WHERE p.alert_id = a.id ORDER BY p.checked_at DESC LIMIT 1) AS latest_max_move,
            ${SQL_MOVE_5M} AS move_5m,
            (SELECT p.percent_move_from_alert FROM alert_performance p
             WHERE p.alert_id = a.id AND p.checkpoint = 'eod') AS eod_move
     FROM alerts a
     WHERE a.trading_day >= ? AND a.alert_tier = 'trade'${assetClause}${deliveryProofClause} AND ${SQL_WINNER}
     ORDER BY COALESCE(${SQL_MOVE_5M}, latest_max_move, eod_move, 0) DESC, a.id DESC LIMIT 25`,
  ).all(since);

  const winnersToday: any = db.prepare(
    `SELECT COUNT(*) AS cnt FROM alerts a
     WHERE a.trading_day = ? AND a.alert_tier = 'trade'${assetClause}${deliveryProofClause} AND ${SQL_WINNER}`,
  ).get(today);

  const onTrackNow = db.prepare(
    `SELECT a.id, a.ticker, a.option_side, a.strike, a.dte, a.alert_time, a.trading_day,
            a.direction, coalesce(a.asset_class,'options') AS asset_class, a.session,
            a.status, a.option_return_pct, a.option_outcome_win,
            (SELECT s.mid FROM options_snapshots s
             WHERE s.alert_id = a.id AND s.checkpoint = 'alert' LIMIT 1) AS entry_mid,
            (SELECT MAX(s.mid) FROM options_snapshots s
             WHERE s.alert_id = a.id AND s.checkpoint IN ('live','eod')) AS best_mid,
            (SELECT p.max_percent_move_after_alert FROM alert_performance p
             WHERE p.alert_id = a.id ORDER BY p.checked_at DESC LIMIT 1) AS latest_max_move,
            ${SQL_MOVE_1M} AS move_1m,
            ${SQL_MOVE_3M} AS move_3m,
            ${SQL_MOVE_5M} AS move_5m,
            1 AS discord_sent,
            1 AS subscriber_delivered,
            ${deliverySql.deliveryAlertId} AS delivery_alert_id,
            ${deliverySql.discordMessageId} AS discord_message_id,
            ${deliverySql.opportunityCaseId} AS opportunity_case_id,
            ${deliverySql.paperTradeId} AS delivered_paper_trade_id
     FROM alerts a
     WHERE a.trading_day >= ? AND a.alert_tier = 'trade'${assetClause}${deliveryProofClause} AND a.status = 'tracking'
       AND ${sqlEarlyOnTrack()}
     ORDER BY ${SQL_MOVE_5M} DESC, ${SQL_MOVE_1M} DESC LIMIT 50`,
  ).all(since);

  const todayOnTrack: any = db.prepare(
    `SELECT COUNT(*) AS cnt FROM alerts a
     WHERE a.trading_day = ? AND a.alert_tier = 'trade'${assetClause}${deliveryProofClause} AND a.status = 'tracking'
       AND ${sqlEarlyOnTrack()}`,
  ).get(today);

  const completedToday: any = db.prepare(
    `SELECT COUNT(*) AS cnt FROM alerts a
     WHERE a.trading_day = ? AND a.alert_tier = 'trade'${assetClause}${deliveryProofClause} AND a.status = 'complete'`,
  ).get(today);

  const dailyTrend = db.prepare(
    `SELECT a.trading_day AS day,
            COUNT(*) AS total,
            SUM(CASE WHEN a.status = 'complete' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN a.status = 'complete' AND a.is_false_positive = 0 THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN a.status = 'complete' AND a.is_false_positive = 1 THEN 1 ELSE 0 END) AS losses,
            SUM(CASE WHEN a.status = 'tracking' THEN 1 ELSE 0 END) AS tracking,
            SUM(CASE WHEN a.status = 'tracking' AND ${sqlEarlyOnTrack()} THEN 1 ELSE 0 END) AS live_on_track,
            AVG(CASE WHEN ${SQL_MOVE_5M} IS NOT NULL THEN ${SQL_MOVE_5M} END) AS avg_move_5m,
            SUM(CASE WHEN ${SQL_MOVE_5M} >= ${EARLY_MOVE_WIN_PCT} THEN 1 ELSE 0 END) AS early_wins,
            SUM(CASE WHEN ${SQL_MOVE_5M} IS NOT NULL AND ${SQL_MOVE_5M} < ${EARLY_MOVE_WIN_PCT} THEN 1 ELSE 0 END) AS early_losses,
            SUM(CASE WHEN a.option_outcome_win = 1 THEN 1 ELSE 0 END) AS option_wins,
            SUM(CASE WHEN a.option_outcome_win = 0 THEN 1 ELSE 0 END) AS option_losses,
            AVG(CASE WHEN p.checkpoint = 'eod' THEN p.max_percent_move_after_alert END) AS avg_max_move
     FROM alerts a
     LEFT JOIN alert_performance p ON p.alert_id = a.id AND p.checkpoint = 'eod'
     WHERE a.trading_day >= ? AND a.alert_tier = 'trade'${assetClause}${deliveryProofClause}
     GROUP BY a.trading_day
     ORDER BY a.trading_day ASC`,
  ).all(since).map((row: any) => mapDailyTrendRow(row));

  const liveOnTrack = summary?.live_on_track ?? 0;
  const todayTotal = summary?.today_total ?? 0;
  const todayTracking = summary?.today_tracking ?? 0;
  const todayOnTrackCount = todayOnTrack?.cnt ?? 0;
  const liveOnTrackPct = onTrackPct(todayOnTrackCount, todayTotal);
  const liveOnTrackOfOpenPct = onTrackPct(todayOnTrackCount, todayTracking);
  const earlyGraded = (summary?.early_graded ?? 0) as number;
  const earlyHitRate = earlyGraded > 0 ? (summary?.early_wins ?? 0) / earlyGraded : null;
  const tradeCaptureGraded = (summary?.trade_capture_early_graded ?? 0) as number;
  const tradeCaptureEarlyHitRate =
    tradeCaptureGraded > 0 ? (summary?.trade_capture_early_wins ?? 0) / tradeCaptureGraded : null;

  return {
    since,
    days,
    total: summary?.total ?? 0,
    todayTotal,
    todayTracking,
    todayOnTrack: todayOnTrackCount,
    winnersToday: winnersToday?.cnt ?? 0,
    completedToday: completedToday?.cnt ?? 0,
    wins: summary?.wins ?? 0,
    losses: summary?.losses ?? 0,
    tracking: summary?.tracking ?? 0,
    liveOnTrack,
    liveOnTrackOfToday: formatOnTrackRatio(todayOnTrackCount, todayTotal),
    liveOnTrackPct,
    liveOnTrackOfOpen: formatOnTrackRatio(todayOnTrackCount, todayTracking),
    liveOnTrackOfOpenPct,
    overallHitRate: hitRate,
    earlyWins: summary?.early_wins ?? 0,
    earlyLosses: summary?.early_losses ?? 0,
    earlyGraded,
    earlyHitRate,
    tradeCaptureTotal: summary?.trade_capture_total ?? 0,
    tradeCaptureEarlyWins: summary?.trade_capture_early_wins ?? 0,
    tradeCaptureEarlyLosses: summary?.trade_capture_early_losses ?? 0,
    tradeCaptureEarlyGraded: tradeCaptureGraded,
    tradeCaptureEarlyHitRate,
    avgMove5m: summary?.avg_move_5m ?? null,
    earlyMoveWinPct: EARLY_MOVE_WIN_PCT,
    earlyOnTrackMinPct: EARLY_ON_TRACK_MIN_PCT,
    discordSentCount: summary?.discord_sent_count ?? 0,
    hitRate,
    avgMaxMove: summary?.avg_max_move ?? null,
    avgEodMove: summary?.avg_eod_move ?? null,
    optionWins: summary?.option_wins ?? 0,
    optionLosses: summary?.option_losses ?? 0,
    optionWinRate,
    avgOptionReturn: summary?.avg_option_return ?? null,
    bySide,
    recent,
    onTrackNow,
    recentWinners,
    dailyTrend,
    note: "On-track = favorable move building (1m/5m or peak). Winners = completed win, early 5m hit, or option +15%. TRADE headline locks 3 min after fire unless tape reverses.",
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
  source: "source", importBatchId: "import_batch_id", dedupKey: "dedup_key",
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

export function journalDedupExists(dedupKey: string): boolean {
  if (!dedupKey) return false;
  return Boolean(getDb().prepare("SELECT 1 FROM trade_journal WHERE dedup_key=?").get(dedupKey));
}

export function insertBrokerImport(meta: {
  broker?: string;
  filename?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  rowCount?: number;
}): number {
  const res = getDb().prepare(
    `INSERT INTO broker_imports (broker, filename, period_start, period_end, row_count) VALUES (?,?,?,?,?)`,
  ).run(
    meta.broker ?? "robinhood",
    meta.filename ?? null,
    meta.periodStart ?? null,
    meta.periodEnd ?? null,
    meta.rowCount ?? 0,
  );
  return Number(res.lastInsertRowid);
}

export function lastBrokerImport() {
  return getDb().prepare(
    "SELECT * FROM broker_imports ORDER BY imported_at DESC LIMIT 1",
  ).get();
}

/** Match imported trade to a scanner callout within ±15 min. */
export function findAlertForJournal(ticker: string, openedAt: string | null): number | null {
  if (!openedAt) return null;
  const t = Date.parse(openedAt);
  if (!Number.isFinite(t)) return null;
  const from = new Date(t - 15 * 60_000).toISOString();
  const to = new Date(t + 15 * 60_000).toISOString();
  const row: any = getDb().prepare(
    `SELECT id FROM alerts WHERE ticker=? AND alert_time BETWEEN ? AND ? ORDER BY id DESC LIMIT 1`,
  ).get(ticker.toUpperCase(), from, to);
  return row?.id ?? null;
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
    if (k in patch) {
      // Discord is auto-send only — ignore attempts to re-enable manual confirm.
      if (k === "discordRequiresManualConfirm" && patch[k]) continue;
      sets.push(`${col} = ?`);
      params.push(patch[k] ? 1 : 0);
    }
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

/** Latest sent Discord BUY for an alert (for result PATCH). */
export function getSentDiscordForAlert(alertId: number) {
  return getDb().prepare(
    `SELECT * FROM notification_events
     WHERE alert_id=? AND channel='discord_webhook' AND status='sent'
       AND payload_json LIKE '%messageId%'
     ORDER BY id DESC LIMIT 1`,
  ).get(alertId) as any;
}

/** True if a WATCH was sent for this ticker within the dedup window. */
export function recentWatchDiscordForTicker(ticker: string, withinMs: number): boolean {
  const since = new Date(Date.now() - withinMs).toISOString();
  const row: any = getDb().prepare(
    `SELECT 1 FROM notification_events
     WHERE channel='discord_webhook' AND status='sent' AND created_at >= ?
       AND payload_json LIKE '%"kind":"watch"%' AND payload_json LIKE ?
     LIMIT 1`,
  ).get(since, `%"ticker":"${ticker}"%`);
  return Boolean(row);
}

export function markNotificationEvent(id: number, status: string, error?: string | null) {
  getDb().prepare(
    "UPDATE notification_events SET status=?, error=?, sent_at=CASE WHEN ?='sent' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE sent_at END WHERE id=?",
  ).run(status, error ?? null, status, id);
}

export type DiscordDeliveryStatus =
  | "PENDING"
  | "SENDING"
  | "SENT"
  | "FAILED"
  | "RETRYING"
  | "SUPPRESSED"
  | "NOT_CONFIGURED";

export function createDiscordDelivery(input: {
  alertId?: number | null;
  channelType: string;
  webhookName: string;
  payloadType: string;
  payload: unknown;
  status?: DiscordDeliveryStatus;
  idempotencyKey?: string | null;
  failureReason?: string | null;
}): string {
  const deliveryId = `dd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const payloadJson = JSON.stringify(input.payload ?? {});
  const preview = payloadJson.replace(/\s+/g, " ").slice(0, 500);
  const idempotencyKey = input.idempotencyKey ?? `${input.alertId ?? "test"}:${input.webhookName}:${input.payloadType}:${preview.slice(0, 80)}`;
  const existing: any = getDb().prepare("SELECT delivery_id FROM discord_deliveries WHERE idempotency_key=?").get(idempotencyKey);
  if (existing?.delivery_id) return existing.delivery_id;
  getDb().prepare(
    `INSERT INTO discord_deliveries
       (delivery_id, alert_id, channel_type, webhook_name, payload_type, payload_preview, payload_json,
        idempotency_key, status, failure_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    deliveryId,
    input.alertId ?? null,
    input.channelType,
    input.webhookName,
    input.payloadType,
    preview,
    payloadJson,
    idempotencyKey,
    input.status ?? "PENDING",
    input.failureReason ?? null,
  );
  return deliveryId;
}

export function updateDiscordDelivery(deliveryId: string, patch: {
  status?: DiscordDeliveryStatus;
  httpStatus?: number | null;
  responseBodySafe?: string | null;
  failureReason?: string | null;
  retryCountDelta?: number;
  nextRetryAt?: string | null;
  attempted?: boolean;
  sent?: boolean;
}) {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status) { sets.push("status=?"); params.push(patch.status); }
  if ("httpStatus" in patch) { sets.push("http_status=?"); params.push(patch.httpStatus ?? null); }
  if ("responseBodySafe" in patch) { sets.push("response_body_safe=?"); params.push(patch.responseBodySafe?.slice(0, 500) ?? null); }
  if ("failureReason" in patch) { sets.push("failure_reason=?"); params.push(patch.failureReason?.slice(0, 500) ?? null); }
  if ("nextRetryAt" in patch) { sets.push("next_retry_at=?"); params.push(patch.nextRetryAt ?? null); }
  if (patch.retryCountDelta) sets.push(`retry_count=retry_count+${Math.max(0, Math.floor(patch.retryCountDelta))}`);
  if (patch.attempted) sets.push("attempted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  if (patch.sent) sets.push("sent_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  if (!sets.length) return;
  params.push(deliveryId);
  getDb().prepare(`UPDATE discord_deliveries SET ${sets.join(", ")} WHERE delivery_id=?`).run(...params);
}

export function getDiscordDelivery(deliveryId: string) {
  return getDb().prepare("SELECT * FROM discord_deliveries WHERE delivery_id=?").get(deliveryId) as any;
}

/** Look up an existing delivery by its idempotency key (for callout dedup). */
export function getDiscordDeliveryByIdempotencyKey(idempotencyKey: string) {
  return getDb().prepare("SELECT * FROM discord_deliveries WHERE idempotency_key=?").get(idempotencyKey) as any;
}

export function listDiscordDeliveries(limit = 100, status?: string | null) {
  const capped = Math.max(1, Math.min(500, Number(limit) || 100));
  // LEFT JOIN alerts so the delivery ledger UI can show ticker + setup type
  // without exposing the raw payload (which may embed webhook context).
  const base =
    `SELECT d.*, a.ticker AS ticker, a.source AS setup_type, a.option_side AS option_side, a.direction AS direction
     FROM discord_deliveries d
     LEFT JOIN alerts a ON a.id = d.alert_id`;
  if (status) {
    return getDb().prepare(`${base} WHERE d.status=? ORDER BY d.created_at DESC LIMIT ?`).all(status, capped) as any[];
  }
  return getDb().prepare(`${base} ORDER BY d.created_at DESC LIMIT ?`).all(capped) as any[];
}

export function discordDeliverySummary() {
  return getDb().prepare(
    `SELECT status, COUNT(*) AS count FROM discord_deliveries GROUP BY status ORDER BY status`,
  ).all() as any[];
}

export function discordDeliveryWindowMetrics(hours = 24) {
  const capped = Math.max(1, Math.min(168, Math.floor(Number(hours) || 24)));
  const sinceMod = `-${capped} hours`;
  const rows = getDb().prepare(
    `SELECT status, COUNT(*) AS count
       FROM discord_deliveries
      WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
      GROUP BY status`,
  ).all(sinceMod) as { status: string; count: number }[];
  const byStatus = Object.fromEntries(rows.map((r) => [String(r.status), Number(r.count ?? 0)]));
  const scalar = (sql: string) => (getDb().prepare(sql).get() as any)?.v ?? null;
  const stuck = Number((getDb().prepare(
    `SELECT COUNT(*) AS v FROM discord_deliveries
      WHERE status IN ('PENDING','SENDING')
        AND created_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes')`,
  ).get() as any)?.v ?? 0);
  return {
    hours: capped,
    byStatus,
    total24h: rows.reduce((n, r) => n + Number(r.count ?? 0), 0),
    sent24h: byStatus.SENT ?? 0,
    failed24h: byStatus.FAILED ?? 0,
    retrying24h: byStatus.RETRYING ?? 0,
    suppressed24h: byStatus.SUPPRESSED ?? 0,
    notConfigured24h: byStatus.NOT_CONFIGURED ?? 0,
    pending24h: byStatus.PENDING ?? 0,
    sending24h: byStatus.SENDING ?? 0,
    stuckInFlight: stuck,
    lastDeliveryAt: scalar("SELECT MAX(created_at) AS v FROM discord_deliveries"),
    lastSentAt: scalar("SELECT MAX(sent_at) AS v FROM discord_deliveries WHERE sent_at IS NOT NULL"),
    lastFailureAt: scalar("SELECT MAX(created_at) AS v FROM discord_deliveries WHERE status IN ('FAILED','RETRYING','SUPPRESSED','NOT_CONFIGURED')"),
  };
}

export function retryableDiscordDeliveries(limit = 25) {
  return getDb().prepare(
    `SELECT * FROM discord_deliveries
     WHERE status IN ('FAILED','RETRYING')
       AND retry_count < 3
       AND (next_retry_at IS NULL OR next_retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ORDER BY created_at ASC LIMIT ?`,
  ).all(Math.max(1, Math.min(100, Number(limit) || 25))) as any[];
}
