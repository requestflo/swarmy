import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { Depth, Section } from '@/components/calm';
import { ErrorState } from '@/components/states';
import { RowsSkeleton } from '@/components/app-tabs/tab-body';
import { useTRPC } from '@/integrations/trpc';
import { CreateSecretCard } from './create-secret-card';
import { OrphansCard } from './orphans-card';
import { SecretRevealBanner, type RevealedSecret } from './secret-reveal-banner';
import { SecretRow } from './secret-row';

interface StackSecretsSectionProps {
  stack: string;
  /** Lifted so the page's own action can open the create card. */
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}

/**
 * The app's secrets as one quiet section: a row per secret (who reads it, when
 * it last changed), expand for rotate / attach / versions. Values are
 * write-only. Unmanaged Docker secrets show from Controls up.
 */
export function StackSecretsSection({ stack, createOpen, onCreateOpenChange }: StackSecretsSectionProps): React.JSX.Element {
  const trpc = useTRPC();
  const [revealed, setRevealed] = React.useState<RevealedSecret | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const secrets = useQuery({ ...trpc.secrets.list.queryOptions({ stack }), refetchInterval: 5_000 });
  const families = secrets.data?.families ?? [];

  return (
    <>
      {revealed ? <SecretRevealBanner revealed={revealed} onDismiss={() => setRevealed(null)} /> : null}
      <Section
        title="Secrets"
        count={secrets.data ? families.length : undefined}
        hint="write-only"
        flush
        action={
          <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => onCreateOpenChange(!createOpen)}>
            <PlusIcon className="size-3.5" /> Add a secret
          </Button>
        }
      >
        <CreateSecretCard stack={stack} open={createOpen} onOpenChange={onCreateOpenChange} onCreated={setRevealed} />
        {secrets.isPending ? (
          <RowsSkeleton />
        ) : secrets.isError ? (
          <ErrorState title="Couldn't load secrets" error={secrets.error} retry={() => void secrets.refetch()} />
        ) : families.length === 0 ? (
          <p className="text-muted-foreground py-3 text-[13.5px]">
            No secrets yet. Add one and swarmy hands it to your services as a file nobody can read back.
          </p>
        ) : (
          <ul aria-label="Secrets" className="flex flex-col">
            {families.map((f) => (
              <SecretRow
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
        <OrphansCard orphans={secrets.data?.orphans ?? []} />
      </Depth>
    </>
  );
}
