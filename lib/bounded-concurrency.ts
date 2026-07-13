export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const concurrency = Math.max(1, Math.min(Math.trunc(Number(limit)) || 1, items.length || 1));
  const results = new Array<R>(items.length);
  let next = 0;

  async function run() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, run));
  return results;
}

export function envConcurrency(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  max: number,
): number {
  const raw = Number(env[key] ?? fallback);
  return Math.max(1, Math.min(Math.trunc(raw) || fallback, max));
}
