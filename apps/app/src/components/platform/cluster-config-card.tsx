import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { RowList, Section } from '@/components/calm';
import { relativeTime } from '@/components/backups/backup-format';
import { LineRow } from '@/components/rowpage/line-row';
import { CardSkeleton, ErrorState } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { ClusterConfigVersions } from './cluster-config-versions';
import { configName, countWords, docLabel, sizeWords } from './cluster-config-words';

/**
 * Settings › Platform (Controls): swarmy's infra config held in the swarm
 * itself (swarm-kv documents in raft), each with its retained versions.
 * Values are never shown; an older version can be put back (admins, audited).
 */
export function ClusterConfigCard(): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.swarmKv.list.queryOptions(), refetchInterval: 60_000 });
  const [open, setOpen] = React.useState<string | null>(null);
  if (q.isPending) return <CardSkeleton lines={4} />;
  if (q.isError) return <ErrorState title="Couldn’t read the cluster config." error={q.error} retry={() => void q.refetch()} />;
  const v = q.data;

  return (
    <Section
      title="Cluster config versions"
      count={v.available ? countWords(v.docs) : undefined}
      hint={v.available ? `${sizeWords(v.footprintBytes, v.maxTotalBytes)} in the swarm` : undefined}
      flush
    >
      {!v.available ? (
        <p className="text-muted-foreground py-3 text-sm">Can’t read it right now: {v.reason}.</p>
      ) : v.docs.length === 0 ? (
        <p className="text-muted-foreground py-3 text-sm">
          Nothing stored yet. Settings such as backup destinations and the front door are kept here once you save them.
        </p>
      ) : (
        <RowList label="Cluster config documents">
          {v.docs.map((d) => {
            const key = `${d.collection}/${d.id}`;
            const isOpen = open === key;
            return (
              <React.Fragment key={key}>
                <LineRow
                  tone={d.bytes >= v.maxDocBytes * 0.75 ? 'warn' : 'ok'}
                  name={docLabel(d.collection, d.name)}
                  say={`v${d.seq}, changed ${relativeTime(d.updatedAt)} · ${d.versions.length} kept`}
                  tech={`${configName(d.collection, d.id, d.seq)} · ${sizeWords(d.bytes, v.maxDocBytes)}`}
                  trailing={
                    d.versions.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="pointer-coarse:min-h-11"
                        aria-expanded={isOpen}
                        onClick={() => setOpen(isOpen ? null : key)}
                      >
                        {isOpen ? 'Hide versions' : 'Versions'}
                      </Button>
                    ) : null
                  }
                />
                {isOpen ? <ClusterConfigVersions collection={d.collection} id={d.id} label={docLabel(d.collection, d.name)} /> : null}
              </React.Fragment>
            );
          })}
        </RowList>
      )}
    </Section>
  );
}
