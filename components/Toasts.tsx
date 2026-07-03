"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

type ToastType = "ok" | "err" | "info";
interface Toast {
  id: number;
  type: ToastType;
  title: string;
  desc: string;
  out?: boolean;
}

interface ToastApi {
  push: (title: string, desc: string, type?: ToastType) => void;
}

const ToastCtx = createContext<ToastApi>({ push: () => {} });

export function useToast() {
  return useContext(ToastCtx);
}

const ICONS: Record<ToastType, string> = { ok: "✅", err: "⚠️", info: "🔔" };

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, out: true } : x)));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 300);
  }, []);

  const push = useCallback(
    (title: string, desc: string, type: ToastType = "ok") => {
      const id = ++idRef.current;
      setToasts((t) => [...t, { id, type, title, desc }]);
      setTimeout(() => remove(id), 4200);
    },
    [remove],
  );

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div id="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type === "ok" ? "" : t.type} ${t.out ? "out" : ""}`}>
            <div className="ti">{ICONS[t.type]}</div>
            <div>
              <div className="tt">{t.title}</div>
              <div className="td">{t.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
