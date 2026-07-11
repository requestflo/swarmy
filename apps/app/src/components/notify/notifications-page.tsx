import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { ProviderCard } from './provider-card';
import { TemplatesCard } from './templates-card';
import { DeliveryLog } from './delivery-log';

/**
 * Settings · Notifications — the org's email relay. Provider config (encrypted),
 * from-address + test send, reusable templates, and the live delivery log.
 */
export function NotificationsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const overview = useQuery({
    ...trpc.notifications.overview.queryOptions(),
    refetchInterval: 10_000,
  });

  const o = overview.data;
  const headline = !o ? (
    <>
      <em>Notifications</em>.
    </>
  ) : o.configured ? (
    <>
      <em>{o.sent24h}</em> sent today.
    </>
  ) : (
    <>
      Get <em>reachable</em>.
    </>
  );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <SectionHeader
        section="Settings"
        title={headline}
        description="Connect an email provider once — alerts, approvals and your apps (POST /api/v1/notify) all send through it."
      />

      {o ? (
        <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
          <Kpi label="Sent · 24h" value={o.sent24h} tone="text-status-online" />
          <Kpi label="Queued" value={o.queued} tone="text-status-progress" />
          <Kpi label="Failed · 24h" value={o.failed24h} tone="text-status-offline" />
          <Kpi label="Bounced · 24h" value={o.bounced24h} tone="text-status-warning" />
        </div>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <ProviderCard />
        <TemplatesCard />
      </div>
      <div className="mt-6">
        <DeliveryLog />
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}): React.JSX.Element {
  return (
    <div className="card-pop px-5 py-4">
      <div className="mono-label text-muted-foreground">{label}</div>
      <div className={`mono-data mt-1 text-3xl font-bold ${tone}`}>{value}</div>
    </div>
  );
}
