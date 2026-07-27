"use client";

import { useEffect, useState } from "react";
import { isUiReviewMode } from "@/lib/dashboard/ui-review";

/** Visible only in explicit UI review mode — never mislabels production health. */
export function UiReviewBanner() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(isUiReviewMode());
    const sync = () => setOn(isUiReviewMode());
    window.addEventListener("storage", sync);
    window.addEventListener("optiscan:ui-review-changed", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("optiscan:ui-review-changed", sync);
    };
  }, []);
  if (!on) return null;
  return (
    <div className="cc-term-review-banner" role="status">
      UI REVIEW — Seeded demo data for screenshot approval. Not production health or live trading signals.
    </div>
  );
}
