import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DbGeoRegionPlan } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { NextAction } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { DbTopologyGeoFields } from '@/components/stacks/db-topology-geo-fields';
import { PgNextAction } from '@/components/stack-data/pg-next-action';
import type { HaChoice } from '@/components/stack-data/pg-choices';
import type { PgMode } from './pg-topology';
import type { PgDetailData } from './use-pg-detail';

const CHOICE: Partial<Record<PgMode, HaChoice>> = { single: 'one', 'primary-replica': 'standby', failover: 'auto' };

/** Geo needs a write region and read regions: the same fields as the Controls topology form. */
function GeoApply({ stack, d }: { stack: string; d: PgDetailData }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const c = d.cluster!;
  const primaryRegion = c.members.filter((m) => m.role === 'primary').flatMap((m) => d.place?.get(m.service) ?? [])[0]?.region ?? '';
  const [writeRegion, setWriteRegion] = React.useState(c.writeRegion ?? primaryRegion);
  const [regions, setRegions] = React.useState<DbGeoRegionPlan[]>([{ region: '', replicas: 1 }]);
  const apply = useMutation(
    trpc.db.setTopology.mutationOptions({
      onSuccess: () => {
        toast.success(`${c.name} is going geo — swarmy is adding the copies now`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const picked = regions.filter((r) => r.region.trim());
  return (
    <NextAction
      eyebrow={c.name}
      tone="info"
      title="Keep copies near your users"
      tech={`db.setTopology · swarmy.db.topology=geo · swarmy.db.writeRegion=${writeRegion || '…'}${picked.map((r) => ` · swarmy.db.region.${r.region}.replicas=${r.replicas}`).join('')}`}
      actions={
        <Button
          className="min-h-11 sm:min-h-9"
          disabled={apply.isPending || !writeRegion.trim() || picked.length === 0}
          onClick={() => apply.mutate({ stack, cluster: c.name, topology: 'geo', writeRegion: writeRegion.trim(), regions: picked })}
        >
          {apply.isPending ? 'Applying…' : 'Go geo'}
        </Button>
      }
    >
      <p className="mb-3">Writes stay in one region; each read region gets its own standby copy, served from DATABASE_RO_URL.</p>
      <DbTopologyGeoFields writeRegion={writeRegion} onWriteRegion={setWriteRegion} regions={regions} onRegions={setRegions} />
    </NextAction>
  );
}

/**
 * The page's one action when a different shape is picked: the Data tab's
 * own apply for one copy / a standby copy / switch over by itself (refused,
 * with the reason, when switch-over can't honestly work here), and the geo
 * plan. Nothing shows while the picked shape is today's.
 */
export function PgModeApply({ stack, d, mode }: { stack: string; d: PgDetailData; mode: PgMode }): React.JSX.Element | null {
  const c = d.cluster!;
  if (mode === c.topology) return null;
  if (mode === 'geo') return <GeoApply stack={stack} d={d} />;
  const choice = CHOICE[mode];
  if (!choice) return null;
  if (choice === 'auto' && d.readiness && !d.readiness.ok) {
    return (
      <NextAction eyebrow={c.name} tone="warn" title="Switching over by itself can’t work here yet" tech="db.failoverReadiness · setTopology refuses failover on the same reason">
        {d.readiness.reason}
      </NextAction>
    );
  }
  return <PgNextAction stack={stack} cluster={c} choice={choice} />;
}
