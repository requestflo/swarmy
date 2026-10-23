import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { BucketSummaryView } from '@swarmy/core';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from '@swarmy/ui';
import { SectionLink, Tech } from '@/components/calm';
import type { AttachTarget } from '@/components/buckets/attach-preview';
import { permWord } from '@/components/buckets/bucket-facts';
import { fmtBytes } from '@/components/buckets/format';
import { reachSay, reachUrl, type ReachMode } from '@/components/buckets/reach-model';
import { ReachSwitch } from '@/components/buckets/reach-switch';
import { SHARED } from './data-board-model';
import type { DataBoard } from './use-data-board';

/** The picked bucket: the switch and what it means, its address, and a keyboard way to attach it. */
export function BucketReachDetail({
  d,
  bucket: b,
  onAttach,
}: {
  d: DataBoard;
  bucket: BucketSummaryView;
  onAttach: (t: AttachTarget) => void;
}): React.JSX.Element {
  const view = d.reach.get(b.id);
  const mode = view?.mode as ReachMode | undefined;
  const owner = d.items.find((i) => i.bucketId === b.id)?.app;
  const detail = d.bucketDetails[(d.bucketStore?.buckets ?? []).findIndex((x) => x.id === b.id)];
  const used = detail?.attachments.map((a) => `${a.stack}/${a.service} (${permWord(detail.keys.find((k) => k.accessKeyId === a.accessKeyId)?.permissions)})`);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[15px] font-semibold">{b.name}</span>
        <span className="text-muted-foreground font-mono text-[11.5px]">
          {fmtBytes(b.usageBytes)} · {owner && owner !== SHARED ? `used by ${owner}` : 'not attached yet'}
        </span>
      </div>
      {view && mode ? (
        <>
          <ReachSwitch view={view} />
          <p className={cn('text-[13px] leading-relaxed', mode === 'PUBLIC' ? 'text-tone-warn' : 'text-muted-foreground')}>{reachSay(mode)}</p>
          <code className="calm-code block truncate px-3 py-2 text-[11.5px]">{reachUrl(view.endpoints)}</code>
        </>
      ) : (
        <div className="shimmer-line h-24 rounded-lg" aria-hidden />
      )}
      <Tech>
        keys: {b.keyCount}
        {used?.length ? ` · ${used.join(', ')}` : ''} · copies: {d.copies}
      </Tech>
      <div className="flex flex-wrap items-center gap-2">
        <Select value="" onValueChange={(app) => onAttach({ bucketId: b.id, bucket: b.name, app })}>
          <SelectTrigger className="h-8 w-auto min-w-40 text-[13px] pointer-coarse:min-h-11" aria-label={`Attach ${b.name} to an app`}>
            <SelectValue placeholder="Attach to an app…" />
          </SelectTrigger>
          <SelectContent>
            {d.apps.map((app) => (
              <SelectItem key={app} value={app}>
                {app}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Link to="/data/buckets/$name" params={{ name: b.name }} className="ml-auto">
          <SectionLink>open bucket →</SectionLink>
        </Link>
      </div>
    </div>
  );
}
