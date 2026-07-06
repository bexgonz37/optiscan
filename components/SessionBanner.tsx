"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { marketSession, type MarketSession } from "@/lib/trading-session";

const MESSAGES: Record<MarketSession, { text: ReactNode }> = {
  regular: {
    text: (
      <>
        Market open — watching for <strong>0DTE option</strong> signals. Go to{" "}
        <Link href="/alerts" className="guide-link">Alerts</Link> when one fires.
      </>
    ),
  },
  premarket: {
    text: (
      <>
        Premarket — watching <strong>stocks only</strong> (shares ↑/↓). No option alerts until 9:30 AM ET.
      </>
    ),
  },
  afterhours: {
    text: (
      <>
        After hours — watching <strong>stocks only</strong> (shares ↑/↓). No option alerts until 9:30 AM ET.
      </>
    ),
  },
  closed: {
    text: <>Market closed — scanning pauses until 4:00 AM ET premarket.</>,
  },
};

export function SessionBanner() {
  const [session, setSession] = useState<MarketSession | null>(null);
  useEffect(() => {
    const update = () => setSession(marketSession());
    update();
    const t = setInterval(update, 60_000);
    return () => clearInterval(t);
  }, []);

  if (!session) return null;
  const msg = MESSAGES[session];

  const bannerClass =
    session === "regular"
      ? "session-banner-regular"
      : session === "closed"
        ? "session-banner-closed"
        : "session-banner-extended";

  return (
    <div className={`panel main session-banner ${bannerClass}`}>
      {msg.text}
    </div>
  );
}
