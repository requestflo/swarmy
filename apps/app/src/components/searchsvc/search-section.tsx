import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SearchProvisionResult } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { SecretRevealBanner } from '@/components/cache/secret-reveal-banner';
import { SearchProvisionForm } from './search-provision-form';
import { SearchRow, SearchSummaryRow } from './search-row';
import { ManagedServiceSection } from '@/components/stack-data/managed-service-section';

/**
 * Search section of the stack Data tab: this stack's managed Meilisearch /
 * Typesense instances as flat rows (row-expand for detail), an inline
 * provision card (Collapsible — never a modal) and the reveal-once key banner.
 */
export function SearchSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [result, setResult] = React.useState<SearchProvisionResult | null>(null);

  const instances = useQuery({
    ...trpc.search.list.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const rows = instances.data ?? [];

  return (
    <ManagedServiceSection
      title="Search"
      count={rows.length}
      newLabel="New search"
      renderForm={(done) => (
        <SearchProvisionForm
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
        ) : null
      }
      loading={instances.isLoading}
      error={instances.error?.message ?? null}
      onRetry={() => void instances.refetch()}
      empty={`No search in ${stack} yet. swarmy can run Meilisearch or Typesense, master key in a Docker secret, host injected into the apps you attach.`}
      summaryRows={rows.map((i) => (
        <SearchSummaryRow key={`${i.stack}/${i.name}`} view={i} />
      ))}
      controlRows={rows.map((i) => (
        <SearchRow key={`${i.stack}/${i.name}`} view={i} />
      ))}
    />
  );
}
