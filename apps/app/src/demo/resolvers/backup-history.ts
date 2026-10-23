import type { DemoStore, DomainResolvers } from '../types';

/**
 * Two weeks of nightly backup history for the Backups boards (16 and 40).
 * Seed-only: it runs after `data` and appends to that module's stores, so
 * `backups.listSnapshots`, `dbBackups.list` and `controllerBackup.listSnapshots`
 * keep their resolvers and simply have a past.
 *
 * The story it extends: every volume saves nightly around 03:00 UTC;
 * storefront's checkout data hit a locked repository five nights ago and the
 * retry at 03:22 worked (last night's failure stays the page's "needs you");
 * storefront/checkout dumps nightly with a 30-day keep window, so a 14-day
 * window would visibly remove the older half; swarmy itself saves at 03:10.
 */

const DAY = 86_400_000;
const MIN = 60_000;

/** 03:00 UTC `n` nights ago, plus `mins`. Always in the past for n ≥ 1. */
function night(n: number, mins = 0): string {
  const midnight = Math.floor(Date.now() / DAY) * DAY;
  return new Date(midnight - n * DAY + 3 * 60 * MIN + mins * MIN).toISOString();
}

/** Stable restic-looking ids (8 hex) so the demo reads the same on every load. */
const hex = (seed: number): string => ((0x5a3c1e07 + seed * 2_654_435_761) >>> 0).toString(16).padStart(8, '0');

interface VolumeSnap {
  id: string; volume: string; targetId: string; targetName: string; status: string; resticId: string | null;
  sizeBytes: string | null; error: string | null; startedAt: string; finishedAt: string | null;
}
interface DbSnap { id: string; time: string; engine: string; sizeBytes: string; tags: string[]; stack: string; cluster: string }
interface CtlSnap { id: string; targetId: string; resticSnapshotId: string | null; sizeBytes: string | null; durationMs: number | null; status: string; manifest: unknown; startedAt: string; finishedAt: string | null; error: string | null }
interface DataSlice {
  targets: { id: string; name: string }[];
  snapshots: VolumeSnap[];
  dbSnapshots: DbSnap[];
  controller: { snapshots: CtlSnap[] };
}

const VOLUMES: [volume: string, bytes: number, mins: number][] = [
  ['data_postgres', 1_820_000_000, 2],
  ['data_redis', 95_000_000, 7],
  ['platform_grafana', 309_000_000, 12],
  ['storefront_checkout', 262_000_000, 17],
];

function seedVolumes(st: DataSlice): void {
  const t = st.targets[0];
  if (!t) return;
  const ok = (volume: string, n: number, bytes: number, mins: number): VolumeSnap => ({
    id: `snap-${volume}-${n}`, volume, targetId: t.id, targetName: t.name, status: 'SUCCEEDED', resticId: hex(n * 31 + mins),
    sizeBytes: String(Math.round(bytes * (1 - n * 0.003))), error: null, startedAt: night(n, mins), finishedAt: night(n, mins + 2),
  });
  const past: VolumeSnap[] = [];
  for (const [volume, bytes, mins] of VOLUMES) {
    for (let n = 1; n <= 13; n++) {
      if (volume === 'storefront_checkout' && n === 5) {
        past.push({ ...ok(volume, n, bytes, mins), id: `snap-${volume}-${n}-a`, status: 'FAILED', resticId: null, sizeBytes: null, error: 'repository is already locked by another process', finishedAt: night(n, mins + 1) });
        past.push(ok(volume, n, bytes, 22));
      } else past.push(ok(volume, n, bytes, mins));
    }
  }
  // Newest first, like the real catalog query.
  st.snapshots = [...st.snapshots, ...past].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function seedDbDumps(st: DataSlice): void {
  const past: DbSnap[] = [];
  for (let n = 3; n <= 29; n++) {
    past.push({
      id: hex(1000 + n), time: night(n, 1), engine: 'pg_dump', sizeBytes: String(Math.round(268_435_456 * (1 - n * 0.004))),
      tags: ['org:org-demo', 'db:storefront/checkout', 'engine:pg_dump'], stack: 'storefront', cluster: 'checkout',
    });
  }
  st.dbSnapshots = [...st.dbSnapshots, ...past];
}

function seedController(st: DataSlice): void {
  const first = st.controller.snapshots[0];
  if (!first) return;
  const past: CtlSnap[] = [];
  for (let n = 2; n <= 13; n++) {
    past.push({
      ...first, id: `csnap-h${n}`, resticSnapshotId: hex(2000 + n), sizeBytes: String(48_234_496 - n * 41_000),
      startedAt: night(n, 10), finishedAt: night(n, 10.1),
    });
  }
  st.controller.snapshots = [...st.controller.snapshots, ...past].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export const backupHistory: DomainResolvers = {
  seed: (store: DemoStore) => {
    const st = store.extra.data as DataSlice | undefined;
    if (!st) return;
    seedVolumes(st);
    seedDbDumps(st);
    seedController(st);
  },
};
