import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CacheProvisionResult } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { CacheProvisionForm } from './cache-provision-form';
import { CacheRow, CacheSummaryRow } from './cache-row';
import { ManagedServiceSection } from '@/components/stack-data/managed-service-section';
import { SecretRevealBanner } from './secret-reveal-banner';

/**
 * Caches section of the stack Data tab: this stack's managed Valkey/Redis
 * clusters as flat rows (row-expand for detail), an inline provision card
 * (Collapsible — never a modal) and the reveal-once password banner.
 */
export function CacheSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [result, setResult] = React.useState<CacheProvisionResult | null>(null);

  const clusters = useQuery({
    ...trpc.cache.list.queryOptions({ stack }),
    refetchInterval: 5_000,
  });
  const rows = clusters.data ?? [];

  return (
    <ManagedServiceSection
      title="Caches"
      count={rows.length}
      newLabel="New cache"
      renderForm={(done) => (
        <CacheProvisionForm
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
        ) : null
      }
      loading={clusters.isLoading}
      error={clusters.error?.message ?? null}
      onRetry={() => void clusters.refetch()}
      empty={`No caches in ${stack} yet. One click deploys Valkey or Redis, password in a Docker secret, REDIS_URL wired into the apps you attach.`}
      summaryRows={rows.map((c) => (
        <CacheSummaryRow key={`${c.stack}/${c.name}`} view={c} />
      ))}
      controlRows={rows.map((c) => (
        <CacheRow key={`${c.stack}/${c.name}`} view={c} />
      ))}
    />
  );
}
