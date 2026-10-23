import type { CodeTab } from '@/components/calm';
import type { Change, Replay, RestorePoint } from './time-travel-replay';

/**
 * Time travel at Code depth. Releases, incidents and database restores have
 * no public REST path yet, so this is what swarmy sees at T (read-only), the
 * same rows the page reads from `releases.list` and `dbBackups.list`.
 */
export function timeTravelCode(input: {
  stack: string;
  at: number;
  replay: Replay;
  changes: Change[];
  cluster: string | null;
  point: RestorePoint | null;
}): CodeTab[] {
  const { stack, at, replay, changes, cluster, point } = input;
  const view = {
    app: stack,
    at: new Date(at).toISOString(),
    release: replay.release ? { id: replay.release.id, createdAt: replay.release.createdAt, status: replay.release.status } : null,
    images: Object.fromEntries(replay.parts.map((p) => [p.name, p.image])),
    changedSince: changes.map((c) => ({ release: c.id, at: new Date(c.at).toISOString(), parts: c.parts })),
    nearestSave: point && cluster ? { cluster, id: point.backup.id, time: point.backup.time, engine: point.backup.engine } : null,
  };
  return [{ label: 'at T', code: `# ${stack} as swarmy recorded it at this moment\n${JSON.stringify(view, null, 2)}` }];
}
