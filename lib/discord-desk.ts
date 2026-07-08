/** UI filter — alerts worth posting to Discord (not signal math). */

import { isFillableOptionsSetup } from "@/lib/format-contract";
import { isMetaShapedAlert } from "@/lib/meta-bar";
import { CORE_WATCH } from "@/lib/universe";

const CORE = new Set(CORE_WATCH);

export function isDiscordRelevantAlert(a: {
  asset_class?: string | null;
  capture_action?: string | null;
  ticker?: string | null;
  entry_spread_pct?: number | null;
  signal_score?: number | null;
  short_rate_at_alert?: number | null;
  volume_surge_at_alert?: number | null;
  move_status?: string | null;
} | null | undefined): boolean {
  if (!a || a.asset_class === "stock") return false;
  if (String(a.capture_action).toUpperCase() === "TRADE") {
    return isFillableOptionsSetup(a);
  }
  return isFillableOptionsSetup(a) && isMetaShapedAlert(a);
}

export function isCoreTicker(symbol: string): boolean {
  return CORE.has(symbol.toUpperCase());
}

/** How long the hero card stays pinned before switching to a newer callout. */
export const HERO_STICKY_MS = 5 * 60_000;
