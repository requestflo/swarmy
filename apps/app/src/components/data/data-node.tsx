import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { TONE_TEXT } from '@/components/calm';
import { BUCKET_DRAG_TYPE } from '@/components/buckets/reach-rings';
import { REACH_LABEL, type ReachMode } from '@/components/buckets/reach-model';
import type { DataItem } from './estate-data';

/** Row height of a data node — the cluster's curves are drawn to it. */
export const NODE_H = 52;

/**
 * One typed data node: the badge (PG · KV · S3 …), its name and a short
 * line. Opens the app's Data tab, or the bucket's page; buckets can be
 * dragged onto another app.
 */
export function DataNode({ item, reach }: { item: DataItem; reach?: ReachMode }): React.JSX.Element {
  const loud = item.tone === 'warn' || item.tone === 'bad';
  const meta = item.kind === 'Bucket' && reach ? `${item.meta} · ${REACH_LABEL[reach].toLowerCase()}` : item.meta;
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          'bg-background flex size-10 shrink-0 items-center justify-center rounded-xl border font-mono text-[11px] font-semibold',
          loud ? cn('border-current', TONE_TEXT[item.tone]) : 'border-border text-foreground/80',
        )}
      >
        {item.badge}
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span className="truncate text-[13px] font-semibold">{item.name}</span>
        <span className={cn('truncate font-mono text-[10.5px]', loud ? TONE_TEXT[item.tone] : 'text-muted-foreground')}>{meta}</span>
      </span>
    </>
  );
  const cls =
    'flex min-w-0 items-center gap-2.5 rounded-lg pr-2 outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring/50';
  const label = `${item.name}, ${item.kind === 'Compose' ? 'from compose' : item.kind}: ${item.say}`;
  return (
    <li className="flex items-center" style={{ height: NODE_H }}>
      {item.kind === 'Bucket' ? (
        <Link
          to="/data/buckets/$name"
          params={{ name: item.name }}
          aria-label={label}
          className={cn(cls, 'cursor-grab active:cursor-grabbing')}
          draggable={Boolean(item.bucketId)}
          onDragStart={(e) => {
            if (!item.bucketId) return;
            e.dataTransfer.setData(BUCKET_DRAG_TYPE, item.bucketId);
            e.dataTransfer.effectAllowed = 'link';
          }}
        >
          {body}
        </Link>
      ) : item.kind === 'Compose' ? (
        <Link to="/stacks/$name/studio" params={{ name: item.app }} search={{ db: item.name }} aria-label={label} className={cls}>
          {body}
        </Link>
      ) : (
        <Link to="/stacks/$name/data" params={{ name: item.app }} aria-label={label} className={cls}>
          {body}
        </Link>
      )}
    </li>
  );
}
