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
  const nested = body?.error;
  const nestedCode = nested && typeof nested === "object" && nested !== null
    ? String((nested as { code?: unknown }).code ?? "")
    : "";
  const nestedMessage = nested && typeof nested === "object" && nested !== null
    ? String((nested as { message?: unknown }).message ?? "")
    : "";
  const text = `${body?.error ?? ""} ${body?.code ?? ""} ${body?.note ?? ""} ${nestedCode} ${nestedMessage}`.toLowerCase();
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

export type ApiParseResult<T = unknown> = {
  ok: boolean;
  status: number;
  data: T | null;
  body: Record<string, unknown> | null;
  errorKind: ApiErrorKind;
  message: string | null;
  parseError: string | null;
  endpoint: string;
};

function extractErrorMessage(body: Record<string, unknown> | null, status: number): string | null {
  if (!body) return status === 401 ? "Authentication required" : null;
  const nested = body.error;
  if (nested && typeof nested === "object" && nested !== null) {
    const msg = (nested as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return msg;
    const code = (nested as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code;
  }
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  if (typeof body.message === "string" && body.message.trim()) return body.message;
  if (typeof body.code === "string" && body.code.trim()) return body.code;
  return null;
}

/**
 * Safe JSON parser for protected API responses. Never throws on empty/malformed bodies.
 * Checks content-type when present, reads text first, and classifies auth vs server failures.
 */
export async function parseApiJsonResponse<T = unknown>(
  res: Response,
  endpoint: string,
): Promise<ApiParseResult<T>> {
  const status = res.status;
  const contentType = res.headers.get("content-type") ?? "";
  let raw = "";
  try {
    raw = await res.text();
  } catch (err) {
    return {
      ok: false,
      status,
      data: null,
      body: null,
      errorKind: "server",
      message: "Network failure while reading response",
      parseError: err instanceof Error ? err.message : String(err),
      endpoint,
    };
  }

  let body: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  const trimmed = raw.trim();
  if (trimmed) {
    const looksJson = contentType.includes("application/json")
      || trimmed.startsWith("{")
      || trimmed.startsWith("[");
    if (looksJson) {
      try {
        body = JSON.parse(trimmed) as Record<string, unknown>;
      } catch (err) {
        parseError = err instanceof Error ? err.message : "Invalid JSON";
      }
    } else {
      parseError = `Unexpected content-type: ${contentType || "unknown"}`;
    }
  } else if (status !== 204) {
    parseError = "Empty response body";
  }

  const message = extractErrorMessage(body, status);
  const errorKind = classifyApiError(status, body);
  const payloadOk = body?.ok;
  const ok = Boolean(
    !parseError
    && res.ok
    && payloadOk !== false
    && errorKind !== "auth",
  );

  return {
    ok,
    status,
    data: ok ? (body as T) : null,
    body,
    errorKind: parseError ? (status === 401 || status === 403 ? "auth" : "server") : errorKind,
    message: parseError
      ? `${parseError}${status ? ` (HTTP ${status})` : ""}`
      : message ?? (ok ? null : `HTTP ${status}`),
    parseError,
    endpoint,
  };
}

export function describeApiLoadFailure(result: ApiParseResult): { title: string; detail: string } {
  if (result.errorKind === "auth") {
    return {
      title: "Access token required",
      detail: result.message ?? "This dashboard needs your private OptiScan access token.",
    };
  }
  if (result.parseError) {
    return {
      title: "Malformed server response",
      detail: `${result.message ?? result.parseError} · ${result.endpoint} · HTTP ${result.status}`,
    };
  }
  if (result.errorKind === "database") {
    return {
      title: "Database unavailable",
      detail: result.message ?? "The database could not be opened.",
    };
  }
  const code = typeof result.body?.error === "object" && result.body?.error
    ? String((result.body.error as { code?: unknown }).code ?? "")
    : "";
  if (code === "SCHEMA_MISMATCH" || /schema|no such table/i.test(result.message ?? "")) {
    return {
      title: "Database schema mismatch",
      detail: result.message ?? "Required tables are missing. Apply pending migrations.",
    };
  }
  if (result.errorKind === "server") {
    return {
      title: "Server error",
      detail: `${result.message ?? "Request failed"} · ${result.endpoint} · HTTP ${result.status}`,
    };
  }
  return {
    title: "Could not load",
    detail: result.message ?? `Request failed · HTTP ${result.status}`,
  };
}

/** Convenience: authenticated GET with safe JSON parsing. */
export async function apiFetchJson<T extends Record<string, unknown> = Record<string, unknown>>(
  input: string,
  init: RequestInit = {},
): Promise<ApiParseResult<T>> {
  const res = await apiFetch(input, { cache: "no-store", ...init });
  return parseApiJsonResponse<T>(res, input);
}

/** Convenience: authenticated GET returning parsed JSON (or null on failure). */
export async function apiGetJson<T = any>(input: string): Promise<T | null> {
  const result = await apiFetchJson<T & Record<string, unknown>>(input);
  return result.ok ? (result.data as T) : null;
}
