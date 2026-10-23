import type { DbBackupSnapshotView } from '@swarmy/core';
import { fmtBytes } from './backup-format';
import { volumeWords } from './backup-words';
import { laneCells, type GridLane, type GridSave, type SaveStatus } from './restore-grid-model';

/**
 * API rows → grid lanes. Three sources say what was saved: volume snapshots
 * (`backups.listSnapshots`), database dumps in each destination's catalog
 * (`dbBackups.list`, tagged `db:<stack>/<cluster>`), and swarmy's own bundle
 * (`controllerBackup.listSnapshots`).
 */

export interface VolumeSnap {
  id: string;
  volume: string;
  status: string;
  targetName: string;
  sizeBytes: string | null;
  startedAt: string;
  error?: string | null;
}

export interface ControllerSnap {
  id: string;
  targetId: string;
  status: string;
  sizeBytes: string | null;
  startedAt: string;
  error: string | null;
}

/** Expired (PRUNED) rows can't be restored, so they leave the grid. */
const STATUS: Record<string, SaveStatus | undefined> = { SUCCEEDED: 'ok', FAILED: 'failed', RUNNING: 'running' };

function newestSize(saves: GridSave[]): string {
  const ok = saves.filter((s) => s.status === 'ok').sort((a, b) => b.atMs - a.atMs)[0];
  return ok?.sizeBytes ? fmtBytes(ok.sizeBytes) : '';
}

function lane(key: string, kind: GridLane['kind'], name: string, what: string, ref: string, saves: GridSave[], starts: number[]): GridLane | null {
  const cells = laneCells(saves, starts);
  if (cells.every((c) => c == null)) return null;
  const size = newestSize(saves);
  return { key, kind, name, meta: size ? `${what} · ${size}` : what, ref, cells };
}

export function volumeLanes(snaps: VolumeSnap[], starts: number[]): GridLane[] {
  const by = new Map<string, GridSave[]>();
  for (const s of snaps) {
    const status = STATUS[s.status];
    if (!status) continue;
    const save: GridSave = { id: s.id, atMs: Date.parse(s.startedAt), status, sizeBytes: s.sizeBytes, where: s.targetName || null, error: s.error ?? null };
    by.set(s.volume, [...(by.get(s.volume) ?? []), save]);
  }
  return [...by].flatMap(([v, saves]) => lane(`vol:${v}`, 'volume', volumeWords(v), 'volume', v, saves, starts) ?? []);
}

export function dbLanes(catalogs: { where: string; whereId?: string; snaps: DbBackupSnapshotView[] }[], starts: number[]): GridLane[] {
  const by = new Map<string, GridSave[]>();
  const seen = new Set<string>();
  for (const { where, whereId, snaps } of catalogs) {
    for (const s of snaps) {
      const ref = s.tags.find((t) => t.startsWith('db:'))?.slice(3);
      // A snapshot id is one save in one repository; never draw it twice.
      if (!ref || seen.has(s.id)) continue;
      seen.add(s.id);
      by.set(ref, [...(by.get(ref) ?? []), { id: s.id, atMs: Date.parse(s.time), status: 'ok', sizeBytes: s.sizeBytes, where, whereId, engine: s.engine, reason: s.reason }]);
    }
  }
  return [...by].flatMap(([ref, saves]) => {
    const [stack, cluster] = ref.split('/');
    return lane(`db:${ref}`, 'db', `${stack}’s ${cluster} database`, 'postgres', ref, saves, starts) ?? [];
  });
}

export function controllerLane(snaps: ControllerSnap[], targetName: (id: string) => string | null, starts: number[]): GridLane | null {
  const saves = snaps.flatMap((s): GridSave[] => {
    const status = STATUS[s.status];
    return status ? [{ id: s.id, atMs: Date.parse(s.startedAt), status, sizeBytes: s.sizeBytes, where: targetName(s.targetId), error: s.error }] : [];
  });
  return lane('controller', 'controller', 'swarmy itself', 'settings, people, history', 'controller', saves, starts);
}

/** By app (the volume prefix / the stack), databases before volumes; swarmy itself last. */
export function orderLanes(lanes: GridLane[]): GridLane[] {
  const app = (l: GridLane): string => (l.kind === 'controller' ? '￿' : l.kind === 'db' ? l.ref.split('/')[0]! : l.ref.split('_')[0]!);
  const rank = { db: 0, volume: 1, controller: 2 } as const;
  return [...lanes].sort((a, b) => app(a).localeCompare(app(b)) || rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
}
