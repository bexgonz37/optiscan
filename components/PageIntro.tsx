"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export function PageIntro({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <div className="page-intro panel main">
      <div className="page-intro-row">
        <div>
          <h1 className="page-intro-title">{title}</h1>
          <p className="page-intro-body">{children}</p>
        </div>
        {action ? (
          <Link href={action.href} className="pill btn btn-primary page-intro-action">
            {action.label}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
