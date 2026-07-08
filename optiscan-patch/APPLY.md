# OptiScan patch — Data Core + AI Copilot

Visual-only pages. No scanner math, alert store, or Discord logic changed.

## 1. Add page files

Copy (or ensure present):

- `app/data/page.tsx` → Data Core + live firehose (`/api/health` + SSE tape)
- `app/copilot/page.tsx` → read-only Copilot stub (latest `/api/alerts` + evidence chips)

## 2. Append CSS

Paste the contents of `optiscan-patch/axiom-theme-additions.css` at the **end** of `app/axiom-theme.css`.

## 3. Nav items in `components/AxiomShell.tsx`

Under **INTELLIGENCE** (or a new **SYSTEM** section), add:

```tsx
{ href: "/data", label: "Data Core" },
{ href: "/copilot", label: "Copilot" },
```

Add page meta:

```tsx
"/data": { title: "Data Core", sub: "Health · quota · firehose" },
"/copilot": { title: "Copilot", sub: "Explain latest callout" },
```

## 4. Verify

```bash
npx tsc --noEmit
npm run build
npm run dev   # http://localhost:8780/data and /copilot
```
