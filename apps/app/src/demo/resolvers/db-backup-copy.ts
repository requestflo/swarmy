import type { DbBackupCopyView, DbBackupOverviewRow, DbBackupScheduleView, DbBackupSnapshotView } from '@swarmy/core';
import type { DemoHandler, DemoStore, DomainResolvers } from '../types';
import { backupCopyLag } from './backup-copy-lag';
import { data } from './data';

/**
 * "Also copy to" on database schedules (board 40), over data.ts's clusters:
 * storefront/checkout's nightly dump is also copied to an off-site R2
 * bucket. The overview carries each copy and how far it trails (the
 * controller's rule: the newest save against when the newest copy began),
 * `dbBackups.list` reads the copy's own saves, and `backups.copyLag` counts
 * the databases at their destination. Comes after data and backupCopyLag.
 */

interface Copy { targetId: string; since: string; okSavedAt: string | null; okStartedAt: string | null; sizeBytes: string | null; error: string | null }
interface Cluster { stack: string; cluster: string; schedule: { engine: string } | null; lastRunAt: string | null; lastStatus: string | null; lastSizeBytes: string | null }
interface Target { id: string; name: string; kind: string; endpoint: string | null; bucket: string; prefix: string | null; region: string | null; hasCredentials: boolean; enabled: boolean; createdAt: string }
interface Lag { targetId: string; schedules: number; databases: number; behindMs: number | null; worstVolume: string | null; neverCopied: number; copying: number; failing: number; lastError: string | null; newestCopyAt: string | null; copiedBytes: string }
interface State { targets: Target[]; dbClusters: Cluster[]; dbSnapshots: Array<DbBackupSnapshotView & { stack: string; cluster: string }> }

const R2: Target = {
  id: 'tgt-r2-offsite', name: 'Cloudflare R2 (off-site)', kind: 's3', endpoint: 'northwind.r2.cloudflarestorage.com',
  bucket: 'northwind-offsite', prefix: 'restic', region: 'auto', hasCredentials: true, enabled: true, createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
};
const st = (s: DemoStore): State => s.extra.data as State;
const copies = (s: DemoStore): Record<string, Copy> => (s.extra.dbCopy ??= {}) as Record<string, Copy>;
const ref = (b: { stack: string; cluster: string }): string => `${b.stack}/${b.cluster}`;
const cluster = (s: DemoStore, b: { stack: string; cluster: string }) => st(s).dbClusters.find((c) => ref(c) === ref(b));
const nameOf = (s: DemoStore, id: string): string | null => st(s).targets.find((t) => t.id === id)?.name ?? null;
const call = async (h: DemoHandler | undefined, i: unknown, s: DemoStore): Promise<unknown> => (h ? h(i, s) : null);

export function demoCopyView(s: DemoStore, c: Copy, cl: Cluster | undefined): DbBackupCopyView {
  const newest = cl?.lastStatus === 'succeeded' ? cl.lastRunAt : c.okSavedAt;
  const behindMs = newest && c.okStartedAt ? Math.max(0, Date.parse(newest) - Date.parse(c.okStartedAt)) : null;
  return {
    targetId: c.targetId, targetName: nameOf(s, c.targetId), method: 'dump', behindMs, neverCopied: newest != null && !c.okStartedAt,
    copying: false, failing: c.error != null, lastError: c.error, newestCopyAt: c.okStartedAt, sizeBytes: c.sizeBytes, restoresTo: null,
  };
}

/** The copy of the cluster's newest good save, made just now. */
function copyNow(s: DemoStore, b: { stack: string; cluster: string }, targetId: string): void {
  const cl = cluster(s, b);
  const prev = copies(s)[ref(b)];
  const now = new Date().toISOString();
  copies(s)[ref(b)] = { targetId, since: prev?.targetId === targetId ? prev.since : now, okSavedAt: cl?.lastRunAt ?? null, okStartedAt: cl?.lastRunAt ? now : null, sizeBytes: cl?.lastSizeBytes ?? null, error: null };
}

export const dbBackupCopy: DomainResolvers = {
  seed: (store) => {
    const d = st(store);
    if (!d.targets.some((t) => t.id === R2.id)) d.targets.push(R2);
    // Last night's dump failed (data.ts); the save before it was copied two minutes after it finished.
    const save = d.dbSnapshots.filter((x) => x.stack === 'storefront' && x.cluster === 'checkout').sort((a, b) => b.time.localeCompare(a.time))[0];
    if (!save) return;
    copies(store)['storefront/checkout'] = {
      targetId: R2.id, since: new Date(Date.now() - 4 * 86_400_000).toISOString(), okSavedAt: save.time,
      okStartedAt: new Date(Date.parse(save.time) + 2 * 60_000).toISOString(), sizeBytes: save.sizeBytes, error: null,
    };
  },
  handlers: {
    'dbBackups.overview': async (i, s) =>
      ((await call(data.handlers?.['dbBackups.overview'], i, s)) as DbBackupOverviewRow[]).map((r) => {
        const c = copies(s)[ref(r)];
        return { ...r, secondaryTargetId: c?.targetId ?? null, copy: c ? demoCopyView(s, c, cluster(s, r)) : null };
      }),
    'dbBackups.getSchedule': async (i, s) => {
      const v = (await call(data.handlers?.['dbBackups.getSchedule'], i, s)) as DbBackupScheduleView | null;
      return v ? { ...v, secondaryTargetId: copies(s)[ref(v)]?.targetId ?? null } : null;
    },
    'dbBackups.setSchedule': async (i, s) => {
      const b = i as { enabled: boolean; stack: string; cluster: string };
      if (!b.enabled) delete copies(s)[ref(b)];
      const v = (await call(data.handlers?.['dbBackups.setSchedule'], i, s)) as DbBackupScheduleView | null;
      return v ? { ...v, secondaryTargetId: copies(s)[ref(b)]?.targetId ?? null } : null;
    },
    'dbBackups.setSecondary': async (i, s) => {
      const b = i as { stack: string; cluster: string; secondaryTargetId: string | null };
      if (b.secondaryTargetId) copyNow(s, b, b.secondaryTargetId);
      else delete copies(s)[ref(b)];
      const v = (await call(data.handlers?.['dbBackups.getSchedule'], i, s)) as DbBackupScheduleView;
      return { ...v, secondaryTargetId: b.secondaryTargetId };
    },
    'dbBackups.run': async (i, s) => {
      const r = await call(data.handlers?.['dbBackups.run'], i, s);
      const c = copies(s)[ref(i as { stack: string; cluster: string })];
      if (c) copyNow(s, i as { stack: string; cluster: string }, c.targetId);
      return r;
    },
    // The copy's own saves: each save since it was set up, under its own id there.
    'dbBackups.list': async (i, s) => {
      const b = (i ?? {}) as { stack?: string; cluster?: string; targetId?: string };
      const rows = (await call(data.handlers?.['dbBackups.list'], i, s)) as DbBackupSnapshotView[];
      const c = b.stack && b.cluster ? copies(s)[`${b.stack}/${b.cluster}`] : undefined;
      if (!c || b.targetId !== c.targetId) return rows;
      return rows.filter((r) => r.time >= c.since && !r.reason).map((r) => ({ ...r, id: `c${r.id.slice(1)}` }));
    },
    'backups.copyLag': async (i, s) => {
      const vols = (await call(backupCopyLag.handlers?.['backups.copyLag'], i, s)) as Array<Omit<Lag, 'databases'>>;
      const out = new Map<string, Lag>(vols.map((v) => [v.targetId, { ...v, databases: 0 }]));
      for (const [r, c] of Object.entries(copies(s))) {
        const v = demoCopyView(s, c, st(s).dbClusters.find((x) => ref(x) === r));
        const row = out.get(c.targetId) ?? { targetId: c.targetId, schedules: 0, databases: 0, behindMs: null, worstVolume: null, neverCopied: 0, copying: 0, failing: 0, lastError: null, newestCopyAt: null, copiedBytes: '0' };
        out.set(c.targetId, row);
        row.schedules += 1;
        row.databases += 1;
        if (v.failing) [row.failing, row.lastError] = [row.failing + 1, row.lastError ?? v.lastError];
        if (v.neverCopied) row.neverCopied += 1;
        row.copiedBytes = String(Number(row.copiedBytes) + Number(v.sizeBytes ?? 0));
        if (v.behindMs != null && (row.behindMs == null || v.behindMs > row.behindMs)) [row.behindMs, row.worstVolume] = [v.behindMs, r];
        if (v.newestCopyAt && (!row.newestCopyAt || v.newestCopyAt > row.newestCopyAt)) row.newestCopyAt = v.newestCopyAt;
      }
      return [...out.values()];
    },
  },
};
