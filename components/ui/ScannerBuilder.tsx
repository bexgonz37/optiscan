"use client";

import { useEffect, useState } from "react";
import { Panel } from "@/components/ui/Panel";
import {
  DEFAULT_STOCK_SCANNERS,
  loadStockScanners,
  saveStockScanners,
  summarizeFilters,
  type StockScanFilters,
  type StockScanPreset,
} from "@/lib/stock-scanner-presets";

/**
 * "MY SCANNERS" builder for the Market tab. Manages user presets in localStorage
 * and reports the active preset up so the parent can filter the tape client-side.
 * Never touches server gates or signal math.
 */

const NUMERIC_FIELDS: { key: keyof StockScanFilters; label: string; step?: number }[] = [
  { key: "minMovePct", label: "Min |% move|" },
  { key: "minSurge", label: "Min RVOL ×", step: 0.5 },
  { key: "minAbsShortRate", label: "Min speed %/m", step: 0.1 },
  { key: "minPrice", label: "Min $" },
  { key: "maxPrice", label: "Max $" },
];

export function ScannerBuilder({
  activeId,
  onActive,
}: {
  activeId: string | null;
  onActive: (preset: StockScanPreset | null) => void;
}) {
  const [list, setList] = useState<StockScanPreset[]>(DEFAULT_STOCK_SCANNERS);
  const [editing, setEditing] = useState<StockScanPreset | null>(null);

  useEffect(() => {
    setList(loadStockScanners());
  }, []);

  useEffect(() => {
    const active = list.find((p) => p.id === activeId) ?? null;
    onActive(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, list]);

  function persist(next: StockScanPreset[]) {
    setList(next);
    saveStockScanners(next);
  }

  function startNew() {
    setEditing({ id: `scan-${Date.now()}`, name: "New scanner", filters: { minMovePct: 2, minSurge: 2 } });
  }

  function saveEditing() {
    if (!editing) return;
    const exists = list.some((p) => p.id === editing.id);
    persist(exists ? list.map((p) => (p.id === editing.id ? editing : p)) : [...list, editing]);
    onActive(editing);
    setEditing(null);
  }

  function remove(id: string) {
    persist(list.filter((p) => p.id !== id));
    if (activeId === id) onActive(null);
  }

  return (
    <Panel title="My Scanners" meta={editing ? "editing" : `${list.length} saved`}>
      {!editing ? (
        <>
          <div className="scanlist">
            {list.map((p) => (
              <div
                key={p.id}
                className={`scanitem${p.id === activeId ? " on" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => onActive(p.id === activeId ? null : p)}
                onKeyDown={(e) => e.key === "Enter" && onActive(p.id === activeId ? null : p)}
              >
                <div className="scantop">
                  <span className="scandot" />
                  <span className="scanname">{p.name}</span>
                  <button
                    type="button"
                    className="scan-edit"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(p);
                    }}
                  >
                    edit
                  </button>
                </div>
                <div className="scandesc">{summarizeFilters(p.filters)}</div>
              </div>
            ))}
          </div>
          <button type="button" className="defadd" onClick={startNew}>
            + New scanner
          </button>
        </>
      ) : (
        <div className="scan-editor">
          <label className="scan-field">
            <span>Name</span>
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </label>
          {NUMERIC_FIELDS.map((f) => (
            <label className="scan-field" key={String(f.key)}>
              <span>{f.label}</span>
              <input
                type="number"
                step={f.step ?? 1}
                value={editing.filters[f.key] != null ? String(editing.filters[f.key]) : ""}
                onChange={(e) => {
                  const v = e.target.value === "" ? undefined : Number(e.target.value);
                  setEditing({ ...editing, filters: { ...editing.filters, [f.key]: v } });
                }}
              />
            </label>
          ))}
          <label className="scan-check">
            <input
              type="checkbox"
              checked={Boolean(editing.filters.requireBreak)}
              onChange={(e) => setEditing({ ...editing, filters: { ...editing.filters, requireBreak: e.target.checked } })}
            />
            <span>Require HOD/LOD break</span>
          </label>
          <div className="scan-actions">
            <button type="button" className="scan-save" onClick={saveEditing}>
              Save
            </button>
            {list.some((p) => p.id === editing.id) ? (
              <button type="button" className="scan-del" onClick={() => remove(editing.id)}>
                Delete
              </button>
            ) : null}
            <button type="button" className="scan-cancel" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
