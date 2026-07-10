"use client";

import type { ReactNode } from "react";

/**
 * Shared layout primitives (Phase 4). One coherent system so pages stop
 * hand-rolling scattered cards, fixed-height blanks, and absolute positioning.
 * All spacing/heights are content-driven — no reserved empty boxes.
 */

/** Outer page container: max width, consistent gutters, vertical rhythm. */
export function PageContainer({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`ui-page ${className}`.trim()}>{children}</div>;
}

/** Page-level header with title, optional subtitle and right-aligned actions. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="ui-pagehead">
      <div className="ui-pagehead-text">
        <h1 className="ui-pagehead-title">{title}</h1>
        {subtitle ? <p className="ui-pagehead-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="ui-pagehead-actions">{actions}</div> : null}
    </header>
  );
}

/**
 * Responsive auto-fit grid. `min` is the minimum column width; columns wrap
 * naturally and never overflow horizontally. Heights are driven by content —
 * cards in a row stretch to the tallest via align-items: stretch.
 */
export function ResponsiveGrid({
  children,
  min = 260,
  gap = 14,
  className = "",
}: {
  children: ReactNode;
  min?: number;
  gap?: number;
  className?: string;
}) {
  return (
    <div
      className={`ui-grid ${className}`.trim()}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`, gap }}
    >
      {children}
    </div>
  );
}

/** A generic card. Header is optional; when absent the body owns all padding. */
export function Card({
  title,
  meta,
  tone,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  meta?: ReactNode;
  tone?: "bull" | "bear" | "warn" | "neutral";
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`ui-card${tone ? ` ui-card-${tone}` : ""} ${className}`.trim()}>
      {title || actions || meta ? (
        <div className="ui-card-head">
          <div className="ui-card-head-text">
            {title ? <div className="ui-card-title">{title}</div> : null}
            {meta ? <div className="ui-card-meta">{meta}</div> : null}
          </div>
          {actions ? <div className="ui-card-actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="ui-card-body">{children}</div>
    </section>
  );
}

export type BadgeTone = "live" | "warn" | "bad" | "muted" | "info" | "bull" | "bear";

/** Status pill with a semantic tone. Used for freshness / delivery / lifecycle. */
export function StatusBadge({ tone = "muted", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`ui-badge ui-badge-${tone}`}>{children}</span>;
}

/**
 * Loading state — a bounded, self-resolving skeleton. Never leaves an
 * unresolved skeleton: the caller swaps it out when data arrives; on its own it
 * simply shows a small labelled shimmer, not a giant reserved box.
 */
export function LoadingState({ label = "Loading…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="ui-loading" role="status" aria-live="polite">
      <div className="ui-loading-label">{label}</div>
      <div className="ui-loading-rows">
        {Array.from({ length: Math.max(1, rows) }).map((_, i) => (
          <div className="ui-skel" key={i} />
        ))}
      </div>
    </div>
  );
}

/**
 * Empty state — REQUIRED to explain *why* it is empty (Phase 4 rule). No blank
 * fixed-height container; the height is exactly the message.
 */
export function EmptyState({
  title,
  reason,
  icon = "○",
  action,
}: {
  title: ReactNode;
  reason: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <div className="ui-empty-icon" aria-hidden>
        {icon}
      </div>
      <div className="ui-empty-title">{title}</div>
      <div className="ui-empty-reason">{reason}</div>
      {action ? <div className="ui-empty-action">{action}</div> : null}
    </div>
  );
}

/** Error state — shows the failure plainly with an optional retry. */
export function ErrorState({ title = "Something went wrong", detail, onRetry }: { title?: ReactNode; detail?: ReactNode; onRetry?: () => void }) {
  return (
    <div className="ui-error" role="alert">
      <div className="ui-error-title">{title}</div>
      {detail ? <div className="ui-error-detail">{detail}</div> : null}
      {onRetry ? (
        <button type="button" className="ui-btn ui-btn-sm" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** Small key/value stat used inside cards and status bars. */
export function KeyValue({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: "bull" | "bear" | "warn" | "muted" }) {
  return (
    <div className="ui-kv">
      <span className="ui-kv-k">{k}</span>
      <span className={`ui-kv-v${tone ? ` ui-kv-${tone}` : ""}`}>{v}</span>
    </div>
  );
}

/** A collapsible technical-details block — keeps raw JSON out of the default view. */
export function DetailsDisclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="ui-details">
      <summary className="ui-details-summary">{summary}</summary>
      <div className="ui-details-body">{children}</div>
    </details>
  );
}
