import * as React from 'react';
import { Tech } from '@/components/calm';
import { TextSkeleton } from '@/components/states';
import { groupResources, peerAddresses, privateWords, type ManagedGroup } from './connections-model';
import type { StackEndpoints } from './types';

/** First few addresses, then "+N more". */
function few(list: string[], n = 4): string {
  return list.length > n ? `${list.slice(0, n).join(', ')} +${list.length - n} more` : list.join(', ');
}

/**
 * What connecting `app` and `peer` does, before you do it (or what it did,
 * once connected): one private network for exactly this pair, the names each
 * side types, what stays private, and the one rolling restart.
 */
export function LinkPreview({
  endpoints: e,
  groups,
  peer,
  theirs,
  theirsFailed,
  connected,
}: {
  endpoints: StackEndpoints;
  groups: ManagedGroup[];
  peer: string;
  theirs: StackEndpoints | undefined;
  theirsFailed: boolean;
  connected: boolean;
}): React.JSX.Element {
  const mine = peerAddresses(e);
  const back = theirs ? peerAddresses(theirs) : [];
  const total = theirs ? e.services.length + theirs.services.length : null;
  return (
    <div className="bg-surface-2 dark:bg-accent/60 flex flex-col gap-2 rounded-xl px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13.5px] font-semibold">
          {e.stack} ↔ {peer}
        </span>
        <span className={connected ? 'text-tone-ok text-xs font-semibold' : 'text-muted-foreground text-xs font-semibold'}>
          {connected ? 'Connected' : 'Preview'}
        </span>
      </div>
      <Change glyph="+">One private network for these two apps only. Every other app still can’t see either of them.</Change>
      <Change glyph="→">
        From {peer}: <span className="font-mono break-words">{mine.length ? few(mine) : `${e.stack} runs no services`}</span>
      </Change>
      <Change glyph="←">
        From {e.stack}:{' '}
        {theirs ? (
          <span className="font-mono break-words">{back.length ? few(back) : `${peer} runs no services`}</span>
        ) : theirsFailed ? (
          <span className="text-muted-foreground">{peer} isn’t running anything right now</span>
        ) : (
          <TextSkeleton className="inline-block h-3 w-40 align-middle" />
        )}
      </Change>
      <Change glyph="◌">
        Shares app services, never its databases.{' '}
        {theirs || theirsFailed || groups.length
          ? privateWords(e.stack, groups, peer, theirs ? groupResources(theirs.resources) : [])
          : null}
      </Change>
      <Change glyph="↻">
        {total === null ? 'Services' : `${total} service${total === 1 ? '' : 's'}`} of both apps restart once, rolling.
      </Change>
      <Tech>
        in swarmy.yaml: connect: [{peer}] · each service answers as {'<service>'}.{'<app>'} on the pair’s own overlay
      </Tech>
    </div>
  );
}

function Change({ glyph, children }: { glyph: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="flex items-start gap-2.5 text-[12.5px] leading-snug">
      <b aria-hidden className="text-tone-mesh w-3.5 shrink-0 font-mono text-[11px] leading-[1.6]">
        {glyph}
      </b>
      <span className="min-w-0">{children}</span>
    </p>
  );
}
