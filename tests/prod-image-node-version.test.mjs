import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { nodeSupportsStripTypes } from "../lib/research/episode/seed-worker-manager.ts";

// The out-of-process seed worker runs via `node --experimental-strip-types`, which requires
// Node >= 22.6. The production image is a Dockerfile build, so package.json `engines` does NOT
// govern the runtime — the Dockerfile base image does. These tests FAIL the build if the
// production image would run Node < 22.6, so we can never silently ship a version that disables
// the worker (or, worse, crash-loops on the flag).

const ROOT = process.cwd();
const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
const nodeFroms = [...dockerfile.matchAll(/^FROM\s+node:(\S+)/gim)].map((m) => m[1]);

/** Minimum concrete version a `node:<tag>` image can resolve to. `node:22` tracks the latest
 *  22.x (>= 22.6 in practice); a pinned `node:22.5` would resolve to exactly 22.5.x. */
function minVersionForTag(tag) {
  const m = tag.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  const major = Number(m[1]);
  // If only the major is pinned (e.g. node:22), the floor for OUR requirement is 22.6 — but a
  // major > 22 image is always fine, and a major < 22 image never is.
  const minor = m[2] !== undefined ? Number(m[2]) : (major === 22 ? 6 : 0);
  return { major, minor, str: `${major}.${minor}.0` };
}

test("Dockerfile pins a Node base image on every FROM node: stage", () => {
  assert.ok(nodeFroms.length >= 1, "Dockerfile must have at least one `FROM node:<tag>` stage");
});

test("every Dockerfile Node base image is >= 22.6 (worker/strip-types capable)", () => {
  for (const tag of nodeFroms) {
    const v = minVersionForTag(tag);
    assert.ok(v, `could not parse node tag: ${tag}`);
    const ok = v.major > 22 || (v.major === 22 && v.minor >= 6);
    assert.ok(ok, `production image node:${tag} is < 22.6 — the seed worker (--experimental-strip-types) cannot run`);
    // And the shared guard must agree the resolved floor supports strip-types.
    assert.equal(nodeSupportsStripTypes(v.str), true, `nodeSupportsStripTypes rejects node:${tag}`);
  }
});

test("a hypothetical node:20 base would be rejected by the guard (regression trip-wire)", () => {
  assert.equal(nodeSupportsStripTypes("20.19.0"), false);
  assert.equal(nodeSupportsStripTypes("22.5.9"), false);
  assert.equal(nodeSupportsStripTypes("22.6.0"), true);
});

test("package.json engines require Node >= 22.6", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(String(pkg.engines?.node ?? ""), /22\.6/);
});
