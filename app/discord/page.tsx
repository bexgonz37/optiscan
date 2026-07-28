"use client";

import { DiscordDeliveryPanel } from "@/components/DiscordDeliveryPanel";
import { Card } from "@/components/ui/Shell";

export default function DiscordPage() {
  return (
    <div className="page-deck">
      <Card title="Discord command surface" meta="Subscriber delivery uses real webhook health and delivery ledger APIs">
        <p className="muted text-sm">
          Verified subscriber alerts, owner research, retries, failures, and webhook readiness are shown from the production delivery ledger.
          Webhook URLs and secrets never render in the browser.
        </p>
      </Card>
      <DiscordDeliveryPanel />
    </div>
  );
}
