# OptiScan — Axiom patch: Data Core + AI Copilot pages

Two new read-only pages that match your existing Axiom shell + `components/ui`.
**No signal/gate math is touched.** Drop these into `optiscan-main`, then commit.

## 1. Add the files
- `app/data/page.tsx`      → new route **/data** (Polygon Data Core + Firehose)
- `app/copilot/page.tsx`   → new route **/copilot** (read-only AI explainer)

Copy them from this patch to the same paths in your repo.

## 2. Append the CSS
Paste the contents of `axiom-theme-additions.css` at the **end of `app/axiom-theme.css`**.

## 3. Add the two nav items (components/AxiomShell.tsx)
In `AxiomShell.tsx`, extend the nav arrays:

```ts
const SCANNER_NAV = [
  { href: "/", label: "Live / Options" },
  { href: "/data", label: "Data Core" },   // + add this
];

const INTEL_NAV = [
  { href: "/copilot", label: "AI Copilot" }, // + add this at the top
  { href: "/alerts", label: "Accuracy" },
  { href: "/alerts?tab=history", label: "Performance" },
  { href: "/settings", label: "Settings" },
  { href: "/review", label: "Review" },
];
```

And add page titles to `PAGE_META`:

```ts
"/data": { title: "Data Core", sub: "Polygon feed · firehose" },
"/copilot": { title: "AI Copilot", sub: "Read-only · explains signals" },
```

## 4. Verify
```bash
npx tsc --noEmit
npm run build
npm run dev   # visit /data and /copilot
```

## Notes / assumptions
- `/data` reads `/api/health` (core stats) and the existing `useScannerStream()` tape (firehose). If your `useScannerStream` export differs, adjust the import; no new Polygon calls are made.
- `/copilot` reads `/api/alerts` and renders the stored `ai_explanation` + gate fields as evidence chips. The command box is a **stub** — search `TODO: wire to Claude` to hook up Claude later.
- Both pages assume the `Panel`, `StatTile` props I saw in your repo (`title`, `meta`, `live`; `label`, `value`, `hint`). If those changed, tweak the props.
## 5. Customizable stock scanners (Market tab)

New files (already in this patch):
- `lib/stock-scanner-presets.ts` — types, defaults, localStorage, `applyStockScan()`
- `components/ui/ScannerBuilder.tsx` — the "My Scanners" list + inline editor

These filter the tape **client-side, Market scope only** — server gates/signal math untouched.

### Wire into `components/OptiscanLiveView.tsx`

**a) imports (top):**
```ts
import { ScannerBuilder } from "@/components/ui/ScannerBuilder";
import { applyStockScan, type StockScanPreset } from "@/lib/stock-scanner-presets";
```

**b) state (near the other useState calls):**
```ts
const [activeScan, setActiveScan] = useState<StockScanPreset | null>(null);
```

**c) filter the rows — right AFTER `displayRows` is computed:**
```ts
const scannedRows = scope === "market" && activeScan
  ? applyStockScan(displayRows, activeScan.filters)
  : displayRows;
```
Then use `scannedRows` instead of `displayRows` in the two useMemos:
```ts
const liveColumns = useMemo(() => buildColumns(scannedRows, sortLabel, scope), [scannedRows, sortLabel, scope]);
const liveStrip  = useMemo(() => buildStrip(scannedRows, scope, loop, tape.length), [scannedRows, scope, loop, tape.length]);
```

**d) render the builder — only on the Market tab.** Put it just before the
`<div className="section-head scanner-head">` block:
```tsx
{scope === "market" ? (
  <div className="axiom-scanner-builder">
    <ScannerBuilder activeId={activeScan?.id ?? null} onActive={setActiveScan} />
  </div>
) : null}
```

Optional CSS (in the additions file) — give it a max width so it sits left:
`.axiom-terminal .axiom-scanner-builder { max-width: 320px; margin-bottom: 12px; }`

### Verify
```bash
npx tsc --noEmit && npm run build && npm run dev
```
Switch to the **Market** tab → pick a scanner → the movers list + strip filter live. Options tab is unchanged.

---

**Later phase (when you're ready):** hook the Copilot command box to Claude, and add Robinhood MCP. Search `TODO: wire to Claude` in `app/copilot/page.tsx` for the boundary.
