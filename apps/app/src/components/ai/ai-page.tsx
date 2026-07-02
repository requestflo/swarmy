import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { KeysCard } from './keys-card';
import { ProvidersCard } from './providers-card';
import { RequestLogCard } from './request-log-card';
import { SettingsCard } from './settings-card';
import { UsageCharts } from './usage-charts';

/**
 * The AI gateway page: providers config, virtual keys, usage & cost charts,
 * request log and gateway toggles. One coral CTA (mint key) lives in KeysCard.
 */
export function AiPage(): React.JSX.Element {
  const trpc = useTRPC();
  const providers = useQuery({ ...trpc.ai.providers.queryOptions(), refetchInterval: 15_000 });
  const usage = useQuery({ ...trpc.ai.usage.queryOptions({ days: 14 }), refetchInterval: 10_000 });

  const configured = (providers.data?.providers ?? []).filter((p) => p.hasKey).length;
  const spend = usage.data?.totals.costUsd ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="AI"
        title={
          configured === 0 ? (
            <>
              One gateway, <em>every</em> model.
            </>
          ) : (
            <>
              ~${spend.toFixed(2)} this <em>fortnight</em>.
            </>
          )
        }
        description="Route every model call through your own gateway: provider keys stay server-side, apps get revocable virtual keys with budgets — usage and cost land here."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ProvidersCard />
        </div>
        <SettingsCard />
      </div>

      <div className="mt-4">
        <UsageCharts />
      </div>

      <div className="mt-4">
        <KeysCard />
      </div>

      <div className="mt-4">
        <RequestLogCard />
      </div>
    </div>
  );
}
