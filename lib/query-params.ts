/**
 * query-params.ts — safe numeric parsing for URL search parameters.
 *
 * WHY THIS EXISTS. `Number(url.searchParams.get("limit"))` returns 0 when the
 * parameter is ABSENT, because `Number(null)` is 0 and `Number.isFinite(0)` is
 * true. Every "parse, then fall back if not finite" idiom therefore silently
 * skips its own default and clamps to the minimum instead.
 *
 * On /api/research/asymmetry/timing this turned a documented default of 200
 * rows into 1 row. The endpoint then reported `notifiedCaptures: 0` and
 * `immediateAlerts: 0` for a session that had genuinely alerted — because both
 * counters were computed from a one-row sample — while the SQL-derived
 * `ratio.notified` correctly said 1. Two counters over one session disagreed,
 * and the truncated one was believed. The same one-row sample also produced the
 * `distributions` block, so the alert was described with a DIFFERENT case's
 * strategy and state.
 *
 * A truncated sample that still looks like a full answer is worse than an
 * error, so absence is handled explicitly here rather than at each call site.
 */

/**
 * Read a bounded integer query parameter.
 *
 * Absent, empty, or non-numeric all yield `fallback` — never the clamped 0 that
 * `Number(null)` produces. A supplied value is clamped into [min, max].
 */
export function intParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = params.get(name);
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
