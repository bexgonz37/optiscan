/** Shared dashboard preferences (localStorage). */

export const REFRESH_CHOICES = [15, 30, 60, 120] as const;
export const DEFAULT_REFRESH_SEC = 30;
export const DASHBOARD_PREFS_KEY = "optiscan:prefs";

export type DashboardTab = "momentum" | "unusual";
export type Theme = "dark" | "light";

export const CHART_TIMEFRAMES = ["1m", "5m", "15m", "1D"] as const;
export type ChartTimeframe = (typeof CHART_TIMEFRAMES)[number];

export const CHART_STACK_TIMEFRAMES = ["1m", "5m", "15m"] as const;
export type ChartStackTimeframe = (typeof CHART_STACK_TIMEFRAMES)[number];

export const CHART_INDICATORS = ["vwap", "ema9", "ema21", "sma50", "rsi", "macd"] as const;
export type ChartIndicator = (typeof CHART_INDICATORS)[number];

export const DEFAULT_CHART_INDICATORS: ChartIndicator[] = ["vwap", "ema9", "ema21"];

export const DEFAULT_STACK_INDICATORS: Record<ChartStackTimeframe, ChartIndicator[]> = {
  "1m": ["vwap", "ema9", "ema21"],
  "5m": ["vwap", "ema9", "ema21"],
  "15m": ["vwap"],
};

export interface DashboardPrefs {
  refreshSec?: number;
  tab?: DashboardTab;
  desktopAlerts?: boolean;
  theme?: Theme;
  chartTimeframe?: ChartTimeframe;
  chartIndicators?: ChartIndicator[];
  /** Per-timeframe indicator toggles for stacked layout. */
  chartIndicatorsByTf?: Partial<Record<ChartStackTimeframe, ChartIndicator[]>>;
  /** Mobile forces single chart regardless. */
  chartStacked?: boolean;
  /** Optional override for 0DTE context strip (max 6). */
  zeroDteStripSymbols?: string[];
}

export function loadDashboardPrefs(): DashboardPrefs {
  try {
    const raw = localStorage.getItem(DASHBOARD_PREFS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as DashboardPrefs;
  } catch {
    return {};
  }
}

export function saveDashboardPrefs(patch: Partial<DashboardPrefs>): void {
  try {
    const cur = loadDashboardPrefs();
    localStorage.setItem(DASHBOARD_PREFS_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch {
    /* ignore */
  }
}
