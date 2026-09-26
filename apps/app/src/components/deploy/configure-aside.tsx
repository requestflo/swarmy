import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BlueprintMetaView, BlueprintPlanView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { CreatesGraph } from '@/components/blueprints/creates-graph';
import { graphModel } from '@/components/blueprints/creates-model';
import { memoryLabel } from '@/components/blueprints/template-words';
import { gb } from '@/components/nodes/servers/server-words';
import { useServerRoom } from './use-server-room';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "Adds 2 services · 1 database · 1 web address", from the dry-run. */
export function addsLine(plan: BlueprintPlanView, domain: boolean): string {
  const services = plan.steps.find((s) => s.kind === 'stack.deploy')?.detail.services?.split(', ').filter(Boolean).length ?? 0;
  const parts = [plural(services, 'service')];
  const dbs = plan.steps.filter((s) => s.kind === 'db.provision').length;
  if (dbs) parts.push(plural(dbs, 'database'));
  const caches = plan.steps.filter((s) => s.kind === 'cache.provision').length;
  if (caches) parts.push(plural(caches, 'cache'));
  const buckets = plan.steps.filter((s) => s.kind === 'bucket').length;
  if (buckets) parts.push(plural(buckets, 'bucket'));
  if (domain || plan.autoHost) parts.push('1 web address');
  return parts.join(' · ');
}

/** The Configure aside (board 3): what you get, drawn, and the one-line footprint under it. */
export function ConfigureAside({
  meta,
  plan,
  host,
  ownDomain,
}: {
  meta: BlueprintMetaView;
  plan: BlueprintPlanView | undefined;
  host: string | null;
  ownDomain: boolean;
}): React.JSX.Element {
  const trpc = useTRPC();
  const targets = useQuery(trpc.backups.listTargets.queryOptions());
  const room = useServerRoom();
  const hasTarget = (targets.data ?? []).some((t) => t.enabled);
  const backup = targets.isPending ? undefined : hasTarget ? 'pg_dump · kept 7 days' : 'needs a place to keep backups';
  const model = graphModel(meta, { plan, host, backup });
  if (model.entry) model.entry = { ...model.entry, label: 'Visitors' };
  return (
    <section aria-label="What you get" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="calm-eyebrow">What you get</h2>
        <span className="text-muted-foreground text-xs">All of this is on by default</span>
      </div>
      <CreatesGraph model={model} details="always" big />
      <dl className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1.5 text-[13px]">
        {plan ? (
          <div className="flex gap-2">
            <dt>Adds</dt>
            <dd className="text-foreground font-mono text-[12.5px]">{addsLine(plan, ownDomain)}</dd>
          </div>
        ) : null}
        {meta.minMemoryMb ? (
          <div className="flex gap-2">
            <dt>Needs</dt>
            <dd className="text-foreground font-mono text-[12.5px]">
              {memoryLabel(meta)}
              {room.roomiest ? ` of ${gb(room.roomiest.freeBytes)} free` : ''}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
