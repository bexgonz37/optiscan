"use client";

import { Suspense } from "react";
import { NowPage } from "@/components/NowPage";

/**
 * Home is the decision-first NOW page.
 * Deep links to Live Options, Quant, etc. remain available from cards and MORE.
 */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <NowPage />
    </Suspense>
  );
}
