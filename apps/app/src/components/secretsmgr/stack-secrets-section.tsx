import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { LockKeyholeIcon, PlusIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CreateSecretCard } from './create-secret-card';
import { OrphansCard } from './orphans-card';
import { SecretRevealBanner, type RevealedSecret } from './secret-reveal-banner';
import { SecretRow } from './secret-row';

interface StackSecretsSectionProps {
  stack: string;
}

/**
 * Secrets scoped to this stack — one flat list, everything inline: create is
 * an expanding card, detail is a row-expand, rotate/delete are AlertDialogs.
 */
export function StackSecretsSection({ stack }: StackSecretsSectionProps): React.JSX.Element {
  const trpc = useTRPC();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [revealed, setRevealed] = React.useState<RevealedSecret | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const secrets = useQuery({
    ...trpc.secrets.list.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const families = secrets.data?.families ?? [];
  const stale = families.reduce((n, f) => n + f.staleConsumers, 0);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mono-label text-muted-foreground">Secrets</p>
          <h2 className="headline text-2xl">
            {families.length === 0 ? (
              <>
                Secrets, <em>sealed</em>.
              </>
            ) : stale > 0 ? (
              <>
                {stale} service{stale === 1 ? '' : 's'} on <em>old</em> secrets.
              </>
            ) : (
              <>
                {families.length} secret{families.length === 1 ? '' : 's'} — all{' '}
                <em>in sync</em>.
              </>
            )}
          </h2>
        </div>
        <Button onClick={() => setCreateOpen((o) => !o)}>
          <PlusIcon className="size-4" /> New secret
        </Button>
      </div>

      {revealed ? (
        <SecretRevealBanner revealed={revealed} onDismiss={() => setRevealed(null)} />
      ) : null}

      <CreateSecretCard
        stack={stack}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={setRevealed}
      />

      {secrets.isLoading ? (
        <div className="card-pop space-y-3 p-5">
          {[0, 1, 2].map((i) => (
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
        <div className="card-pop p-2">
          <EmptyState
            icon={<LockKeyholeIcon />}
            title="No secrets in this stack yet — create one."
            description="Versioned Docker secrets, mounted at /run/secrets and rotated with one click — swarmy restarts every consumer for you."
            action={
              <Button variant="outline" onClick={() => setCreateOpen(true)}>
                <PlusIcon className="size-4" /> New secret
              </Button>
            }
          />
        </div>
      ) : (
        <div className="card-pop divide-border divide-y overflow-hidden">
          {families.map((f) => (
            <SecretRow
              key={f.family}
              family={f}
              stack={stack}
              expanded={expanded === f.family}
              onToggle={() => setExpanded((e) => (e === f.family ? null : f.family))}
            />
          ))}
        </div>
      )}

      <OrphansCard orphans={secrets.data?.orphans ?? []} />
    </section>
  );
}
