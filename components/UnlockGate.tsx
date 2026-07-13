"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getToken, setToken, apiFetch, UNAUTHORIZED_EVENT,
} from "@/lib/client-auth";

/**
 * UnlockGate — the single owner-facing "Unlock OptiScan" experience.
 *
 * Mounted once (in the root layout). It opens a simple modal asking for the
 * private access token (SCAN_API_TOKEN) whenever:
 *   - a protected API request returns 401 (the shared apiFetch fires an event), or
 *   - on first load the server requires a token and none is stored / it is stale.
 *
 * It never shows developer instructions, never renders/logs the token value, and
 * never places the token in a URL. The input is a password field; the value only
 * ever lives in component state until saved through the shared client helper.
 */

async function serverRequiresUnlock(): Promise<boolean> {
  // A cheap probe against a token-gated status endpoint. 401 → unlock needed.
  // Any other outcome (200, network error, open server) → no forced prompt.
  try {
    const res = await apiFetch("/api/runtime/status", { cache: "no-store" });
    return res.status === 401;
  } catch {
    return false;
  }
}

export function UnlockGate() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const probing = useRef(false);

  const openPrompt = useCallback((msg?: string) => {
    setValue("");
    setMessage(msg ?? null);
    setOpen(true);
  }, []);

  // Open on any 401 raised by the shared apiFetch helper.
  useEffect(() => {
    const onUnauthorized = () => openPrompt("Your access token was rejected. Enter the current token to continue.");
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [openPrompt]);

  // First-load probe: if the server is gated and we can't reach it authorized,
  // prompt once. Skipped entirely when the server is open (no token required).
  useEffect(() => {
    if (probing.current) return;
    probing.current = true;
    void (async () => {
      if (await serverRequiresUnlock()) openPrompt();
    })();
  }, [openPrompt]);

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (!token) { setMessage("Enter your access token."); return; }
    setBusy(true);
    setMessage(null);
    // Save first so the probe request carries it, then verify against the server.
    setToken(token);
    try {
      const res = await apiFetch("/api/runtime/status", { cache: "no-store" });
      if (res.status === 401) {
        // apiFetch already cleared the bad token.
        setMessage("That token was not accepted. Check it in your Railway variables and try again.");
        setBusy(false);
        return;
      }
      setOpen(false);
      setValue("");
      // Nudge open pages to reload their data now that we're authorized.
      window.dispatchEvent(new CustomEvent("optiscan:token-changed"));
    } catch {
      // Network/server error is not an auth failure — keep the token, close, let
      // pages surface their own "server unavailable" state.
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }, [value]);

  if (!open) {
    // A discreet re-entry affordance only appears if we have no token at all.
    if (getToken()) return null;
    return (
      <button
        type="button"
        className="unlock-fab"
        onClick={() => openPrompt()}
        aria-label="Enter OptiScan access token"
      >
        🔒 Enter access token
      </button>
    );
  }

  return (
    <div className="unlock-overlay" role="dialog" aria-modal="true" aria-labelledby="unlock-title">
      <form className="unlock-card" onSubmit={submit}>
        <div className="unlock-title" id="unlock-title">Unlock OptiScan</div>
        <p className="unlock-sub">
          This dashboard needs your private OptiScan access token. It is your owner
          password (the <code>SCAN_API_TOKEN</code> from Railway) — not shared with
          anyone and never sent anywhere except your own server.
        </p>
        <input
          className="unlock-input"
          type="password"
          autoComplete="off"
          autoFocus
          spellCheck={false}
          placeholder="Access token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Access token"
        />
        {message ? <div className="unlock-msg">{message}</div> : null}
        <div className="unlock-actions">
          <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>
            {busy ? "Checking…" : "Unlock"}
          </button>
        </div>
        <p className="unlock-hint">
          You can change or remove this later in Settings → “Lock dashboard”.
        </p>
      </form>
    </div>
  );
}
