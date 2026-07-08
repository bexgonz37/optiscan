import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("Live defaults to Options and filters hero/history by product", () => {
  const live = read("components/OptiscanLiveView.tsx");
  assert.ok(live.includes('useState<Scope>("options")'), "Options must remain the default product");
  assert.ok(live.includes('a.asset_class === "stock"'), "Market mode filters stock alerts");
  assert.ok(live.includes('a.asset_class !== "stock"'), "Options mode filters option alerts");
  assert.ok(live.includes('saveDashboardPrefs({ liveScope: "market" })'), "selected product persists");
  assert.ok(live.includes("LONG/SHORT · no options"), "Market mode is explicitly shares-only");
});

test("Settings exposes separate option and stock Discord channels", () => {
  const settings = read("app/settings/page.tsx");
  assert.ok(settings.includes('testDiscord("options")'));
  assert.ok(settings.includes('testDiscord("stocks")'));
  assert.ok(settings.includes("stockCalloutsEnabled"));
});
