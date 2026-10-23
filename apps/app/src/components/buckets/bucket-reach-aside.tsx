import * as React from 'react';
import type { BucketDetailView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { Depth, Section } from '@/components/calm';
import { shortName } from './attach-plan';
import { BucketEndpoints } from './bucket-endpoints';
import { REACH_TONE, RING_LABELS, placeOnRings, reachSay, reachUrl, reaches, type ReachMode } from './reach-model';
import { ReachRings, type RingChip } from './reach-rings';
import { ReachSwitch } from './reach-switch';
import type { BucketAccessView } from './use-bucket-reach';

interface Who {
  name: string;
  ring: ReachMode;
}

/** Who sits on each ring: the services attached to it, the private network, the internet. */
function whoFor(b: BucketDetailView): Who[] {
  const inside = b.attachments.length
    ? b.attachments.map((a) => ({ name: shortName(a.stack, a.service), ring: 'INTERNAL' as const }))
    : [{ name: 'your apps', ring: 'INTERNAL' as const }];
  return [...inside, { name: 'laptops & servers', ring: 'MESH' }, { name: 'anyone online', ring: 'PUBLIC' }];
}

/** "Who can reach it": the rings, the switch, what it means and the address it answers on. */
export function BucketReachAside({ bucket: b, access }: { bucket: BucketDetailView; access: BucketAccessView | undefined }): React.JSX.Element {
  const mode = access?.mode as ReachMode | undefined;
  const chips: RingChip[] = mode
    ? [
        ...placeOnRings(whoFor(b), (w) => w.ring).map(({ item: w, ring, left, top }) => ({
          key: `${ring}:${w.name}`,
          label: w.name,
          left,
          top,
          tone: REACH_TONE[ring],
          dim: !reaches(mode, ring),
        })),
        { key: 'bucket', label: b.name, left: 50, top: 50, tone: REACH_TONE[mode], selected: true },
      ]
    : [];
  return (
    <Section title="Who can reach it" action={access ? <ReachSwitch view={access} /> : null}>
      {access && mode ? (
        <>
          <ReachRings labels={RING_LABELS} chips={chips} highlight={mode} />
          <p className={cn('text-[13px] leading-relaxed', mode === 'PUBLIC' ? 'text-tone-warn' : 'text-muted-foreground')}>{reachSay(mode)}</p>
          <code className="calm-code block truncate px-3 py-2 text-[11.5px]">{reachUrl(access.endpoints)}</code>
          <Depth at="controls">
            <BucketEndpoints access={access} />
          </Depth>
        </>
      ) : (
        <div className="shimmer-line mx-auto aspect-square w-full max-w-[400px] rounded-full" aria-hidden />
      )}
    </Section>
  );
}
