import type { DockerClient } from '@swarmy/core/docker';
import type { SnapshotEntry, SnapshotLsPayload, SnapshotLsResult } from '@swarmy/core/protocol';
import { stderrWhy } from './dump-pump';
import { lsArgs, prepareRead } from './snapshot-read';
import { prepareSidecarStream } from './sidecar-stream';

/**
 * `snapshotLs`: one directory of a volume backup for the download picker
 * (`restic ls --json <snap> <path>`, non-recursive). The output is streamed
 * and the sidecar is stopped once `limit` children are in, so a folder with a
 * million files costs the same as one with a thousand.
 */

const TYPES = new Set(['file', 'dir', 'symlink']);

/** One `restic ls --json` line → an entry, or null for the snapshot line / junk. Pure. */
export function parseLsLine(line: string): SnapshotEntry | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const kind = o.struct_type ?? o.message_type;
  if (kind !== 'node' || typeof o.path !== 'string' || typeof o.name !== 'string') return null;
  const type = typeof o.type === 'string' && TYPES.has(o.type) ? (o.type as SnapshotEntry['type']) : 'other';
  return {
    path: o.path,
    name: o.name,
    type,
    ...(type === 'file' && typeof o.size === 'number' ? { size: o.size } : {}),
    ...(typeof o.mtime === 'string' ? { mtime: o.mtime } : {}),
  };
}

/** Fold the parsed lines into the result: the path itself, then its children. Pure. */
export function foldLs(path: string, entries: SnapshotEntry[], limit: number): SnapshotLsResult {
  const node = entries.find((e) => e.path === path) ?? null;
  const children = node?.type === 'dir' ? entries.filter((e) => e !== node) : [];
  children.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name));
  return { node, entries: children.slice(0, limit), truncated: children.length > limit };
}

export async function snapshotLs(docker: DockerClient, p: SnapshotLsPayload): Promise<SnapshotLsResult> {
  const sc = await prepareRead(docker, p);
  const entries: SnapshotEntry[] = [];
  let tail = '';
  let stopped = false;
  const side = await prepareSidecarStream(docker, { ...sc, args: lsArgs(p) }, (data) => {
    if (stopped) return;
    const lines = (tail + data.toString('utf8')).split('\n');
    tail = lines.pop() ?? '';
    for (const line of lines) {
      const e = parseLsLine(line);
      if (e) entries.push(e);
    }
    // The path itself + `limit` children + one more to know it was cut.
    if (entries.length > p.limit + 1) {
      stopped = true;
      side.kill();
    }
  });
  await side.start();
  const code = await side.done;
  if (!stopped) {
    const last = parseLsLine(tail);
    if (last) entries.push(last);
    if (code !== 0) throw new Error(stderrWhy(side.stderr()));
  }
  return foldLs(p.path, entries, p.limit);
}
