"use client";

/**
 * client-auth.ts — the ONE shared client-side authenticated fetch helper.
 *
 * The hosted app is gated by an optional owner password (SCAN_API_TOKEN on the
 * server). The browser stores that password in localStorage under the existing
 * key `optiscan:token` and attaches it to every protected request as the
 * `x-scan-token` header.
 *
 * Invariants:
 *   - The token is NEVER put in a URL/query string (leaks into logs/history).
 *   - The token is NEVER logged or sent to analytics.
 *   - A 401 response clears the stored token and asks the owner to re-enter it,
 *     without exposing any developer/database instructions.
 *   - A 401 (authorization) is classified separately from a 5xx/database error.
 *
 * No server-only imports live here so the pure helpers are unit-testable with a
 * mocked global. All browser access is guarded by typeof checks.
 */

export const TOKEN_KEY = "optiscan:token";
export const UNAUTHORIZED_EVENT = "optiscan:unauthorized";
export const TOKEN_CHANGED_EVENT = "optiscan:token-changed";

export function getToken(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const t = localStorage.getItem(TOKEN_KEY);
    return t && t.trim() ? t : null;
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(TOKEN_KEY, token.trim());
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(TOKEN_CHANGED_EVENT));
    }
  } catch {
    /* storage unavailable — ignore */
  }
}

export function clearToken(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(TOKEN_KEY);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(TOKEN_CHANGED_EVENT));
    }
  } catch {
    /* ignore */
  }
}

export function hasToken(): boolean {
  return getToken() != null;
}

/** Header object carrying the token, or empty when none is stored. */
export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { "x-scan-token": t } : {};
}

/** Notify the app that the owner needs to (re-)enter the access token. */
export function requestUnlock(): void {
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
  } catch {
    /* ignore */
  }
}

export type ApiErrorKind =
  | "auth" // unauthorized / invalid or missing token
  | "database" // database unavailable
  | "provider" // market-data provider unavailable
  | "discord" // discord delivery unavailable
  | "server" // generic server / network failure
  | null; // no error

/**
 * Classify a failed response into a single owner-facing error state. A 401 is
 * ALWAYS `auth` and never a database message — this is the core fix for the
 * confusing "run npm install (better-sqlite3)" text appearing on a token error.
 */
export function classifyApiError(
  status: number,
  body?: { error?: unknown; code?: unknown; note?: unknown } | null,
): ApiErrorKind {
  if (status === 401 || status === 403) return "auth";
  const text = `${body?.error ?? ""} ${body?.code ?? ""} ${body?.note ?? ""}`.toLowerCase();
  // Only surface the database-install hint when the failure is genuinely about a
  // missing/unavailable database — never for an authorization failure.
  if (status >= 500 || /better-sqlite3|database|sqlite|no such table|db unavailable/.test(text)) {
    if (/better-sqlite3|database|sqlite|no such table/.test(text)) return "database";
    if (/polygon|massive|provider|market data|quota|rate.?limit/.test(text)) return "provider";
    if (/discord|webhook/.test(text)) return "discord";
    return "server";
  }
  if (/polygon|massive|provider|market data|quota|rate.?limit/.test(text)) return "provider";
  if (/discord|webhook/.test(text)) return "discord";
  if (status >= 400) return "server";
  return null;
}

/** True only when the failure indicates better-sqlite3 is genuinely missing. */
export function isBetterSqliteMissing(status: number, body?: { error?: unknown } | null): boolean {
  if (status === 401 || status === 403) return false;
  return /better-sqlite3|cannot find module 'better-sqlite3'/i.test(String(body?.error ?? ""));
}

/**
 * The one authenticated fetch. Attaches the token header (never a query param),
 * and on 401 clears the bad token and fires the unlock event. Returns the raw
 * Response so callers keep full control over parsing.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  const t = getToken();
  if (t) headers.set("x-scan-token", t);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    // A stored-but-rejected token is invalid or has changed on the server.
    clearToken();
    requestUnlock();
  }
  return res;
}

/** Convenience: authenticated GET returning parsed JSON (or null on failure). */
export async function apiGetJson<T = any>(input: string): Promise<T | null> {
  try {
    const res = await apiFetch(input, { cache: "no-store" });
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
