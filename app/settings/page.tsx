"use client";

/**
 * /settings — language mode, capture thresholds, notification channels,
 * Discord controls (off by default; webhook URL is env-only and never shown
 * here — only a configured yes/no), and the pending manual-confirm queue.
 */

import { useCallback, useEffect, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";

export default function SettingsPage() {
  const [settings, setSettings] = useState<any>(null);
  const [languageMode, setLanguageMode] = useState("private");
  const [webhookConfigured, setWebhookConfigured] = useState(false);
  const [pending, setPending] = useState<any[]>([]);
  const [minMomentum, setMinMomentum] = useState("65");
  const [minUnusual, setMinUnusual] = useState("80");
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
      }
      const p = await fetch("/api/notifications/pending", { cache: "no-store", headers });
      const pd = await p.json();
      if (pd.ok) setPending(pd.pending ?? []);
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to load settings");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function patch(body: Record<string, unknown>) {
    setMsg(null);
    const res = await fetch("/api/notifications/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...scanHeaders() },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (d.ok) { setSettings(d.settings); setLanguageMode(d.languageMode); setMsg("Saved."); }
    else setMsg(d.error ?? "Save failed");
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

  const Toggle = ({ label, field, hint }: { label: string; field: string; hint?: string }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid rgba(120,140,160,.12)" }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        {hint ? <div className="muted" style={{ fontSize: 11 }}>{hint}</div> : null}
      </div>
      <div
        className={`pill btn ${settings?.[field] ? "on" : ""}`}
        onClick={() => patch({ [{
          browser_popup_enabled: "browserPopupEnabled",
          desktop_notification_enabled: "desktopNotificationEnabled",
          sound_enabled: "soundEnabled",
          discord_enabled: "discordEnabled",
          discord_requires_manual_confirm: "discordRequiresManualConfirm",
        }[field] as string]: settings?.[field] ? 0 : 1 })}
      >
        {settings?.[field] ? "On" : "Off"}
      </div>
    </div>
  );

  const sel = { background: "#10161d", color: "var(--txt)", border: "1px solid rgba(120,140,160,.25)", borderRadius: 8, padding: "6px 8px", fontSize: 12 } as const;

  return (
    <div className="app">
      <div className="topbar">
        <div className="logo"><span className="mark">O</span>OptiScan<small>settings</small></div>
        <div className="spacer" />
        {msg ? <div className="pill">{msg}</div> : null}
        <a className="pill btn" href="/alert-lab">Alert Lab</a>
        <a className="pill btn" href="/review">How it works</a>
        <a className="pill btn" href="/">← Scanner</a>
      </div>

      <div className="layout" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "start" }}>
        <div className="panel main" style={{ padding: 16 }}>
          <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>Language mode</h2>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Private mode shows my labels (A+ Setup, Possible Call/Put Setup). Public mode is
            education-safe wording for screenshots/streams — no directive trading language anywhere.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <div className={`pill btn ${languageMode === "private" ? "on" : ""}`} onClick={() => patch({ languageMode: "private" })}>Private Trading Mode</div>
            <div className={`pill btn ${languageMode === "public" ? "on" : ""}`} onClick={() => patch({ languageMode: "public" })}>Public / Education Mode</div>
          </div>

          <h2 style={{ margin: "14px 0 10px", fontSize: 15 }}>Capture thresholds</h2>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Minimum scanner score for a signal to be saved + tracked as an alert.
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 12, width: 160 }}>Momentum alerts ≥</span>
            <input style={{ ...sel, width: 70 }} value={minMomentum} onChange={(e) => setMinMomentum(e.target.value)} />
            <span style={{ fontSize: 12, width: 160 }}>Unusual-flow alerts ≥</span>
            <input style={{ ...sel, width: 70 }} value={minUnusual} onChange={(e) => setMinUnusual(e.target.value)} />
            <div className="pill btn" onClick={() => patch({ alertMinMomentumScore: Number(minMomentum), alertMinUnusualScore: Number(minUnusual) })}>Save</div>
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            Scoring weights themselves are documented in <code>lib/alert-scoring.js</code> and kept in code so every historical score stays comparable.
          </div>

          <h2 style={{ margin: "16px 0 10px", fontSize: 15 }}>Notifications</h2>
          <Toggle label="Browser popups" field="browser_popup_enabled" hint="Real-time popup cards with Watch / Journal / Snooze actions" />
          <Toggle label="Desktop notifications" field="desktop_notification_enabled" hint="Needs browser permission (enable via Alerts On in the scanner)" />
          <Toggle label="Sound" field="sound_enabled" />
          <div style={{ marginTop: 10 }}>
            <div className="pill btn" onClick={testChannels}>Render test alert payloads</div>
          </div>
          {testPreview ? (
            <pre style={{ fontSize: 10, background: "#0b0f14", padding: 10, borderRadius: 8, overflow: "auto", maxHeight: 220, marginTop: 10 }}>
              {JSON.stringify({ private: testPreview.privatePopup, public: testPreview.publicAlert, discord: testPreview.discordPreview }, null, 2)}
            </pre>
          ) : null}
        </div>

        <div className="panel main" style={{ padding: 16 }}>
          <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>Discord (off by default)</h2>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Webhook URL lives only in <code>.env.local</code> (<code>DISCORD_WEBHOOK_URL</code>) — never in the browser.
            Status: <strong style={{ color: webhookConfigured ? "var(--green)" : "var(--amber)" }}>{webhookConfigured ? "configured" : "not configured"}</strong>.
            All Discord messages use Public / Education wording and are safety-checked before sending.
          </div>
          <Toggle label="Discord alerts" field="discord_enabled" hint="Master switch — nothing is ever sent while this is off" />
          <Toggle label="Require manual confirmation" field="discord_requires_manual_confirm" hint="Alerts queue below; you review + send each one yourself" />
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
            <div style={{ flex: 1, fontSize: 13 }}>Public wording required for Discord<div className="muted" style={{ fontSize: 11 }}>Locked on — Discord always uses education-mode language</div></div>
            <div className="pill on">Locked On</div>
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <div className="pill btn" onClick={testDiscord}>Send Discord test</div>
          </div>

          <h2 style={{ margin: "16px 0 10px", fontSize: 15 }}>Pending Discord alerts ({pending.length})</h2>
          {!pending.length ? (
            <div className="muted" style={{ fontSize: 12 }}>Nothing waiting for confirmation.</div>
          ) : pending.map((p) => {
            let content = ""; try { content = JSON.parse(p.payload_json ?? "{}").content ?? ""; } catch { /* ignore */ }
            return (
              <div key={p.id} style={{ border: "1px solid rgba(120,140,160,.2)", borderRadius: 8, padding: 10, marginBottom: 8 }}>
                <div style={{ fontSize: 11, whiteSpace: "pre-line", marginBottom: 8 }}>{content}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <div className="pill btn" onClick={() => confirmPending(p.id)}>Confirm &amp; send</div>
                  <div className="pill btn" onClick={() => confirmPending(p.id, true)}>Discard</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="footer">Settings · scanner alerts are research signals, never recommendations · not financial advice</div>
    </div>
  );
}
