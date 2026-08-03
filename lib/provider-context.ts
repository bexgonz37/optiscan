/**
 * Ambient provider-request attribution.
 *
 * Every Massive/Polygon call funnels through one `polyFetch`, which until now counted
 * requests into a single process-local number. "280/min saturated" was therefore true
 * but unactionable — nothing recorded WHICH consumer spent the minute.
 *
 * A consumer wraps its work in `withProviderConsumer(...)`; every provider call made
 * inside that scope — however deep the call stack — is attributed to it. Nested scopes
 * take the innermost label, so a shared helper called from two schedulers is billed to
 * whichever one invoked it.
 *
 * This module only labels requests. It never makes, blocks, or retries one.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Attribution buckets. Priority order (Gate B7) reads top to bottom: live scanner
 * safety first, optional enrichment last. `unattributed` means a call escaped every
 * scope — a defect to fix, not a category to grow.
 */
export type ProviderConsumer =
  | "scanner"
  | "options_discovery"
  | "options_paper_mark"
  | "asymmetry_discovery"
  | "asymmetry_mark"
  | "watchlist"
  | "premarket"
  | "historical_research"
  | "enrichment"
  | "diagnostics"
  | "dashboard_api"
  | "seed_worker"
  | "unattributed";

export const PROVIDER_CONSUMERS: readonly ProviderConsumer[] = [
  "scanner",
  "options_discovery",
  "options_paper_mark",
  "asymmetry_discovery",
  "asymmetry_mark",
  "watchlist",
  "premarket",
  "historical_research",
  "enrichment",
  "diagnostics",
  "dashboard_api",
  "seed_worker",
  "unattributed",
] as const;

/** Coarse category, derived from the consumer. Kept separate so reports can roll up. */
export type ProviderCategory = "scanner" | "mark" | "discovery" | "research" | "enrichment" | "diagnostic";

const CATEGORY_BY_CONSUMER: Record<ProviderConsumer, ProviderCategory> = {
  scanner: "scanner",
  options_discovery: "discovery",
  options_paper_mark: "mark",
  asymmetry_discovery: "discovery",
  asymmetry_mark: "mark",
  watchlist: "research",
  premarket: "research",
  historical_research: "research",
  enrichment: "enrichment",
  diagnostics: "diagnostic",
  dashboard_api: "diagnostic",
  seed_worker: "research",
  unattributed: "diagnostic",
};

export function providerCategoryFor(consumer: ProviderConsumer): ProviderCategory {
  return CATEGORY_BY_CONSUMER[consumer] ?? "diagnostic";
}

export interface ProviderScope {
  consumer: ProviderConsumer;
  /** Optional sweep/job identifier so requests can be grouped per invocation. */
  invocationId?: string | null;
  /** True when the scope is fetching history rather than live market state. */
  historical?: boolean;
}

const storage = new AsyncLocalStorage<ProviderScope>();

export function isProviderConsumer(value: unknown): value is ProviderConsumer {
  return typeof value === "string" && (PROVIDER_CONSUMERS as readonly string[]).includes(value);
}

/** Run `fn` with every provider call inside it attributed to `scope`. */
export function withProviderConsumer<T>(
  scope: ProviderConsumer | ProviderScope,
  fn: () => T,
): T {
  const resolved: ProviderScope = typeof scope === "string" ? { consumer: scope } : scope;
  return storage.run(resolved, fn);
}

/** The innermost active scope, or null outside any scope. */
export function currentProviderScope(): ProviderScope | null {
  return storage.getStore() ?? null;
}

/** The innermost active consumer, or `unattributed`. */
export function currentProviderConsumer(): ProviderConsumer {
  return storage.getStore()?.consumer ?? "unattributed";
}
