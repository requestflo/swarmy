import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { AlreadyOn, Depth, NextAction, usePageDepth } from '@/components/calm';
import { PageError, PageSkeleton } from '@/components/states';
import { KeysCard } from './keys-card';
import { PlaygroundCard } from './playground-card';
import { ProvidersCard } from './providers-card';
import { RequestLogCard } from './request-log-card';
import { SettingsCard } from './settings-card';
import { UsageCharts } from './usage-charts';
import { KeyRows, ProviderRows, UsageRows } from './ai-summary';
import { AiCode } from './ai-code';

/**
 * The AI gateway: one endpoint for every model. Summary says what's ready
 * and what it cost; Controls holds provider keys, settings, the playground,
 * charts, app keys and the request log; Code the app's `ai:` key and a call.
 */
export function AiPage(): React.JSX.Element {
  const trpc = useTRPC();
  const { setDepth } = usePageDepth();
  const providers = useQuery({ ...trpc.ai.providers.queryOptions(), refetchInterval: 15_000 });
  const usage = useQuery({ ...trpc.ai.usage.queryOptions({ days: 14 }), refetchInterval: 10_000 });
  const keys = useQuery({ ...trpc.ai.keys.queryOptions(), refetchInterval: 10_000 });
  const settings = useQuery(trpc.ai.settings.queryOptions());

  // The headline is a claim about the gateway — don't make it before we know.
  if (providers.isPending || usage.isPending) return <PageSkeleton variant="list" />;
  if (providers.isError) {
    return <PageError title="Couldn’t reach the AI gateway." error={providers.error} retry={() => void providers.refetch()} retrying={providers.isFetching} />;
  }
  const p = providers.data;
  const ready = p.providers.filter((x) => x.hasKey || x.inCluster).length;
  const t = usage.data?.totals;
  const cachePct = t && t.requests ? Math.round((t.cacheHits / t.requests) * 100) : 0;
  const open = (id: string): void => {
    setDepth('controls');
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };
  const title =
    ready === 0 ? (
      <>One address for every AI model. <em>Add a provider to start.</em></>
    ) : (
      <>
        {ready} provider{ready === 1 ? '' : 's'} ready, about ${(t?.costUsd ?? 0).toFixed(2)} in 14 days.{' '}
        <em>{(t?.requests ?? 0).toLocaleString()} requests, {cachePct}% answered from cache.</em>
      </>
    );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 pb-24 lg:pb-20 xl:px-10">
      <SectionHeader
        title={title}
        description="Apps call one OpenAI-compatible address with their own key. Provider keys stay with swarmy; each app key has a budget and a list of models it may use."
        actions={ready > 0 ? <Button onClick={() => open('ai-keys')}>Give an app a key</Button> : undefined}
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          {ready === 0 ? (
            <NextAction title="Add your first provider key" actions={<Button onClick={() => open('ai-providers')}>Add a provider</Button>}>
              Paste an API key once (Anthropic, OpenAI, or a model on your own servers). Apps never see it.
            </NextAction>
          ) : null}
          <ProviderRows providers={p.providers} />
          {usage.data ? <UsageRows usage={usage.data} /> : null}
          {keys.data ? <KeyRows keys={keys.data} /> : null}
          <Depth at="controls">
            <div id="ai-providers" className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2"><ProvidersCard /></div>
              <SettingsCard />
            </div>
            <PlaygroundCard />
            <UsageCharts />
            <div id="ai-keys"><KeysCard /></div>
            <RequestLogCard />
          </Depth>
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <AiCode gatewayUrl={p.gatewayUrl} />
          <AlreadyOn
            items={[
              { what: 'Fallback', detail: 'fast, smart and embed switch provider if one is down' },
              { what: 'Cache', detail: settings.data?.cache === false ? 'off' : 'repeated questions cost nothing' },
              { what: 'Privacy', detail: settings.data?.guardrails.redactPii === false ? 'prompts logged as sent' : 'emails, cards and keys masked in the log' },
            ]}
          />
        </aside>
      </div>
    </div>
  );
}
