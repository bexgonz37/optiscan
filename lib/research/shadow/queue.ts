/**
 * lib/research/shadow/queue.ts — a bounded, fire-and-forget async queue for ALL shadow work
 * (discovery / analog / market-context / AI). PURE mechanism (no domain knowledge).
 *
 * Guarantees that keep the live scanner + Discord path safe:
 *   • FIRE-AND-FORGET: `submit()` returns immediately; the scanner never awaits shadow work.
 *   • BOUNDED: a max in-flight concurrency and a max queue depth. When full, new tasks are DROPPED
 *     and counted (backpressure) — shadow work can never grow unbounded or starve the loop.
 *   • DEDUP: tasks with the same key (symbol|source|event|time-bucket) collapse to one.
 *   • TIMEOUT + ISOLATION: every task races a timeout; any throw/timeout is caught, counted, and
 *     never propagates. A shadow failure can never affect an actionable decision.
 *   • METRICS: depth, in-flight, processed, dropped, errors, timeouts, and latency percentiles.
 */
export interface QueueConfig { concurrency: number; maxDepth: number; taskTimeoutMs: number }
export function defaultQueueConfig(env: NodeJS.ProcessEnv = process.env): QueueConfig {
  const n = (v: string | undefined, d: number) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  return { concurrency: n(env.SHADOW_QUEUE_CONCURRENCY, 2), maxDepth: n(env.SHADOW_QUEUE_MAX_DEPTH, 500), taskTimeoutMs: n(env.SHADOW_QUEUE_TIMEOUT_MS, 5000) };
}

export interface QueueMetrics { depth: number; inFlight: number; submitted: number; processed: number; dropped: number; deduped: number; errors: number; timeouts: number; latency: { p50: number | null; p95: number | null; max: number | null; n: number } }

interface Task { key: string; run: () => Promise<void> }

export class ShadowQueue {
  private cfg: QueueConfig;
  private q: Task[] = [];
  private keys = new Set<string>();
  private inFlight = 0;
  private lat: number[] = [];
  private m = { submitted: 0, processed: 0, dropped: 0, deduped: 0, errors: 0, timeouts: 0 };
  private now: () => number;

  constructor(cfg: Partial<QueueConfig> = {}, now: () => number = Date.now) { this.cfg = { ...defaultQueueConfig(), ...cfg }; this.now = now; }

  /** Enqueue a task. Returns false when dropped (dedup or full). NEVER throws. */
  submit(key: string, run: () => Promise<void>): boolean {
    this.m.submitted += 1;
    if (this.keys.has(key)) { this.m.deduped += 1; return false; }           // dedup
    if (this.q.length >= this.cfg.maxDepth) { this.m.dropped += 1; return false; } // backpressure
    this.keys.add(key);
    this.q.push({ key, run });
    void this.pump();
    return true;
  }

  private async pump(): Promise<void> {
    while (this.inFlight < this.cfg.concurrency && this.q.length > 0) {
      const task = this.q.shift()!;
      this.inFlight += 1;
      void (async () => {
        await Promise.resolve(); // YIELD: a task NEVER runs synchronously during submit()
        const started = this.now();
        try {
          await this.withTimeout(task.run(), this.cfg.taskTimeoutMs);
          this.m.processed += 1;
        } catch (e: any) {
          if (e && e.__shadowTimeout) this.m.timeouts += 1; else this.m.errors += 1;
        } finally {
          this.recordLatency(this.now() - started);
          this.keys.delete(task.key);
          this.inFlight -= 1;
          if (this.q.length > 0) void this.pump();
        }
      })();
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    if (!(ms > 0)) return p;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error("shadow task timeout"), { __shadowTimeout: true })), ms);
      if (typeof (t as any).unref === "function") (t as any).unref();
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  private recordLatency(ms: number): void { this.lat.push(ms); if (this.lat.length > 1000) this.lat.shift(); }

  metrics(): QueueMetrics {
    const s = [...this.lat].sort((a, b) => a - b);
    const p = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] : null);
    return { depth: this.q.length, inFlight: this.inFlight, submitted: this.m.submitted, processed: this.m.processed, dropped: this.m.dropped, deduped: this.m.deduped, errors: this.m.errors, timeouts: this.m.timeouts, latency: { p50: p(0.5), p95: p(0.95), max: s.length ? s[s.length - 1] : null, n: s.length } };
  }
  /** Test/inspection: drain to completion. */
  async drain(): Promise<void> { while (this.inFlight > 0 || this.q.length > 0) await new Promise((r) => setTimeout(r, 2)); }
}

type G = typeof globalThis & { __optiscanShadowQueue?: ShadowQueue };
/** One process-wide shadow queue (created lazily). */
export function shadowQueue(): ShadowQueue {
  const g = globalThis as G;
  return (g.__optiscanShadowQueue ??= new ShadowQueue());
}
/** Dedup key: symbol|source|event|time-bucket (default 10s buckets). */
export function shadowKey(symbol: string, source: string, event: string, atMs: number, bucketMs = 10_000): string {
  return `${String(symbol).toUpperCase()}|${source}|${event}|${Math.floor(atMs / bucketMs)}`;
}
