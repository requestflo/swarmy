import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TONE_DOT, type Tone } from '@/components/calm';
import { RING_SHARE, type ReachMode } from './reach-model';

export interface RingChip {
  key: string;
  label: string;
  left: number;
  top: number;
  tone: Tone;
  /** Can't reach at the current mode: drawn faint with a ✕. */
  dim?: boolean;
  selected?: boolean;
  /** Accessible name for a button chip ("media, private network"). */
  aria?: string;
  onSelect?: () => void;
  /** Makes the chip draggable, carrying this bucket id. */
  dragBucketId?: string;
}

/** The drag payload a bucket chip carries and a drop target reads. */
export const BUCKET_DRAG_TYPE = 'application/x-swarmy-bucket';

const RING_VAR: Record<ReachMode, string> = { INTERNAL: '--tone-ok', MESH: '--tone-mesh', PUBLIC: '--tone-warn' };

/**
 * Three rings — inside swarmy, the private network, the internet — with chips
 * placed on them (buckets on the Data page, who can reach one on its page).
 * The diagram is decorative; the chips are real buttons with their own names.
 */
export function ReachRings({
  chips,
  labels,
  highlight,
  className,
}: {
  chips: RingChip[];
  labels: Record<ReachMode, string>;
  /** The ring the bucket sits on now (its page): drawn stronger, gently breathing. */
  highlight?: ReachMode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('relative mx-auto aspect-square w-full max-w-[400px]', className)}>
      <svg viewBox="0 0 100 100" className="absolute inset-0 size-full" aria-hidden>
        {(['PUBLIC', 'MESH', 'INTERNAL'] as const).map((ring) => {
          const r = RING_SHARE[ring] * 50;
          const c = `var(${RING_VAR[ring]})`;
          return (
            <g key={ring}>
              <circle
                cx="50"
                cy="50"
                r={r}
                strokeWidth={highlight === ring ? 0.6 : 0.3}
                strokeDasharray={ring === 'INTERNAL' ? undefined : ring === 'MESH' ? '1.1 1.3' : '0.5 1.3'}
                style={{ stroke: `color-mix(in oklch, ${c} ${highlight === ring ? 80 : 45}%, transparent)`, fill: `color-mix(in oklch, ${c} 6%, transparent)` }}
                className={cn(highlight === ring && 'motion-safe:animate-pulse')}
              />
              <text x="50" y={50 - r + 4.2} textAnchor="middle" className="font-mono" style={{ fontSize: 2.6, letterSpacing: '0.1em', fill: c }}>
                {labels[ring]}
              </text>
            </g>
          );
        })}
        <circle cx="50" cy="50" r="2.6" style={{ fill: 'var(--muted)', stroke: 'var(--border)' }} strokeWidth="0.3" />
        <circle cx="50" cy="50" r="0.8" style={{ fill: 'var(--foreground)' }} />
      </svg>
      {chips.map((c) => (
        <Chip key={c.key} chip={c} />
      ))}
    </div>
  );
}

function Chip({ chip: c }: { chip: RingChip }): React.JSX.Element {
  const cls = cn(
    'bg-card absolute flex h-7 max-w-[46%] -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold whitespace-nowrap',
    c.dim && 'opacity-40',
    c.selected ? 'border-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_20%,transparent)]' : 'border-border',
  );
  const body = (
    <>
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', c.dim ? 'bg-muted-foreground/40' : TONE_DOT[c.tone])} />
      <span className="truncate">{c.label}</span>
      {c.dim ? <span aria-hidden className="text-muted-foreground">✕</span> : null}
    </>
  );
  const style = { left: `${c.left}%`, top: `${c.top}%` };
  if (!c.onSelect) {
    return (
      <span className={cls} style={style}>
        {body}
        {c.dim ? <span className="sr-only"> (can’t reach it)</span> : null}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={c.aria}
      aria-pressed={c.selected}
      onClick={c.onSelect}
      draggable={Boolean(c.dragBucketId)}
      onDragStart={(e) => {
        if (!c.dragBucketId) return;
        e.dataTransfer.setData(BUCKET_DRAG_TYPE, c.dragBucketId);
        e.dataTransfer.effectAllowed = 'link';
      }}
      className={cn(cls, 'hover:border-primary/60 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11', c.dragBucketId && 'active:cursor-grabbing')}
      style={style}
    >
      {body}
    </button>
  );
}
