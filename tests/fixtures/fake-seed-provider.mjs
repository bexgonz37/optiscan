/**
 * tests/fixtures/fake-seed-provider.mjs — injected into the seed worker via
 * SEED_WORKER_PROVIDER_MODULE so integration tests exercise the real worker PROCESS without a live
 * provider. Returns synthetic spike bars and burns deliberate SYNCHRONOUS CPU per symbol so the
 * worker is provably busy — letting the parent test prove the API loop is NOT blocked.
 */
function spikeBars(n = 4000) {
  const base = Date.UTC(2024, 0, 2, 14, 30, 0), out = [];
  for (let i = 0; i < n; i++) {
    let c = 100, v = 1000;
    if (i % 400 >= 95 && i % 400 <= 115) { c = 100 + ((i % 400) - 94) * 0.25; v = 6000; }
    out.push({ t: base + i * 60_000, o: c, h: c, l: c, c, v });
  }
  return out;
}

// deliberate synchronous CPU (blocks the WORKER's loop, never the parent's)
function burnMs(ms) {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) { x += Math.sqrt(x + 1); }
  return x;
}

export async function fetchBars(symbol, opts) {
  const chunks = 3;
  for (let i = 0; i < chunks; i++) opts.onChunk?.({ from: "", to: "", bars: 1000, succeeded: true, truncated: false, index: i, total: chunks });
  burnMs(Number(process.env.FAKE_BURN_MS ?? 200)); // heavy synchronous work in the worker process
  const bars = spikeBars();
  return {
    bars, providerCalls: chunks, succeeded: true, note: "synthetic",
    chunks, rangeComplete: true, truncated: false,
    firstBarMs: bars[0].t, lastBarMs: bars[bars.length - 1].t,
    chunkDetail: Array.from({ length: chunks }, () => ({ from: "", to: "", bars: 1000, succeeded: true, truncated: false })),
  };
}
