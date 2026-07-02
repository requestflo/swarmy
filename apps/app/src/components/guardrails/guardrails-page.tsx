import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlertIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { DecisionsFeed } from './decisions-feed';
import { RulesList } from './rules-list';
import { SafetyModeCard } from './safety-mode-card';
import { StackEnvCard } from './stack-env-card';

/**
 * Governance → Guardrails: the production safety switch, the rule list,
 * the stack environment editor and the blocked/overridden decisions feed.
 */
export function GuardrailsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const config = useQuery({
    ...trpc.guardrails.config.queryOptions(),
    refetchInterval: 15_000,
  });

  const enabledCount = config.data?.rules.filter((r) => r.enabled).length ?? 0;
  const title = config.data?.productionSafetyMode ? (
    <>
      Production is <em>locked down</em>.
    </>
  ) : (
    <>
      {enabledCount} guardrail{enabledCount === 1 ? '' : 's'} <em>armed</em>.
    </>
  );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Governance · Guardrails"
        title={title}
        description="Rules that keep production safe — pinned images, database replicas, backups, limits. Violating deploys are refused; every block and override is on the record."
      />

      {config.isLoading ? (
        <div className="space-y-6">
          <div className="shimmer-line h-28 rounded-2xl" />
          <div className="shimmer-line h-64 rounded-2xl" />
        </div>
      ) : config.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<ShieldAlertIcon />}
            title="Couldn't load your guardrails"
            description={config.error.message}
            action={
              <Button variant="outline" onClick={() => void config.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : config.data ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <div className="min-w-0 space-y-6">
            <SafetyModeCard config={config.data} />
            <RulesList config={config.data} />
          </div>
          <div className="space-y-6">
            <StackEnvCard />
            <DecisionsFeed />
          </div>
        </div>
      ) : null}
    </div>
  );
}
