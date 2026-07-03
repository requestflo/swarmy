import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { BoxIcon, PlusIcon } from 'lucide-react';
import type { VectorProvisionResult } from '@swarmy/core';
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
import { PgvectorSection } from './pgvector-section';
import { VectorProvisionForm } from './vector-provision-form';
import { VectorRow } from './vector-row';

/**
 * Vector section of the stack Data tab: this stack's managed qdrant instances
 * as flat rows (row-expand for detail), an inline provision card (Collapsible
 * — never a modal), the reveal-once key banner, and pgvector enablement for
 * the stack's managed Postgres clusters.
 */
export function VectorSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [creating, setCreating] = React.useState(false);
  const [result, setResult] = React.useState<VectorProvisionResult | null>(null);

  const instances = useQuery({
    ...trpc.vector.list.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const rows = instances.data ?? [];

  return (
    <Card className="card-pop border-0">
      <CardContent className="space-y-4 p-6">
        <Collapsible open={creating} onOpenChange={setCreating}>
          <div className="flex flex-wrap items-center gap-3">
            <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
              <BoxIcon className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold leading-tight">Vector stores</h3>
              <p className="text-muted-foreground mono-label !mb-0">
                Qdrant / pgvector · API key in a Docker secret
              </p>
            </div>
            <CollapsibleTrigger asChild>
              <Button variant="outline" className="shrink-0">
                <PlusIcon className="size-4" /> New vector store
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div className="border-border bg-muted/20 mt-4 rounded-lg border p-4">
              <VectorProvisionForm
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
            title={`Qdrant ${result.name} is provisioning.`}
            description={
              <>
                Save the API key now — it lives only in the Docker secret{' '}
                <code className="mono-data">{result.keySecret}</code> and can&apos;t be shown
                again. Attached apps read it from the secret file automatically.
              </>
            }
            secret={result.apiKey}
            endpoint={result.url}
            onDismiss={() => setResult(null)}
          />
        ) : null}

        {instances.isLoading ? (
          <div className="space-y-2">
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
            icon={<BoxIcon />}
            title={`No vector stores in ${stack} yet — create one.`}
            description="One click provisions Qdrant on this stack: private-only, key in a Docker secret, volume-backed storage. Attach an app and it gets QDRANT_URL automatically — or flip pgvector on below."
            action={
              <Button variant="outline" onClick={() => setCreating(true)}>
                <PlusIcon className="size-4" /> Provision a vector store
              </Button>
            }
          />
        ) : (
          <div className="divide-border divide-y">
            {rows.map((v) => (
              <VectorRow key={`${v.stack}/${v.name}`} view={v} />
            ))}
          </div>
        )}

        <PgvectorSection stack={stack} />
      </CardContent>
    </Card>
  );
}
