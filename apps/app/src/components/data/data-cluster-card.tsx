import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { TONE_DOT } from '@/components/calm';
import { BUCKET_DRAG_TYPE } from '@/components/buckets/reach-rings';
import type { ReachMode } from '@/components/buckets/reach-model';
import type { AppCluster } from './data-board-model';
import { DataNode, NODE_H } from './data-node';

/**
 * One app as a cluster: a hub with the app's name and services, a curve to
 * each thing it keeps. A real app is a drop target — drop a bucket on it to
 * preview attaching (the preview renders as `children`, inside the card).
 */
export function DataClusterCard({
  cluster: c,
  reachOf,
  onDropBucket,
  children,
}: {
  cluster: AppCluster;
  reachOf: (bucketId: string | undefined) => ReachMode | undefined;
  onDropBucket: (bucketId: string, app: string) => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [over, setOver] = React.useState(0);
  const accepts = (e: React.DragEvent): boolean => c.droppable && e.dataTransfer.types.includes(BUCKET_DRAG_TYPE);
  const n = c.items.length;
  const h = n * NODE_H;
  return (
    <section
      aria-label={c.label}
      onDragEnter={(e) => accepts(e) && setOver((v) => v + 1)}
      onDragLeave={(e) => accepts(e) && setOver((v) => Math.max(0, v - 1))}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
      }}
      onDrop={(e) => {
        setOver(0);
        const id = e.dataTransfer.getData(BUCKET_DRAG_TYPE);
        if (!c.droppable || !id) return;
        e.preventDefault();
        onDropBucket(id, c.app);
      }}
      className={cn(
        'calm-card relative flex min-w-0 flex-col gap-2 overflow-hidden px-4 pt-3.5 pb-3 transition-shadow',
        'bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:22px_22px]',
        over > 0 && 'border-primary border-dashed shadow-[0_0_0_6px_color-mix(in_oklch,var(--primary)_10%,transparent)]',
      )}
    >
      <header className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span aria-hidden className={cn('size-2 shrink-0 self-center rounded-full', TONE_DOT[c.tone], c.tone !== 'ok' && 'motion-safe:animate-pulse')} />
        {c.droppable ? (
          <Link to="/stacks/$name/data" params={{ name: c.app }} className="text-[14px] font-bold hover:underline">
            {c.label}
          </Link>
        ) : (
          <span className="text-[14px] font-bold">{c.label}</span>
        )}
        <span className="text-muted-foreground font-mono text-[11px]">{c.total}</span>
      </header>
      {n === 0 ? (
        <p className="text-muted-foreground py-3 text-[13px]">
          Keeps nothing yet. Drop a bucket here, or add a database in its{' '}
          <Link to="/stacks/$name/data" params={{ name: c.app }} className="text-foreground underline-offset-2 hover:underline">
            Data tab
          </Link>
          .
        </p>
      ) : (
        <div className="flex min-w-0 items-center">
          {c.droppable ? (
            <div className="bg-muted/60 border-border flex size-16 shrink-0 flex-col items-center justify-center rounded-full border text-center">
              <span className="max-w-[56px] truncate text-[11.5px] font-bold">{c.app}</span>
              {c.services !== undefined ? (
                <span className="text-muted-foreground font-mono text-[9.5px]">
                  {c.services} service{c.services === 1 ? '' : 's'}
                </span>
              ) : null}
            </div>
          ) : null}
          {c.droppable ? (
            <svg width="28" height={h} viewBox={`0 0 28 ${h}`} aria-hidden className="shrink-0">
              {c.items.map((it, i) => {
                const y = i * NODE_H + NODE_H / 2;
                return <path key={it.key} d={`M0 ${h / 2} C14 ${h / 2} 14 ${y} 28 ${y}`} fill="none" strokeWidth="1.3" className="stroke-foreground/15" />;
              })}
            </svg>
          ) : null}
          <ul className="flex min-w-0 flex-1 flex-col" aria-label={`${c.label}: what it keeps`}>
            {c.items.map((it) => (
              <DataNode key={it.key} item={it} reach={reachOf(it.bucketId)} />
            ))}
          </ul>
        </div>
      )}
      {children}
    </section>
  );
}
