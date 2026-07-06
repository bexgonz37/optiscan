/**
 * halt-inference.ts — infer halt/resume state and catalyst freshness from headlines.
 */

const HALT_RE = /\b(trading halt|halted|volatility pause|luld pause|limit up|limit down|news pending|t1 halt|t2 halt)\b/i;
const RESUME_RE = /\b(resume(s|d)? trading|trading resumed|halt lifted|halt canceled)\b/i;

/** Latest halt signal from headline text, if any. */
export function inferHaltStatus(headlines: string[] = []): "halted" | "resumed" | null {
  for (const raw of headlines) {
    const h = String(raw ?? "");
    if (RESUME_RE.test(h)) return "resumed";
    if (HALT_RE.test(h)) return "halted";
  }
  return null;
}

/** True when the newest matching headline is under 30 minutes old. */
export function catalystFresh(publishedAt: string | null | undefined, nowMs = Date.now()): boolean {
  if (!publishedAt) return false;
  const t = Date.parse(publishedAt);
  return Number.isFinite(t) && nowMs - t <= 30 * 60_000;
}

/** Pick catalyst type from the freshest headline in a news batch. */
export function catalystFromNews(
  articles: Array<{ title?: string | null; publishedAt?: string | null; published_utc?: string | null }>,
  classifyHeadline: (title: string) => string,
  nowMs = Date.now(),
): { catalystType: string; catalystFresh: boolean } {
  let best: { type: string; t: number } | null = null;
  for (const a of articles ?? []) {
    const title = a.title ?? "";
    const ts = Date.parse(a.publishedAt ?? a.published_utc ?? "");
    const type = classifyHeadline(title);
    if (!Number.isFinite(ts)) continue;
    if (!best || ts > best.t) best = { type, t: ts };
  }
  if (!best) return { catalystType: "no_clear_catalyst", catalystFresh: false };
  return { catalystType: best.type, catalystFresh: nowMs - best.t <= 30 * 60_000 };
}
