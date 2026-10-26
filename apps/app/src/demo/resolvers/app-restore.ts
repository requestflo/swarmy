import { planAppRestore, type AppRestoreResultView, type AppRestoreScopeView } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * The demo's whole-app restore (board 10): `backups.appRestoreScope` and
 * `backups.restoreApp` over data.ts's saves. Like the controller: the app's
 * saved volumes and its Postgres, its plain services stopped once, a plan
 * refused when a part can't reach the moment, and each part saved first
 * (the database's copy lands in its list as a `pre-restore` save).
 */

interface VolumeSnap { id: string; volume: string; targetId: string; targetName: string; status: string; resticId: string | null; sizeBytes: string | null; error: string | null; startedAt: string; finishedAt: string | null }
interface DbSnap { id: string; time: string; engine: string; sizeBytes: string | null; tags: string[]; stack: string; cluster: string; reason?: string | null }
interface DbCluster { stack: string; cluster: string; schedule: { engine: string; pitr: boolean } | null }
interface DemoData { snapshots: VolumeSnap[]; dbSnapshots: DbSnap[]; dbClusters: DbCluster[] }

const data = (s: DemoStore): DemoData => s.extra.data as DemoData;
const RUN_MS = 5_000;

function scopeOf(s: DemoStore, stack: string): AppRestoreScopeView {
  const st = data(s);
  const stackId = s.stacks.find((x) => x.name === stack)?.id ?? null;
  const databases = st.dbClusters.filter((c) => c.stack === stack).map((c) => c.cluster).sort();
  const saved = [...new Set(st.snapshots.map((x) => x.volume).filter((v) => v.startsWith(`${stack}_`)))].sort();
  const pg = (v: string): boolean => databases.some((c) => v.startsWith(`${stack}_${c}-`) && v.endsWith('-data'));
  return {
    stack,
    volumes: saved.filter((v) => !pg(v)),
    leftOut: saved.filter(pg).map((volume) => ({ volume, why: 'database' as const })),
    databases,
    stops: s.services
      .filter((x) => x.stackId === stackId && x.replicas.desired > 0)
      .map((x) => ({ service: `${stack}_${x.name}`, replicas: x.replicas.desired }))
      .sort((a, b) => a.service.localeCompare(b.service)),
    keepsRunning: databases.map((c) => ({ service: `${stack}_${c}-primary`, why: 'database' as const })),
  };
}

export const appRestoreDemo: DomainResolvers = {
  handlers: {
    'backups.appRestoreScope': (i, s) => scopeOf(s, (i as { stack: string }).stack),

    'backups.restoreApp': (i, s) => {
      const b = i as { stack: string; at: string; confirm: string };
      if (b.confirm.trim() !== b.stack) throw new Error(`type ${b.stack} to restore the whole app`);
      const st = data(s);
      const scope = scopeOf(s, b.stack);
      const plan = planAppRestore({
        at: Date.parse(b.at),
        volumes: scope.volumes.map((volume) => ({ volume, saves: st.snapshots.filter((x) => x.volume === volume) })),
        databases: scope.databases.map((cluster) => ({
          cluster,
          saves: st.dbSnapshots.filter((x) => x.stack === b.stack && x.cluster === cluster).map((x) => ({ id: x.id, time: x.time, engine: x.engine as never })),
          pitr: null,
        })),
      });
      if (!plan.ok) throw new Error(`Nothing was restored: ${plan.refused.map((r) => r.name).join(', ')} can't go back that far.`);
      return new Promise<AppRestoreResultView>((resolve) =>
        setTimeout(() => {
          const now = new Date().toISOString();
          const parts = plan.parts.map((p, k) => {
            const safetySnapshotId = `pre-${Date.now().toString(16)}${k}`;
            if (p.kind === 'volume') {
              const like = st.snapshots.find((x) => x.id === p.pointId)!;
              st.snapshots = [{ ...like, id: safetySnapshotId, status: 'SUCCEEDED', startedAt: now, finishedAt: now, resticId: safetySnapshotId.slice(0, 8) }, ...st.snapshots];
            } else {
              const tags = ['org:org-demo', `db:${b.stack}/${p.name}`, 'engine:pg_dump', 'reason:pre-restore'];
              st.dbSnapshots = [{ id: safetySnapshotId, time: now, engine: 'pg_dump', sizeBytes: '271581184', tags, stack: b.stack, cluster: p.name, reason: 'pre-restore' }, ...st.dbSnapshots];
            }
            return { ...p, safetySnapshotId, status: 'restored' as const };
          });
          resolve({ stack: b.stack, at: new Date(plan.at).toISOString(), skewMs: plan.skewMs, stopped: scope.stops.map((x) => x.service), parts });
        }, RUN_MS),
      );
    },
  },
};
