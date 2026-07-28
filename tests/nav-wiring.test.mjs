import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Nav wiring spec — every link the chrome renders must resolve to a real page.
 * Catches dead nav entries (a route renamed or removed without updating the rail).
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

/** Pull `href: "/x"` and `href="/x"` targets out of a source file. */
function hrefsIn(src) {
  const found = new Set();
  for (const m of src.matchAll(/href[:=]\s*"([^"]+)"/g)) found.add(m[1]);
  return [...found];
}

/** A route is served if app/<segments>/page.tsx exists (root = app/page.tsx). */
function routeExists(pathname) {
  const clean = pathname.split("#")[0].split("?")[0];
  if (clean === "/") return existsSync(join(root, "app", "page.tsx"));
  const segments = clean.replace(/^\/+|\/+$/g, "").split("/");
  return existsSync(join(root, "app", ...segments, "page.tsx"));
}

const CHROME_FILES = [
  "components/AxiomShell.tsx",
  "components/MoreDrawer.tsx",
  "components/MobileBottomNav.tsx",
];

/** Redirect sources declared in next.config.mjs. */
function configRedirects() {
  const src = read("next.config.mjs");
  const block = src.match(/async redirects\(\)[\s\S]*?\n  \},/)[0];
  return [...block.matchAll(/source:\s*"([^"]+)"\s*,\s*destination:\s*"([^"]+)"/g)]
    .map(([, source, destination]) => ({ source, destination }));
}

test("no next.config redirect shadows a page that still exists", () => {
  // A redirect is matched before routing, so declaring one for a live route
  // silently makes that page (and every link to it) unreachable.
  const shadowed = configRedirects()
    .filter((r) => routeExists(r.source))
    .filter((r) => {
      // A redirect stub page (`redirect()` only) is allowed to have a matching
      // config redirect — both send the user to the same retired-route target.
      const segments = r.source.replace(/^\/+/, "").split("/");
      const src = read(join("app", ...segments, "page.tsx"));
      return !/redirect\(/.test(src);
    })
    .map((r) => `${r.source} -> ${r.destination}`);
  assert.deepEqual(shadowed, [], `redirects shadow live pages:\n${shadowed.join("\n")}`);
});

test("retired routes redirect to the same place their stub page does", () => {
  for (const { source, destination } of configRedirects()) {
    if (!routeExists(source)) continue;
    const segments = source.replace(/^\/+/, "").split("/");
    const stub = read(join("app", ...segments, "page.tsx"));
    const target = destination.split("?")[0].split("#")[0];
    assert.ok(
      stub.includes(target),
      `${source}: config redirects to ${destination} but its stub page does not point at ${target}`,
    );
  }
});

test("every nav link in the app chrome resolves to a real page", () => {
  const dead = [];
  for (const file of CHROME_FILES) {
    for (const href of hrefsIn(read(file))) {
      // Drawer anchors and external links are not routes.
      if (href.startsWith("#") || href.startsWith("http") || href.startsWith("mailto:")) continue;
      if (!href.startsWith("/")) continue;
      if (!routeExists(href)) dead.push(`${file} -> ${href}`);
    }
  }
  assert.deepEqual(dead, [], `dead nav links:\n${dead.join("\n")}`);
});

test("no nav link points at a redirected route", () => {
  const sources = new Set(configRedirects().map((r) => r.source));
  const bounced = [];
  for (const file of CHROME_FILES) {
    for (const href of hrefsIn(read(file))) {
      if (!href.startsWith("/")) continue;
      const clean = href.split("#")[0].split("?")[0];
      if (sources.has(clean)) bounced.push(`${file} -> ${href}`);
    }
  }
  assert.deepEqual(bounced, [], `nav links land on a redirect:\n${bounced.join("\n")}`);
});

test("every page named in the rail has a header title so it never renders bare", () => {
  const shell = read("components/AxiomShell.tsx");
  const meta = shell.match(/const PAGE_META[\s\S]*?\n\};/)[0];
  const navBlocks = [
    shell.match(/const PRODUCT_NAV[\s\S]*?\];/)[0],
    shell.match(/const ADVANCED_NAV[\s\S]*?\];/)[0],
  ].join("\n");

  const missing = [];
  for (const href of hrefsIn(navBlocks)) {
    if (!href.startsWith("/")) continue;
    // PAGE_META is keyed by first segment (plus the /paper/0dte special case).
    const key = href === "/paper/0dte" ? href : `/${href.split("/").filter(Boolean)[0] ?? ""}`;
    if (!meta.includes(`"${key}"`)) missing.push(href);
  }
  assert.deepEqual(missing, [], `nav entries without PAGE_META: ${missing.join(", ")}`);
});

test("nav items carry an icon so the rail is not a wall of text", () => {
  const shell = read("components/AxiomShell.tsx");
  const navrail = read("components/ui/NavRail.tsx");
  const product = shell.match(/const PRODUCT_NAV[\s\S]*?\];/)[0];
  for (const line of product.split("\n")) {
    if (!line.includes("href:")) continue;
    assert.match(line, /icon:\s*"/, `PRODUCT nav item needs an icon: ${line.trim()}`);
  }
  assert.match(navrail, /ICON_PATHS/);
  assert.match(navrail, /NavGlyph/);
});

test("primary product rail exposes the redesigned decision surfaces", () => {
  const shell = read("components/AxiomShell.tsx");
  const product = shell.match(/const PRODUCT_NAV[\s\S]*?\];/)[0];
  for (const [href, label] of [
    ["/", "NOW"],
    ["/callouts", "AI OPTIONS"],
    ["/quant", "QUANT"],
    ["/watchlist", "WATCHLIST"],
    ["/discord", "DISCORD"],
    ["/paper", "PAPER"],
    ["/settings", "SETTINGS"],
  ]) {
    assert.ok(product.includes(`href: "${href}"`), `${href} is primary`);
    assert.ok(product.includes(`label: "${label}"`), `${label} is labeled`);
  }
});

test("AI Options does not force all bearish setups into research-only UI", () => {
  const src = read("app/callouts/page.tsx");
  assert.doesNotMatch(src, /c\.direction\s*===\s*"bearish"\s*\|\|\s*c\.researchOnlyWarning/);
  assert.match(src, /if \(c\.researchOnlyWarning\) systemAction = "RESEARCH"/);
});
