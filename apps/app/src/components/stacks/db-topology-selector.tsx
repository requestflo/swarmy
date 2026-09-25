import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranchIcon, NetworkIcon } from 'lucide-react';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import type {
  DbGeoRegionPlan as DbGeoRegion,
  DbTopologyConfigView as DbTopologyConfig,
  DbTopologyMode,
} from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { DbTopologyGeoFields } from './db-topology-geo-fields';

interface SetTopologyInput {
  stack: string;
  cluster: string;
  topology: DbTopologyMode;
  writeRegion?: string;
  regions?: DbGeoRegion[];
}

const MODES: { value: DbTopologyMode; label: string; blurb: string }[] = [
  { value: 'single', label: 'Single', blurb: 'One primary, no replicas — simplest and cheapest.' },
  { value: 'primary-replica', label: 'Primary + replicas', blurb: 'One writer, N read replicas — scales reads.' },
  { value: 'failover', label: 'Auto-failover', blurb: 'A replica promotes if the primary dies — HA writes.' },
  { value: 'geo', label: 'Geo-distributed', blurb: 'Read replicas per region, one write region.' },
  { value: 'active-active', label: 'Active-active', blurb: 'Every region writes — conflict-resolved, advanced.' },
];

const labelFor = (m: DbTopologyMode): string => MODES.find((x) => x.value === m)?.label ?? m;

interface DbTopologySelectorProps {
  stack: string;
  cluster: string;
  /** Live topology for the cluster (from `db.get`); seeds the form. */
  current?: DbTopologyConfig;
}

/**
 * In-situ topology changer for a managed-DB cluster. Picks the HA shape
 * (single / primary-replica / failover / geo / active-active) and applies it via
 * `db.setTopology`, which stamps the `swarmy.db.topology` label the reconcile
 * worker converges to — no redeploy, no data move from the operator's side.
 * Mounts into the db-cluster panel beside the replica scaler.
 */
export function DbTopologySelector({
  stack,
  cluster,
  current,
}: DbTopologySelectorProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [mode, setMode] = React.useState<DbTopologyMode>(current?.topology ?? 'primary-replica');
  const [writeRegion, setWriteRegion] = React.useState(current?.writeRegion ?? '');
  const [regions, setRegions] = React.useState<DbGeoRegion[]>(
    current?.regions?.length ? current.regions : [{ region: '', replicas: 1 }],
  );

  const apply = useMutation(
    trpc.db.setTopology.mutationOptions({
      onSuccess: (res) => {
        toast.success(`${res.cluster} → ${labelFor(res.topology)} topology`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const meta = MODES.find((m) => m.value === mode);
  const unchanged = mode === current?.topology && mode !== 'geo';
  // Auto-failover only where it can honestly work (QA-058): say why not.
  const readiness = useQuery({
    ...trpc.db.failoverReadiness.queryOptions({ stack, cluster }),
    enabled: mode === 'failover',
  });
  const failoverBlocked = mode === 'failover' && readiness.data && !readiness.data.ok ? readiness.data.reason : null;
  const failoverSurvives = mode === 'failover' && readiness.data?.ok ? readiness.data.survives : null;

  const onApply = (): void => {
    const payload: SetTopologyInput = { stack, cluster, topology: mode };
    if (mode === 'geo') {
      payload.writeRegion = writeRegion.trim() || undefined;
      payload.regions = regions.filter((r) => r.region.trim().length > 0);
    } else if (mode === 'failover' && writeRegion.trim()) {
      payload.writeRegion = writeRegion.trim();
    }
    apply.mutate(payload);
  };

  return (
    <div className="border-border min-w-0 space-y-5 rounded-xl border p-4">
        <div className="flex items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
            <NetworkIcon className="size-5" />
          </span>
          <div>
            <h3 className="font-semibold leading-tight">Topology</h3>
            <p className="text-muted-foreground mono-label">
              {cluster} · change the HA shape in place
            </p>
          </div>
        </div>

        <div className="grid gap-1.5">
          <Select value={mode} onValueChange={(v) => setMode(v as DbTopologyMode)}>
            <SelectTrigger className="w-full" aria-label="Topology">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {meta && (
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <GitBranchIcon className="size-3.5 shrink-0" /> {meta.blurb}
            </p>
          )}
        </div>

        {failoverBlocked ? (
          <p role="alert" className="border-status-offline/40 bg-status-offline/10 text-tone-bad rounded-lg border px-3 py-2 text-sm">
            {failoverBlocked}
          </p>
        ) : failoverSurvives ? (
          <p className="text-muted-foreground text-sm">{failoverSurvives}</p>
        ) : null}

        {mode === 'geo' && (
          <DbTopologyGeoFields
            writeRegion={writeRegion}
            onWriteRegion={setWriteRegion}
            regions={regions}
            onRegions={setRegions}
          />
        )}

        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={onApply} disabled={apply.isPending || unchanged || !!failoverBlocked}>
            <NetworkIcon className="size-4" /> Apply topology
          </Button>
          {current?.topology && (
            <span className="text-muted-foreground mono-label">
              now: {labelFor(current.topology)}
            </span>
          )}
        </div>
      </div>
  );
}
