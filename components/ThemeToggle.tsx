"use client";

/**
 * ThemeToggle — flips between dark and light by setting data-theme on <html>
 * and persisting the choice in dashboard prefs. The initial theme is applied
 * pre-hydration by the inline script in app/layout.tsx to avoid a flash.
 */

import { useEffect, useState } from "react";
import { loadDashboardPrefs, saveDashboardPrefs, type Theme } from "@/lib/dashboard-prefs";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const current = (document.documentElement.dataset.theme as Theme) || loadDashboardPrefs().theme || "dark";
    setTheme(current);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    saveDashboardPrefs({ theme: next });
  }

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={toggle}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
    >
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}
