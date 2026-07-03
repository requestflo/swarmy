import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { RecordsList } from './records-list';
import { TemplatesGallery } from './templates-gallery';

interface StackGeoSectionProps {
  stack: string;
}

/** Geo-DNS section for this stack's Network tab: records, health, HA templates. */
export function StackGeoSection({ stack }: StackGeoSectionProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const records = useQuery({ ...trpc.geodns.listRecords.queryOptions({ stack }), refetchInterval: 5000 });

  return (
    <section className="space-y-4">
      <h2 className="headline text-xl">
        Geo-<em>DNS</em>
      </h2>
      <RecordsList records={records.data ?? []} onChange={() => void qc.invalidateQueries()} />
      <TemplatesGallery />
    </section>
  );
}
