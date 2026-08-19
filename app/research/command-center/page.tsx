"use client";

/**
 * /research/command-center — the PRIVATE research view.
 *
 * Owner only. Subscribers never see this route, and nothing rendered here is
 * subscriber performance. Distinct from `/` (the live decision screen) and from
 * `/pipeline-health` (operational health): this page answers "where does the evidence
 * stand", and mixing that question with an ops fault makes both harder to act on.
 */
import { ResearchCommandCenter } from "@/components/ResearchCommandCenter";

export default function ResearchCommandCenterPage() {
  return <ResearchCommandCenter />;
}
