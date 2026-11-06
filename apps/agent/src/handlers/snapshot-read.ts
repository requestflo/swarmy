import type { DockerClient } from '@swarmy/core/docker';
import {
  DEFAULT_RESTIC_IMAGE,
  hostRepoPathRefusal,
  imageRepoOf,
  type RegistryAuth,
  type ResticRepo,
  type SnapshotDumpPayload,
  type SnapshotLsPayload,
} from '@swarmy/core/protocol';
import { assertSnapshotRef, repoEnv } from './backup';
import { pullHelper } from './helper-pull';

/**
 * How the agent runs restic to READ a volume backup (`snapshotLs`,
 * `snapshotDump`): the restic image only (its mirrored copy counts:
 * `imageRepoOf` unwraps `swarmy-system/…`), `--no-lock` (reading never writes
 * a lock into the repo, so a killed download leaves nothing stale), a
 * node-path repo mounted read-only, credentials as container env.
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

function assertRestic(image: string): void {
  if (imageRepoOf(image) !== imageRepoOf(DEFAULT_RESTIC_IMAGE)) {
    throw new ReadRefused(`only the restic image may read a backup (got ${image.slice(0, 80)})`);
  }
}

interface ReadInput {
  repo: ResticRepo;
  image?: string;
  /** Upstream restic when the mirrored `image` can't be pulled (`helper-pull.ts`). */
  fallbackImage?: string;
  registryAuth?: RegistryAuth;
  network?: string;
}

/** The read sidecar, checked: both the image and its fallback must be restic. Pure. */
export function readSidecar(p: ReadInput): ReadSidecar {
  const image = p.image ?? DEFAULT_RESTIC_IMAGE;
  assertRestic(image);
  if (p.fallbackImage) assertRestic(p.fallbackImage);
  let binds: string[] = [];
  if (p.repo.kind === 'node') {
    const why = hostRepoPathRefusal(p.repo.repo);
    if (why) throw new ReadRefused(`refusing this node backup repo: ${why}`);
    binds = [`${p.repo.repo}:${p.repo.repo}:ro`];
  }
  return { image, env: repoEnv(p.repo), binds, networkMode: p.network };
}

/**
 * {@link readSidecar} with its image pulled the way every backup sidecar's is
 * (`pullHelper`): a mirrored copy with the login, else the upstream fallback.
 * `pull: false` once that's done, so the sidecar doesn't pull it again
 * without the login. An older controller sends neither: the sidecar pulls.
 */
export async function prepareRead(docker: DockerClient, p: ReadInput): Promise<ReadSidecar & { pull: boolean }> {
  const sc = readSidecar(p);
  if (!p.fallbackImage && !p.registryAuth) return { ...sc, pull: true };
  return { ...sc, image: await pullHelper(docker, 'restic', sc.image, p.fallbackImage, p.registryAuth), pull: false };
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
