import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArchiveIcon } from 'lucide-react';
import { Section, SectionLink } from '@/components/calm';
import { EmptyState } from '@/components/states';
import type { AttachTarget } from '@/components/buckets/attach-preview';
import { REACH_LABEL, REACH_TONE, RING_LABELS, placeOnRings, type ReachMode } from '@/components/buckets/reach-model';
import { ReachRings } from '@/components/buckets/reach-rings';
import { BucketReachDetail } from './bucket-reach-detail';
import type { DataBoard } from './use-data-board';

/**
 * "Who can reach each bucket": every bucket on its ring (inside swarmy ·
 * private network · internet). Pick one to change it in place; drag one onto
 * an app to attach it.
 */
export function BucketReachPanel({ d, onAttach }: { d: DataBoard; onAttach: (t: AttachTarget) => void }): React.JSX.Element {
  const store = d.bucketStore;
  const buckets = store?.buckets ?? [];
  const [sel, setSel] = React.useState<string | null>(null);
  const cur = buckets.find((b) => b.id === sel) ?? buckets[0];
  const loaded = buckets.filter((b) => d.reach.has(b.id));
  const placed = placeOnRings(loaded, (b) => d.reach.get(b.id)!.mode as ReachMode);

  return (
    <Section
      title="Who can reach each bucket"
      action={
        <Link to="/data/buckets">
          <SectionLink>All buckets →</SectionLink>
        </Link>
      }
    >
      {store?.state !== 'ready' ? (
        <p className="text-muted-foreground text-[13px]">
          File storage is {store?.state === 'unreachable' ? 'not answering' : 'off'}.{' '}
          <Link to="/data/buckets" className="text-foreground underline-offset-2 hover:underline">
            See why
          </Link>
          .
        </p>
      ) : buckets.length === 0 ? (
        <EmptyState icon={<ArchiveIcon />} title="No buckets yet" description="Make one on Files & buckets, then drop it on an app here." />
      ) : (
        <>
          {loaded.length === 0 ? (
            <div className="shimmer-line mx-auto aspect-square w-full max-w-[400px] rounded-full" aria-hidden />
          ) : (
            <ReachRings
              labels={RING_LABELS}
              chips={placed.map(({ item: b, ring, left, top }) => ({
                key: b.id,
                label: b.name,
                left,
                top,
                tone: REACH_TONE[ring],
                selected: b.id === cur?.id,
                aria: `${b.name}: ${REACH_LABEL[ring].toLowerCase()}`,
                onSelect: () => setSel(b.id),
                dragBucketId: b.id,
              }))}
            />
          )}
          <div className="bg-border h-px" />
          {cur ? <BucketReachDetail d={d} bucket={cur} onAttach={onAttach} /> : null}
        </>
      )}
    </Section>
  );
}
