"use client";

/**
 * CardTip — hover the whole card to see what it means (beginner UX).
 * Uses the same glossary as InfoTip; desktop hover, tap-friendly via InfoTip on labels.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { metricInfo } from "@/lib/metric-glossary";

export function CardTip({
  metric,
  children,
  className = "",
}: {
  metric: string;
  children: ReactNode;
  className?: string;
}) {
  const info = metricInfo(metric);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tipId = useId();
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  if (!info) return <div className={className}>{children}</div>;

  return (
    <div
      ref={wrapRef}
      className={`cardtip-wrap${open ? " cardtip-open" : ""} ${className}`.trim()}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={close}
    >
      {children}
      {open ? (
        <div id={tipId} role="tooltip" className="cardtip-pop">
          <div className="cardtip-title">{info.label}</div>
          <p>{info.what}</p>
          <p><b>Why it matters:</b> {info.why}</p>
          <p className="cardtip-risk"><b>Watch out:</b> {info.risk}</p>
        </div>
      ) : null}
    </div>
  );
}
