"use client";

import { useCallback, useEffect, useState } from "react";
import { PageContainer, PageHeader, Card, LoadingState, ErrorState, StatusBadge, KeyValue } from "@/components/ui/Shell";
import { apiFetchJson, describeApiLoadFailure } from "@/lib/client-auth";

type SubSummary = {
  total: number;
  active: number;
  pastDue: number;
  canceled: number;
  unlinkedDiscord: number;
  recentRoleSyncErrors: number;
};

type Subscriber = {
  id: number;
  stripeCustomerId: string | null;
  discordUserId: string | null;
  email: string | null;
  status: string;
  currentPeriodEndMs: number | null;
};

export default function SubscriptionsPage() {
  const [summary, setSummary] = useState<SubSummary | null>(null);
  const [subs, setSubs] = useState<Subscriber[]>([]);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await apiFetchJson<{ ok: boolean; billingEnabled: boolean; summary: SubSummary; subscribers: Subscriber[] }>(
      "/api/billing/subscribers",
    );
    if (!r.ok) {
      const { title, detail } = describeApiLoadFailure(r);
      setError(`${title}: ${detail}`);
      setLoading(false);
      return;
    }
    setBillingEnabled(r.data?.billingEnabled ?? false);
    setSummary(r.data?.summary ?? null);
    setSubs(r.data?.subscribers ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <LoadingState label="Loading subscription ops…" />;
  if (error) return <ErrorState title="Subscription ops unavailable" detail={error} onRetry={load} />;

  return (
    <PageContainer>
      <PageHeader title="Discord Subscriptions" subtitle="Stripe ↔ Discord role sync — owner only" />
      <Card title="Billing status" meta={billingEnabled ? "BILLING_ENABLED=1" : "Billing inactive until Stripe configured"}>
        <KeyValue k="Active subscribers" v={String(summary?.active ?? 0)} />
        <KeyValue k="Past due" v={String(summary?.pastDue ?? 0)} />
        <KeyValue k="Unlinked Discord" v={String(summary?.unlinkedDiscord ?? 0)} />
        <KeyValue k="Role sync errors (24h)" v={String(summary?.recentRoleSyncErrors ?? 0)} />
        <p className="mt-2 text-xs opacity-60">Emergency alert stop: set OPTIONS_CALLOUTS_KILL=1 in Railway env.</p>
      </Card>
      <Card title="Subscribers" meta={`${subs.length} rows`}>
        {subs.length === 0 ? (
          <p className="text-sm opacity-70">No subscribers yet. Configure Stripe + webhook before taking payment.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {subs.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 border-b border-white/10 pb-2">
                <StatusBadge tone={s.status === "active" ? "bull" : s.status === "past_due" ? "warn" : "muted"}>{s.status}</StatusBadge>
                <span>{s.email ?? s.stripeCustomerId ?? `#${s.id}`}</span>
                <span className="opacity-60">Discord: {s.discordUserId ?? "not linked"}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </PageContainer>
  );
}
