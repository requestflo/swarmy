import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlertIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { ExposureRulesCard } from './exposure-rules-card';
import { ExposureTable } from './exposure-table';
import { ExposureViolations } from './exposure-violations';

/**
 * Network → Exposure: the public/private/managed audit of every service,
 * the rules card ("Block violating deploys") and the live violations feed.
 */
export function ExposurePage(): React.JSX.Element {
  const trpc = useTRPC();

  const overview = useQuery({
    ...trpc.exposure.overview.queryOptions(),
    refetchInterval: 10_000,
  });
  const violations = useQuery({
    ...trpc.exposure.violations.queryOptions(),
    refetchInterval: 15_000,
  });

  const rows = overview.data?.rows ?? [];
  const counts = overview.data?.counts ?? { public: 0, private: 0, managed: 0 };
  const vio = violations.data ?? [];
  const violatingIds = new Set(vio.map((v) => v.serviceId));

  const title =
    rows.length === 0 ? (
      <>
        What's <em>exposed</em>?
      </>
    ) : vio.length > 0 ? (
      <>
        {vio.length} exposure violation{vio.length === 1 ? '' : 's'} need <em>you</em>.
      </>
    ) : (
      <>
        {counts.public} public, {counts.private + counts.managed} <em>sealed</em>.
      </>
    );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <SectionHeader
        section="Governance"
        title={title}
        description="Every service, audited: what faces the internet (domains and published ports), what stays private, and what your rules say about it."
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="min-w-0">
          {overview.isLoading ? (
            <div className="card-pop space-y-3 p-5">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="shimmer-line h-12 rounded-lg" />
              ))}
            </div>
          ) : overview.isError ? (
            <div className="card-pop p-2">
              <EmptyState
                icon={<ShieldAlertIcon />}
                title="Couldn't run the audit"
                description={overview.error.message}
                action={
                  <Button variant="outline" onClick={() => void overview.refetch()}>
                    Retry
                  </Button>
                }
              />
            </div>
          ) : rows.length === 0 ? (
            <div className="card-pop p-2">
              <EmptyState
                icon={<ShieldAlertIcon />}
                title="Nothing running yet"
                description="Deploy a service and swarmy audits its published ports, domains and managed-data posture — verdicts land here."
              />
            </div>
          ) : (
            <ExposureTable rows={rows} violatingIds={violatingIds} />
          )}
        </div>

        <div className="space-y-6">
          <ExposureViolations violations={vio} isLoading={violations.isLoading} />
          <ExposureRulesCard />
        </div>
      </div>
    </div>
  );
}
