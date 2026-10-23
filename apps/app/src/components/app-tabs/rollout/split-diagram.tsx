import * as React from 'react';
import { GlobeIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';

export interface SplitEnd {
  title: string;
  sub: string;
}

/** Ribbon width in px for a share of visitors (a sliver stays visible). */
const ribbon = (pct: number): number => (pct <= 0 ? 1 : Math.max(2, Math.round((pct / 100) * 26)));

/**
 * The canary split (board AppRollout): the app's address and its visitors a
 * second on the left, ribbons as wide as each share, the version that keeps
 * the rest and the one being tried on the right. No drag handle: the share
 * is picked with the chips above it.
 */
export function SplitDiagram({
  door,
  doorSub,
  pct,
  stable,
  canary,
}: {
  door: string;
  doorSub: string | null;
  pct: number;
  stable: SplitEnd;
  canary: SplitEnd;
}): React.JSX.Element {
  return (
    <div className="bg-background border-border flex min-h-36 items-stretch rounded-xl border p-3 sm:min-h-40 sm:p-4" role="img" aria-label={`${door}: ${100 - pct}% to ${stable.title}, ${pct}% to ${canary.title}`}>
      <div className="flex w-[36%] max-w-56 min-w-0 flex-col justify-center">
        <Node title={door} sub={doorSub} icon />
      </div>
      <div className="relative min-w-6 flex-1">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden className="absolute inset-0 size-full">
          <path d="M0 50 C 50 50 50 22 100 22" fill="none" className="stroke-status-online/55" strokeWidth={ribbon(100 - pct)} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d="M0 50 C 50 50 50 78 100 78" fill="none" className="stroke-primary/70" strokeWidth={ribbon(pct)} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <div className="flex w-[42%] max-w-64 min-w-0 flex-col justify-between gap-3">
        <Node title={stable.title} sub={stable.sub} dot="bg-status-online" />
        <Node title={canary.title} sub={canary.sub} dot="bg-primary" coral />
      </div>
    </div>
  );
}

function Node({ title, sub, icon, dot, coral }: { title: string; sub: string | null; icon?: boolean; dot?: string; coral?: boolean }): React.JSX.Element {
  return (
    <div className={cn('bg-card flex min-w-0 flex-col gap-0.5 rounded-lg border px-2.5 py-2', coral ? 'border-primary/50' : 'border-border')}>
      <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
        {icon ? <GlobeIcon aria-hidden className="text-primary size-3.5 shrink-0" /> : null}
        {dot ? <span aria-hidden className={cn('size-2 shrink-0 rounded-full', dot)} /> : null}
        <span className="[overflow-wrap:anywhere] sm:truncate">{title}</span>
      </span>
      {sub ? <span className="text-muted-foreground font-mono text-[10.5px] [overflow-wrap:anywhere] sm:truncate">{sub}</span> : null}
    </div>
  );
}
