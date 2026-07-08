"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export type NavItem = { href: string; label: string; section?: string };

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
  sections?: { title: string; items: NavItem[] }[];
  items?: NavItem[];
  footer?: ReactNode;
  isActive: (href: string) => boolean;
}) {
  const groups = sections ?? [{ title: "WORKSPACE", items: items ?? [] }];

  return (
    <aside className="rail" aria-label="Main navigation">
      <div className="raillogo">{logo}</div>
      <div className="railtag">{tagline}</div>
      <nav className="railnav">
        {groups.map((group) => (
          <div key={group.title}>
            <div className="railsec">{group.title}</div>
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                prefetch
                className={`navitem${isActive(item.href) ? " on" : ""}`}
              >
                <span className="ni" aria-hidden />
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      {footer ? <div className="railfoot">{footer}</div> : null}
    </aside>
  );
}
