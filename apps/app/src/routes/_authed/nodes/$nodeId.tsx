import * as React from 'react';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PauseIcon, PlayIcon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Progress,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { AreaTrend, useRolling } from '@/components/charts';
import { bytes, cores, pct } from '@/lib/format';

export const Route = createFileRoute('/_authed/nodes/$nodeId')({
  component: NodeDetailPage,
});

function NodeDetailPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { nodeId } = useParams({ from: '/_authed/nodes/$nodeId' });

  const node = useQuery(trpc.nodes.get.queryOptions({ id: nodeId }));
  const live = useQuery({
    ...trpc.nodes.liveStatsLatest.queryOptions({ nodeId }),
    refetchInterval: 2_000,
  });
  const containers = useQuery({
    ...trpc.nodes.containers.queryOptions({ nodeId }),
    refetchInterval: 5_000,
  });

  const point = React.useMemo(
    () =>
      live.data
        ? {
            t: new Date().toLocaleTimeString(),
            cpu: Number(live.data.cpuPercent.toFixed(1)),
            mem: live.data.memTotalBytes
              ? Number(((live.data.memUsedBytes / live.data.memTotalBytes) * 100).toFixed(1))
              : 0,
          }
        : undefined,
    [live.dataUpdatedAt, live.data],
  );
  const trend = useRolling(point, 60);

  const drain = useMutation(
    trpc.nodes.drain.mutationOptions({
      onSuccess: () => {
        toast.success('Node draining');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const activate = useMutation(
    trpc.nodes.activate.mutationOptions({
      onSuccess: () => {
        toast.success('Node activated');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const n = node.data;
  return (
    <div>
      <PageHeader
        title={n?.name ?? 'Node'}
        description={n ? `${n.hostname} · ${n.engineVersion ?? 'docker'} · ${n.os ?? ''}` : ''}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => drain.mutate({ id: nodeId })}
              disabled={drain.isPending}
            >
              <PauseIcon className="size-4" /> Drain
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => activate.mutate({ id: nodeId })}
              disabled={activate.isPending}
            >
              <PlayIcon className="size-4" /> Activate
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Live utilization</CardTitle>
          </CardHeader>
          <CardContent>
            {trend.length > 1 ? (
              <AreaTrend
                data={trend}
                yMax={100}
                unit="%"
                series={[
                  { key: 'cpu', color: 'var(--color-chart-1)', label: 'CPU' },
                  { key: 'mem', color: 'var(--color-chart-3)', label: 'Memory' },
                ]}
              />
            ) : (
              <div className="text-muted-foreground flex h-[220px] items-center justify-center text-sm">
                {live.data ? 'Collecting samples…' : 'Node offline — no live data'}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <Row label="Status">
              <StatusBadge
                tone={n?.status === 'online' ? 'online' : n?.status === 'draining' ? 'warning' : 'offline'}
                label={n?.status ?? '—'}
              />
            </Row>
            <Row label="Role">
              <Badge variant={n?.role === 'manager' ? 'default' : 'muted'}>{n?.role ?? '—'}</Badge>
            </Row>
            <Row label="CPU now">{pct(live.data?.cpuPercent)}</Row>
            <Row label="Memory">
              {bytes(live.data?.memUsedBytes)} / {bytes(live.data?.memTotalBytes)}
            </Row>
            <Row label="Resources">{cores(n?.resources.cpus ?? null)}</Row>
            <Row label="Agent">{n?.agentVersion ?? '—'}</Row>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Containers ({containers.data?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Image</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(containers.data ?? []).map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">{c.image}</TableCell>
                  <TableCell>
                    <StatusBadge
                      tone={c.state === 'running' ? 'online' : c.state === 'exited' ? 'offline' : 'warning'}
                      label={c.state}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{c.status}</TableCell>
                </TableRow>
              ))}
              {containers.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground py-8 text-center text-sm">
                    No containers reported.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
