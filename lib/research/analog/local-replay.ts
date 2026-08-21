/**
 * local-replay.ts — ANALOG_LOCAL_REPLAY_V1. Widen the analog corpus from bars OptiScan
 * ALREADY OWNS, with zero provider calls and zero recurring spend.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 *
 * The replay corpus is 11,679 episodes across FIVE tickers, and the chronological
 * evaluation drew queries from three of them. That is the single largest reason the 5d
 * result cannot be separated from "mega-caps drifted together in 2023–2024".
 *
 * The usual remedy is to seed more symbols, which means `runReplaySeed` and a provider
 * bill. But `historical_underlying_bars` is a DURABLE store the off-peak ingestion lane
 * already filled: 60,164 minute bars across 15 symbols. Those bars are possessed. Replaying
 * them costs nothing, spends no quota, and touches no live path.
 *
 * ── Nothing about the science is relaxed to get there ────────────────────────
 *
 * This module does NOT re-implement seeding. It calls `seedEpisodesPure` — the same
 * function the provider-backed lane calls — so the candidate rule, the Zone-A blocks, the
 * T0 fence, the liquidity tier, the label conventions and the deterministic `episode_key`
 * are byte-identical to the existing corpus. The only thing that changes is where the bars
 * came from. Persistence goes through `persistEpisodeOnDb` / `persistLabelOnDb`, which
 * REFUSE any episode whose Zone-A asOf exceeds t0 and any label that is not strictly
 * forward, so a leaky row cannot enter even if this module were wrong.
 *
 * Because `episodeKeyOf` is a pure function of (source, symbol, t0Ms, schemaVersion), a
 * re-run over the same bars re-derives the same keys and `INSERT OR IGNORE` makes it a
 * no-op. Running it twice cannot double-count anything.
 *
 * ── What it CANNOT do, stated up front ───────────────────────────────────────
 *
 * The stored bars span five sessions. `resolveHorizonEnd` needs N forward trading days to
 * emit an N-day label, so this source can produce 15m/30m/1h/EOD labels for every session
 * it covers, 1d for all but the last, 3d for the first two, and 5d/10d for NONE. It widens
 * breadth at INTRADAY and daily horizons and contributes nothing at all to the 5d question.
 * `plannedHorizons` reports that per symbol rather than leaving it to be discovered in a
 * result that quietly has no 5d rows.
 *
 * Evidence class is unchanged: these are HISTORICAL_UNDERLYING_ONLY, exactly like the rest
 * of the replay corpus. More rows never upgrade a class. There is no option leg here and
 * this module will never manufacture one.
 */
import { seedEpisodesPure, defaultSeedConfig, type SeedConfig } from "../episode/seed.ts";
import { persistEpisodeOnDb, persistLabelOnDb } from "../episode/store.ts";
import { HORIZONS } from "../episode/schema.ts";
import type { Bar } from "../episode/labels.ts";

export const ANALOG_LOCAL_REPLAY_VERSION = "ANALOG_LOCAL_REPLAY_V1";

interface ReplayDb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run?: (...a: any[]) => { changes: number } };
}

function tableExists(db: ReplayDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

export interface StoredBarSubject {
  symbol: string;
  timeframe: string;
  bars: number;
  firstMs: number;
  lastMs: number;
  tradingDays: number;
  /** Distinct `quality` values recorded by the ingestion lane. */
  quality: string;
  /** Which provider/job wrote them. */
  sources: string;
}

export interface StoredBarInventory {
  version: string;
  table: string;
  present: boolean;
  subjects: StoredBarSubject[];
  totalBars: number;
  distinctSymbols: number;
  distinctTradingDays: number;
  earliestMs: number | null;
  latestMs: number | null;
  note: string;
}

/**
 * What the durable bar store actually holds, per symbol AND timeframe.
 *
 * Timeframe is part of the key on purpose: a symbol with 1d bars and a symbol with 1m bars
 * support completely different reconstructions, and a count that pools them answers neither
 * question. `seedEpisodesPure`'s warmup/velocity/baseline windows are bar counts, so feeding
 * it daily bars would silently reinterpret a 15-bar window as three trading weeks.
 */
export function storedBarInventoryOnDb(db: ReplayDb): StoredBarInventory {
  const empty: StoredBarInventory = {
    version: ANALOG_LOCAL_REPLAY_VERSION,
    table: "historical_underlying_bars",
    present: false,
    subjects: [], totalBars: 0, distinctSymbols: 0, distinctTradingDays: 0,
    earliestMs: null, latestMs: null,
    note: "historical_underlying_bars is not present in this database; nothing can be replayed locally",
  };
  if (!tableExists(db, "historical_underlying_bars")) return empty;
  let rows: any[] = [];
  try {
    rows = db.prepare(
      `SELECT symbol, timeframe, COUNT(*) n, MIN(ts_ms) lo, MAX(ts_ms) hi,
              COUNT(DISTINCT date(ts_ms/1000,'unixepoch')) days,
              GROUP_CONCAT(DISTINCT quality) quality,
              GROUP_CONCAT(DISTINCT source) sources
         FROM historical_underlying_bars
        GROUP BY symbol, timeframe
        ORDER BY symbol ASC, timeframe ASC`,
    ).all() ?? [];
  } catch (e: any) {
    return { ...empty, present: true, note: `bar inventory unavailable: ${String(e?.message ?? e).slice(0, 160)}` };
  }
  const subjects: StoredBarSubject[] = rows.map((r) => ({
    symbol: String(r.symbol),
    timeframe: String(r.timeframe),
    bars: Number(r.n ?? 0),
    firstMs: Number(r.lo ?? 0),
    lastMs: Number(r.hi ?? 0),
    tradingDays: Number(r.days ?? 0),
    quality: String(r.quality ?? ""),
    sources: String(r.sources ?? ""),
  }));
  const totalBars = subjects.reduce((a, s) => a + s.bars, 0);
  return {
    version: ANALOG_LOCAL_REPLAY_VERSION,
    table: "historical_underlying_bars",
    present: true,
    subjects,
    totalBars,
    distinctSymbols: new Set(subjects.map((s) => s.symbol)).size,
    distinctTradingDays: subjects.reduce((a, s) => Math.max(a, s.tradingDays), 0),
    earliestMs: subjects.length ? Math.min(...subjects.map((s) => s.firstMs)) : null,
    latestMs: subjects.length ? Math.max(...subjects.map((s) => s.lastMs)) : null,
    note:
      "Rows here are POSSESSED — replaying them issues no provider request and spends no quota. " +
      "The UTC day count is a coverage indicator; independent-session accounting is done by " +
      "countIndependentSessions against the trading calendar, never by this number.",
  };
}

export interface LocalReplayOptions {
  /** Restrict to these symbols. Omit for every symbol the store holds at `timeframe`. */
  symbols?: string[];
  /** Bar granularity to replay. The seed config's windows are BAR COUNTS, so this matters. */
  timeframe?: string;
  /** Report what would be written without writing anything. DEFAULTS TO TRUE — writing is opt-in. */
  dryRun?: boolean;
  /** Cap on symbols processed per invocation, so one call cannot walk the whole store. */
  maxSymbols?: number;
  /** Cap on bars read per symbol. */
  maxBarsPerSymbol?: number;
  config?: SeedConfig;
}

export interface LocalReplaySymbolResult {
  symbol: string;
  barsRead: number;
  firstBarMs: number | null;
  lastBarMs: number | null;
  /** Sessions the bars cover, by Eastern calendar date. */
  sessionsCovered: number;
  candidateMoments: number;
  episodesInserted: number;
  episodesAlreadyPresent: number;
  episodesRefused: number;
  labelsInserted: number;
  labelsByHorizon: Record<string, number>;
  /** Horizons the bar span can support at all, before any labelling is attempted. */
  plannedHorizons: string[];
  unsupportedHorizons: string[];
  note: string;
}

export interface LocalReplayResult {
  version: string;
  ran: boolean;
  dryRun: boolean;
  timeframe: string;
  evidenceClass: "HISTORICAL_UNDERLYING_ONLY";
  symbolsConsidered: number;
  symbolsProcessed: number;
  symbolsCapped: boolean;
  episodesInserted: number;
  episodesAlreadyPresent: number;
  episodesRefused: number;
  labelsInserted: number;
  labelsByHorizon: Record<string, number>;
  perSymbol: LocalReplaySymbolResult[];
  providerCallsIssued: 0;
  note: string;
  skippedReason: string | null;
}

/** Eastern calendar date of an instant — the same shape `countIndependentSessions` validates. */
function easternDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * Which horizons a bar span could possibly resolve.
 *
 * This is a CAPABILITY statement, not a promise: `resolveHorizonEnd` still refuses per
 * episode when a specific candidate lacks forward bars. Reporting it up front is what stops
 * "5d: 0 rows" from being read as "5d found nothing" when the truth is "5d was never
 * reachable from five sessions of bars".
 */
export function plannedHorizonsFor(sessionDates: readonly string[]): { supported: string[]; unsupported: string[] } {
  const sessions = new Set(sessionDates).size;
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const h of HORIZONS) {
    const needForwardSessions = h === "1d" ? 1 : h === "3d" ? 3 : h === "5d" ? 5 : h === "10d" ? 10 : 0;
    // An N-day label needs N forward sessions AFTER the decision session, so the span must
    // hold at least N + 1 sessions for even one episode to reach it.
    if (sessions >= needForwardSessions + 1) supported.push(h);
    else unsupported.push(h);
  }
  return { supported, unsupported };
}

/**
 * Replay the stored bars into the canonical episode + label tables.
 *
 * Never throws into the caller. Never issues a provider request — the only I/O is a bounded
 * read of `historical_underlying_bars` and idempotent inserts.
 */
export function seedAnalogCorpusFromStoreOnDb(
  db: ReplayDb,
  options: LocalReplayOptions = {},
  nowMs: number = Date.now(),
): LocalReplayResult {
  const timeframe = options.timeframe ?? "1m";
  // Writing is the OPT-IN. An omitted flag on a function that inserts into the canonical
  // episode tables should describe, not act.
  const dryRun = options.dryRun !== false;
  const maxSymbols = Math.max(1, Math.min(100, options.maxSymbols ?? 50));
  const maxBars = Math.max(100, Math.min(200_000, options.maxBarsPerSymbol ?? 50_000));
  const cfg = options.config ?? defaultSeedConfig();

  const base: LocalReplayResult = {
    version: ANALOG_LOCAL_REPLAY_VERSION,
    ran: false,
    dryRun,
    timeframe,
    evidenceClass: "HISTORICAL_UNDERLYING_ONLY",
    symbolsConsidered: 0, symbolsProcessed: 0, symbolsCapped: false,
    episodesInserted: 0, episodesAlreadyPresent: 0, episodesRefused: 0,
    labelsInserted: 0, labelsByHorizon: {},
    perSymbol: [],
    providerCallsIssued: 0,
    note:
      "Reconstructed from historical_underlying_bars via seedEpisodesPure — the same seeding " +
      "function the provider-backed lane uses. Zero provider calls, zero spend. Evidence class " +
      "is unchanged: HISTORICAL_UNDERLYING_ONLY. No option leg exists in this source and none is modelled.",
    skippedReason: null,
  };

  if (!tableExists(db, "historical_underlying_bars")) {
    return { ...base, skippedReason: "historical_underlying_bars is not present in this database" };
  }
  if (!tableExists(db, "setup_episodes") || !tableExists(db, "episode_labels")) {
    return { ...base, skippedReason: "setup_episodes / episode_labels are not present in this database" };
  }

  let symbols: string[];
  try {
    const rows = db.prepare(
      "SELECT DISTINCT symbol FROM historical_underlying_bars WHERE timeframe=? ORDER BY symbol ASC",
    ).all(timeframe) as any[];
    symbols = rows.map((r) => String(r.symbol).toUpperCase());
  } catch (e: any) {
    return { ...base, skippedReason: `symbol scan failed: ${String(e?.message ?? e).slice(0, 160)}` };
  }
  if (options.symbols?.length) {
    const want = new Set(options.symbols.map((s) => String(s).toUpperCase()));
    symbols = symbols.filter((s) => want.has(s));
  }
  const considered = symbols.length;
  const capped = symbols.length > maxSymbols;
  const use = capped ? symbols.slice(0, maxSymbols) : symbols;

  const perSymbol: LocalReplaySymbolResult[] = [];
  const labelsByHorizon: Record<string, number> = {};
  let episodesInserted = 0, episodesAlreadyPresent = 0, episodesRefused = 0, labelsInserted = 0;

  for (const symbol of use) {
    let barRows: any[] = [];
    try {
      barRows = db.prepare(
        `SELECT ts_ms, open, high, low, close, volume
           FROM historical_underlying_bars
          WHERE symbol=? AND timeframe=?
          ORDER BY ts_ms ASC LIMIT ?`,
      ).all(symbol, timeframe, maxBars) as any[];
    } catch (e: any) {
      perSymbol.push({
        symbol, barsRead: 0, firstBarMs: null, lastBarMs: null, sessionsCovered: 0,
        candidateMoments: 0, episodesInserted: 0, episodesAlreadyPresent: 0, episodesRefused: 0,
        labelsInserted: 0, labelsByHorizon: {}, plannedHorizons: [], unsupportedHorizons: [...HORIZONS],
        note: `bar read failed: ${String(e?.message ?? e).slice(0, 120)}`,
      });
      continue;
    }

    // A bar with a null OHLC is not a bar. Dropping it is the only honest option: the
    // seeder's windows are positional, and a fabricated close would propagate into every
    // velocity, range and volatility reading downstream of it.
    const bars: Bar[] = [];
    for (const r of barRows) {
      const t = Number(r.ts_ms);
      const o = Number(r.open), h = Number(r.high), l = Number(r.low), c = Number(r.close), v = Number(r.volume);
      if (![t, o, h, l, c, v].every((x) => Number.isFinite(x))) continue;
      bars.push({ t, o, h, l, c, v });
    }

    const sessionDates = [...new Set(bars.map((b) => easternDate(b.t)))].sort();
    const { supported, unsupported } = plannedHorizonsFor(sessionDates);

    const seeded = seedEpisodesPure(symbol, bars, cfg);
    const symLabels: Record<string, number> = {};
    let insertedHere = 0, presentHere = 0, refusedHere = 0, labelsHere = 0;

    for (const s of seeded) {
      if (dryRun) {
        // Count what WOULD be written. The refusal predicate is inside persistEpisodeOnDb,
        // so a dry run reports intent and never claims the guard's verdict in advance.
        insertedHere += 1;
        for (const l of s.labels) { symLabels[l.horizon] = (symLabels[l.horizon] ?? 0) + 1; labelsHere += 1; }
        continue;
      }
      const r = persistEpisodeOnDb(db as any, s.episode, nowMs);
      if (!r.ok) { refusedHere += 1; continue; }
      if (r.inserted) insertedHere += 1; else presentHere += 1;
      for (const l of s.labels) {
        const w = persistLabelOnDb(db as any, s.episodeKey, s.episode.t0Ms, l, nowMs);
        if (w.inserted) { symLabels[l.horizon] = (symLabels[l.horizon] ?? 0) + 1; labelsHere += 1; }
      }
    }

    for (const [h, n] of Object.entries(symLabels)) labelsByHorizon[h] = (labelsByHorizon[h] ?? 0) + n;
    episodesInserted += insertedHere;
    episodesAlreadyPresent += presentHere;
    episodesRefused += refusedHere;
    labelsInserted += labelsHere;

    perSymbol.push({
      symbol,
      barsRead: bars.length,
      firstBarMs: bars.length ? bars[0].t : null,
      lastBarMs: bars.length ? bars[bars.length - 1].t : null,
      sessionsCovered: sessionDates.length,
      candidateMoments: seeded.length,
      episodesInserted: insertedHere,
      episodesAlreadyPresent: presentHere,
      episodesRefused: refusedHere,
      labelsInserted: labelsHere,
      labelsByHorizon: symLabels,
      plannedHorizons: supported,
      unsupportedHorizons: unsupported,
      note: bars.length === barRows.length
        ? "every stored bar was usable"
        : `${barRows.length - bars.length} stored bars had a non-finite OHLCV field and were dropped rather than repaired`,
    });
  }

  return {
    ...base,
    ran: true,
    symbolsConsidered: considered,
    symbolsProcessed: use.length,
    symbolsCapped: capped,
    episodesInserted,
    episodesAlreadyPresent,
    episodesRefused,
    labelsInserted,
    labelsByHorizon,
    perSymbol,
  };
}
