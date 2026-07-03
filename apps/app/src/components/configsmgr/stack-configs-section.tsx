import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileCogIcon, PlusIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ConfigRow } from './config-row';
import { CreateConfigCard } from './create-config-card';
import { OrphansCard } from './orphans-card';

interface StackConfigsSectionProps {
  stack: string;
}

/**
 * Configs scoped to this stack — one flat list, everything inline: create is
 * an expanding card, detail (content, diffs, versions) is a row-expand, and
 * apply/rollback/delete confirm via AlertDialog with live restart previews.
 */
export function StackConfigsSection({ stack }: StackConfigsSectionProps): React.JSX.Element {
  const trpc = useTRPC();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const configs = useQuery({
    ...trpc.configs.list.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const families = configs.data?.families ?? [];
  const stale = families.reduce((n, f) => n + f.staleConsumers, 0);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mono-label text-muted-foreground">Configs</p>
          <h2 className="headline text-2xl">
            {families.length === 0 ? (
              <>
                Configs, <em>versioned</em>.
              </>
            ) : stale > 0 ? (
              <>
                {stale} service{stale === 1 ? '' : 's'} on <em>old</em> configs.
              </>
            ) : (
              <>
                {families.length} config{families.length === 1 ? '' : 's'} — all <em>current</em>.
              </>
            )}
          </h2>
        </div>
        <Button variant="outline" onClick={() => setCreateOpen((o) => !o)}>
          <PlusIcon className="size-4" /> New config
        </Button>
      </div>

      <CreateConfigCard stack={stack} open={createOpen} onOpenChange={setCreateOpen} />

      {configs.isLoading ? (
        <div className="card-pop space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer-line h-12 rounded-lg" />
          ))}
        </div>
      ) : configs.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<FileCogIcon />}
            title="Couldn't load configs"
            description={configs.error.message}
            action={
              <Button variant="outline" onClick={() => void configs.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : families.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<FileCogIcon />}
            title="No configs in this stack yet — create one."
            description="Versioned Docker configs you can read, diff and roll back — mounted at a stable path, applied with a restart preview."
            action={
              <Button variant="outline" onClick={() => setCreateOpen(true)}>
                <PlusIcon className="size-4" /> New config
              </Button>
            }
          />
        </div>
      ) : (
        <div className="card-pop divide-border divide-y overflow-hidden">
          {families.map((f) => (
            <ConfigRow
              key={f.family}
              family={f}
              stack={stack}
              expanded={expanded === f.family}
              onToggle={() => setExpanded((e) => (e === f.family ? null : f.family))}
            />
          ))}
        </div>
      )}

      <OrphansCard orphans={configs.data?.orphans ?? []} />
    </section>
  );
}
