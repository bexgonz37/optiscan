/**
 * alert-timing.ts — PURE alert-timing diagnostics + quality metrics (§8/§9).
 *
 * The runtime records one AlertTimingRecord per callout decision (detected /
 * trigger-confirmed / callout-created / Discord-sent timestamps, quote age,
 * seconds-since-trigger, distance-from-trigger, entry-window validity, and the
 * late-rejection reason). This module aggregates those records into the owner
 * quality metrics — it computes, it does not fabricate: a metric with no data
 * reports null, never a made-up number.
 */

export interface AlertTimingRecord {
  /** Entry-window state at decision time. */
  entryState: string | null;
  /** Seconds between the trigger confirming and the alert (null if unknown). */
  secondsSinceTrigger: number | null;
  /** |distance| from the trigger level in % at send time (null if unknown). */
  distanceFromTriggerPct: number | null;
  /** Was the entry window still valid when the alert was produced? */
  entryWindowValid: boolean;
  /** Did an actionable Discord alert actually send? */
  sent: boolean;
  /** Latency from trigger confirmation to the Discord send (ms), when sent. */
  triggerToDiscordMs: number | null;
  /** Was this downgraded to MISSED / rejected for extension? */
  downgradedMissed: boolean;
  rejectedForExtension: boolean;
  /** Paper fill outcome (null = no paper fill from this alert). */
  paperFilledInsideWindow: boolean | null;
  /**
   * Was this callout rescued to ACTIONABLE by the deterministic breakout-crossing
   * latch (the breakout crossed the entry band between supervisor cycles)? Optional
   * so pre-latch records remain valid; instrumentation for measuring how often the
   * latch recovers an otherwise-missed breakout. Never fabricated.
   */
  crossingRescued?: boolean;
}

export interface AlertTimingSummary {
  total: number;
  sentBeforeTrigger: number;   // alerted while still EARLY/NEAR_TRIGGER (ahead of the move)
  sentAtTrigger: number;       // alerted as ACTIONABLE inside the window
  sentLate: number;            // alerted while EXTENDED/MISSED/INVALIDATED
  downgradedToMissed: number;
  rejectedForExtension: number;
  avgTriggerToDiscordMs: number | null;
  pctValidWindowAtSend: number | null;
  pctRejectedForExtension: number | null;
  paperFillsInsideWindow: number;
  paperFillsOutsideWindow: number;
  /** How many callouts the breakout-crossing latch rescued to ACTIONABLE. */
  crossingRescues: number;
}

const EARLY_STATES = new Set(["EARLY", "NEAR_TRIGGER", "DEVELOPING"]);
const LATE_STATES = new Set(["EXTENDED", "MISSED", "INVALIDATED"]);

export function summarizeAlertTiming(records: AlertTimingRecord[]): AlertTimingSummary {
  const total = records.length;
  let sentBeforeTrigger = 0, sentAtTrigger = 0, sentLate = 0;
  let downgradedToMissed = 0, rejectedForExtension = 0;
  let paperInside = 0, paperOutside = 0;
  let crossingRescues = 0;
  const latencies: number[] = [];
  let sentCount = 0, sentWithValidWindow = 0;

  for (const r of records) {
    const es = r.entryState ?? "";
    if (r.sent) {
      sentCount++;
      if (r.entryWindowValid) sentWithValidWindow++;
      if (LATE_STATES.has(es)) sentLate++;
      else if (es === "ACTIONABLE" || es === "ACTIONABLE_NOW") sentAtTrigger++;
      else if (EARLY_STATES.has(es)) sentBeforeTrigger++;
      if (r.triggerToDiscordMs != null && Number.isFinite(r.triggerToDiscordMs)) latencies.push(r.triggerToDiscordMs);
    }
    if (r.downgradedMissed) downgradedToMissed++;
    if (r.rejectedForExtension) rejectedForExtension++;
    if (r.paperFilledInsideWindow === true) paperInside++;
    else if (r.paperFilledInsideWindow === false) paperOutside++;
    if (r.crossingRescued === true) crossingRescues++;
  }

  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
  return {
    total,
    sentBeforeTrigger,
    sentAtTrigger,
    sentLate,
    downgradedToMissed,
    rejectedForExtension,
    avgTriggerToDiscordMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    pctValidWindowAtSend: pct(sentWithValidWindow, sentCount),
    pctRejectedForExtension: pct(rejectedForExtension, total),
    paperFillsInsideWindow: paperInside,
    paperFillsOutsideWindow: paperOutside,
    crossingRescues,
  };
}
