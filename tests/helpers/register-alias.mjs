/**
 * The smallest alias-aware harness that lets node:test import production modules.
 *
 * lib/db.ts imports its collaborators through the `@/` alias declared in
 * tsconfig paths (`"@/*": ["./*"]`). tsc and Next both resolve it; the node:test
 * runner does not, so every attempt to import the real getDb() from a test
 * failed at module resolution. That gap is why the 0cc84fb migration-ordering
 * outage reached production: with lib/db.ts unimportable, every content fixture
 * built its own in-memory table, and none of them could observe SCHEMA meeting a
 * long-lived database.
 *
 * `module.registerHooks` (Node >= 22.15) installs a synchronous, in-process
 * resolve hook. No loader thread, no extra dependency, no duplication of
 * production logic — it only teaches node the mapping tsconfig already declares.
 *
 * Usage, BEFORE any `@/`-importing module is loaded:
 *   import "./helpers/register-alias.mjs";
 *   const { getDb } = await import("@/lib/db");
 */
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** tsconfig `paths` maps the alias to a directory, not to a file — resolve the extension the way the bundler does. */
const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx", "/index.mjs", "/index.js"];

function firstExistingFile(base) {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return pathToFileURL(candidate).href;
    }
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    // `@/lib/db` — the tsconfig alias.
    if (specifier.startsWith("@/")) {
      const url = firstExistingFile(path.join(ROOT, specifier.slice(2)));
      if (url) return { url, shortCircuit: true };
    }
    // `./accuracy-ratios` — production TS is compiled with bundler resolution, so
    // relative imports are extensionless too. Node ESM requires the extension, and
    // an aliased module is worthless if its own neighbours cannot load. Only
    // applied to parents inside this repository, and only when the specifier has
    // no extension of its own, so node_modules resolution is untouched.
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      const parentPath = fileURLToPath(context.parentURL);
      if (parentPath.startsWith(ROOT) && !path.extname(specifier)) {
        const url = firstExistingFile(path.resolve(path.dirname(parentPath), specifier));
        if (url) return { url, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
