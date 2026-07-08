/** Twitter / Discord copy for daily callout posts — UI only, not signal math. */

import { formatCalloutHeadline } from "@/lib/format-contract";

export function formatAlertTweet(a: {
  ticker?: string | null;
  option_side?: string | null;
  strike?: number | null;
  dte?: number | null;
  capture_action?: string | null;
  asset_class?: string | null;
  option_return_pct?: number | null;
  latest_max_move?: number | null;
  eod_move?: number | null;
  alert_time?: string | null;
  entry_mid?: number | null;
  entry_spread_pct?: number | null;
}): string {
  const side = String(a.option_side ?? "").toUpperCase().startsWith("P") ? "PUT" : "CALL";
  const headline = formatCalloutHeadline(a);
  const ret = a.option_return_pct ?? a.latest_max_move ?? a.eod_move;
  const retLine = ret != null ? `${ret >= 0 ? "+" : ""}${Math.round(ret)}% on contract` : "tracking open";
  const contract =
    a.strike != null
      ? `$${a.strike} ${side}${a.dte != null ? ` · ${a.dte}DTE` : ""}`
      : side;
  const time = a.alert_time
    ? new Date(a.alert_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })
    : "";
  return [
    `${headline} · ${a.ticker ?? "?"}`,
    contract,
    retLine,
    time ? `Called ${time} ET` : "",
    "#0DTE #options",
  ].filter(Boolean).join("\n");
}

export function formatDailyRecapTweet(alerts: Array<{
  asset_class?: string | null;
  capture_action?: string | null;
  option_return_pct?: number | null;
  latest_max_move?: number | null;
  option_outcome_win?: number | null;
}>): string {
  const options = alerts.filter((a) => a.asset_class !== "stock");
  const trades = options.filter((a) => String(a.capture_action).toUpperCase() === "TRADE");
  const graded = options.filter((a) => {
    const r = a.option_return_pct ?? a.latest_max_move;
    return r != null;
  });
  const wins = graded.filter((a) => (a.option_return_pct ?? a.latest_max_move ?? 0) > 0);
  const totalRet = graded.reduce((s, a) => s + (a.option_return_pct ?? a.latest_max_move ?? 0), 0);
  const avg = graded.length ? totalRet / graded.length : 0;

  return [
    `📊 Today's 0DTE desk`,
    `${trades.length} BUY callouts · ${options.length} total signals`,
    graded.length
      ? `${wins.length}/${graded.length} green · avg ${avg >= 0 ? "+" : ""}${Math.round(avg)}% on contracts`
      : `${options.length} signals · grading at EOD`,
    `Join the Discord for live alerts 👇`,
    "#0DTE #daytrading #options",
  ].join("\n");
}

export function postableOptionsAlerts<T extends {
  asset_class?: string | null;
  capture_action?: string | null;
  entry_spread_pct?: number | null;
  signal_score?: number | null;
  short_rate_at_alert?: number | null;
  volume_surge_at_alert?: number | null;
  move_status?: string | null;
}>(alerts: T[]): T[] {
  return alerts.filter((a) => {
    if (a.asset_class === "stock") return false;
    const spread = a.entry_spread_pct;
    const score = a.signal_score ?? 0;
    const speed = Math.abs(Number(a.short_rate_at_alert ?? 0));
    const surge = Number(a.volume_surge_at_alert ?? 0);
    const moveOk = !a.move_status || !["exhausted", "extended_risky", "continuing"].includes(a.move_status);
    if (String(a.capture_action).toUpperCase() === "TRADE") {
      return spread != null && spread <= 5 && score >= 84 && moveOk;
    }
    return spread != null && spread <= 5 && score >= 84 && speed >= 0.22 && surge >= 2.2 && moveOk;
  });
}

export function formatWeeklyDiscordPitch(alerts: Array<{
  asset_class?: string | null;
  capture_action?: string | null;
  option_return_pct?: number | null;
  latest_max_move?: number | null;
  ticker?: string | null;
  trading_day?: string | null;
}>): string {
  const premium = premiumDiscordCallouts(alerts);
  const graded = premium.filter((a) => (a.option_return_pct ?? a.latest_max_move) != null);
  const wins = graded.filter((a) => (a.option_return_pct ?? a.latest_max_move ?? 0) > 0);
  const total = graded.reduce((s, a) => s + (a.option_return_pct ?? a.latest_max_move ?? 0), 0);
  const avg = graded.length ? total / graded.length : 0;
  const best = [...graded].sort(
    (a, b) => (b.option_return_pct ?? b.latest_max_move ?? -999) - (a.option_return_pct ?? a.latest_max_move ?? -999),
  )[0];
  const bestLine = best
    ? `Best: ${best.ticker} ${best.option_return_pct != null ? `+${Math.round(best.option_return_pct)}%` : ""}`
    : "";

  return [
    `🔥 This week's 0DTE desk (verified BUY callouts only)`,
    `${premium.length} BUY signals · tight spreads · liquid names`,
    graded.length
      ? `${wins.length}/${graded.length} winners · avg ${avg >= 0 ? "+" : ""}${Math.round(avg)}% per contract`
      : "Live grading through the week",
    bestLine,
    `Want these live? Join Discord — weekly access.`,
    "#0DTE #options #daytrading",
  ].filter(Boolean).join("\n");
}

/** Only TRADE-tier, fillable — what you sell on Discord. */
export function premiumDiscordCallouts<T extends {
  asset_class?: string | null;
  capture_action?: string | null;
  entry_spread_pct?: number | null;
  signal_score?: number | null;
  short_rate_at_alert?: number | null;
  volume_surge_at_alert?: number | null;
  move_status?: string | null;
}>(alerts: T[]): T[] {
  return postableOptionsAlerts(alerts).filter(
    (a) => String(a.capture_action ?? "").toUpperCase() === "TRADE",
  );
}

export function alertsInLastDays<T extends { trading_day?: string | null; alert_time?: string | null }>(
  alerts: T[],
  days: number,
): T[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return alerts.filter((a) => {
    const t = a.alert_time ? Date.parse(a.alert_time) : Date.parse(`${a.trading_day}T16:00:00`);
    return Number.isFinite(t) && t >= cutoff;
  });
}
export function dailyPnlSummary(alerts: Array<{
  asset_class?: string | null;
  option_return_pct?: number | null;
  latest_max_move?: number | null;
  capture_action?: string | null;
}>) {
  const options = postableOptionsAlerts(alerts);
  const graded = options.filter((a) => (a.option_return_pct ?? a.latest_max_move) != null);
  const wins = graded.filter((a) => (a.option_return_pct ?? a.latest_max_move ?? 0) > 0);
  const total = graded.reduce((s, a) => s + (a.option_return_pct ?? a.latest_max_move ?? 0), 0);
  return {
    totalCallouts: options.length,
    buyCount: options.filter((a) => String(a.capture_action).toUpperCase() === "TRADE").length,
    graded: graded.length,
    wins: wins.length,
    totalReturnPct: total,
    avgReturnPct: graded.length ? total / graded.length : null,
  };
}
