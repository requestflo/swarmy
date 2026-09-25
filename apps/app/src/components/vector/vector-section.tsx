import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { VectorProvisionResult } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { SecretRevealBanner } from '@/components/cache/secret-reveal-banner';
import { PgvectorSection } from './pgvector-section';
import { VectorProvisionForm } from './vector-provision-form';
import { VectorRow, VectorSummaryRow } from './vector-row';
import { ManagedServiceSection } from '@/components/stack-data/managed-service-section';

/**
 * Vector section of the stack Data tab: this stack's managed qdrant instances
 * as flat rows (row-expand for detail), an inline provision card (Collapsible
 * — never a modal), the reveal-once key banner, and pgvector enablement for
 * the stack's managed Postgres clusters.
 */
export function VectorSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [result, setResult] = React.useState<VectorProvisionResult | null>(null);

  const instances = useQuery({
    ...trpc.vector.list.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const rows = instances.data ?? [];

  return (
    <ManagedServiceSection
      title="Vector stores"
      count={rows.length}
      newLabel="New vector store"
      renderForm={(done) => (
        <VectorProvisionForm
          stack={stack}
          onProvisioned={(r) => {
            setResult(r);
            done();
          }}
        />
      )}
      banner={
        result ? (
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
        ) : null
      }
      loading={instances.isLoading}
      error={instances.error?.message ?? null}
      onRetry={() => void instances.refetch()}
      empty={`No vector store in ${stack} yet. Provision Qdrant, or turn pgvector on inside a Postgres database below.`}
      summaryRows={rows.map((v) => (
        <VectorSummaryRow key={`${v.stack}/${v.name}`} view={v} />
      ))}
      controlRows={rows.map((v) => (
        <VectorRow key={`${v.stack}/${v.name}`} view={v} />
      ))}
      footer={<PgvectorSection stack={stack} />}
    />
  );
}
