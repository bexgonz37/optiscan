"use client";

import { useEffect } from "react";

/** Catches render errors in the app shell so a bad row doesn't white-screen a live session. */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[OptiScan] UI error:", error);
  }, [error]);

  return (
    <div className="app" style={{ padding: 24, maxWidth: 520, margin: "40px auto" }}>
      <div className="panel main" style={{ padding: 20 }}>
        <h2 style={{ margin: "0 0 8px" }}>Something went wrong</h2>
        <p className="muted" style={{ margin: "0 0 16px", lineHeight: 1.6 }}>
          The scanner hit an unexpected error. Your data is safe — try refreshing. If it keeps happening,
          restart <code>npm run dev</code>.
        </p>
        <p className="muted" style={{ fontSize: 12, marginBottom: 16 }}>{error.message}</p>
        <button type="button" className="pill btn btn-primary" onClick={() => reset()}>
          Try again
        </button>
      </div>
    </div>
  );
}
