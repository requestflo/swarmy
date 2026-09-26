import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { InvService, NodeSummary } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { STATUS_WORD, TONE_DOT, TONE_TEXT } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { usePlatformStatus } from '@/components/platform/use-platform';
import { platformParts, platformRunning } from './platform-parts';

/**
 * swarmy's own parts as small cards: the controller (`platform.status`), the
 * swarmy-system services from the live inventory, and the registry
 * (`cicd.getRegistryConfig`). A part with no data is left out.
 */
export function PlatformCards({ system, nodes }: { system: InvService[]; nodes: NodeSummary[] | undefined }): React.JSX.Element | null {
  const trpc = useTRPC();
  const status = usePlatformStatus();
  const registry = useQuery({ ...trpc.cicd.getRegistryConfig.queryOptions(), refetchInterval: 60_000 });
  const parts = platformParts({
    system,
    nodes,
    controllerVersion: status.data?.release.controller.version ?? null,
    registry: registry.data ?? null,
  });
  if (parts.length === 0) return null;
  const run = platformRunning(parts);
  const calm = run.ok === run.total;
  return (
    <section aria-labelledby="platform-title" className="calm-card flex flex-col gap-2.5 px-3.5 pt-3 pb-3.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h2 id="platform-title" className="font-display text-[15px] font-bold tracking-[-0.01em]">
          Platform
        </h2>
        <span className="text-muted-foreground text-[12.5px]">swarmy’s own parts, kept running for you</span>
        <span
          className={cn(
            'inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-semibold',
            calm ? 'bg-status-online/15 text-tone-ok' : 'bg-status-warning/15 text-tone-warn',
          )}
        >
          <span aria-hidden className={cn('size-1.5 rounded-full', calm ? 'bg-status-online' : 'bg-status-warning')} />
          {run.ok} of {run.total} running
        </span>
        <Link
          to="/settings/platform"
          className="text-primary ml-auto font-mono text-[11.5px] hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
        >
          settings / platform →
        </Link>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2">
        {parts.map((p) => (
          <li key={p.key} className="min-w-0">
            <Link
              to="/settings/platform"
              className="border-border bg-background hover:border-foreground/20 flex min-h-11 min-w-0 flex-col gap-0.5 rounded-[11px] border px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <span className="flex items-center gap-1.5 text-[13px] font-semibold">
                <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[p.tone])} />
                <span className="truncate">{p.name}</span>
                {p.tone !== 'ok' && p.tone !== 'idle' ? (
                  <span className={cn('ml-auto text-[11px]', TONE_TEXT[p.tone])}>{STATUS_WORD[p.tone]}</span>
                ) : null}
              </span>
              <span className="text-muted-foreground truncate font-mono text-[10.5px]">{p.sub}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
