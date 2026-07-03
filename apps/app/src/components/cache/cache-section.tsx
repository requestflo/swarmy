import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, ZapIcon } from 'lucide-react';
import type { CacheProvisionResult } from '@swarmy/core';
import {
  Button,
  Card,
  CardContent,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EmptyState,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CacheProvisionForm } from './cache-provision-form';
import { CacheRow } from './cache-row';
import { SecretRevealBanner } from './secret-reveal-banner';

/**
 * Caches section of the stack Data tab: this stack's managed Valkey/Redis
 * clusters as flat rows (row-expand for detail), an inline provision card
 * (Collapsible — never a modal) and the reveal-once password banner.
 */
export function CacheSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [creating, setCreating] = React.useState(false);
  const [result, setResult] = React.useState<CacheProvisionResult | null>(null);

  const clusters = useQuery({
    ...trpc.cache.list.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const rows = clusters.data ?? [];

  return (
    <Card className="card-pop border-0">
      <CardContent className="space-y-4 p-6">
        <Collapsible open={creating} onOpenChange={setCreating}>
          <div className="flex flex-wrap items-center gap-3">
            <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
              <ZapIcon className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold leading-tight">Caches</h3>
              <p className="text-muted-foreground mono-label !mb-0">
                Valkey / Redis · private by default · password in a Docker secret
              </p>
            </div>
            <CollapsibleTrigger asChild>
              <Button variant="outline" className="shrink-0">
                <PlusIcon className="size-4" /> New cache
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div className="border-border bg-muted/20 mt-4 rounded-lg border p-4">
              <CacheProvisionForm
                stack={stack}
                onProvisioned={(r) => {
                  setResult(r);
                  setCreating(false);
                }}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>

        {result ? (
          <SecretRevealBanner
            title={`Cache ${result.cluster} is provisioning.`}
            description={
              <>
                Save the password now — it lives only in the Docker secret{' '}
                <code className="mono-data">{result.passwordSecret}</code> and can&apos;t be shown
                again. Attached apps read it from the secret file automatically.
              </>
            }
            secret={result.password}
            endpoint={`redis://${result.host}:${result.port}`}
            onDismiss={() => setResult(null)}
          />
        ) : null}

        {clusters.isLoading ? (
          <div className="space-y-2">
            <div className="shimmer-line h-12 rounded-lg" />
            <div className="shimmer-line h-12 rounded-lg" />
          </div>
        ) : clusters.isError ? (
          <div className="flex flex-wrap items-center gap-3 py-2">
            <p className="text-status-offline text-sm">{clusters.error.message}</p>
            <Button variant="outline" size="sm" onClick={() => void clusters.refetch()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<ZapIcon />}
            title={`No caches in ${stack} yet — provision one.`}
            description="One click deploys Valkey or Redis on this stack's swarm: single node to sentinel HA, password in a Docker secret, and attached apps get REDIS_URL wired automatically."
            action={
              <Button variant="outline" onClick={() => setCreating(true)}>
                <PlusIcon className="size-4" /> Provision a cache
              </Button>
            }
          />
        ) : (
          <div className="divide-border divide-y">
            {rows.map((c) => (
              <CacheRow key={`${c.stack}/${c.name}`} view={c} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
