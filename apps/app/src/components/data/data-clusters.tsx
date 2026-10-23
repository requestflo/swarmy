import * as React from 'react';
import { Section, Tech } from '@/components/calm';
import { AttachPreview, type AttachTarget } from '@/components/buckets/attach-preview';
import { attachCandidates } from '@/components/buckets/attach-plan';
import type { ReachMode } from '@/components/buckets/reach-model';
import { fmtBytes } from '@/components/buckets/format';
import { fileBytes } from './data-board-model';
import { DataClusterCard } from './data-cluster-card';
import { storeCount } from './estate-data';
import type { DataBoard } from './use-data-board';

/**
 * "Your data, by app": one cluster per app with typed data nodes. Drop a
 * bucket on an app (or pick one under the bucket, for keyboards) to see the
 * variables swarmy would add before anything changes.
 */
export function DataClusters({
  d,
  target,
  onTarget,
}: {
  d: DataBoard;
  target: AttachTarget | null;
  onTarget: (t: AttachTarget | null) => void;
}): React.JSX.Element {
  const buckets = d.bucketStore?.buckets ?? [];
  const bytes = fileBytes(d.items);
  const reachOf = (id: string | undefined): ReachMode | undefined => (id ? (d.reach.get(id)?.mode as ReachMode | undefined) : undefined);
  const drop = (bucketId: string, app: string): void => {
    const b = buckets.find((x) => x.id === bucketId);
    if (b) onTarget({ bucketId, bucket: b.name, app });
  };
  return (
    <Section
      title="Your data, by app"
      count={`${storeCount(d.items) || 'nothing yet'}${bytes ? ` · ${fmtBytes(bytes)} of files` : ''}`}
      hint={d.storeServers ? <Tech>garage on {d.storeServers} server{d.storeServers === 1 ? '' : 's'}</Tech> : undefined}
    >
      <div className="grid gap-3 md:grid-cols-2">
        {d.clusters.map((c) => (
          <DataClusterCard key={c.app} cluster={c} reachOf={reachOf} onDropBucket={drop}>
            {target && target.app === c.app ? (
              <AttachPreview
                key={`${target.bucketId}:${target.app}`}
                target={target}
                candidates={attachCandidates(c.app, d.services, d.attachedTo)}
                endpoint={d.bucketStore?.endpoint ?? null}
                region={d.bucketStore?.region ?? 'swarmy'}
                onClose={() => onTarget(null)}
                className="mt-1"
              />
            ) : null}
          </DataClusterCard>
        ))}
      </div>
      {buckets.length > 0 ? (
        <p className="text-muted-foreground hidden font-mono text-[11px] pointer-fine:block">
          Drag a bucket onto an app to attach it · or pick an app under “Who can reach each bucket”
        </p>
      ) : null}
    </Section>
  );
}
