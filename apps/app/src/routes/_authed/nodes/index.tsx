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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { bytes, cores, relTime } from '@/lib/format';

export const Route = createFileRoute('/_authed/nodes/')({
  component: NodesPage,
});

function NodesPage() {
  const trpc = useTRPC();
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 5_000 });

  return (
    <div>
      <PageHeader title="Nodes" description="Machines connected to your swarm via the agent." />
      {nodes.data && nodes.data.length === 0 ? (
        <EmptyState
          icon={<ServerIcon />}
          title="No nodes connected"
          description="Mint a join token in Settings, then run the swarmy agent on each node."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>CPU</TableHead>
                  <TableHead>Memory</TableHead>
                  <TableHead>Resources</TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(nodes.data ?? []).map((n) => (
                  <TableRow key={n.id}>
                    <TableCell>
                      <Link
                        to="/nodes/$nodeId"
                        params={{ nodeId: n.id }}
                        className="font-medium hover:underline"
                      >
                        {n.name}
                      </Link>
                      <div className="text-muted-foreground text-xs">{n.hostname}</div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        tone={n.status === 'online' ? 'online' : n.status === 'draining' ? 'warning' : 'offline'}
                        label={n.status}
                      />
                    </TableCell>
                    <TableCell>
                      <Badge variant={n.role === 'manager' ? 'default' : 'muted'}>{n.role}</Badge>
                    </TableCell>
                    <TableCell className="w-32">
                      <Progress value={n.live?.cpuPercent ?? 0} />
                    </TableCell>
                    <TableCell className="w-32">
                      <Progress value={n.live?.memPercent ?? 0} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {cores(n.resources.cpus)} · {bytes(n.resources.memBytes)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {relTime(n.lastSeenAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
