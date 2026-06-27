import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';
import { ZoneConfigCard } from '@/components/geo/zone-config-card';
import { ZonePreviewCard } from '@/components/geo/zone-preview-card';
import { NodeRegionsCard } from '@/components/geo/node-regions-card';
import { RecordsList } from '@/components/geo/records-list';
import { AddRecordDialog } from '@/components/geo/add-record-dialog';
import { TemplatesGallery } from '@/components/geo/templates-gallery';

export const Route = createFileRoute('/_authed/geo')({
  component: GeoPage,
});

function GeoPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const config = useQuery(trpc.geodns.getConfig.queryOptions());
  const records = useQuery(trpc.geodns.listRecords.queryOptions());
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  const preview = useQuery({
    ...trpc.geodns.previewZone.queryOptions(),
    enabled: !!config.data?.enabled,
  });

  const invalidate = (): void => {
    void qc.invalidateQueries();
  };

  const enabled = !!config.data?.enabled;
  const recordCount = records.data?.length ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Geo-DNS"
        title={
          recordCount > 0 ? (
            <>
              <CountUp value={recordCount} /> record{recordCount === 1 ? '' : 's'}{' '}
              <em>steered</em>.
            </>
          ) : (
            <>
              Closest healthy region, <em>always</em>.
            </>
          )
        }
        description="Authoritative Geo-DNS (CoreDNS) routes each visitor to the nearest healthy regional ingress — and drains away from a region that goes dark."
        actions={
          <>
            <StatusBadge
              tone={enabled ? 'online' : 'neutral'}
              label={enabled ? 'CoreDNS · live' : 'Off'}
            />
            <AddRecordDialog onDone={invalidate} />
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <ZoneConfigCard
          enabled={enabled}
          initialZone={config.data?.zone ?? ''}
          initialTtl={config.data?.ttl ?? 30}
          onChange={invalidate}
        />
        <ZonePreviewCard enabled={enabled} preview={preview.data} />
      </div>

      <NodeRegionsCard nodes={nodes.data ?? []} onChange={invalidate} />
      <RecordsList records={records.data ?? []} onChange={invalidate} />
      <TemplatesGallery />
    </div>
  );
}
