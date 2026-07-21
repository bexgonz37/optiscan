/**
 * lib/research/episode/store.ts — persistence for Setup Episodes + labels (Phase A).
 * Impure (SQLite) with a testable OnDb core.
 *
 * Safety: the store REFUSES to persist a leaky episode (any Zone-A block asOf > t0) or a
 * non-forward label (labelAsOfMs <= t0) — such rows never enter the memory. Idempotent:
 * episodes UNIQUE(episode_key); labels UNIQUE(episode_key,horizon,target_kind). Never
 * throws into a live caller. HARD no-op path unless EPISODE_CAPTURE_ENABLED=1.
 */
import { researchFlags } from "../flags.ts";
import { validateEpisodeNoLookahead, validateLabelForward, leakageGuardValue } from "./leakage.ts";
import { episodeKeyOf, type Episode, type EpisodeLabel } from "./schema.ts";

interface EpisodeDb {
  prepare(sql: string): { run: (...a: any[]) => { changes: number } };
}

const j = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

export interface PersistEpisodeResult { ok: boolean; inserted: boolean; episodeKey: string; violations: string[] }

/** Persist one Episode. Refuses (never writes) if it fails the leakage guard. Idempotent. */
export function persistEpisodeOnDb(db: EpisodeDb, ep: Episode, nowMs: number = Date.now()): PersistEpisodeResult {
  const key = episodeKeyOf(ep.source, ep.symbol, ep.t0Ms, ep.featureSchemaVersion);
  const verdict = validateEpisodeNoLookahead(ep);
  if (!verdict.ok) return { ok: false, inserted: false, episodeKey: key, violations: verdict.violations };
  const b = ep.blocks;
  const info = db.prepare(
    `INSERT OR IGNORE INTO setup_episodes
      (episode_key, source, symbol, t0_ms, trading_day, session, tod_bucket, asset_class, direction,
       regime_label, regime_model_version, liquidity_tier, validity_tier,
       price_structure_json, momentum_json, volume_json, volatility_json, regime_json, sector_json,
       breadth_json, options_context_json, catalyst_json, liquidity_json, data_quality_json, missing_json,
       gate_results_json, feature_schema_version, max_feature_as_of_ms, provenance_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?)`,
  ).run(
    key, ep.source, ep.symbol.toUpperCase(), ep.t0Ms, ep.tradingDay, ep.session, ep.todBucket, ep.assetClass, ep.direction,
    ep.regimeLabel, ep.regimeModelVersion, ep.liquidityTier, ep.validityTier,
    j(b.priceStructure), j(b.momentum), j(b.volume), j(b.volatility), j(b.regime), j(b.sector),
    j(b.breadth), j(b.optionsContext), j(b.catalyst), j(b.liquidity), j(b.dataQuality), j(ep.missing),
    j(ep.gateResults), ep.featureSchemaVersion, leakageGuardValue(ep), j(ep.provenance), nowMs,
  );
  return { ok: true, inserted: info.changes > 0, episodeKey: key, violations: [] };
}

export interface PersistLabelResult { ok: boolean; inserted: boolean; reason: string | null }

/** Persist one forward label. Refuses (never writes) if not strictly forward of t0. Idempotent. */
export function persistLabelOnDb(db: EpisodeDb, episodeKey: string, t0Ms: number, label: EpisodeLabel, nowMs: number = Date.now()): PersistLabelResult {
  const verdict = validateLabelForward(label, t0Ms);
  if (!verdict.ok) return { ok: false, inserted: false, reason: verdict.violations.join("; ") };
  const info = db.prepare(
    `INSERT OR IGNORE INTO episode_labels
      (episode_key, horizon, target_kind, outcome_kind, return_pct, mfe_pct, mae_pct, target_before_stop,
       time_to_target_ms, time_to_invalidation_ms, realized_vol, gap_pct, gap_filled, model_assumptions_json,
       label_as_of_ms, computed_at_ms)
     VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?)`,
  ).run(
    episodeKey, label.horizon, label.targetKind, label.outcomeKind, label.returnPct, label.mfePct, label.maePct, label.targetBeforeStop,
    label.timeToTargetMs, label.timeToInvalidationMs, label.realizedVol, label.gapPct, label.gapFilled == null ? null : (label.gapFilled ? 1 : 0),
    j(label.modelAssumptions), label.labelAsOfMs, nowMs,
  );
  return { ok: true, inserted: info.changes > 0, reason: null };
}

// ── live wrapper (flag-gated; not auto-wired — Phase C replay is the primary writer) ──
// eslint-disable-next-line @typescript-eslint/no-require-imports
const liveDb = () => require("@/lib/db").getDb();

export interface CaptureEpisodeSummary { captured: number; refused: number; skippedReason: string | null }

/** Live episode capture. HARD no-op unless EPISODE_CAPTURE_ENABLED=1. Never throws. */
export function captureEpisodes(episodes: Episode[], nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): CaptureEpisodeSummary {
  if (!researchFlags(env).episodeCapture) return { captured: 0, refused: 0, skippedReason: "EPISODE_CAPTURE_ENABLED!=1" };
  let captured = 0, refused = 0;
  try {
    const db = liveDb() as EpisodeDb;
    for (const ep of episodes) {
      const r = persistEpisodeOnDb(db, ep, nowMs);
      if (!r.ok) refused += 1; else if (r.inserted) captured += 1;
    }
  } catch (err: any) {
    return { captured, refused, skippedReason: `episode capture error (isolated): ${err?.message ?? String(err)}` };
  }
  return { captured, refused, skippedReason: null };
}
