import { isOptionsQuoteSession } from "../../market-session-guard.ts";
import { normalizeTimestamp } from "../../timestamps.ts";
import { tradingDay } from "../../trading-session.ts";

export type LifecycleQuoteRejection =
  | "INVALID_QUOTE"
  | "QUOTE_TIMESTAMP_UNAVAILABLE"
  | "QUOTE_TIMESTAMP_IN_FUTURE"
  | "QUOTE_STALE"
  | "QUOTE_OUTSIDE_OPTIONS_SESSION"
  | "QUOTE_FROM_DIFFERENT_SESSION"
  | "MARKET_CLOSED_OR_EVENT_TIME_UNVERIFIED";

export interface LifecycleQuoteValidation {
  valid: boolean;
  eventAtMs: number | null;
  observedAtMs: number;
  quoteAgeMs: number | null;
  delayedDelivery: boolean;
  reason: LifecycleQuoteRejection | null;
}

export function validateLifecycleQuote(input: {
  bid: number | null | undefined;
  ask: number | null | undefined;
  providerTimestamp: number | string | bigint | Date | null | undefined;
  observedAtMs: number;
  maxQuoteAgeMs: number;
  persistedEventAtMs?: number | null;
  persistedAtMs?: number | null;
  env?: NodeJS.ProcessEnv;
}): LifecycleQuoteValidation {
  const env = input.env ?? process.env;
  const rejected = (
    reason: LifecycleQuoteRejection,
    eventAtMs: number | null = null,
    quoteAgeMs: number | null = null,
  ): LifecycleQuoteValidation => ({
    valid: false,
    eventAtMs,
    observedAtMs: input.observedAtMs,
    quoteAgeMs,
    delayedDelivery: false,
    reason,
  });

  if (
    input.bid == null || !Number.isFinite(input.bid) || input.bid <= 0
    || input.ask == null || !Number.isFinite(input.ask) || input.ask <= 0
    || input.ask < input.bid
  ) {
    return rejected("INVALID_QUOTE");
  }

  const normalized = normalizeTimestamp(input.providerTimestamp, input.observedAtMs);
  if (!normalized.valid || normalized.milliseconds == null) {
    return rejected("QUOTE_TIMESTAMP_UNAVAILABLE");
  }
  const eventAtMs = normalized.milliseconds;
  const observedAgeMs = input.observedAtMs - eventAtMs;
  if (!Number.isFinite(observedAgeMs) || observedAgeMs < 0) {
    return rejected("QUOTE_TIMESTAMP_IN_FUTURE", eventAtMs);
  }

  if (!isOptionsQuoteSession(eventAtMs, env)) {
    return rejected("QUOTE_OUTSIDE_OPTIONS_SESSION", eventAtMs, observedAgeMs);
  }
  if (tradingDay(eventAtMs) !== tradingDay(input.observedAtMs)) {
    return rejected("QUOTE_FROM_DIFFERENT_SESSION", eventAtMs, observedAgeMs);
  }

  const observedDuringOptionsSession = isOptionsQuoteSession(input.observedAtMs, env);
  let quoteAgeMs = observedAgeMs;
  if (!observedDuringOptionsSession) {
    const persistedEventAtMs = input.persistedEventAtMs;
    const persistedAtMs = input.persistedAtMs;
    const provedBeforeClose = persistedEventAtMs != null
      && Number.isFinite(persistedEventAtMs)
      && Math.abs(persistedEventAtMs - eventAtMs) <= 1_000
      && persistedAtMs != null
      && Number.isFinite(persistedAtMs)
      && persistedAtMs >= eventAtMs
      && isOptionsQuoteSession(persistedAtMs, env)
      && tradingDay(persistedAtMs) === tradingDay(eventAtMs);
    if (!provedBeforeClose) {
      return rejected("MARKET_CLOSED_OR_EVENT_TIME_UNVERIFIED", eventAtMs, observedAgeMs);
    }
    quoteAgeMs = (persistedAtMs as number) - eventAtMs;
  }
  if (!Number.isFinite(quoteAgeMs) || quoteAgeMs < 0) {
    return rejected("QUOTE_TIMESTAMP_IN_FUTURE", eventAtMs);
  }
  if (quoteAgeMs > input.maxQuoteAgeMs) {
    return rejected("QUOTE_STALE", eventAtMs, quoteAgeMs);
  }

  return {
    valid: true,
    eventAtMs,
    observedAtMs: input.observedAtMs,
    quoteAgeMs,
    delayedDelivery: !observedDuringOptionsSession,
    reason: null,
  };
}
