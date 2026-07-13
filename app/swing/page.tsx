"use client";

/**
 * /swing — legacy route kept working for existing bookmarks. Swing research now
 * lives inside the consolidated Callouts page (Swing Research tab); this page
 * renders the same panel and links there. No functionality was removed.
 */

import { Suspense } from "react";
import Link from "next/link";
import { SwingResearchPanel } from "@/components/SwingResearchPanel";

export default function SwingPage() {
  return (
    <Suspense fallback={null}>
      <div className="axiom-compat-note">
        Swing research now lives in <Link href="/callouts?tab=swing">Callouts → Swing Research</Link>. This page still works.
      </div>
      <SwingResearchPanel />
    </Suspense>
  );
}
