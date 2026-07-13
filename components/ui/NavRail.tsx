"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

export type NavItem = { href: string; label: string; section?: string; note?: string; disabled?: boolean };

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
  section, isActive,
}: {
  section: NavSection;
  isActive: (href: string) => boolean;
}) {
  const { title, items, collapsible, collapsedByDefault, storageKey } = section;
  const [open, setOpen] = useState(!collapsedByDefault);

  // Restore persisted state after mount (avoids hydration mismatch).
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
        <NavLinks items={items} isActive={isActive} />
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
      {open ? <NavLinks items={items} isActive={isActive} /> : null}
    </div>
  );
}

function NavLinks({ items, isActive }: { items: NavItem[]; isActive: (href: string) => boolean }) {
  return (
    <>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          prefetch
          className={`navitem${isActive(item.href) ? " on" : ""}${item.disabled ? " dis" : ""}`}
        >
          <span className="ni" aria-hidden />
          <span className="navitem-label">{item.label}</span>
          {item.note ? <span className="navitem-note">{item.note}</span> : null}
        </Link>
      ))}
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
}: {
  logo: ReactNode;
  tagline: string;
  sections?: NavSection[];
  items?: NavItem[];
  footer?: ReactNode;
  isActive: (href: string) => boolean;
}) {
  const groups: NavSection[] = sections ?? [{ title: "WORKSPACE", items: items ?? [] }];

  return (
    <aside className="rail" aria-label="Main navigation">
      <div className="raillogo">{logo}</div>
      <div className="railtag">{tagline}</div>
      <nav className="railnav">
        {groups.map((group) => (
          <CollapsibleSection key={group.title} section={group} isActive={isActive} />
        ))}
      </nav>
      {footer ? <div className="railfoot">{footer}</div> : null}
    </aside>
  );
}
