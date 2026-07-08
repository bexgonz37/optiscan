"use client";

import type { ReactNode } from "react";

export function SignalCard({
  kicker,
  action,
  live,
  bear,
  contract,
  reason,
  children,
  footer,
}: {
  kicker?: ReactNode;
  action: ReactNode;
  live?: boolean;
  bear?: boolean;
  contract?: ReactNode;
  reason?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className={`sig axiom-signal${bear ? " bear" : " bull"}${live ? " fresh" : ""}`}>
      {kicker ? <div className="callout-kicker">{kicker}</div> : null}
      <div className="sigtop">
        <div className="sigact">{action}{live ? <span className="nowchip">NOW</span> : null}</div>
      </div>
      {contract ? <div className="sigconv num">{contract}</div> : null}
      {reason ? <div className="sigwhy">{reason}</div> : null}
      {children}
      {footer}
    </div>
  );
}
