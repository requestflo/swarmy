import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NodeSummary } from '@swarmy/core';
import { CalmRow, Section } from '@/components/calm';
import { fmtBytes } from '@/components/buckets/format';
import { useTRPC } from '@/integrations/trpc';
import { RowsSkeleton } from '../tab-body';
import type { PlacedService } from '../scaling/use-app-placement';
import { MakeDurable } from './make-durable';
import { useAppBuckets } from './use-app-buckets';
import { LinkButton, VolumeLine } from './volume-line';
import { volumeRows } from './volume-model';
import { volumeSize } from './volume-size';

const and = (xs: string[]): string => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/**
 * Volumes (board AppPlacement): data on disk stays on its server, buckets
 * replicate instead. Each named volume says its size and server, as the
 * agents measured them (`nodes.volumeSizes`); pinned data moves with "Move…"
 * (the Servers move flow), a bucket opens its page, a throwaway volume can be
 * made durable.
 */
export function VolumesSection({ stack, rows, nodes }: { stack: string; rows: PlacedService[]; nodes: NodeSummary[] }): React.JSX.Element {
  const vols = React.useMemo(() => volumeRows(stack, rows, nodes), [stack, rows, nodes]);
  const { buckets, copies, servers } = useAppBuckets(stack);
  const trpc = useTRPC();
  const sizesQ = useQuery({ ...trpc.nodes.volumeSizes.queryOptions(), refetchInterval: 60_000 });
  // A failed read is "size not reported" for every volume, never a zero.
  const reports = sizesQ.data ?? (sizesQ.isError ? [] : undefined);
  const [durable, setDurable] = React.useState<string | null>(null);
  const count = vols.length + (buckets?.length ?? 0);
  return (
    <Section title="Volumes" count={buckets ? count : undefined} hint="data on disk stays on its server; buckets replicate instead" flush>
      {buckets === undefined || reports === undefined ? (
        <RowsSkeleton rows={2} />
      ) : count === 0 ? (
        <p className="text-muted-foreground px-1 py-3 text-[13.5px]">Nothing here keeps files. Every copy starts clean, so any server can run it.</p>
      ) : (
        <div className="flex flex-col">
          {vols.map((v) => (
            <React.Fragment key={v.key}>
              <VolumeLine v={v} size={volumeSize(v, reports, nodes)} onDurable={() => setDurable(v.key)} />
              {durable === v.key ? <MakeDurable stack={stack} row={v} svc={rows.find((r) => r.inv.id === v.serviceId)!} onDone={() => setDurable(null)} /> : null}
            </React.Fragment>
          ))}
          {buckets.map(({ bucket, parts }) => (
            <CalmRow
              key={bucket.id}
              tone="ok"
              name={bucket.name}
              sub={`bucket · used by ${parts.join(', ')}`}
              say={`${fmtBytes(bucket.usageBytes)}${copies ? `, ${copies} ${copies === 1 ? 'copy' : 'copies'} of every file` : ''}${servers?.length ? ` on ${and(servers)}` : ''}: any server can read it.`}
              tech={`${bucket.objects.toLocaleString()} objects · S3_* attached to ${parts.join(', ')}`}
              word={copies && copies > 1 ? 'Replicated' : 'One copy'}
              wordTone={copies && copies > 1 ? 'ok' : 'warn'}
              trailing={<LinkButton to="/data/buckets/$name" params={{ name: bucket.name }} label="Open" />}
            />
          ))}
        </div>
      )}
    </Section>
  );
}
