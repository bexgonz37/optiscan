"use client";

/**
 * /settings — language mode, capture thresholds, and notification channels.
 */

import { useCallback, useEffect, useState } from "react";
import { scanHeaders, requestNotifyPermission } from "@/hooks/useScanner";
import { invalidateLanguageMode } from "@/hooks/useLanguageMode";
import { HelpSection } from "@/components/HelpSection";
import { loadDashboardPrefs, saveDashboardPrefs } from "@/lib/dashboard-prefs";

export default function SettingsPage() {
  const [settings, setSettings] = useState<any>(null);
  const [languageMode, setLanguageMode] = useState("private");
  const [webhookConfigured, setWebhookConfigured] = useState(false);
  const [discordWebhooks, setDiscordWebhooks] = useState({ options: false, stocks: false, recap: false });
  const [stockCalloutsEnabled, setStockCalloutsEnabled] = useState(false);
  const [extendedStockNotify, setExtendedStockNotify] = useState(false);
  const [minRate, setMinRate] = useState("0.2");
  const [minSurge, setMinSurge] = useState("1.4");
  const [minAccel, setMinAccel] = useState("0");
  const [minEfficiency, setMinEfficiency] = useState("0.35");
  const [minLevelSurge, setMinLevelSurge] = useState("1.2");
  const [maxSpread, setMaxSpread] = useState("5");
  const [stockMinScore, setStockMinScore] = useState("66");
  const [desktopAlerts, setDesktopAlerts] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [testPreview, setTestPreview] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      const headers = scanHeaders();
      const res = await fetch("/api/notifications/settings", { cache: "no-store", headers });
      const d = await res.json();
      if (d.ok) {
        setSettings(d.settings);
        setLanguageMode(d.languageMode);
        setWebhookConfigured(Boolean(d.discordWebhookConfigured));
        setDiscordWebhooks(d.discordWebhooks ?? { options: false, stocks: false, recap: false });
        setStockCalloutsEnabled(Boolean(d.stockCalloutsEnabled));
        setExtendedStockNotify(Boolean(d.extendedStockNotify));
        const t = d.scannerThresholds;
        if (t) {
          setMinRate(String(t.scannerMinRatePctMin ?? 0.2));
          setMinSurge(String(t.scannerMinVolSurge ?? 1.4));
          setMinAccel(String(t.scannerMinAccel ?? 0));
          setMinEfficiency(String(t.scannerMinEfficiency ?? 0.35));
          setMinLevelSurge(String(t.scannerMinLevelSurge ?? 1.2));
          setMaxSpread(String(t.tradeMaxSpreadPct ?? 5));
          setStockMinScore(String(t.stockMinScore ?? 66));
        }
      }
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to load settings");
    }
  }, []);

  useEffect(() => {
    load();
    const p = loadDashboardPrefs();
    if (typeof p.desktopAlerts === "boolean") setDesktopAlerts(p.desktopAlerts);
  }, [load]);

  async function patch(body: Record<string, unknown>) {
    setMsg(null);
    const res = await fetch("/api/notifications/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...scanHeaders() },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (d.ok) {
      setSettings(d.settings);
      setLanguageMode(d.languageMode);
      invalidateLanguageMode(); // update mode-aware views without reload
      if (d.discordWebhooks) setDiscordWebhooks(d.discordWebhooks);
      setStockCalloutsEnabled(Boolean(d.stockCalloutsEnabled));
      setExtendedStockNotify(Boolean(d.extendedStockNotify));
      setMsg("Saved.");
    } else setMsg(d.error ?? "Save failed");
  }

  async function testChannels() {
    const res = await fetch("/api/notifications/test", { method: "POST", headers: scanHeaders() });
    const d = await res.json();
    setTestPreview(d.ok ? d : null);
    setMsg(d.ok ? "Test payloads rendered below." : d.error ?? "Test failed");
  }

  async function testDiscord(kind: "options" | "stocks") {
    const res = await fetch(`/api/notifications/discord/test?kind=${kind}`, { method: "POST", headers: scanHeaders() });
    const d = await res.json();
    setMsg(d.ok ? `Discord ${kind} test sent.` : d.error ?? "Discord test failed");
  }

  async function toggleDesktopAlerts() {
    if (!desktopAlerts) {
      const ok = await requestNotifyPermission();
      setDesktopAlerts(ok);
      saveDashboardPrefs({ desktopAlerts: ok });
      setMsg(ok ? "Desktop alerts enabled." : "Browser blocked notifications.");
    } else {
      setDesktopAlerts(false);
      saveDashboardPrefs({ desktopAlerts: false });
      setMsg("Desktop alerts disabled.");
    }
  }

  const Toggle = ({ label, field, hint }: { label: string; field: string; hint?: string }) => (
    <div className="settings-row">
      <div className="settings-row-label">
        {label}
        {hint ? <div className="settings-row-hint">{hint}</div> : null}
      </div>
      <button
        type="button"
        className={`btn-toggle${settings?.[field] ? " on" : ""}`}
        onClick={() =>
          patch({
            [{
              browser_popup_enabled: "browserPopupEnabled",
              desktop_notification_enabled: "desktopNotificationEnabled",
              sound_enabled: "soundEnabled",
              discord_enabled: "discordEnabled",
              discord_requires_manual_confirm: "discordRequiresManualConfirm",
            }[field] as string]: settings?.[field] ? 0 : 1,
          })
        }
      >
        {settings?.[field] ? "On" : "Off"}
      </button>
    </div>
  );

  return (
    <div className="page-deck">
      <div className="page-deck-toolbar">
        <div className="settings-page-header muted">
          Notifications and speed thresholds. Help and how the scanner works are at the bottom.
        </div>
        {msg ? <span className="settings-status-msg muted text-xs">{msg}</span> : null}
      </div>

      <div className="settings-grid">
        <div className="panel main settings-panel axiom-panel">
          <h2>Dashboard</h2>
          <p className="settings-desc">0DTE fast-mover callouts — speed and volume gates for BUY CALL/PUT signals.</p>

          <div className="settings-row">
            <div className="settings-row-label">
              Desktop alerts (browser)
              <div className="settings-row-hint">OS notification ping on strong scanner signals</div>
            </div>
            <button type="button" className={`btn-toggle${desktopAlerts ? " on" : ""}`} onClick={toggleDesktopAlerts}>
              {desktopAlerts ? "On" : "Off"}
            </button>
          </div>

          <h2>Language mode</h2>
          <p className="settings-desc">
            Private mode shows BUY CALL/PUT labels. Public mode is education-safe for screenshots.
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <button
              type="button"
              className={`btn-toggle${languageMode === "private" ? " on" : ""}`}
              onClick={() => patch({ languageMode: "private" })}
            >
              Private
            </button>
            <button
              type="button"
              className={`btn-toggle${languageMode === "public" ? " on" : ""}`}
              onClick={() => patch({ languageMode: "public" })}
            >
              Public
            </button>
          </div>

          <h2>Capture thresholds</h2>
          <p className="settings-desc">
            Scanner speed and volume gates — higher = fewer, better callouts. Recommended (from the 2026-07-07 accuracy
            audit): Speed 0.18–0.25 · Surge 1.4–1.8 · Efficiency 0.35–0.45 · Max spread 4–6%. Going below Speed 0.15 or
            Surge 1.3 fires on single-tick noise.
          </p>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <span className="settings-desc" style={{ margin: 0 }}>Speed ≥</span>
            <input className="input-sm" style={{ width: 64 }} value={minRate} onChange={(e) => setMinRate(e.target.value)} />
            <span className="settings-desc" style={{ margin: 0 }}>%/min · Surge ≥</span>
            <input className="input-sm" style={{ width: 64 }} value={minSurge} onChange={(e) => setMinSurge(e.target.value)} />
            <span className="settings-desc" style={{ margin: 0 }}>x · Accel &gt;</span>
            <input className="input-sm" style={{ width: 64 }} value={minAccel} onChange={(e) => setMinAccel(e.target.value)} />
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <span className="settings-desc" style={{ margin: 0 }}>Efficiency ≥</span>
            <input className="input-sm" style={{ width: 64 }} value={minEfficiency} onChange={(e) => setMinEfficiency(e.target.value)} />
            <span className="settings-desc" style={{ margin: 0 }}>· Level-break surge ≥</span>
            <input className="input-sm" style={{ width: 64 }} value={minLevelSurge} onChange={(e) => setMinLevelSurge(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <span className="settings-desc" style={{ margin: 0 }} title="A BUY callout requires the contract's bid-ask spread at or under this — wider than ~6% and the spread eats the move.">
              BUY max spread ≤
            </span>
            <input className="input-sm" style={{ width: 64 }} value={maxSpread} onChange={(e) => setMaxSpread(e.target.value)} />
            <span className="settings-desc" style={{ margin: 0 }}>%</span>
            <button
              type="button"
              className="btn-primary"
              onClick={() =>
                patch({
                  scannerMinRatePctMin: Number(minRate),
                  scannerMinVolSurge: Number(minSurge),
                  scannerMinAccel: Number(minAccel),
                  scannerMinEfficiency: Number(minEfficiency),
                  scannerMinLevelSurge: Number(minLevelSurge),
                  tradeMaxSpreadPct: Number(maxSpread),
                })
              }
            >
              Save thresholds
            </button>
          </div>

          <h2>Market momentum</h2>
          <p className="settings-desc">
            Shares-only LONG/SHORT callouts in premarket, regular hours, and after-hours. Engine: {stockCalloutsEnabled ? "enabled" : "disabled — set STOCK_CALLOUTS=1"}.
          </p>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <span className="settings-desc" style={{ margin: 0 }}>Stock score ≥</span>
            <input aria-label="Minimum stock callout score" className="input-sm" style={{ width: 64 }} value={stockMinScore} onChange={(e) => setStockMinScore(e.target.value)} />
            <button type="button" className="btn-primary" onClick={() => patch({ stockMinScore: Number(stockMinScore) })}>Save stock threshold</button>
          </div>
          <div className="settings-row">
            <div className="settings-row-label">Extended-hours Discord<div className="settings-row-hint">Allow stock BUYs in premarket and after-hours</div></div>
            <button type="button" className={`btn-toggle${extendedStockNotify ? " on" : ""}`} onClick={() => patch({ extendedStockNotify: !extendedStockNotify })}>
              {extendedStockNotify ? "On" : "Off"}
            </button>
          </div>

          <h2>Notifications</h2>
          <Toggle label="Browser popups" field="browser_popup_enabled" hint="Popup cards with Watch / Journal / Snooze" />
          <Toggle label="Desktop notifications" field="desktop_notification_enabled" hint="Works with popup alerts from the scanner" />
          <Toggle label="Sound" field="sound_enabled" />
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn-primary" onClick={testChannels}>
              Preview test alert
            </button>
          </div>
          {testPreview ? (
            <pre style={{ fontSize: 10, background: "#0b0f14", padding: 10, borderRadius: 8, overflow: "auto", maxHeight: 180, marginTop: 10 }}>
              {JSON.stringify({ private: testPreview.privatePopup, public: testPreview.publicAlert, discord: testPreview.discordPreview }, null, 2)}
            </pre>
          ) : null}
        </div>

        <div className="panel main settings-panel axiom-panel">
          <h2>Discord</h2>
          <p className="settings-desc">
            Webhook in <code>.env.local</code> only — never exposed to the browser.
            Status:{" "}
            <strong style={{ color: webhookConfigured ? "var(--green)" : "var(--amber)" }}>
              {webhookConfigured ? "configured" : "not configured"}
            </strong>
          </p>
          <div className="discord-channel-status">
            <div><span>Options</span><strong className={discordWebhooks.options ? "pos" : "muted"}>{discordWebhooks.options ? "connected" : "missing"}</strong></div>
            <div><span>Stocks</span><strong className={discordWebhooks.stocks ? "pos" : "muted"}>{discordWebhooks.stocks ? "connected" : "missing"}</strong></div>
            <div><span>Recap</span><strong className={discordWebhooks.recap ? "pos" : "muted"}>{discordWebhooks.recap ? "connected" : "optional"}</strong></div>
          </div>
          <Toggle label="Discord alerts" field="discord_enabled" hint="Auto-send BUY CALL/PUT when TRADE fires (needs webhook in .env.local)" />
          {settings?.discord_enabled ? (
            <p className="settings-desc" style={{ color: "var(--green)", marginTop: 8 }}>
              Auto-send ON — TRADE signals post to Discord instantly. No manual confirm queue.
            </p>
          ) : null}
          <div className="settings-row">
            <div className="settings-row-label">
              Public wording for Discord
              <div className="settings-row-hint">Always locked on — education-safe language</div>
            </div>
            <span className="btn-toggle on" style={{ cursor: "default" }}>
              Locked
            </span>
          </div>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button type="button" className="btn-primary" onClick={() => testDiscord("options")}>Test options webhook</button>
            <button type="button" className="btn-primary" onClick={() => testDiscord("stocks")}>Test stocks webhook</button>
          </div>
        </div>
      </div>

      <div id="help" className="settings-help-wrap">
        <HelpSection />
      </div>

      <div className="page-deck-foot muted text-xs">Settings · alerts are research signals, never recommendations · not financial advice</div>
    </div>
  );
}
