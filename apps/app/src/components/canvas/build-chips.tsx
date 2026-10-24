import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { InvService } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { newestBuild } from './newest-build';

/**
 * The newest build behind this app, as the stages swarmy records (board
 * AppCanvas: build ✓ 38 s · scan · roll out). Nothing when no linked repo
 * deploys to one of its parts. Links to the build's page.
 */
export function BuildChips({ stack, services }: { stack: string; services: readonly InvService[] }): React.JSX.Element | null {
  const trpc = useTRPC();
  const repos = useQuery({ ...trpc.cicd.listRepos.queryOptions(), refetchInterval: 60_000 });
  const builds = useQuery({ ...trpc.cicd.listBuilds.queryOptions(), refetchInterval: 10_000 });
  const scans = useQuery({ ...trpc.registryPolicy.listScans.queryOptions({ limit: 200 }), refetchInterval: 30_000 });
  if (!repos.data || !builds.data) return null;
  const b = newestBuild(stack, services, repos.data, builds.data, scans.data ?? []);
  if (!b) return null;
  return (
    <div className="flex min-w-0 flex-col items-start gap-0.5 md:items-end">
      <Link
        to="/ci/$buildId"
        params={{ buildId: b.id }}
        className="hover:border-foreground/25 border-border flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-full border px-3 py-1 font-mono text-[11px] pointer-coarse:min-h-11"
      >
        <span className="text-muted-foreground">newest build · {b.part}</span>
        {b.chips.map((c) => (
          <span key={c.label} className={cn('inline-flex items-center gap-1.5', TONE_TEXT[c.tone])}>
            <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[c.tone], c.tone === 'info' && 'motion-safe:animate-pulse')} />
            {c.label}
          </span>
        ))}
      </Link>
      <Tech className="max-w-full truncate">{b.tech}</Tech>
    </div>
  );
}
