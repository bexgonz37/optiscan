/**
 * poll-guard.ts — PURE in-flight guard for interval-driven UI polling.
 *
 * Why this exists: a page that polls on a fixed interval will happily start a
 * second request while the first is still running. When the endpoint is slower
 * than the interval, in-flight requests accumulate until the browser's
 * per-host connection limit (6 on HTTP/1.1) is exhausted — at which point every
 * later request on that origin queues indefinitely and unrelated pages hang on
 * their loading skeletons. Observed in production: `/api/now` took ~14s while
 * the Watchlist polled it every 3s.
 *
 * The guard enforces two rules:
 *   1. At most ONE run in flight at a time. A tick that arrives while a run is
 *      active is SKIPPED, not queued — skipping is correct for polling, because
 *      the next tick will fetch fresher data anyway.
 *   2. Disposal aborts the active request, so an unmounted component cannot
 *      keep a socket open or set state after teardown.
 *
 * No React, no DOM, no I/O — so the overlap property is directly testable.
 */

export type PollRunOutcome = "ran" | "skipped" | "disposed";

export interface PollGuard {
  /**
   * Run `fn` unless a run is already in flight or the guard is disposed.
   * The AbortSignal is aborted by `dispose()`, so pass it to fetch.
   */
  run: (fn: (signal: AbortSignal) => Promise<void>) => Promise<PollRunOutcome>;
  /** Abort any in-flight run and refuse all future runs. Idempotent. */
  dispose: () => void;
  /** True while a run is in flight. Diagnostics/tests only. */
  isRunning: () => boolean;
  /** True once disposed. Diagnostics/tests only. */
  isDisposed: () => boolean;
}

export function createPollGuard(): PollGuard {
  let inFlight = false;
  let controller: AbortController | null = null;
  let disposed = false;

  return {
    async run(fn) {
      if (disposed) return "disposed";
      // The whole point: a tick arriving mid-run is dropped, never stacked.
      if (inFlight) return "skipped";
      inFlight = true;
      const local = new AbortController();
      controller = local;
      try {
        await fn(local.signal);
        return "ran";
      } finally {
        inFlight = false;
        // Only clear the shared handle if this run still owns it, so a dispose
        // during the run cannot be undone by that run finishing.
        if (controller === local) controller = null;
      }
    },
    dispose() {
      disposed = true;
      try {
        controller?.abort();
      } catch {
        /* aborting an already-settled request is not an error */
      }
      controller = null;
    },
    isRunning: () => inFlight,
    isDisposed: () => disposed,
  };
}

/** An aborted fetch is expected on unmount and must not surface as an error. */
export function isAbortError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { name?: string }).name === "AbortError");
}
