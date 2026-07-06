"use client";

/**
 * /settings — language mode, capture thresholds, notification channels,
 * dashboard preferences, Discord controls, and pending manual-confirm queue.
 */

import { useCallback, useEffect, useState } from "react";
import { scanHeaders, requestNotifyPermission } from "@/hooks/useScanner";
import { AppNav } from "@/components/AppNav";
import { HelpSection } from "@/components/HelpSection";
import {
  DEFAULT_REFRESH_SEC,
  REFRESH_CHOICES,
  loadDashboardPrefs,
  saveDashboardPrefs,
} from "@/lib/dashboard-prefs";

export default function SettingsPage() {
  const [settings, setSettings] = useState<any>(null);
  const [languageMode, setLanguageMode] = useState("private");
  const [webhookConfigured, setWebhookConfigured] = useState(false);
  const [pending, setPending] = useState<any[]>([]);
  const [minMomentum, setMinMomentum] = useState("62");
  const [minUnusual, setMinUnusual] = useState("80");
  const [minRate, setMinRate] = useState("0.18");
  const [minSurge, setMinSurge] = useState("1.4");
  const [minAccel, setMinAccel] = useState("0");
  const [minEfficiency, setMinEfficiency] = useState("0.35");
  const [minLevelSurge, setMinLevelSurge] = useState("1.2");
  const [stockMinScore, setStockMinScore] = useState("66");
  const [refreshSec, setRefreshSec] = useState(DEFAULT_REFRESH_SEC);
  const [desktopAlerts, setDesktopAlerts] = useState(false);
  const [extendedStockNotify, setExtendedStockNotify] = useState(false);
  const [stripSymbols, setStripSymbols] = useState("");
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
        const t = d.scannerThresholds;
        if (t) {
          setMinMomentum(String(t.alertMinMomentumScore ?? 62));
          setMinUnusual(String(t.alertMinUnusualScore ?? 80));
          setMinRate(String(t.scannerMinRatePctMin ?? 0.18));
          setMinSurge(String(t.scannerMinVolSurge ?? 1.4));
          setMinAccel(String(t.scannerMinAccel ?? 0));
          setMinEfficiency(String(t.scannerMinEfficiency ?? 0.35));
          setMinLevelSurge(String(t.scannerMinLevelSurge ?? 1.2));
          setStockMinScore(String(t.stockMinScore ?? 66));
        }
        setExtendedStockNotify(Boolean(d.extendedStockNotify));
      }
      const manualConfirm = Boolean(d.settings?.discord_requires_manual_confirm);
      if (manualConfirm) {
        const p = await fetch("/api/notifications/pending", { cache: "no-store", headers });
        const pd = await p.json();
        if (pd.ok) setPending(pd.pending ?? []);
      } else {
        setPending([]);
      }
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to load settings");
    }
  }, []);

  useEffect(() => {
    load();
    const p = loadDashboardPrefs();
    if (typeof p.refreshSec === "number" && (REFRESH_CHOICES as readonly number[]).includes(p.refreshSec)) {
      setRefreshSec(p.refreshSec);
    }
    if (typeof p.desktopAlerts === "boolean") setDesktopAlerts(p.desktopAlerts);
    if (Array.isArray(p.zeroDteStripSymbols)) setStripSymbols(p.zeroDteStripSymbols.join(", "));
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
      setMsg("Saved.");
    } else setMsg(d.error ?? "Save failed");
  }

  async function confirmPending(id: number, discard = false) {
    const res = await fetch("/api/notifications/pending", {
      method: "POST",
      headers: { "content-type": "application/json", ...scanHeaders() },
      body: JSON.stringify(discard ? { id, action: "discard" } : { id }),
    });
    const d = await res.json();
    setMsg(d.ok ? (discard ? "Discarded." : "Sent to Discord.") : d.error ?? "Failed");
    load();
  }

  async function testChannels() {
    const res = await fetch("/api/notifications/test", { method: "POST", headers: scanHeaders() });
    const d = await res.json();
    setTestPreview(d.ok ? d : null);
    setMsg(d.ok ? "Test payloads rendered below." : d.error ?? "Test failed");
  }

  async function testDiscord() {
    const res = await fetch("/api/notifications/discord/test", { method: "POST", headers: scanHeaders() });
    const d = await res.json();
    setMsg(d.ok ? "Discord test sent." : d.error ?? "Discord test failed");
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

  function setIntervalPref(sec: number) {
    setRefreshSec(sec);
    saveDashboardPrefs({ refreshSec: sec });
    setMsg(`Scanner refresh set to ${sec}s.`);
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
    <div className="app">
      <AppNav status={msg ? [{ label: msg }] : undefined} />

      <div className="settings-page-header muted">
        Notifications and optional tuning. Help and how the scanner works are at the bottom.
      </div>

      <div className="settings-grid">
        <div className="panel main settings-panel">
          <h2>Dashboard</h2>
          <p className="settings-desc">Scanner auto-refreshes on the dashboard. Live movers update every ~1.5s automatically.</p>

          <div className="settings-row">
            <div className="settings-row-label">
              Scanner refresh interval
              <div className="settings-row-hint">How often momentum &amp; unusual scans run</div>
            </div>
            <select
              className="select-sm"
              value={refreshSec}
              onChange={(e) => setIntervalPref(Number(e.target.value))}
            >
              {REFRESH_CHOICES.map((s) => (
                <option key={s} value={s}>
                  {s} seconds
                </option>
              ))}
            </select>
          </div>

          <div className="settings-row">
            <div className="settings-row-label">
              Desktop alerts (browser)
              <div className="settings-row-hint">OS notification ping on strong scanner signals</div>
            </div>
            <button type="button" className={`btn-toggle${desktopAlerts ? " on" : ""}`} onClick={toggleDesktopAlerts}>
              {desktopAlerts ? "On" : "Off"}
            </button>
          </div>

          <div className="settings-row">
            <div className="settings-row-label">
              0DTE context strip symbols
              <div className="settings-row-hint">Up to 6 tickers on Live (comma-separated). Chart symbol is always first.</div>
            </div>
            <input
              className="input-sm"
              style={{ minWidth: 220 }}
              placeholder="SPY, QQQ, IWM…"
              value={stripSymbols}
              onChange={(e) => setStripSymbols(e.target.value)}
              onBlur={() => {
                const list = stripSymbols.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 6);
                setStripSymbols(list.join(", "));
                saveDashboardPrefs({ zeroDteStripSymbols: list.length ? list : undefined });
                setMsg(list.length ? "0DTE strip symbols saved." : "0DTE strip reset to universe default.");
              }}
            />
          </div>

          <h2>Language mode</h2>
          <p className="settings-desc">
            Private mode shows trading labels. Public mode is education-safe for screenshots.
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
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
          <p className="settings-desc">Minimum scores and scanner gates. Higher = fewer but sharper callouts. Run <code>node scripts/calibrate-accuracy.mjs</code> to tune toward 70% early hit rate.</p>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <span className="settings-desc" style={{ margin: 0 }}>Momentum ≥</span>
            <input className="input-sm" style={{ width: 64 }} value={minMomentum} onChange={(e) => setMinMomentum(e.target.value)} />
            <span className="settings-desc" style={{ margin: 0 }}>Unusual ≥</span>
            <input className="input-sm" style={{ width: 64 }} value={minUnusual} onChange={(e) => setMinUnusual(e.target.value)} />
          </div>
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
            <span className="settings-desc" style={{ margin: 0 }} title="Premarket/after-hours stock callouts (BUY LONG/SHORT)">Stock score ≥</span>
            <input className="input-sm" style={{ width: 64 }} value={stockMinScore} onChange={(e) => setStockMinScore(e.target.value)} />
            <button
              type="button"
              className="btn-primary"
              onClick={() =>
                patch({
                  alertMinMomentumScore: Number(minMomentum),
                  alertMinUnusualScore: Number(minUnusual),
                  scannerMinRatePctMin: Number(minRate),
                  scannerMinVolSurge: Number(minSurge),
                  scannerMinAccel: Number(minAccel),
                  scannerMinEfficiency: Number(minEfficiency),
                  scannerMinLevelSurge: Number(minLevelSurge),
                  stockMinScore: Number(stockMinScore),
                })
              }
            >
              Save thresholds
            </button>
          </div>

          <h2>Notifications</h2>
          <Toggle label="Browser popups" field="browser_popup_enabled" hint="Popup cards with Watch / Journal / Snooze" />
          <Toggle label="Desktop notifications" field="desktop_notification_enabled" hint="Works with popup alerts from the scanner" />
          <Toggle label="Sound" field="sound_enabled" />
          <div className="settings-row">
            <div className="settings-row-label">
              Premarket/after-hours stock alerts
              <div className="settings-row-hint">
                Popups and Discord for extended-hours share callouts. Off by default — alerts still appear in History.
              </div>
            </div>
            <button
              type="button"
              className={`btn-toggle${extendedStockNotify ? " on" : ""}`}
              onClick={() => {
                const next = !extendedStockNotify;
                setExtendedStockNotify(next);
                patch({ extendedStockNotify: next });
              }}
            >
              {extendedStockNotify ? "On" : "Off"}
            </button>
          </div>
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

        <div className="panel main settings-panel">
          <h2>Discord</h2>
          <p className="settings-desc">
            Webhook in <code>.env.local</code> only — never exposed to the browser.
            Status:{" "}
            <strong style={{ color: webhookConfigured ? "var(--green)" : "var(--amber)" }}>
              {webhookConfigured ? "configured" : "not configured"}
            </strong>
          </p>
          <Toggle label="Discord alerts" field="discord_enabled" hint="Auto-send BUY CALL/PUT when TRADE fires (needs webhook in .env.local)" />
          <Toggle label="Manual confirmation" field="discord_requires_manual_confirm" hint="Off = instant Discord on every BUY signal" />
          {!settings?.discord_requires_manual_confirm && settings?.discord_enabled ? (
            <p className="settings-desc" style={{ color: "var(--green)", marginTop: 8 }}>
              Auto-send ON — only extra-clear BUY signals (≥82% confidence, stock moving ≥0.2%/min the right way). No flood.
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
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn-primary" onClick={testDiscord}>
              Send Discord test
            </button>
          </div>

          {settings?.discord_requires_manual_confirm ? (
            <>
              <h2>Pending Discord ({pending.length})</h2>
              {!pending.length ? (
                <p className="settings-desc">Nothing waiting for confirmation.</p>
              ) : (
                pending.map((p) => {
                  let content = "";
                  try {
                    content = JSON.parse(p.payload_json ?? "{}").content ?? "";
                  } catch {
                    /* ignore */
                  }
                  return (
                    <div key={p.id} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10, marginBottom: 8 }}>
                      <div style={{ fontSize: 11, whiteSpace: "pre-line", marginBottom: 8 }}>{content}</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" className="btn-primary" onClick={() => confirmPending(p.id)}>
                          Send
                        </button>
                        <button type="button" className="btn-toggle" onClick={() => confirmPending(p.id, true)}>
                          Discard
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </>
          ) : null}
        </div>
      </div>

      <div id="help" className="settings-help-wrap">
        <HelpSection />
      </div>

      <div className="footer">Settings · alerts are research signals, never recommendations · not financial advice</div>
    </div>
  );
}
