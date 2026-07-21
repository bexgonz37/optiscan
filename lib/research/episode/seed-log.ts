/**
 * lib/research/episode/seed-log.ts — structured (one-JSON-line) logging + an event-loop lag
 * sampler for the async seed pipeline (Analog Engine, Phase E.4). Logging is intentionally cheap
 * and synchronous-console only; it never touches the DB or the network so it cannot itself block.
 *
 * Enable verbose seed logs with SEED_LOG=1 (errors/lag warnings always print).
 */
export type SeedLogEvent =
  | "worker_start" | "worker_poll" | "worker_exit" | "worker_spawn" | "worker_respawn"
  | "job_claim" | "job_start" | "job_done" | "job_skip"
  | "provider_call_start" | "provider_call_end" | "rate_sleep"
  | "tx_start" | "tx_commit" | "checkpoint_write"
  | "api_request_start" | "api_request_end"
  | "event_loop_lag" | "db_lock_wait" | "lease_renew" | "error";

const on = () => process.env.SEED_LOG === "1";
const ALWAYS = new Set<SeedLogEvent>(["error", "event_loop_lag", "db_lock_wait", "worker_exit", "worker_respawn"]);

export function slog(evt: SeedLogEvent, fields: Record<string, unknown> = {}): void {
  if (!on() && !ALWAYS.has(evt)) return;
  try {
    // Never echo secrets: callers pass only ids/counters/durations.
    process.stdout.write(JSON.stringify({ ts: Date.now(), src: "seed", evt, ...fields }) + "\n");
  } catch { /* logging must never throw */ }
}

/** Wrap an async provider call with start/end timing logs. Returns the awaited value. */
export async function timed<T>(evt: "provider_call_start", fields: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  slog(evt, fields);
  try {
    const v = await fn();
    slog("provider_call_end", { ...fields, ms: Date.now() - t0, ok: true });
    return v;
  } catch (err: any) {
    slog("provider_call_end", { ...fields, ms: Date.now() - t0, ok: false, err: String(err?.message ?? err).slice(0, 120) });
    throw err;
  }
}

/**
 * Sample event-loop lag on the CURRENT thread. A timer scheduled for `intervalMs` that fires
 * `delay` late means the loop was blocked ~`delay` ms. Logs when lag exceeds `warnMs`. Returns a
 * stop function. Used on the WEB (main) thread so a blocked API loop is observable.
 */
export function startEventLoopLagSampler(intervalMs = 1000, warnMs = 200): () => void {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - intervalMs;
    last = now;
    if (lag >= warnMs) slog("event_loop_lag", { lagMs: lag });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
