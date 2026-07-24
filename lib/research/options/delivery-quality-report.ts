/**
 * Discord delivery quality report — before/after style stats from options_delivery_decisions.
 * Used to validate OPTIONS_QUALITY_DELIVER_BAR / MAX_DELIVER_PER_FLUSH changes.
 */
export interface DiscordQualityWindowStats {
  label: string;
  fromMs: number;
  toMs: number;
  decisions: number;
  deliverIntent: number;
  researchOnly: number;
  rejected: number;
  deliveredFinal: number;
  avgQuality: number | null;
  avgDeliveredQuality: number | null;
  highQualityDelivered: number; // quality >= 0.75
  midBandResearchOnly: number; // 0.55 <= q < deliverBar and RESEARCH_ONLY
  subscriberAlertCount: number;
  missedFastMoversProxy: number; // Tier0 RESEARCH_ONLY with quality >= 0.65
  falsePositiveProxy: number; // delivered with quality < 0.70 (should be rare after raise)
}

export interface DiscordQualityReport {
  generatedAtMs: number;
  deliverBar: number;
  maxPerFlush: number;
  before: DiscordQualityWindowStats;
  after: DiscordQualityWindowStats;
  note: string;
}

function num(env: NodeJS.ProcessEnv, k: string, d: number): number {
  const n = Number(env[k]);
  return Number.isFinite(n) ? n : d;
}

function windowStats(
  db: { prepare: (sql: string) => { get: (...a: any[]) => any; all?: (...a: any[]) => any[] } },
  label: string,
  fromMs: number,
  toMs: number,
  deliverBar: number,
): DiscordQualityWindowStats {
  const has = Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_delivery_decisions'`).get(),
  );
  if (!has) {
    return {
      label,
      fromMs,
      toMs,
      decisions: 0,
      deliverIntent: 0,
      researchOnly: 0,
      rejected: 0,
      deliveredFinal: 0,
      avgQuality: null,
      avgDeliveredQuality: null,
      highQualityDelivered: 0,
      midBandResearchOnly: 0,
      subscriberAlertCount: 0,
      missedFastMoversProxy: 0,
      falsePositiveProxy: 0,
    };
  }

  const rows = (db
    .prepare(
      `SELECT outcome, final_delivery_outcome, quality, tier, reason
       FROM options_delivery_decisions
       WHERE created_at_ms >= ? AND created_at_ms < ?`,
    )
    .all?.(fromMs, toMs) ?? []) as Array<Record<string, any>>;

  let deliverIntent = 0;
  let researchOnly = 0;
  let rejected = 0;
  let deliveredFinal = 0;
  let qSum = 0;
  let qN = 0;
  let dqSum = 0;
  let dqN = 0;
  let highQualityDelivered = 0;
  let midBandResearchOnly = 0;
  let missedFastMoversProxy = 0;
  let falsePositiveProxy = 0;

  for (const r of rows) {
    const outcome = String(r.outcome ?? "");
    const final = String(r.final_delivery_outcome ?? "");
    const q = Number(r.quality);
    const tier = Number(r.tier);
    if (Number.isFinite(q)) {
      qSum += q;
      qN += 1;
    }
    if (outcome === "DELIVER_TO_DISCORD") deliverIntent += 1;
    else if (outcome === "RESEARCH_ONLY") researchOnly += 1;
    else if (outcome === "REJECT") rejected += 1;

    const sent = final === "DELIVERED" || (outcome === "DELIVER_TO_DISCORD" && (final === "" || final === "SKIPPED") && Number(r.delivery_sent) === 1);
    // Prefer explicit DELIVERED
    if (final === "DELIVERED") {
      deliveredFinal += 1;
      if (Number.isFinite(q)) {
        dqSum += q;
        dqN += 1;
        if (q >= 0.75) highQualityDelivered += 1;
        if (q < 0.7) falsePositiveProxy += 1;
      }
    }
    if (outcome === "RESEARCH_ONLY" && Number.isFinite(q) && q >= 0.55 && q < deliverBar) midBandResearchOnly += 1;
    if (outcome === "RESEARCH_ONLY" && tier === 0 && Number.isFinite(q) && q >= 0.65) missedFastMoversProxy += 1;
  }

  let subscriberAlertCount = 0;
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_alerts'`).get()) {
    subscriberAlertCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM options_alerts WHERE state='SENT' AND sent_at_ms >= ? AND sent_at_ms < ?`,
          )
          .get(fromMs, toMs) as { n: number } | undefined
      )?.n ?? 0,
    );
  }

  return {
    label,
    fromMs,
    toMs,
    decisions: rows.length,
    deliverIntent,
    researchOnly,
    rejected,
    deliveredFinal: deliveredFinal || subscriberAlertCount,
    avgQuality: qN ? +(qSum / qN).toFixed(4) : null,
    avgDeliveredQuality: dqN ? +(dqSum / dqN).toFixed(4) : null,
    highQualityDelivered,
    midBandResearchOnly,
    subscriberAlertCount,
    missedFastMoversProxy,
    falsePositiveProxy,
  };
}

/**
 * Compare decisions before vs after the quality-bar raise.
 * Default split: last 7d before changePoint vs since changePoint (or last 24h if unset).
 */
export function buildDiscordQualityReport(
  db: { prepare: (sql: string) => { get: (...a: any[]) => any; all?: (...a: any[]) => any[] } },
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): DiscordQualityReport {
  const deliverBar = num(env, "OPTIONS_QUALITY_DELIVER_BAR", 0.7);
  const maxPerFlush = Math.max(1, Math.floor(num(env, "OPTIONS_MAX_DELIVER_PER_FLUSH", 1)));
  // Change point: when bar was raised in prod (~ commit f6631e2). Override via env.
  const changePoint = num(env, "DISCORD_QUALITY_CHANGE_MS", nowMs - 6 * 60 * 60_000);
  const beforeFrom = changePoint - 7 * 24 * 60 * 60_000;
  const afterTo = nowMs;

  return {
    generatedAtMs: nowMs,
    deliverBar,
    maxPerFlush,
    before: windowStats(db, "before_bar_raise", beforeFrom, changePoint, 0.62),
    after: windowStats(db, "after_bar_raise", changePoint, afterTo, deliverBar),
    note:
      "Before window uses historical decisions under prior ~0.62 bar. After window uses current bar. " +
      "missedFastMoversProxy = Tier0 RESEARCH_ONLY with quality≥0.65. falsePositiveProxy = DELIVERED with quality<0.70.",
  };
}
