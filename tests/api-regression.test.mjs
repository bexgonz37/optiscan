import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseApiJsonResponse,
  describeApiLoadFailure,
  classifyApiError,
} from "../lib/client-auth.ts";
import {
  classifyRouteError,
} from "../lib/api-error.ts";
import {
  listRecentOpportunityCasesOnDb,
  opportunityCasesTableReady,
  OpportunityCasesSchemaError,
} from "../lib/opportunity-case/store.ts";
import { buildWhyNoAlertsDiagnostic } from "../lib/research/options/pipeline-diagnostics.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

function mockResponse(status, body, contentType = "application/json") {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  };
}

test("parseApiJsonResponse: success payload", async () => {
  const res = mockResponse(200, JSON.stringify({ ok: true, cases: [], count: 0 }));
  const parsed = await parseApiJsonResponse(res, "/api/opportunity-cases");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.parseError, null);
  assert.deepEqual(parsed.data?.cases, []);
});

test("parseApiJsonResponse: unauthorized JSON never throws", async () => {
  const res = mockResponse(401, JSON.stringify({ ok: false, code: "unauthorized", error: "token required" }));
  const parsed = await parseApiJsonResponse(res, "/api/opportunity-cases");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errorKind, "auth");
  assert.equal(parsed.parseError, null);
});

test("parseApiJsonResponse: empty body reports parse error instead of throwing", async () => {
  const res = mockResponse(500, "");
  const parsed = await parseApiJsonResponse(res, "/api/ai");
  assert.equal(parsed.ok, false);
  assert.match(parsed.parseError ?? "", /Empty response body/);
  assert.match(parsed.message ?? "", /HTTP 500/);
});

test("parseApiJsonResponse: malformed JSON reports parse error", async () => {
  const res = mockResponse(200, "{not-json");
  const parsed = await parseApiJsonResponse(res, "/api/ai");
  assert.equal(parsed.ok, false);
  assert.match(parsed.parseError ?? "", /JSON/i);
});

test("parseApiJsonResponse: 204 empty body is not a parse failure", async () => {
  const res = mockResponse(204, "", "");
  const parsed = await parseApiJsonResponse(res, "/api/ai");
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.status, 204);
});

test("describeApiLoadFailure distinguishes auth from empty-state server failures", () => {
  const auth = describeApiLoadFailure({
    ok: false,
    status: 401,
    data: null,
    body: { ok: false, code: "unauthorized" },
    errorKind: "auth",
    message: "Authentication required",
    parseError: null,
    endpoint: "/api/research/options/pipeline-health",
  });
  assert.match(auth.title, /token/i);

  const empty = describeApiLoadFailure({
    ok: false,
    status: 500,
    data: null,
    body: null,
    errorKind: "server",
    message: "Empty response body (HTTP 500)",
    parseError: "Empty response body",
    endpoint: "/api/ai",
  });
  assert.match(empty.title, /Malformed|Could not load|Server error/);
});

test("classifyApiError handles nested structured error objects", () => {
  assert.equal(
    classifyApiError(503, { ok: false, error: { code: "SCHEMA_MISMATCH", message: "no such table: opportunity_cases" } }),
    "database",
  );
});

test("classifyRouteError maps missing-table failures to SCHEMA_MISMATCH", () => {
  const err = classifyRouteError(new Error("SQLITE_ERROR: no such table: opportunity_cases"));
  assert.equal(err.code, "SCHEMA_MISMATCH");
  assert.equal(err.status, 503);
});

test("Opportunity Cases API route: try/catch and JSON content-type", () => {
  const route = read("app/api/opportunity-cases/route.ts");
  assert.match(route, /jsonFromRouteError/);
  assert.match(route, /checkApiToken\(req\)/);
  assert.match(route, /content-type/);
});

test("Pipeline Health API route: deferred boot and try/catch", () => {
  const route = read("app/api/research/options/pipeline-health/route.ts");
  assert.match(route, /deferServerBoot\(\)/);
  assert.doesNotMatch(route, /ensureServerBoot\(\)/);
  assert.match(route, /jsonFromRouteError/);
});

test("AI Lab API route GET: deferred boot and try/catch", () => {
  const route = read("app/api/ai/route.ts");
  assert.match(route, /deferServerBoot\(\)/);
  assert.match(route, /export async function GET[\s\S]*jsonFromRouteError/);
});

test("Enterprise UI pages use shared safe JSON parser", () => {
  for (const page of [
    "app/intelligence/page.tsx",
    "app/pipeline-health/page.tsx",
    "app/ai/page.tsx",
  ]) {
    const src = read(page);
    assert.match(src, /apiFetchJson|parseApiJsonResponse/, `${page} must use safe parser`);
    assert.doesNotMatch(src, /await r\.json\(\)/, `${page} must not blindly call r.json()`);
  }
});

test("Opportunity cases: zero records returns valid empty list", () => {
  const db = {
    prepare(sql) {
      if (/sqlite_master/.test(sql)) {
        return { get: () => ({ 1: 1 }), all: () => [], run: () => ({ changes: 0 }) };
      }
      if (/SELECT case_json FROM opportunity_cases/.test(sql)) {
        return { get: () => undefined, all: () => [], run: () => ({ changes: 0 }) };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  assert.equal(opportunityCasesTableReady(db), true);
  assert.deepEqual(listRecentOpportunityCasesOnDb(db, 10), []);
});

test("Opportunity cases: missing table throws schema error (not empty success)", () => {
  const db = {
    prepare(sql) {
      if (/sqlite_master/.test(sql)) return { get: () => undefined, all: () => [], run: () => ({ changes: 0 }) };
      throw new Error("should not query missing table");
    },
  };
  assert.equal(opportunityCasesTableReady(db), false);
  assert.throws(
    () => listRecentOpportunityCasesOnDb(db, 10),
    OpportunityCasesSchemaError,
  );
});

test("Pipeline diagnostics: legitimate empty dataset still returns JSON-shaped diagnostic", () => {
  const diagnostic = buildWhyNoAlertsDiagnostic(null, {});
  assert.equal(typeof diagnostic.summary, "string");
  assert.ok(Array.isArray(diagnostic.likelyBlockers));
  assert.equal(typeof diagnostic.candidates.observed24h, "number");
});

test("jsonApiError responds with structured JSON envelope", () => {
  const core = read("lib/api-error.ts");
  const src = read("lib/api-response.ts");
  assert.match(core, /classifyRouteError/);
  assert.match(src, /jsonApiError/);
  assert.match(src, /application\/json/);
  assert.match(src, /error: \{ code, message \}/);
});
