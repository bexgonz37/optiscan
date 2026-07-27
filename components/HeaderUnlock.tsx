"use client";

import { useCallback, useEffect, useState } from "react";
import { hasToken, promptUnlock, TOKEN_CHANGED_EVENT } from "@/lib/client-auth";

/** Top-right unlock affordance — replaces the floating FAB on desktop. */
export function HeaderUnlock() {
  const [locked, setLocked] = useState(true);

  const sync = useCallback(() => setLocked(!hasToken()), []);

  useEffect(() => {
    sync();
    window.addEventListener(TOKEN_CHANGED_EVENT, sync);
    return () => window.removeEventListener(TOKEN_CHANGED_EVENT, sync);
  }, [sync]);

  if (!locked) return null;

  return (
    <button
      type="button"
      className="header-unlock-btn"
      onClick={() => promptUnlock()}
      aria-label="Enter OptiScan access token"
    >
      🔒 Unlock
    </button>
  );
}
