/**
 * runtime-module-closure.mjs — resolve the static import closure of the modules
 * production loads FROM DISK at runtime.
 *
 * Two entry points are never seen by the bundler:
 *   - worker/seed-worker.ts  — spawned as its own `node` process
 *   - lib/server-boot.ts     — imported by instrumentation via a runtime path
 *
 * Next's output file tracing therefore cannot discover them, and a force-include
 * in `outputFileTracingIncludes` is a LITERAL file list: it does not parse the
 * files it copies. So every transitive dependency has to be named. This computes
 * that closure from source so the list can be verified instead of guessed.
 *
 * Exported for tests; runnable directly for a report:
 *   node scripts/runtime-module-closure.mjs
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Entry points that production loads from disk rather than through the bundler. */
export const RUNTIME_ENTRY_POINTS = Object.freeze([
  "worker/seed-worker.ts",
  "lib/server-boot.ts",
]);

// Static ESM imports/re-exports plus `await import("...")` with a literal
// specifier. A computed specifier cannot be resolved statically and is reported
// separately rather than silently dropped.
const SPEC_RE = /(?:^|[\s;}])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const DYNAMIC_RE = /\bimport\s*\(\s*(?![\s]*["'])/g;

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".mjs", ".jsx", "/index.ts", "/index.js"];

/** Resolve one specifier to a repo-relative path, or null when it is external. */
export function resolveSpecifier(fromFile, spec) {
  let base;
  if (spec.startsWith(".")) base = resolve(dirname(join(REPO_ROOT, fromFile)), spec);
  else if (spec.startsWith("@/")) base = join(REPO_ROOT, spec.slice(2));
  else return null; // bare specifier — a node_module, already installed in the image

  // A TS source importing "./x.js" means "./x.ts" when only the TS file exists.
  const swaps = base.endsWith(".js") ? [base, `${base.slice(0, -3)}.ts`] : [base];
  for (const candidate of swaps) {
    for (const suffix of CANDIDATE_SUFFIXES) {
      const full = candidate + suffix;
      if (existsSync(full) && statSync(full).isFile()) return relative(REPO_ROOT, full).replace(/\\/g, "/");
    }
  }
  return null;
}

/**
 * Walk the static import graph from the runtime entry points.
 * Returns repo-relative files (entries included) and any unresolved specifiers.
 */
export function runtimeModuleClosure(entryPoints = RUNTIME_ENTRY_POINTS) {
  const seen = new Set();
  const unresolved = [];
  const computedImportSites = [];
  const queue = [...entryPoints];

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const abs = join(REPO_ROOT, file);
    if (!existsSync(abs)) { unresolved.push({ from: "<entry>", spec: file }); continue; }
    const src = readFileSync(abs, "utf8");

    if (DYNAMIC_RE.test(src)) computedImportSites.push(file);
    DYNAMIC_RE.lastIndex = 0;

    for (const m of src.matchAll(SPEC_RE)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      const target = resolveSpecifier(file, spec);
      if (target) { if (!seen.has(target)) queue.push(target); }
      else if (spec.startsWith(".") || spec.startsWith("@/")) unresolved.push({ from: file, spec });
    }
  }
  return {
    files: [...seen].sort(),
    unresolved,
    computedImportSites: [...new Set(computedImportSites)].sort(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, "/") || process.argv[1]?.endsWith("runtime-module-closure.mjs")) {
  const { files, unresolved, computedImportSites } = runtimeModuleClosure();
  console.log(`runtime module closure: ${files.length} files`);
  for (const f of files) console.log("  " + f);
  if (computedImportSites.length) {
    console.log(`\ncomputed import() sites (cannot be traced statically): ${computedImportSites.length}`);
    for (const f of computedImportSites) console.log("  " + f);
  }
  if (unresolved.length) {
    console.log(`\nUNRESOLVED relative specifiers: ${unresolved.length}`);
    for (const u of unresolved) console.log(`  ${u.from} -> ${u.spec}`);
  }
}
