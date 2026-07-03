import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { LayoutTemplateIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { BlueprintCard } from './blueprint-card';

/**
 * Deploy → Blueprints: the gallery of production-ready stacks. Pick a card and
 * it expands in place — name it, preview the plan ("Will create: …"), deploy —
 * then you land in the new stack's workspace. No modals anywhere.
 */
export function BlueprintsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const blueprints = useQuery(trpc.blueprints.list.queryOptions());
  const cards = blueprints.data ?? [];

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Deploy · Blueprints"
        title={
          <>
            Ship a whole stack in <em>one</em> deploy.
          </>
        }
        description="Production-ready apps with the database, cache, secrets and domain wired in. Pick one, name it, deploy."
      />

      {blueprints.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="shimmer-line h-52 rounded-2xl" />
          ))}
        </div>
      ) : blueprints.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<LayoutTemplateIcon />}
            title="Couldn't load the gallery"
            description={blueprints.error.message}
            action={
              <Button variant="outline" onClick={() => void blueprints.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : cards.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<LayoutTemplateIcon />}
            title="No blueprints available"
            description="The catalog is empty on this controller build."
          />
        </div>
      ) : (
        <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((meta) => (
            <BlueprintCard
              key={meta.id}
              meta={meta}
              active={activeId === meta.id}
              onToggle={(open) => setActiveId(open ? meta.id : null)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
