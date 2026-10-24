import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { NodeSummary } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { CalmRow, RowList, Section, SectionLink } from '@/components/calm';
import { RowsSkeleton } from '@/components/app-tabs/tab-body';

/** `isBuilderCapable` over the summary: the server's own override wins, else the Builder role. */
function capable(n: NodeSummary): boolean {
  return n.buildOverride === 'deny' ? false : n.buildOverride === 'allow' ? true : n.builder === true;
}

function source(n: NodeSummary): string {
  if (n.buildOverride === 'allow') return 'SWARMY_ALLOW_BUILD=true on the server';
  if (n.buildOverride === 'deny') return 'swarmy.node.builder=true · vetoed by SWARMY_ALLOW_BUILD=false';
  return 'swarmy.node.builder=true';
}

/**
 * Builders (board 51): the servers allowed to run builds — the Builder role
 * (`swarmy.node.builder`), or the server's own SWARMY_ALLOW_BUILD override,
 * decided the way the controller picks one (`isBuilderCapable`). A server
 * whose role is on but whose operator vetoed builds is listed, quietly.
 */
export function BuildersSection(): React.JSX.Element {
  const trpc = useTRPC();
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 10_000 });
  const all = nodes.data ?? [];
  const builders = all.filter(capable);
  const vetoed = all.filter((n) => n.buildOverride === 'deny' && n.builder === true);
  return (
    <Section
      title="Builders"
      count={nodes.data ? builders.length : undefined}
      hint="servers allowed to run builds · rootless BuildKit, never the main Docker"
      action={<Link to="/nodes"><SectionLink>Servers →</SectionLink></Link>}
      flush
    >
      {nodes.isPending ? (
        <RowsSkeleton rows={2} />
      ) : builders.length + vetoed.length === 0 ? (
        <p className="text-muted-foreground pb-3 text-[13px]">
          No server may build yet, so pushes wait. Turn on the Builder role for a server under Servers.
        </p>
      ) : (
        <RowList label="Builders">
          {[...builders, ...vetoed].map((n) => {
            const allowed = builders.includes(n);
            const online = n.status !== 'offline' && n.status !== 'pending';
            return (
              <CalmRow
                key={n.id}
                tone={!allowed ? 'idle' : online ? 'ok' : 'bad'}
                name={n.name}
                sub={n.region ? `${n.hostname} · ${n.region}` : n.hostname}
                say={!allowed ? 'Its operator turned builds off on this server.' : online ? 'Builds in its own rootless BuildKit, never the main Docker.' : 'Offline: builds wait for another builder.'}
                tech={source(n)}
                word={!allowed ? 'Vetoed' : online ? 'Online' : 'Offline'}
                to="/nodes/$nodeId"
                params={{ nodeId: n.id }}
              />
            );
          })}
        </RowList>
      )}
    </Section>
  );
}
