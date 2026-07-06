/** Shared dashboard preferences (localStorage). */

export const REFRESH_CHOICES = [15, 30, 60, 120] as const;
export const DEFAULT_REFRESH_SEC = 30;
export const DASHBOARD_PREFS_KEY = "optiscan:prefs";

export type DashboardTab = "momentum" | "unusual";

export interface DashboardPrefs {
  refreshSec?: number;
  tab?: DashboardTab;
  desktopAlerts?: boolean;
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
