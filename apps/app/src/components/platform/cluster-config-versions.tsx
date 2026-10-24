import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { StatusWord } from '@/components/calm';
import { fmtBytes, relativeTime } from '@/components/backups/backup-format';
import { CardSkeleton, ErrorState } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { changeWords } from './cluster-config-words';
import { RevertConfigDialog } from './revert-config-dialog';

/** One document's retained versions, newest first, each older one with "Put back vN". */
export function ClusterConfigVersions({
  collection,
  id,
  label,
}: {
  collection: string;
  id: string;
  label: string;
}): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery(trpc.swarmKv.versions.queryOptions({ collection, id }));
  if (q.isPending) return <CardSkeleton lines={2} />;
  if (q.isError) return <ErrorState title="Couldn’t read its versions." error={q.error} retry={() => void q.refetch()} />;
  const current = q.data.find((v) => v.current)?.seq ?? 0;
  return (
    <ul aria-label={`Versions of ${label}`} className="border-border grid gap-1 border-b py-2 pl-6">
      {q.data.map((v) => (
        <li key={v.seq} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
          <span className="mono-data w-10 shrink-0 font-semibold">v{v.seq}</span>
          <span className="text-muted-foreground min-w-0 flex-1">
            {relativeTime(v.updatedAt)} · {fmtBytes(v.bytes)} · {v.current ? 'in use now' : changeWords(v.changes)}
          </span>
          {v.current ? (
            <StatusWord tone="ok" word="Current" />
          ) : (
            <RevertConfigDialog collection={collection} id={id} label={label} seq={v.seq} nextSeq={current + 1} changes={v.changes} />
          )}
        </li>
      ))}
    </ul>
  );
}
