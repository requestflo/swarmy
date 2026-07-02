import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileCogIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CreateConfigDialog } from './create-config-dialog';
import { FamiliesTable } from './families-table';
import { FamilyDrawer } from './family-drawer';
import { OrphansCard } from './orphans-card';

/**
 * Governance → Configs: Docker-native config families with readable content,
 * diff-previewed edits, apply with restart previews and one-click rollback.
 */
export function ConfigsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const [selectedFamily, setSelectedFamily] = React.useState<string | null>(null);

  const configs = useQuery({
    ...trpc.configs.list.queryOptions(),
    refetchInterval: 10_000,
  });

  const families = configs.data?.families ?? [];
  const orphans = configs.data?.orphans ?? [];
  const stale = families.reduce((n, f) => n + f.staleConsumers, 0);
  const selected = families.find((f) => f.family === selectedFamily) ?? null;

  const title =
    families.length === 0 ? (
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
    );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Governance · Configs"
        title={title}
        description="Versioned Docker configs you can read, diff and roll back. Edit safely: preview the change, see exactly which services restart, then apply."
        actions={<CreateConfigDialog />}
      />

      {configs.isLoading ? (
        <div className="card-pop space-y-3 p-5">
          {[0, 1, 2, 3].map((i) => (
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
        <>
          <div className="card-pop p-2">
            <EmptyState
              icon={<FileCogIcon />}
              title="No configs yet — create one."
              description="Store a Caddy snippet or app config as a versioned Docker config, mount it into services at a stable path, and edit with diffs, restart previews and rollback."
              action={<CreateConfigDialog variant="outline" />}
            />
          </div>
          <OrphansCard orphans={orphans} />
        </>
      ) : (
        <>
          <FamiliesTable families={families} onOpen={(f) => setSelectedFamily(f.family)} />
          <OrphansCard orphans={orphans} />
        </>
      )}

      <FamilyDrawer
        family={selected}
        onOpenChange={(open) => {
          if (!open) setSelectedFamily(null);
        }}
      />
    </div>
  );
}
