import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CopyIcon, DatabaseIcon, XIcon } from 'lucide-react';
import { Button, StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DbMemberList } from '@/components/pitr-ha/db-member-list';
import { PitrStatusRow } from '@/components/pitr-ha/pitr-status-row';
import { HostRow, SlotPlaceholder } from './db-cluster-panel-parts';
import { dbClusterTone } from './db-cluster-tone';

interface DbClusterPanelProps {
  stack: string;
  cluster: string;
  onClose: () => void;
  /** HA topology selector — filled by the topology-UI surface. */
  topologySlot?: React.ReactNode;
  /** Backup / restore actions — filled by the topology-UI surface. */
  backupSlot?: React.ReactNode;
}

/**
 * Managed-DB cluster panel (epic #8 + slice A2). Docks in the canvas inspector
 * column when a db-cluster group node is clicked — never a slide-over.
 * Renders the cluster's live topology off `db.get` (Docker-truth): every
 * member with role, health, replication-lag badge and a crown on the current
 * leader, the PITR/WAL shipping state, and the stable rw/ro connection hosts.
 * Also HOSTS two coordinated slots the topology-UI surface fills: `topologySlot`
 * (the HA topology selector) and `backupSlot` (backup/restore actions).
 */
export function DbClusterPanel({ stack, cluster, onClose, topologySlot, backupSlot }: DbClusterPanelProps): React.JSX.Element {
  const trpc = useTRPC();
  const topology = useQuery({ ...trpc.db.get.queryOptions({ stack }), refetchInterval: 4_000 });
  const view = topology.data?.clusters.find((c) => c.name === cluster) ?? null;
  const { tone, label } = dbClusterTone(view);

  return (
    <>
      <div className="border-border flex items-center gap-3 border-b p-4">
        <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
          <DatabaseIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display truncate text-lg font-bold">{cluster}</p>
          <p className="mono-label !mb-0 truncate">
            {view?.engine ?? 'postgres'} · {stack} · {view?.topology ?? '—'}
          </p>
        </div>
        <StatusBadge tone={tone} label={label} className="shrink-0" />
        <Button variant="ghost" size="icon" className="shrink-0 rounded-full" onClick={onClose} aria-label="Close inspector">
          <XIcon className="size-4" />
        </Button>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto p-4">
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
            <SlotPlaceholder hint={topology.isLoading ? 'Loading topology…' : 'Cluster not found in live inventory'} />
          ) : (
            <div className="space-y-2">
              <DbMemberList members={view.members} leader={view.leader ?? view.primary.service} />
              <PitrStatusRow pitr={view.pitr} shipper={view.walShipper} />
            </div>
          )}
        </section>

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

        <section className="space-y-2">
          <p className="mono-label text-muted-foreground !mb-0">HA topology</p>
          {topologySlot ?? <SlotPlaceholder hint="Topology selector mounts here" />}
        </section>

        <section className="space-y-2">
          <p className="mono-label text-muted-foreground !mb-0">Backups</p>
          {backupSlot ?? <SlotPlaceholder hint="Backup actions mount here" />}
        </section>
      </div>
    </>
  );
}
