"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { marketSession, type MarketSession } from "@/lib/trading-session";
import { useLanguageMode } from "@/hooks/useLanguageMode";

function messages(isPublic: boolean): Record<MarketSession, { text: ReactNode }> {
  return {
  regular: {
    text: (
      <>
        Market open — watching for <strong>0DTE option</strong> signals. Go to{" "}
        <Link href="/alerts" className="guide-link">Alerts</Link> when one fires.
      </>
    ),
  },
  premarket: {
    text: isPublic ? (
      <>
        Premarket — tape is live; <strong>call/put momentum watches</strong> begin at 9:30 AM ET.
      </>
    ) : (
      <>
        Premarket — tape is live; <strong>BUY CALL/PUT</strong> callouts fire at 9:30 AM ET.
      </>
    ),
  },
  afterhours: {
    text: (
      <>
        After hours — tape is live; option callouts resume at 9:30 AM ET.
      </>
    ),
  },
  closed: {
    text: <>Market closed — scanning pauses until 4:00 AM ET premarket.</>,
  },
  };
}

export function SessionBanner() {
  const [session, setSession] = useState<MarketSession | null>(null);
  const languageMode = useLanguageMode();
  useEffect(() => {
    const update = () => setSession(marketSession());
    update();
    const t = setInterval(update, 60_000);
    return () => clearInterval(t);
  }, []);

  if (!session) return null;
  const msg = messages(languageMode === "public")[session];

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
