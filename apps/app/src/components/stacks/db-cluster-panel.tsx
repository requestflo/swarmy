import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { DatabaseIcon, CopyIcon } from 'lucide-react';
import {
  CopyButton,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  StatusBadge,
  type StatusTone,
} from '@swarmy/ui';
import { DB_LAG_WARN_SECONDS } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { DbMemberList } from '@/components/pitr-ha/db-member-list';
import { PitrStatusRow } from '@/components/pitr-ha/pitr-status-row';

/** Read-only host pill with a copy affordance (mirrors the managed-db panel). */
function HostRow({ kind, host }: { kind: 'RW' | 'RO'; host: string }): React.JSX.Element {
  return (
    <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="mono-label text-muted-foreground !mb-0 w-7 shrink-0">{kind}</span>
        <code className="mono-data truncate text-xs">{host}</code>
      </div>
      <CopyButton value={host} />
    </div>
  );
}

/**
 * A muted, dashed placeholder that marks where a coordinated slot mounts. Shown
 * only until the owning surface fills the slot, so the panel still reads as a
 * complete frame while the topology/backup controls are wired in.
 */
function SlotPlaceholder({ hint }: { hint: string }): React.JSX.Element {
  return (
    <div className="border-border/60 text-muted-foreground mono-label !mb-0 rounded-lg border border-dashed px-3 py-4 text-center !text-[11px]">
      {hint}
    </div>
  );
}

/**
 * Managed-DB cluster panel (epic #8 + slice A2). Opens from the stack canvas
 * when a db-cluster group node is clicked. Renders the cluster's live topology
 * off `db.get` (Docker-truth): every member with role, health, replication-lag
 * badge and a crown on the current leader (`swarmy.db.leader`), the PITR/WAL
 * shipping state, and the stable rw/ro connection hosts.
 *
 * It also HOSTS two coordinated slots the topology-UI surface fills:
 * `topologySlot` (the HA topology selector) and `backupSlot` (backup/restore
 * actions, including the PITR schedule toggle).
 */
export function DbClusterPanel({
  stack,
  cluster,
  onOpenChange,
  topologySlot,
  backupSlot,
}: {
  /** Stack the clicked cluster lives in, or null when closed. */
  stack: string | null;
  /** Cluster name from the clicked node, or null when closed. */
  cluster: string | null;
  onOpenChange: (open: boolean) => void;
  /** HA topology selector — filled by the topology-UI surface. */
  topologySlot?: React.ReactNode;
  /** Backup / restore actions — filled by the topology-UI surface. */
  backupSlot?: React.ReactNode;
}): React.JSX.Element {
  const trpc = useTRPC();
  const open = Boolean(stack && cluster);

  const topology = useQuery({
    ...trpc.db.get.queryOptions({ stack: stack ?? '' }),
    enabled: open,
    refetchInterval: 4_000,
  });

  const view = topology.data?.clusters.find((c) => c.name === cluster) ?? null;

  const replicasOk = view ? view.replicas.running >= view.replicas.desired : false;
  const lagging = (view?.maxLagSeconds ?? 0) > DB_LAG_WARN_SECONDS;
  const clusterTone: StatusTone = !view
    ? 'neutral'
    : view.primary.status === 'absent'
      ? 'offline'
      : view.primary.status === 'running' && replicasOk && !lagging
        ? 'online'
        : view.primary.status === 'deploying'
          ? 'progress'
          : 'warning';
  const clusterLabel = !view
    ? '—'
    : view.primary.status === 'absent'
      ? 'absent'
      : lagging
        ? 'lagging'
        : replicasOk
          ? 'healthy'
          : 'degraded';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="border-border border-b p-6">
          <div className="flex items-center gap-3">
            <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
              <DatabaseIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <SheetTitle className="truncate">{cluster ?? 'Cluster'}</SheetTitle>
              <SheetDescription className="mono-label !mb-0">
                {view?.engine ?? 'postgres'} · {stack} · {view?.topology ?? '—'}
              </SheetDescription>
            </div>
            <StatusBadge tone={clusterTone} label={clusterLabel} className="ml-auto shrink-0" />
          </div>
        </SheetHeader>

        <div className="space-y-6 p-6">
          {/* ── Replication: per-member roles, lag badges, leader crown ────── */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="mono-label text-muted-foreground !mb-0">Replication</p>
              {view && (
                <span className="mono-data text-muted-foreground text-[11px]">
                  {view.replicas.running}/{view.declaredReplicas}{' '}
                  {view.declaredReplicas === 1 ? 'replica' : 'replicas'}
                  {view.maxLagSeconds !== undefined ? ` · worst lag ${view.maxLagSeconds}s` : ''}
                </span>
              )}
            </div>
            {!view ? (
              <SlotPlaceholder
                hint={topology.isLoading ? 'Loading topology…' : 'Cluster not found in live inventory'}
              />
            ) : (
              <div className="space-y-2">
                <DbMemberList members={view.members} leader={view.leader ?? view.primary.service} />
                <PitrStatusRow pitr={view.pitr} shipper={view.walShipper} />
              </div>
            )}
          </section>

          {/* ── Connection hosts ──────────────────────────────────────────── */}
          {view && (
            <section className="space-y-2">
              <div className="flex items-center gap-1.5">
                <CopyIcon className="text-muted-foreground size-3" />
                <p className="mono-label text-muted-foreground !mb-0">Connection</p>
              </div>
              <HostRow kind="RW" host={view.rwHost} />
              <HostRow kind="RO" host={view.roHost} />
            </section>
          )}

          {/* ── Topology selector slot (topology-UI surface fills this) ────── */}
          <section className="space-y-2">
            <p className="mono-label text-muted-foreground !mb-0">HA topology</p>
            {topologySlot ?? <SlotPlaceholder hint="Topology selector mounts here" />}
          </section>

          {/* ── Backup actions slot (topology-UI surface fills this) ───────── */}
          <section className="space-y-2">
            <p className="mono-label text-muted-foreground !mb-0">Backups</p>
            {backupSlot ?? <SlotPlaceholder hint="Backup actions mount here" />}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
