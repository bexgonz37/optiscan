import test from "node:test";
import assert from "node:assert/strict";
import { checkApiToken, unauthorized } from "../lib/auth.ts";

const ORIGINAL_ENV = { ...process.env };

function req(url, headers = {}) {
  return new Request(url, { headers });
}

test("unset SCAN_API_TOKEN leaves routes open (documented default)", () => {
  delete process.env.SCAN_API_TOKEN;
  assert.equal(checkApiToken(req("http://localhost:8780/api/scan/momentum")), true);
  process.env = { ...ORIGINAL_ENV };
});

test("with token set, request without credentials is rejected", () => {
  process.env.SCAN_API_TOKEN = "s3cret-token";
  assert.equal(checkApiToken(req("http://localhost:8780/api/scan/momentum")), false);
  process.env = { ...ORIGINAL_ENV };
});

test("x-scan-token header is accepted", () => {
  process.env.SCAN_API_TOKEN = "s3cret-token";
  assert.equal(
    checkApiToken(req("http://localhost:8780/api/scan/momentum", { "x-scan-token": "s3cret-token" })),
    true,
  );
  process.env = { ...ORIGINAL_ENV };
});

test("Authorization: Bearer is accepted", () => {
  process.env.SCAN_API_TOKEN = "s3cret-token";
  assert.equal(
    checkApiToken(req("http://localhost:8780/api/scan/momentum", { authorization: "Bearer s3cret-token" })),
    true,
  );
  process.env = { ...ORIGINAL_ENV };
});

test("?token= query param is NO LONGER accepted (P0-3: log/referrer leakage)", () => {
  process.env.SCAN_API_TOKEN = "s3cret-token";
  assert.equal(
    checkApiToken(req("http://localhost:8780/api/scan/momentum?token=s3cret-token")),
    false,
  );
  process.env = { ...ORIGINAL_ENV };
});

test("wrong header token is rejected (timing-safe compare)", () => {
  process.env.SCAN_API_TOKEN = "s3cret-token";
  assert.equal(
    checkApiToken(req("http://localhost:8780/api/scan/momentum", { "x-scan-token": "wrong" })),
    false,
  );
  assert.equal(
    checkApiToken(req("http://localhost:8780/api/scan/momentum", { "x-scan-token": "s3cret-tokeX" })),
    false,
  );
  process.env = { ...ORIGINAL_ENV };
});

test("unauthorized() responds 401 JSON", async () => {
  const res = unauthorized();
  assert.equal(res.status, 401);
  const body = JSON.parse(await res.text());
  assert.equal(body.ok, false);
});
