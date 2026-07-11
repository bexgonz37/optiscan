"use client";

import { Suspense } from "react";
import { CommandCenter } from "@/components/CommandCenter";

/**
 * Home is the calm, sectioned Command Center (Phase 6). The full live scanner
 * moved to /scanner and is linked from here.
 */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <CommandCenter />
    </Suspense>
  );
}
