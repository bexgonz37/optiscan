"use client";

import type { ReactNode } from "react";

export function Panel({
  title,
  meta,
  live,
  children,
  className = "",
}: {
  title: string;
  meta?: ReactNode;
  live?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`axiom-panel panel ${className}`.trim()}>
      <div className="ph">
        <div className="pht">
          <i aria-hidden />
          {title}
        </div>
        {meta ? <div className={`phc${live ? " rec" : ""}`}>{meta}</div> : null}
      </div>
      <div className="pb">{children}</div>
    </section>
  );
}
