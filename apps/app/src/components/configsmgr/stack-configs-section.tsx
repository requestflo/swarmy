import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { Depth, Section } from '@/components/calm';
import { RowsSkeleton } from '@/components/app-tabs/tab-body';
import { ErrorState } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { ConfigRow } from './config-row';
import { CreateConfigCard } from './create-config-card';
import { OrphansCard } from './orphans-card';

/**
 * The app's config files (versioned Docker configs) as one quiet section:
 * readable, diffable, applied with a restart preview. Row-expand holds the
 * content, versions and apply / put back.
 */
export function StackConfigsSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const configs = useQuery({ ...trpc.configs.list.queryOptions({ stack }), refetchInterval: 5_000 });
  const families = configs.data?.families ?? [];

  return (
    <>
      <Section
        title="Config files"
        count={configs.data ? families.length : undefined}
        hint="readable, versioned"
        flush
        action={
          <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => setCreateOpen((o) => !o)}>
            <PlusIcon className="size-3.5" /> Add a file
          </Button>
        }
      >
        <CreateConfigCard stack={stack} open={createOpen} onOpenChange={setCreateOpen} />
        {configs.isPending ? (
          <RowsSkeleton rows={2} />
        ) : configs.isError ? (
          <ErrorState title="Couldn't load config files" error={configs.error} retry={() => void configs.refetch()} />
        ) : families.length === 0 ? (
          <p className="text-muted-foreground py-3 text-[13.5px]">
            No config files yet. Add one and swarmy mounts it at a fixed path, with every version kept.
          </p>
        ) : (
          <ul aria-label="Config files" className="flex flex-col">
            {families.map((f) => (
              <ConfigRow
                key={f.family}
                family={f}
                stack={stack}
                expanded={expanded === f.family}
                onToggle={() => setExpanded((e) => (e === f.family ? null : f.family))}
              />
            ))}
          </ul>
        )}
      </Section>
      <Depth at="controls">
        <OrphansCard orphans={configs.data?.orphans ?? []} />
      </Depth>
    </>
  );
}
