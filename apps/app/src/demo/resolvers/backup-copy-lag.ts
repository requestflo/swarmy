import type { DemoStore, DomainResolvers } from '../types';

/**
 * The demo's `backups.copyLag`: how far each "also copy to" destination
 * trails, over data.ts's schedules and snapshots, by the controller's rule
 * (per volume, the newest save on the primary destination against the newest
 * copy, a copy in flight is not lag). The seed has the Postgres volume also
 * copied to the on-node NVMe, its newest copy four minutes behind. Comes
 * after data.ts in the registry (its seed changes data's state).
 */

interface Snap {
  id: string;
  volume: string;
  targetId: string;
  targetName: string;
  status: string;
  resticId: string | null;
  sizeBytes: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}
interface Sched {
  volume: string;
  targetId: string;
  secondaryTargetId?: string | null;
  paused: boolean;
}
interface State {
  targets: Array<{ id: string; name: string }>;
  snapshots: Snap[];
  schedules: Array<Sched & { id: string }>;
}

const st = (s: DemoStore): State => s.extra.data as State;
const newest = (rows: Snap[]): Snap | undefined => [...rows].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

export const backupCopyLag: DomainResolvers = {
  seed: (store) => {
    const d = st(store);
    const pg = d.schedules.find((x) => x.id === 'sch-pg');
    const save = newest(d.snapshots.filter((x) => x.volume === 'data_postgres' && x.status === 'SUCCEEDED'));
    const nvme = d.targets.find((t) => t.id === 'tgt-node-local');
    if (!pg || !save || !nvme) return;
    pg.secondaryTargetId = nvme.id;
    const at = Date.parse(save.startedAt) - 4 * 60_000;
    d.snapshots.push({
      ...save,
      id: 'snap-pg-copy-1',
      targetId: nvme.id,
      targetName: nvme.name,
      resticId: '5d0e77c2',
      startedAt: new Date(at).toISOString(),
      finishedAt: new Date(at + 90_000).toISOString(),
    });
  },
  handlers: {
    'backups.copyLag': (_i, s) => {
      const d = st(s);
      const out = new Map<string, { targetId: string; schedules: number; behindMs: number | null; worstVolume: string | null; neverCopied: number; copying: number; failing: number; lastError: string | null; newestCopyAt: string | null; copiedBytes: string }>();
      for (const sc of d.schedules) {
        const dest = sc.secondaryTargetId;
        if (sc.paused || !dest || dest === sc.targetId) continue;
        const v = out.get(dest) ?? { targetId: dest, schedules: 0, behindMs: null, worstVolume: null, neverCopied: 0, copying: 0, failing: 0, lastError: null, newestCopyAt: null, copiedBytes: '0' };
        out.set(dest, v);
        v.schedules += 1;
        const on = (t: string, ok: boolean) => newest(d.snapshots.filter((x) => x.volume === sc.volume && x.targetId === t && (!ok || x.status === 'SUCCEEDED')));
        const saved = on(sc.targetId, true);
        const copy = on(dest, true);
        const last = on(dest, false);
        if (last?.status === 'RUNNING') v.copying += 1;
        if (last?.status === 'FAILED') [v.failing, v.lastError] = [v.failing + 1, last.error];
        if (copy) {
          v.copiedBytes = String(Number(v.copiedBytes) + Number(copy.sizeBytes ?? 0));
          if (!v.newestCopyAt || copy.startedAt > v.newestCopyAt) v.newestCopyAt = copy.startedAt;
        }
        if (!saved) continue;
        if (!copy) {
          if (last?.status !== 'RUNNING') v.neverCopied += 1;
          continue;
        }
        const behind = last?.status === 'RUNNING' ? 0 : Math.max(0, Date.parse(saved.startedAt) - Date.parse(copy.startedAt));
        if (v.behindMs == null || behind > v.behindMs) [v.behindMs, v.worstVolume] = [behind, sc.volume];
      }
      return [...out.values()];
    },
  },
};
