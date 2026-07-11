import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Navigation spec (Phase 5). Source-spec tests (client components can't run in
 * the node test runner). Lock the simplified primary nav AND guarantee that
 * renamed/removed routes still resolve via redirects — no dead links.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("primary nav lists the eight target destinations", () => {
  const shell = read("components/AxiomShell.tsx");
  const wanted = [
    ["/", "Command Center"],
    ["/alerts", "Options Callouts"],
    ["/watchlist", "Watchlist"],
    ["/paper", "Paper Trading"],
    ["/performance", "Performance"],
    ["/quant", "Research & Backtesting"],
    ["/data", "System Health"],
    ["/settings", "Settings"],
  ];
  for (const [href, label] of wanted) {
    assert.ok(shell.includes(`href: "${href}"`), `nav missing href ${href}`);
    assert.ok(shell.includes(label), `nav missing label "${label}"`);
  }
});

test("new Watchlist and Performance pages exist", () => {
  assert.ok(existsSync(join(root, "app/watchlist/page.tsx")), "watchlist page missing");
  assert.ok(existsSync(join(root, "app/performance/page.tsx")), "performance page missing");
});

test("renamed / removed routes still resolve via redirects (no dead links)", () => {
  const redirects = {
    "app/stocks/page.tsx": "/watchlist",
    "app/now/page.tsx": "/",
    "app/scanner/page.tsx": "/",
    "app/review/page.tsx": "/alerts",
  };
  for (const [file, target] of Object.entries(redirects)) {
    const src = read(file);
    assert.ok(/redirect\(/.test(src), `${file} must redirect`);
    assert.ok(src.includes(target), `${file} must redirect toward ${target}`);
  }
});

test("Watchlist and Performance are read-only over existing APIs (no provider calls, no order placement)", () => {
  for (const f of ["app/watchlist/page.tsx", "app/performance/page.tsx"]) {
    const src = read(f);
    assert.ok(!/place_equity_order|place_option_order|polyFetch/.test(src), `${f} must not trade or call providers directly`);
  }
  assert.ok(read("app/watchlist/page.tsx").includes("/api/scanner/live"), "watchlist reads existing live API");
  assert.ok(read("app/performance/page.tsx").includes("/api/alerts/stats"), "performance reads existing stats API");
});
