import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, SearchIcon } from 'lucide-react';
import type { SearchProvisionResult } from '@swarmy/core';
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
import { SecretRevealBanner } from '@/components/cache/secret-reveal-banner';
import { SearchProvisionForm } from './search-provision-form';
import { SearchRow } from './search-row';

/**
 * Search section of the stack Data tab: this stack's managed Meilisearch /
 * Typesense instances as flat rows (row-expand for detail), an inline
 * provision card (Collapsible — never a modal) and the reveal-once key banner.
 */
export function SearchSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [creating, setCreating] = React.useState(false);
  const [result, setResult] = React.useState<SearchProvisionResult | null>(null);

  const instances = useQuery({
    ...trpc.search.list.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const rows = instances.data ?? [];

  return (
    <Card className="card-pop border-0">
      <CardContent className="space-y-4 p-6">
        <Collapsible open={creating} onOpenChange={setCreating}>
          <div className="flex flex-wrap items-center gap-3">
            <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
              <SearchIcon className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold leading-tight">Search</h3>
              <p className="text-muted-foreground mono-label !mb-0">
                Meilisearch / Typesense · master key in a Docker secret
              </p>
            </div>
            <CollapsibleTrigger asChild>
              <Button variant="outline" className="shrink-0">
                <PlusIcon className="size-4" /> New search
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div className="border-border bg-muted/20 mt-4 rounded-lg border p-4">
              <SearchProvisionForm
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
            title={`Search instance ${result.name} is provisioning.`}
            description={
              <>
                Save the master key now — it lives only in the Docker secret{' '}
                <code className="mono-data">{result.keySecret}</code> and can&apos;t be shown
                again. Attached apps read it from the secret file automatically.
              </>
            }
            secret={result.masterKey}
            endpoint={result.url}
            onDismiss={() => setResult(null)}
          />
        ) : null}

        {instances.isLoading ? (
          <div className="space-y-2">
            <div className="shimmer-line h-12 rounded-lg" />
            <div className="shimmer-line h-12 rounded-lg" />
          </div>
        ) : instances.isError ? (
          <div className="flex flex-wrap items-center gap-3 py-2">
            <p className="text-status-offline text-sm">{instances.error.message}</p>
            <Button variant="outline" size="sm" onClick={() => void instances.refetch()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<SearchIcon />}
            title={`No search engines in ${stack} yet — create one.`}
            description="Instant, typo-tolerant search without running servers yourself: swarmy provisions Meilisearch or Typesense on this stack, keeps the master key in a Docker secret, and injects the connection into any app you attach."
            action={
              <Button variant="outline" onClick={() => setCreating(true)}>
                <PlusIcon className="size-4" /> Provision search
              </Button>
            }
          />
        ) : (
          <div className="divide-border divide-y">
            {rows.map((i) => (
              <SearchRow key={`${i.stack}/${i.name}`} view={i} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
