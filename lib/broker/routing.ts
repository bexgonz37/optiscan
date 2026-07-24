/**
 * Centralized paper-accounting read routing (B6).
 * Single place for LEGACY / V2_SHADOW / V2 — no scattered env checks in scanners.
 *
 * IMPORTANT: Scanner, Discord delivery, gates, thresholds, and AI must NOT import this module.
 */
import {
  paperBrokerV2Enabled,
  paperBrokerV2ReadsEnabled,
  paperBrokerV2ShadowReadEnabled,
  validateBrokerV2FlagCombination,
} from "./flags.ts";

export type PaperReadSource = "LEGACY" | "V2_SHADOW" | "V2";

export interface PaperReadRoute {
  /** Source stamped on user-visible responses. */
  responseSource: "LEGACY" | "V2";
  /** Whether to compute V2 in parallel for shadow comparison (never returned as primary). */
  runShadowCompare: boolean;
  dualWriteEnabled: boolean;
  shadowReadEnabled: boolean;
  v2ReadsEnabled: boolean;
  flagValidation: ReturnType<typeof validateBrokerV2FlagCombination>;
  /** Human-readable note for dashboards. */
  note: string;
}

/**
 * Resolve how paper-accounting / research-reporting reads should behave.
 * Default: LEGACY authoritative. V2 reads only when explicitly enabled.
 */
export function resolvePaperReadSource(env: NodeJS.ProcessEnv = process.env): PaperReadRoute {
  const flagValidation = validateBrokerV2FlagCombination(env);
  const dualWriteEnabled = paperBrokerV2Enabled(env);
  const shadowReadEnabled = paperBrokerV2ShadowReadEnabled(env);
  const v2ReadsEnabled = paperBrokerV2ReadsEnabled(env);

  if (!flagValidation.ok) {
    // Fail safe: never serve V2 when flags are invalid.
    return {
      responseSource: "LEGACY",
      runShadowCompare: false,
      dualWriteEnabled,
      shadowReadEnabled,
      v2ReadsEnabled,
      flagValidation,
      note: `Flag guard failed — forcing LEGACY. ${flagValidation.errors.join("; ")}`,
    };
  }

  if (v2ReadsEnabled) {
    return {
      responseSource: "V2",
      runShadowCompare: false,
      dualWriteEnabled,
      shadowReadEnabled,
      v2ReadsEnabled,
      flagValidation,
      note: "V2 reads enabled — approved paper-accounting reads return V2 (rollback: set PAPER_BROKER_V2_READS_ENABLED=0).",
    };
  }

  if (shadowReadEnabled) {
    return {
      responseSource: "LEGACY",
      runShadowCompare: true,
      dualWriteEnabled,
      shadowReadEnabled,
      v2ReadsEnabled,
      flagValidation,
      note: "Shadow-read ON — legacy returned to clients; V2 compared in parallel.",
    };
  }

  return {
    responseSource: "LEGACY",
    runShadowCompare: false,
    dualWriteEnabled,
    shadowReadEnabled,
    v2ReadsEnabled,
    flagValidation,
    note: "Legacy authoritative (default). V2 research APIs remain separate and gated.",
  };
}

/** Instantaneous rollback helper — documents that only the reads flag must flip. */
export function rollbackV2ReadsToLegacy(): { disableEnv: string; effect: string } {
  return {
    disableEnv: "PAPER_BROKER_V2_READS_ENABLED=0",
    effect: "All routed paper-accounting reads immediately return LEGACY; no migration or destructive writes.",
  };
}
