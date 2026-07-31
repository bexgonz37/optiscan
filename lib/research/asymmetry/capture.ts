/**
 * capture.ts — THE runtime edge from the live options loop into the radar.
 *
 * This is the only function the production scanner calls. It exists so the live
 * path has exactly one entrypoint with one contract:
 *
 *   options loop (exact OCC known, before subscriber qualification finishes)
 *     -> captureAsymmetryCandidate()
 *       -> decideLiveIntake()        [pure admission]
 *       -> openAsymmetryCaseOnDb()   [durable case]
 *
 * THREE PROPERTIES THE CALLER DEPENDS ON, ALL ENFORCED HERE:
 *
 * 1. IT NEVER THROWS. Every path is inside one try/catch that returns a result.
 *    The scanner calls this in its hot loop; an exception here would abort a
 *    candidate and could cost a real subscriber alert. Research always yields.
 *
 * 2. IT RETURNS NOTHING THE CALLER CAN ACT ON. The result is diagnostic only —
 *    there is no field a caller could branch on to change a SEND decision, and
 *    `subscriberSendCreated` is typed `false`.
 *
 * 3. IT IS OFF BY DEFAULT. Without HIGH_ASYMMETRY_CAPTURE_ENABLED=1 it returns
 *    immediately, having touched no database and made no provider call.
 *
 * Note the capture flag is SEPARATE from the notification flag. Capture is
 * silent research and can run alone; notification additionally requires
 * HIGH_ASYMMETRY_PRIVATE_ENABLED and a dedicated webhook.
 */
import { decideLiveIntake, type LiveIntakeInput } from "./live-intake.ts";
import { hasActiveAsymmetryCase, openAsymmetryCaseOnDb } from "./case-store.ts";
import { deriveResearchState } from "./states.ts";
import type { AsymmetryResearchState } from "./states.ts";

export const CAPTURE_ENABLED_ENV = "HIGH_ASYMMETRY_CAPTURE_ENABLED";

type CaptureDb = Parameters<typeof openAsymmetryCaseOnDb>[0];

export type CaptureOutcome =
  | "DISABLED"
  | "BLOCKED"
  | "DUPLICATE"
  | "CAPTURED"
  | "PERSIST_FAILED"
  | "ERROR";

export interface CaptureResult {
  outcome: CaptureOutcome;
  reason: string | null;
  state: AsymmetryResearchState | null;
  fingerprint: string | null;
  optionSymbol: string | null;
  blockedBy: string[];
  labels: string[];
  /** Always false. Nothing here can authorise a subscriber send. */
  subscriberSendCreated: false;
}

const inert = (outcome: CaptureOutcome, reason: string | null): CaptureResult => ({
  outcome, reason, state: null, fingerprint: null, optionSymbol: null,
  blockedBy: [], labels: [], subscriberSendCreated: false,
});

export interface CaptureInput extends Omit<LiveIntakeInput, "hasActiveCase"> {
  setupFamilyLabel?: string | null;
}

/**
 * Capture one live candidate. Never throws.
 *
 * The caller passes a candidate it has ALREADY selected an exact OCC for, and
 * does so BEFORE subscriber qualification completes — so the radar sees
 * contracts the subscriber pipeline may go on to reject.
 */
export function captureAsymmetryCandidate(
  db: CaptureDb,
  input: CaptureInput,
  env: NodeJS.ProcessEnv = process.env,
): CaptureResult {
  try {
    if (env[CAPTURE_ENABLED_ENV] !== "1") {
      return inert("DISABLED", `${CAPTURE_ENABLED_ENV} is not set`);
    }

    // Duplicate check is a read; the PRIMARY KEY is the real guarantee, so a
    // race between two ticks still cannot create two cases.
    const duplicate = hasActiveAsymmetryCase(db, input.sessionDate, input.fingerprint);

    const decision = decideLiveIntake({ ...input, hasActiveCase: duplicate });
    if (!decision.admitted) {
      const isDuplicate = decision.blockedBy.includes("DUPLICATE_ACTIVE_CASE");
      return {
        outcome: isDuplicate ? "DUPLICATE" : "BLOCKED",
        reason: decision.blockedBy.join(", "),
        state: null,
        fingerprint: input.fingerprint,
        optionSymbol: decision.optionSymbol,
        blockedBy: decision.blockedBy,
        labels: decision.labels,
        subscriberSendCreated: false,
      };
    }

    // Deterministic initial state. AI has no involvement at any point.
    const state = initialStateFor(decision.labels.length);

    const persisted = openAsymmetryCaseOnDb(db, {
      sessionDate: input.sessionDate,
      fingerprint: input.fingerprint,
      symbol: input.symbol,
      direction: input.direction,
      optionSymbol: decision.optionSymbol as string,
      state,
      firstDetectedAtMs: input.observedAtMs,
      earlyAsk: input.ask,
      earlyBid: input.bid,
      earlySpreadPct: decision.spreadPct,
      setupFamily: input.setupFamilyLabel ?? input.setupFamily ?? null,
      scannerVersion: input.scannerVersion ?? null,
      evidenceJson: JSON.stringify({
        mid: decision.mid,
        spreadPct: decision.spreadPct,
        volumeOiRatio: decision.volumeOiRatio,
        vwapRelationship: decision.vwapRelationship,
        optionVolume: input.optionVolume,
        openInterest: input.openInterest,
        impliedVolatility: input.impliedVolatility,
        delta: input.delta,
        gamma: input.gamma,
        underlyingPrice: input.underlyingPrice,
        vwap: input.vwap,
        relativeVolume: input.relativeVolume,
        volumeAcceleration: input.volumeAcceleration,
        priorMovePct: input.priorMovePct,
        compressionState: input.compressionState,
        distanceToTriggerPct: input.distanceToTriggerPct,
        roomToNextLevelPct: input.roomToNextLevelPct,
        marketAlignment: input.marketAlignment,
        sectorAlignment: input.sectorAlignment,
        catalyst: input.catalyst,
      }),
      missingEvidence: decision.labels,
      normalQualifiedAtMs: null,
      normalAsk: null,
    }, input.nowMs);

    if (!persisted.ok) {
      return {
        outcome: "PERSIST_FAILED", reason: persisted.error, state,
        fingerprint: input.fingerprint, optionSymbol: decision.optionSymbol,
        blockedBy: [], labels: decision.labels, subscriberSendCreated: false,
      };
    }
    return {
      outcome: persisted.created ? "CAPTURED" : "DUPLICATE",
      reason: null, state,
      fingerprint: input.fingerprint, optionSymbol: decision.optionSymbol,
      blockedBy: [], labels: decision.labels, subscriberSendCreated: false,
    };
  } catch (err: any) {
    // Total containment. The scanner must never see an exception from research.
    return inert("ERROR", String(err?.message ?? err));
  }
}

/**
 * Initial state from evidence coverage alone. Deterministic and AI-free.
 * A fully-evidenced candidate is HIGH_ASYMMETRY; a sparsely-evidenced one is
 * still EARLY_ASYMMETRY rather than rejected, because disclosing uncertainty is
 * the point — but with almost nothing known it is INSUFFICIENT_EVIDENCE.
 */
export function initialStateFor(missingCount: number): AsymmetryResearchState {
  if (missingCount === 0) return "HIGH_ASYMMETRY";
  if (missingCount <= 3) return "CONFIRMING";
  if (missingCount <= 9) return "EARLY_ASYMMETRY";
  return "INSUFFICIENT_EVIDENCE";
}

/** Re-exported so callers never import the state module directly. */
export { deriveResearchState };
