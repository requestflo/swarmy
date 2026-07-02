import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { LockKeyholeIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CreateSecretDialog } from './create-secret-dialog';
import { FamiliesTable } from './families-table';
import { FamilyDrawer } from './family-drawer';
import { OrphansCard } from './orphans-card';

/**
 * Governance → Secrets: Docker-native secret families with versions, rotation
 * and a live usage map. Values are write-only — swarmy never shows them back.
 */
export function SecretsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const [selectedFamily, setSelectedFamily] = React.useState<string | null>(null);

  const secrets = useQuery({
    ...trpc.secrets.list.queryOptions(),
    refetchInterval: 10_000,
  });

  const families = secrets.data?.families ?? [];
  const orphans = secrets.data?.orphans ?? [];
  const stale = families.reduce((n, f) => n + f.staleConsumers, 0);
  const selected = families.find((f) => f.family === selectedFamily) ?? null;

  const title =
    families.length === 0 ? (
      <>
        Secrets, <em>sealed</em>.
      </>
    ) : stale > 0 ? (
      <>
        {stale} service{stale === 1 ? '' : 's'} on <em>old</em> secrets.
      </>
    ) : (
      <>
        {families.length} secret{families.length === 1 ? '' : 's'} — all <em>current</em>.
      </>
    );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Governance · Secrets"
        title={title}
        description="Versioned Docker secrets with one-click rotation. swarmy tracks which services read each one and restarts them onto new versions — values are write-only, forever."
        actions={<CreateSecretDialog />}
      />

      {secrets.isLoading ? (
        <div className="card-pop space-y-3 p-5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="shimmer-line h-12 rounded-lg" />
          ))}
        </div>
      ) : secrets.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<LockKeyholeIcon />}
            title="Couldn't load secrets"
            description={secrets.error.message}
            action={
              <Button variant="outline" onClick={() => void secrets.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : families.length === 0 ? (
        <>
          <div className="card-pop p-2">
            <EmptyState
              icon={<LockKeyholeIcon />}
              title="No secrets yet — create one."
              description="Store a DATABASE_URL or API key as a versioned Docker secret, mount it into services at /run/secrets, and rotate it safely later — swarmy restarts every consumer for you."
              action={<CreateSecretDialog variant="outline" />}
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
