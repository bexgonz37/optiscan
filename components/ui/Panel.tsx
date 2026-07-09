"use client";

import type { ReactNode } from "react";
import { CardTip } from "@/components/CardTip";
import { InfoTip } from "@/components/InfoTip";

export function Panel({
  title,
  meta,
  live,
  children,
  className = "",
  tip,
}: {
  title: string;
  meta?: ReactNode;
  live?: boolean;
  children: ReactNode;
  className?: string;
  tip?: string;
}) {
  const panel = (
    <section className={`axiom-panel panel ${className}`.trim()}>
      <div className="ph">
        <div className="pht">
          <i aria-hidden />
          {tip ? <InfoTip metric={tip}>{title}</InfoTip> : title}
        </div>
        {meta ? <div className={`phc${live ? " rec" : ""}`}>{meta}</div> : null}
      </div>
      <div className="pb">{children}</div>
    </section>
  );
  if (tip) return <CardTip metric={tip} className="axiom-panel-wrap">{panel}</CardTip>;
  return panel;
}
