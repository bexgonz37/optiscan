/** Open the global chart drawer from any client page (Settings, popups, etc.). */
export const OPEN_CHART_EVENT = "optiscan:open-chart";

export function openLiveChart(symbol: string) {
  if (typeof window === "undefined" || !symbol?.trim()) return;
  window.dispatchEvent(
    new CustomEvent(OPEN_CHART_EVENT, { detail: { symbol: symbol.trim().toUpperCase() } }),
  );
}
