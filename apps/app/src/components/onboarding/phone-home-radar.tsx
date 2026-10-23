import * as React from 'react';
import type { NodeSummary } from '@swarmy/core';
import { cn } from '@swarmy/ui';

const DOT: Record<string, string> = { online: 'bg-status-online', draining: 'bg-status-warning', offline: 'bg-status-idle' };
const RINGS = [0.42, 0.66, 0.84];

/** A blip's spot: spread by the golden angle, alternating rings, as % of the radar. */
export function blipAt(i: number): { left: number; top: number } {
  const a = ((i * 137.5 + 210) * Math.PI) / 180;
  const r = RINGS[i % RINGS.length]! * 50;
  return { left: 50 + r * Math.cos(a), top: 50 + r * Math.sin(a) };
}

/**
 * Board 12's radar: your servers as blips around swarmy (the centre), the
 * sweep while it listens, and the new one popping in coral when it phones home.
 */
export function PhoneHomeRadar({ nodes, sweeping, arrivedId }: { nodes: NodeSummary[] | undefined; sweeping: boolean; arrivedId: string | null }): React.JSX.Element {
  return (
    <div className="border-border relative aspect-square w-full max-w-[320px] overflow-hidden rounded-full border bg-[color-mix(in_oklab,var(--card)_70%,var(--background))]">
      {[0.33, 0.66, 1].map((s) => (
        <span
          key={s}
          aria-hidden
          className="border-foreground/[0.07] absolute rounded-full border"
          style={{ inset: `${(1 - s) * 50}%` }}
        />
      ))}
      <span aria-hidden className="bg-foreground/[0.05] absolute top-0 left-1/2 h-full w-px" />
      <span aria-hidden className="bg-foreground/[0.05] absolute top-1/2 left-0 h-px w-full" />
      {sweeping ? (
        <>
          <span
            aria-hidden
            className="absolute inset-0 rounded-full motion-safe:animate-spin motion-reduce:hidden"
            style={{
              animationDuration: '3.2s',
              background: 'conic-gradient(from 0deg, color-mix(in oklab, var(--primary) 22%, transparent), transparent 16%)',
            }}
          />
          <span aria-hidden className="border-primary/50 absolute inset-[30%] rounded-full border-[1.5px] motion-safe:animate-ping motion-reduce:hidden" />
        </>
      ) : null}
      {(nodes ?? []).map((n, i) => {
        const p = blipAt(i);
        const fresh = n.id === arrivedId;
        const right = p.left > 62;
        return (
          <span
            key={n.id}
            className={cn('absolute flex items-center gap-1.5 font-mono text-[11px] whitespace-nowrap', fresh ? 'text-foreground font-semibold' : 'text-muted-foreground', right && 'flex-row-reverse')}
            style={{ top: `${p.top}%`, ...(right ? { right: `${100 - p.left}%` } : { left: `${p.left}%` }), transform: `translate(${right ? '4px' : '-4px'}, -50%)` }}
          >
            <i className={cn('block shrink-0 rounded-full', fresh ? 'bg-primary size-3 motion-safe:animate-pulse' : cn('size-2', DOT[n.status] ?? 'bg-status-idle'))} />
            {n.name}
          </span>
        );
      })}
      <span aria-hidden className="bg-primary border-background absolute top-1/2 left-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px]" />
      <span className="sr-only">{nodes?.length ? `Your servers: ${nodes.map((n) => n.name).join(', ')}` : 'No servers yet'}</span>
    </div>
  );
}

/** Counts from when the link exists, not from when the page opened. */
function useElapsed(running: boolean): string {
  const [start, setStart] = React.useState(() => Date.now());
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (!running) return;
    setStart(Date.now());
    const t = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => window.clearInterval(t);
  }, [running]);
  const s = Math.floor((Date.now() - start) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Under the radar while nothing has arrived: listening, or waiting for a link. */
export function PhoneHomeWaiting({ armed }: { armed: boolean }): React.JSX.Element {
  const elapsed = useElapsed(armed);
  return armed ? (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <h2 className="font-display text-[1.35rem] font-bold tracking-[-0.02em]">Waiting for it to phone home…</h2>
      <p className="text-muted-foreground font-mono text-[12px]">
        <span aria-hidden className="text-primary motion-safe:animate-pulse">● </span>
        {`listening · ${elapsed} · usually under 90 s`}
      </p>
    </div>
  ) : (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <h2 className="font-display text-[1.3rem] font-bold tracking-[-0.02em]">The new server shows up here.</h2>
      <p className="text-muted-foreground text-[13.5px]">Make a link and run it; this watches for it to join.</p>
    </div>
  );
}
