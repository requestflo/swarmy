import * as React from 'react';
import type { ServiceHealthProbesView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { Depth, TONE_TEXT, Tech } from '@/components/calm';
import { probeLine, sayMs, summarizeProbes } from './probe-model';

/**
 * "Last N probes" (board AppRollout): Docker's own record — the last 5
 * probes per copy — summed up in one line. N is what Docker kept, never more.
 */
export function HealthProbes({ name, data }: { name: string; data: ServiceHealthProbesView | null | undefined }): React.JSX.Element | null {
  if (data === undefined) return <div aria-hidden className="bg-muted h-4 w-64 animate-pulse rounded motion-reduce:animate-none" />;
  if (data === null) return null;
  const s = summarizeProbes(data.copies);
  if (!s) {
    return <p className="text-muted-foreground text-[13px]">No probes from {name}’s copies yet. Docker reports them once a check has run.</p>;
  }
  const failing = data.copies.filter((c) => c.status === 'unhealthy');
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[13px] font-semibold">Last {s.count} probes</span>
        <span className="text-muted-foreground font-mono text-[11px]">
          {s.copies === 1 ? 'one copy' : `across ${s.copies} copies`} · Docker keeps 5 a copy
        </span>
      </div>
      <p className={cn('font-mono text-[13px]', TONE_TEXT[s.misses > 0 ? 'warn' : 'ok'])}>{probeLine(s)}</p>
      {failing.length > 0 ? (
        <p className="text-tone-bad text-[13px]">
          {failing.length === 1 ? `One copy${failing[0]?.node ? ` on ${failing[0].node}` : ''} is` : `${failing.length} copies are`} unhealthy right now.
        </p>
      ) : null}
      <Depth at="controls">
        {data.copies.map((c) => (
          <Tech key={c.containerId}>
            {c.node ?? c.nodeId} · {c.containerId.slice(0, 12)} · {c.status}
            {c.failingStreak ? ` · ${c.failingStreak} missed in a row` : ''} · {c.probes.map((p) => (p.exitCode === 0 ? sayMs(p.durationMs) : `exit ${p.exitCode}`)).join(', ')}
          </Tech>
        ))}
      </Depth>
    </div>
  );
}
