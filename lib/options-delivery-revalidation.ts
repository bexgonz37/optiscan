import {
  evaluateInstrumentSession,
  optionsSessionAllowsStrategy,
  type InstrumentSessionResult,
} from "./instrument-session-authority.ts";

export interface OptionsDeliveryContext {
  symbol: string;
  optionSymbol: string;
  expiration?: string | null;
  candidateAtMs: number;
  quoteAtMs: number;
  strategySessions?: readonly string[];
  maxCandidateAgeMs?: number;
  maxQuoteAgeMs?: number;
}

export interface OptionsDeliveryRevalidation {
  ok: boolean;
  reason: string;
  primaryCause: "STILL_ACTIONABLE" | "STALE_CAPTURE" | "QUOTE_UNAVAILABLE" | "AFTER_HOURS_REPROCESSING" | "SESSION_CLASSIFICATION_FAILURE";
  candidateAgeMs: number | null;
  quoteAgeMs: number | null;
  session: InstrumentSessionResult;
}

const DEFAULT_MAX_AGE_MS = 90_000;

export function revalidateOptionsDelivery(
  context: OptionsDeliveryContext | null | undefined,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): OptionsDeliveryRevalidation {
  const session = evaluateInstrumentSession(
    { symbol: context?.symbol, optionSymbol: context?.optionSymbol, expiration: context?.expiration },
    nowMs,
    env,
  );
  const fail = (
    primaryCause: OptionsDeliveryRevalidation["primaryCause"], reason: string,
    candidateAgeMs: number | null = null, quoteAgeMs: number | null = null,
  ): OptionsDeliveryRevalidation => ({ ok: false, primaryCause, reason, candidateAgeMs, quoteAgeMs, session });
  if (!context || !context.symbol || !context.optionSymbol) {
    return fail("SESSION_CLASSIFICATION_FAILURE", "missing persisted instrument delivery context");
  }
  if (!optionsSessionAllowsStrategy(session, context.strategySessions ?? ["regular"])) {
    return fail("AFTER_HOURS_REPROCESSING", `${session.optionsState}: ${session.reason}`);
  }
  const candidateAgeMs = Number.isFinite(context.candidateAtMs) ? nowMs - context.candidateAtMs : null;
  const quoteAgeMs = Number.isFinite(context.quoteAtMs) ? nowMs - context.quoteAtMs : null;
  const maxCandidateAgeMs = context.maxCandidateAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxQuoteAgeMs = context.maxQuoteAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (candidateAgeMs == null || candidateAgeMs < 0 || candidateAgeMs > maxCandidateAgeMs) {
    return fail("STALE_CAPTURE", `candidate is ${candidateAgeMs ?? "unknown"}ms old`, candidateAgeMs, quoteAgeMs);
  }
  if (quoteAgeMs == null || quoteAgeMs < 0 || quoteAgeMs > maxQuoteAgeMs) {
    return fail("QUOTE_UNAVAILABLE", `executable quote is ${quoteAgeMs ?? "unknown"}ms old`, candidateAgeMs, quoteAgeMs);
  }
  return {
    ok: true,
    primaryCause: "STILL_ACTIONABLE",
    reason: "instrument session and persisted executable quote remain current",
    candidateAgeMs,
    quoteAgeMs,
    session,
  };
}

export function parseOptionsDeliveryContext(raw: unknown): OptionsDeliveryContext | null {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!v || typeof v !== "object") return null;
    const x = v as Record<string, unknown>;
    return {
      symbol: String(x.symbol ?? ""),
      optionSymbol: String(x.optionSymbol ?? ""),
      expiration: x.expiration == null ? null : String(x.expiration),
      candidateAtMs: Number(x.candidateAtMs),
      quoteAtMs: Number(x.quoteAtMs),
      strategySessions: Array.isArray(x.strategySessions) ? x.strategySessions.map(String) : ["regular"],
      maxCandidateAgeMs: x.maxCandidateAgeMs == null ? undefined : Number(x.maxCandidateAgeMs),
      maxQuoteAgeMs: x.maxQuoteAgeMs == null ? undefined : Number(x.maxQuoteAgeMs),
    };
  } catch {
    return null;
  }
}
