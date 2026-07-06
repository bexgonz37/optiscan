"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { marketSession, type MarketSession } from "@/lib/trading-session";

const MESSAGES: Record<MarketSession, { text: ReactNode }> = {
  regular: {
    text: (
      <>
        Market open — watching for <strong>0DTE option</strong> signals. Go to{" "}
        <Link href="/alerts" style={{ color: "inherit", textDecoration: "underline" }}>Alerts</Link> when one fires.
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

  return (
    <div
      className="panel main"
      style={{
        padding: "10px 14px",
        marginBottom: 14,
        fontSize: 13,
        lineHeight: 1.5,
        borderLeft: `3px solid ${session === "regular" ? "var(--amber)" : session === "closed" ? "var(--muted)" : "var(--blue, #4a90c4)"}`,
      }}
    >
      {msg.text}
    </div>
  );
}
