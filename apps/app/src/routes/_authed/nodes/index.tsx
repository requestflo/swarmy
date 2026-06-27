import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ServerIcon } from 'lucide-react';
import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  Progress,
  StatusBadge,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';
import { bytes, cores, pct, relTime } from '@/lib/format';

export const Route = createFileRoute('/_authed/nodes/')({
  component: NodesPage,
});

function NodesPage(): React.JSX.Element {
  const trpc = useTRPC();
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 5_000 });

  const list = nodes.data ?? [];
  const online = list.filter((n) => n.status === 'online').length;
  const total = list.length;
  const allGreen = total > 0 && online === total;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Nodes"
        title={
          allGreen ? (
            <>All <em>{online}</em> nodes online.</>
          ) : (
            <><em>{online}</em> of {total} nodes online.</>
          )
        }
        description="Every machine connected to your swarm via the agent — one place."
      />

      {nodes.data && nodes.data.length === 0 ? (
        <Card className="card-pop border-0">
          <CardContent className="p-0">
            <EmptyState
              icon={<ServerIcon />}
              title="Quiet so far. Add a node."
              description="Mint a join token in Settings, then run the swarmy agent on each machine — it shows up here the moment it phones home."
            />
          </CardContent>
        </Card>
      ) : (
        <Card className="card-pop border-0">
          <CardContent className="p-0">
            <div className="flex items-center justify-between gap-4 px-6 py-4">
              <span className="mono-label">
                <CountUp value={online} /> / {total} online
              </span>
              <span className="mono-label text-muted-foreground">{total} total</span>
            </div>
            <div className="divide-border divide-y border-t">
              {list.map((n) => (
                <Link
                  key={n.id}
                  to="/nodes/$nodeId"
                  params={{ nodeId: n.id }}
                  className="hover:bg-accent/60 flex items-center gap-4 px-6 py-4 transition-colors"
                >
                  <StatusBadge
                    tone={n.status === 'online' ? 'online' : n.status === 'draining' ? 'warning' : 'offline'}
                    label=""
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{n.name}</p>
                    <p className="text-muted-foreground mono-label truncate">{n.hostname}</p>
                  </div>
                  <div className="hidden w-28 sm:block">
                    <Badge variant={n.role === 'manager' ? 'info' : 'muted'}>{n.role}</Badge>
                  </div>
                  <div className="hidden w-32 lg:block">
                    <span className="mono-label">CPU {pct(n.live?.cpuPercent)}</span>
                    <Progress value={n.live?.cpuPercent ?? 0} className="mt-1" />
                  </div>
                  <div className="hidden w-32 lg:block">
                    <span className="mono-label">MEM {pct(n.live?.memPercent)}</span>
                    <Progress value={n.live?.memPercent ?? 0} className="mt-1" />
                  </div>
                  <div className="hidden w-40 text-right xl:block">
                    <p className="mono-data text-sm">{cores(n.resources.cpus)}</p>
                    <p className="text-muted-foreground mono-label">{bytes(n.resources.memBytes)}</p>
                  </div>
                  <div className="text-muted-foreground mono-label hidden w-20 text-right md:block">
                    {relTime(n.lastSeenAt)}
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
