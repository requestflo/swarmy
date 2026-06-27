import * as React from 'react';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIcon, BoxesIcon, PauseIcon, PlayIcon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Progress,
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { AreaTrend, useRolling } from '@/components/charts';
import { CountUp } from '@/components/count-up';
import { bytes, cores, pct } from '@/lib/format';

export const Route = createFileRoute('/_authed/nodes/$nodeId')({
  component: NodeDetailPage,
});

function NodeDetailPage(): React.JSX.Element {
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
  const online = n?.status === 'online';
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Node"
        title={<>{n?.name ?? 'Node'} is <em>{n?.status ?? 'unknown'}</em>.</>}
        description={n ? `${n.hostname} · ${n.engineVersion ?? 'docker'} · ${n.os ?? ''}` : undefined}
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
        <Card className="card-pop border-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ActivityIcon className="text-primary size-4" /> Live utilization
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-5 flex flex-wrap items-end gap-x-10 gap-y-4">
              <div>
                <p className="mono-label">CPU now</p>
                <CountUp
                  className="mono-data text-3xl font-bold sm:text-4xl"
                  value={live.data?.cpuPercent ?? 0}
                  format={(v) => `${v.toFixed(0)}%`}
                />
              </div>
              <div>
                <p className="mono-label">Memory</p>
                <CountUp
                  className="mono-data text-3xl font-bold sm:text-4xl"
                  value={
                    live.data?.memTotalBytes
                      ? (live.data.memUsedBytes / live.data.memTotalBytes) * 100
                      : 0
                  }
                  format={(v) => `${v.toFixed(0)}%`}
                />
              </div>
            </div>
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
                {live.data ? 'Collecting samples…' : 'Node offline — no live data.'}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="card-pop border-0">
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <Row label="Status">
              <StatusBadge
                tone={online ? 'online' : n?.status === 'draining' ? 'warning' : 'offline'}
                label={n?.status ?? '—'}
              />
            </Row>
            <Row label="Role">
              <Badge variant={n?.role === 'manager' ? 'info' : 'muted'}>{n?.role ?? '—'}</Badge>
            </Row>
            <Row label="CPU now">
              <span className="mono-data">{pct(live.data?.cpuPercent)}</span>
            </Row>
            <Row label="Memory">
              <span className="mono-data">
                {bytes(live.data?.memUsedBytes)} / {bytes(live.data?.memTotalBytes)}
              </span>
            </Row>
            <Row label="Resources">
              <span className="mono-data">{cores(n?.resources.cpus ?? null)}</span>
            </Row>
            <Row label="Agent">
              <span className="mono-data">{n?.agentVersion ?? '—'}</span>
            </Row>
          </CardContent>
        </Card>
      </div>

      <Card className="card-pop mt-6 border-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BoxesIcon className="text-primary size-4" /> Containers
            <span className="mono-data text-muted-foreground">{containers.data?.length ?? 0}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1">
          {(containers.data ?? []).map((c) => (
            <div
              key={c.id}
              className="hover:bg-accent/60 -mx-2 flex items-center justify-between gap-4 rounded-xl px-4 py-3 transition-colors"
            >
              <div className="flex min-w-0 items-center gap-3">
                <StatusBadge
                  tone={c.state === 'running' ? 'online' : c.state === 'exited' ? 'offline' : 'warning'}
                  label=""
                />
                <div className="min-w-0">
                  <p className="truncate font-medium">{c.name}</p>
                  <p className="mono-label text-muted-foreground truncate">{c.image}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-4">
                <span className="mono-data text-muted-foreground hidden text-xs sm:inline">
                  {c.status}
                </span>
                <StatusBadge
                  tone={c.state === 'running' ? 'online' : c.state === 'exited' ? 'offline' : 'warning'}
                  label={c.state}
                />
              </div>
            </div>
          ))}
          {containers.data?.length === 0 && (
            <p className="text-muted-foreground py-10 text-center text-sm">
              Nothing running here yet. Deploy a service to fill it up.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="mono-label text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
