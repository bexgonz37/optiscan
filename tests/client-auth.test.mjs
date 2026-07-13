import test from "node:test";
import assert from "node:assert/strict";
import {
  getToken, setToken, clearToken, hasToken, authHeaders, apiFetch,
  classifyApiError, isBetterSqliteMissing, TOKEN_KEY,
} from "../lib/client-auth.ts";

// Minimal localStorage + window mock so the client helper runs under node.
function installDom() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  const listeners = new Map();
  globalThis.window = {
    dispatchEvent: (ev) => { (listeners.get(ev.type) ?? []).forEach((fn) => fn(ev)); return true; },
    addEventListener: (t, fn) => { listeners.set(t, [...(listeners.get(t) ?? []), fn]); },
    removeEventListener: () => {},
  };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  return { store };
}

test("token: set / get / has / clear round-trips under the shared key", () => {
  installDom();
  assert.equal(getToken(), null);
  assert.equal(hasToken(), false);
  setToken("secret-abc");
  assert.equal(getToken(), "secret-abc");
  assert.equal(hasToken(), true);
  assert.equal(globalThis.localStorage.getItem(TOKEN_KEY), "secret-abc");
  clearToken();
  assert.equal(getToken(), null);
});

test("authHeaders attaches the token as x-scan-token (or nothing)", () => {
  installDom();
  assert.deepEqual(authHeaders(), {});
  setToken("tok-1");
  assert.deepEqual(authHeaders(), { "x-scan-token": "tok-1" });
});

test("a saved valid token is attached to protected API requests", async () => {
  installDom();
  setToken("valid-token");
  let seenHeader = null;
  let seenUrl = null;
  globalThis.fetch = async (url, init) => {
    seenUrl = url;
    seenHeader = new Headers(init.headers).get("x-scan-token");
    return { status: 200, json: async () => ({ ok: true }) };
  };
  await apiFetch("/api/runtime/status");
  assert.equal(seenHeader, "valid-token");
  // The token must NEVER appear in the URL / query string.
  assert.ok(!String(seenUrl).includes("valid-token"), "token must not be in the URL");
});

test("a 401 clears/rejects the bad token and fires the unlock event", async () => {
  installDom();
  setToken("stale-token");
  let unauthorizedFired = false;
  globalThis.window.addEventListener("optiscan:unauthorized", () => { unauthorizedFired = true; });
  globalThis.fetch = async () => ({ status: 401, json: async () => ({ ok: false, code: "unauthorized" }) });
  const res = await apiFetch("/api/runtime/status");
  assert.equal(res.status, 401);
  assert.equal(getToken(), null, "bad token cleared");
  assert.equal(unauthorizedFired, true, "unlock event dispatched");
});

test("database errors are classified separately from auth errors", () => {
  // A 401 is ALWAYS auth — never a database-install message.
  assert.equal(classifyApiError(401, { error: "This dashboard needs your private OptiScan access token." }), "auth");
  assert.equal(isBetterSqliteMissing(401, { error: "Cannot find module 'better-sqlite3'" }), false);
  // A genuine DB failure is database, and only that triggers the sqlite hint.
  assert.equal(classifyApiError(500, { error: "Cannot find module 'better-sqlite3'" }), "database");
  assert.equal(isBetterSqliteMissing(500, { error: "Cannot find module 'better-sqlite3'" }), true);
  // Provider / discord / generic server stay distinct.
  assert.equal(classifyApiError(200, { error: "polygon provider unavailable" }), "provider");
  assert.equal(classifyApiError(200, { error: "discord webhook failed" }), "discord");
  assert.equal(classifyApiError(503, { error: "boom" }), "server");
  assert.equal(classifyApiError(200, null), null);
});
