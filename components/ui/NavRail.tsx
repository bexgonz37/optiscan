"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

/** Icon keys kept as plain strings so nav config stays data-only. */
export type NavIcon =
  | "now"
  | "alerts"
  | "paper"
  | "discord"
  | "more"
  | "research"
  | "watchlist"
  | "performance"
  | "history"
  | "settings"
  | "scanner"
  | "health"
  | "guide";

export type NavItem = {
  href: string;
  label: string;
  section?: string;
  note?: string;
  disabled?: boolean;
  icon?: NavIcon;
};

/** 16px stroke icons on a 24-grid, drawn in currentColor. */
const ICON_PATHS: Record<NavIcon, string> = {
  now: "M13 2 4 14h6l-1 8 9-12h-6l1-8Z",
  alerts: "M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 21a2 2 0 0 1-3.4 0",
  paper: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7l-5-5ZM14 2v6h6M8 13h8M8 17h5",
  discord: "M7 8.5c1.4-1 3-1.5 5-1.5s3.6.5 5 1.5M8.5 16c1 .7 2.1 1 3.5 1s2.5-.3 3.5-1M8 12h.1M16 12h.1M5.5 5.5c1.8-1 4-1.5 6.5-1.5s4.7.5 6.5 1.5c.8 2.1 1.2 4.3 1.2 6.8 0 2.1-.4 4.2-1.2 6.2-1.7 1-3.9 1.5-6.5 1.5s-4.8-.5-6.5-1.5c-.8-2-1.2-4.1-1.2-6.2 0-2.5.4-4.7 1.2-6.8Z",
  more: "M4 6h16M4 12h16M4 18h16",
  research: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
  watchlist: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5",
  performance: "M3 3v18h18M7 15v3M12 10v8M17 5v13",
  history: "M12 21a9 9 0 1 0-9-9M12 7v5l4 2M3 12l3-3M3 12l3 3",
  settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.3a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4h.2A1.7 1.7 0 0 0 4.4 8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4V3.7a2 2 0 1 1 4 0V4a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.3a1.7 1.7 0 0 0-1.3 1Z",
  scanner: "M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M3 12h18",
  health: "M22 12h-4l-3 8-4-16-3 8H2",
  guide: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 1 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15Z",
};

function NavGlyph({ icon }: { icon?: NavIcon }) {
  if (!icon) return <span className="ni" aria-hidden />;
  return (
    <span className="ni ni-icon" aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d={ICON_PATHS[icon]} />
      </svg>
    </span>
  );
}

export type NavSection = {
  title: string;
  items: NavItem[];
  /** Collapsible sections render a toggle header; default open unless collapsedByDefault. */
  collapsible?: boolean;
  collapsedByDefault?: boolean;
  /** Persist open/closed under this localStorage key. */
  storageKey?: string;
};

function CollapsibleSection({
  section,
  isActive,
  onItemClick,
}: {
  section: NavSection;
  isActive: (href: string) => boolean;
  onItemClick?: (href: string) => boolean;
}) {
  const { title, items, collapsible, collapsedByDefault, storageKey } = section;
  const [open, setOpen] = useState(!collapsedByDefault);

  useEffect(() => {
    if (!collapsible || !storageKey) return;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === "open") setOpen(true);
      else if (saved === "closed") setOpen(false);
    } catch { /* ignore */ }
  }, [collapsible, storageKey]);

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      try { if (storageKey) localStorage.setItem(storageKey, next ? "open" : "closed"); } catch { /* ignore */ }
      return next;
    });
  };

  if (!collapsible) {
    return (
      <div>
        <div className="railsec">{title}</div>
        <NavLinks items={items} isActive={isActive} onItemClick={onItemClick} />
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        className="railsec railsec-toggle"
        aria-expanded={open}
        onClick={toggle}
      >
        <span>{title}</span>
        <span className="railsec-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open ? <NavLinks items={items} isActive={isActive} onItemClick={onItemClick} /> : null}
    </div>
  );
}

function NavLinks({
  items,
  isActive,
  onItemClick,
}: {
  items: NavItem[];
  isActive: (href: string) => boolean;
  onItemClick?: (href: string) => boolean;
}) {
  return (
    <>
      {items.map((item) => {
        if (onItemClick && item.href.startsWith("#")) {
          return (
            <button
              key={`${item.href}:${item.label}`}
              type="button"
              className={`navitem${isActive(item.href) ? " on" : ""}${item.disabled ? " dis" : ""}`}
              onClick={() => onItemClick(item.href)}
            >
              <NavGlyph icon={item.icon} />
              <span className="navitem-label">{item.label}</span>
              {item.note ? <span className="navitem-note">{item.note}</span> : null}
            </button>
          );
        }
        return (
          <Link
            key={`${item.href}:${item.label}`}
            href={item.href}
            prefetch
            className={`navitem${isActive(item.href) ? " on" : ""}${item.disabled ? " dis" : ""}`}
            onClick={(e) => {
              if (onItemClick?.(item.href)) e.preventDefault();
            }}
          >
            <NavGlyph icon={item.icon} />
            <span className="navitem-label">{item.label}</span>
            {item.note ? <span className="navitem-note">{item.note}</span> : null}
          </Link>
        );
      })}
    </>
  );
}

export function NavRail({
  logo,
  tagline,
  sections,
  items,
  footer,
  isActive,
  onItemClick,
}: {
  logo: ReactNode;
  tagline: string;
  sections?: NavSection[];
  items?: NavItem[];
  footer?: ReactNode;
  isActive: (href: string) => boolean;
  /** Return true to prevent default navigation (e.g. MORE drawer). */
  onItemClick?: (href: string) => boolean;
}) {
  const groups: NavSection[] = sections ?? [{ title: "WORKSPACE", items: items ?? [] }];

  return (
    <aside className="rail" aria-label="Main navigation">
      <div className="raillogo">{logo}</div>
      <div className="railtag">{tagline}</div>
      <nav className="railnav">
        {groups.map((group) => (
          <CollapsibleSection key={group.title} section={group} isActive={isActive} onItemClick={onItemClick} />
        ))}
      </nav>
      {footer ? <div className="railfoot">{footer}</div> : null}
    </aside>
  );
}
