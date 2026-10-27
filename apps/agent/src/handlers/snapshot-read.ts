import {
  DEFAULT_RESTIC_IMAGE,
  hostRepoPathRefusal,
  imageRepoOf,
  type ResticRepo,
  type SnapshotDumpPayload,
  type SnapshotLsPayload,
} from '@swarmy/core/protocol';
import { assertSnapshotRef, repoEnv } from './backup';

/**
 * How the agent runs restic to READ a volume backup (`snapshotLs`,
 * `snapshotDump`): the restic image only, `--no-lock` (reading never writes a
 * lock into the repo, so a killed download leaves nothing stale), a node-path
 * repo mounted read-only, credentials as container env. Pure.
 */

export interface ReadSidecar {
  image: string;
  env: string[];
  binds: string[];
  networkMode?: string;
}

class ReadRefused extends Error {
  readonly code = 'E_REFUSED';
}

export function readSidecar(p: { repo: ResticRepo; image?: string; network?: string }): ReadSidecar {
  const image = p.image ?? DEFAULT_RESTIC_IMAGE;
  if (imageRepoOf(image) !== imageRepoOf(DEFAULT_RESTIC_IMAGE)) {
    throw new ReadRefused(`only the restic image may read a backup (got ${image.slice(0, 80)})`);
  }
  let binds: string[] = [];
  if (p.repo.kind === 'node') {
    const why = hostRepoPathRefusal(p.repo.repo);
    if (why) throw new ReadRefused(`refusing this node backup repo: ${why}`);
    binds = [`${p.repo.repo}:${p.repo.repo}:ro`];
  }
  return { image, env: repoEnv(p.repo), binds, networkMode: p.network };
}

/** `restic dump` of one file (its bytes) or one folder (a tar). */
export function dumpArgs(p: Pick<SnapshotDumpPayload, 'snapshotId' | 'path' | 'kind'>): string[] {
  const archive = p.kind === 'dir' ? ['--archive', 'tar'] : [];
  return ['--no-lock', 'dump', ...archive, '--', assertSnapshotRef(p.snapshotId), p.path];
}

/** `restic ls` of one path: the path itself, then a folder's direct children. */
export function lsArgs(p: Pick<SnapshotLsPayload, 'snapshotId' | 'path'>): string[] {
  return ['--no-lock', 'ls', '--json', '--', assertSnapshotRef(p.snapshotId), p.path];
}
