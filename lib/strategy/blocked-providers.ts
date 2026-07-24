/**
 * Typed provider interfaces for data-dependent strategies that cannot activate
 * without licensed integrations. Returns BLOCKED evaluations — never fabricates data.
 */
import { blockedEvaluation, type StrategyEvaluation } from "./evaluation.ts";

export type DataProviderStatus = "ACTIVE" | "INACTIVE" | "BLOCKED" | "RESEARCH_ONLY";

export interface DataProviderEntitlement {
  providerId: string;
  dataset: string;
  status: DataProviderStatus;
  dependency: string;
  licensingConfirmed: boolean;
}

export const BLOCKED_DATA_PROVIDERS: DataProviderEntitlement[] = [
  { providerId: "level2", dataset: "order_book", status: "BLOCKED", dependency: "Licensed Level 2 order-book feed", licensingConfirmed: false },
  { providerId: "level3", dataset: "event_level", status: "BLOCKED", dependency: "Licensed Level 3 event-level feed", licensingConfirmed: false },
  { providerId: "dealer_gex", dataset: "gamma_exposure", status: "BLOCKED", dependency: "Documented dealer positioning inputs with legitimate licensing", licensingConfirmed: false },
  { providerId: "dark_pool", dataset: "off_exchange", status: "BLOCKED", dependency: "Licensed dark-pool print feed", licensingConfirmed: false },
  { providerId: "historical_options_greeks", dataset: "options_nbbo_greeks", status: "BLOCKED", dependency: "Historical options NBBO/Greeks entitlement", licensingConfirmed: false },
  { providerId: "earnings_calendar", dataset: "scheduled_events", status: "INACTIVE", dependency: "Paid earnings calendar provider wired server-side", licensingConfirmed: false },
];

const BLOCKED_STRATEGY_MAP: Record<string, { family: string; providerId: string }> = {
  order_book_imbalance: { family: "flow_microstructure", providerId: "level2" },
  queue_position: { family: "flow_microstructure", providerId: "level3" },
  dealer_gamma_exposure: { family: "options_structure", providerId: "dealer_gex" },
  dark_pool_anomaly: { family: "flow_microstructure", providerId: "dark_pool" },
  historical_option_replay: { family: "statistical", providerId: "historical_options_greeks" },
};

export function providerStatus(providerId: string): DataProviderEntitlement | null {
  return BLOCKED_DATA_PROVIDERS.find((p) => p.providerId === providerId) ?? null;
}

export function evaluateBlockedStrategy(strategyId: string): StrategyEvaluation | null {
  const map = BLOCKED_STRATEGY_MAP[strategyId];
  if (!map) return null;
  const prov = providerStatus(map.providerId);
  if (!prov || prov.status === "ACTIVE") return null;
  return blockedEvaluation(strategyId, map.family, prov.dependency);
}

export function isProviderActive(providerId: string): boolean {
  const p = providerStatus(providerId);
  return p?.status === "ACTIVE" && p.licensingConfirmed;
}
