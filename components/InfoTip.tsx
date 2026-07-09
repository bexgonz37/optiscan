"use client";

/**
 * InfoTip — the beginner-education tooltip (audit v1.1).
 *
 * Wrap any metric label:  <InfoTip metric="speed">Speed</InfoTip>
 * or render a standalone icon:  <InfoTip metric="spread" />
 *
 * Desktop: hover opens. Mobile/touch: tapping the ⓘ icon toggles (44px hit
 * area). Content comes ONLY from lib/metric-glossary.ts so wording lives in
 * one place. Unknown keys render children unchanged (never crash the UI).
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { metricInfo } from "@/lib/metric-glossary";

export function InfoTip({
  metric,
  children,
  side = "top",
}: {
  metric: string;
  children?: ReactNode;
  side?: "top" | "bottom";
}) {
  const info = metricInfo(metric);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const tipId = useId();

  const close = useCallback(() => setOpen(false), []);

  // Tap-away + Escape close (mobile keeps it open until dismissed).
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

  if (!info) return <>{children ?? null}</>;

  return (
    <span
      ref={wrapRef}
      className="infotip-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={close}
    >
      {children}
      <button
        type="button"
        className="infotip-icon"
        aria-label={`What is ${info.label}?`}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        i
      </button>
      {open ? (
        <span id={tipId} role="tooltip" className={`infotip-pop infotip-${side}`}>
          <span className="infotip-title">{info.label}</span>
          <span className="infotip-row"><b>What it is:</b> {info.what}</span>
          <span className="infotip-row"><b>Why it matters:</b> {info.why}</span>
          <span className="infotip-row"><b>Higher or lower?</b> {info.direction}</span>
          <span className="infotip-row"><b>In the score:</b> {info.scoring}</span>
          <span className="infotip-row infotip-risk"><b>Watch out:</b> {info.risk}</span>
        </span>
      ) : null}
    </span>
  );
}
