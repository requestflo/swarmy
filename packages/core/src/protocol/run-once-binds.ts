/**
 * The agent-side allowlist for `container.runOnce` binds.
 *
 * A one-shot runs whatever image its payload names, so a bind is the line
 * between "a utility container" and "root on the node" (`/:/host`, the Docker
 * socket). The agent refuses every bind except the three shapes swarmy's own
 * one-shots use:
 *
 *  1. a NAMED volume at a safe in-container path (`vol:/data[:ro]`): backups,
 *     volume moves, engine upgrades, registry GC, the trivy cache, cosign keys;
 *  2. the Docker socket, identity-mapped, for the docker-CLI system image only
 *     (platform upgrade `docker service update`, decommission `swarm leave`);
 *  3. a node-local restic repo, identity-mapped, for the restic image only, and
 *     never a system path (backup-verify on a `node` backup target).
 *
 * Pure: the agent enforces it, and controller tests prove every payload swarmy
 * builds still passes.
 */
import { parseImageRef, SYSTEM_MIRROR_NAMESPACE, systemImage } from '../system-images';
import { CONTAINER_PATH_RE, DOCKER_VOLUME_NAME_RE } from './backup';

export const RUN_ONCE_DOCKER_SOCKET = '/var/run/docker.sock';

/** Host roots a node-repo bind may never be (or sit under). */
const PROTECTED_HOST_ROOTS = [
  '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/root', '/run',
  '/sbin', '/snap', '/sys', '/usr', '/var/lib/containerd', '/var/lib/docker', '/var/lib/swarmy', '/var/run',
];

const MODES = new Set(['ro', 'rw']);

/** `host/path` of an image, with a swarmy-system mirror copy unwrapped to its upstream. */
export function imageRepoOf(ref: string): string {
  const p = parseImageRef(ref);
  const ns = `${SYSTEM_MIRROR_NAMESPACE}/`;
  if (p.path.startsWith(ns)) {
    const inner = p.path.slice(ns.length);
    return inner.includes('/') ? inner : `${p.host}/${p.path}`;
  }
  return `${p.host}/${p.path}`;
}

const repoOfKey = (key: 'dockerCli' | 'restic') => imageRepoOf(systemImage(key).ref);

/** Why a host path may not back a node restic repo, or null when it may. */
export function hostRepoPathRefusal(path: string): string | null {
  if (!CONTAINER_PATH_RE.test(path) || path.includes('//') || /\/\.?$/.test(path) || /\/\.\//.test(path)) {
    return `${JSON.stringify(path.slice(0, 80))} is not a plain absolute path`;
  }
  const hit = PROTECTED_HOST_ROOTS.find((r) => path === r || path.startsWith(`${r}/`));
  return hit ? `${path} is a system path (${hit})` : null;
}

/**
 * Why ONE bind is refused, or null when it passes. `images` are every ref the
 * agent may run for this one-shot (the image and its upstream fallback): a host
 * bind needs ALL of them to be the system image that bind belongs to.
 */
export function runOnceBindRefusal(bind: string, images: readonly string[]): string | null {
  const parts = bind.split(':');
  if (parts.length < 2 || parts.length > 3) return `bind ${JSON.stringify(bind.slice(0, 80))} is not source:target[:mode]`;
  const [source = '', target = '', mode] = parts;
  if (mode !== undefined && !MODES.has(mode)) return `bind mode ${JSON.stringify(mode)} is not ro or rw`;
  if (!CONTAINER_PATH_RE.test(target)) return `bind target ${JSON.stringify(target.slice(0, 80))} is not a safe container path`;
  if (!source.startsWith('/')) {
    return DOCKER_VOLUME_NAME_RE.test(source) ? null : `${JSON.stringify(source.slice(0, 80))} is not a Docker volume name`;
  }
  const all = (repo: string) => images.length > 0 && images.every((i) => imageRepoOf(i) === repo);
  if (source === RUN_ONCE_DOCKER_SOCKET) {
    if (target !== RUN_ONCE_DOCKER_SOCKET) return 'the Docker socket mounts only at its own path';
    return all(repoOfKey('dockerCli')) ? null : 'only the docker CLI system one-shot may mount the Docker socket';
  }
  if (target !== source) return `host path ${source} must mount at the same path (a node backup repo)`;
  if (!all(repoOfKey('restic'))) return `only the restic system one-shot may mount a host path (${source})`;
  return hostRepoPathRefusal(source);
}

/** The first refused bind's reason, or null when every bind passes. */
export function runOnceBindsRefusal(binds: readonly string[] | undefined, images: readonly (string | undefined)[]): string | null {
  const refs = images.filter((i): i is string => typeof i === 'string' && i.length > 0);
  for (const b of binds ?? []) {
    const why = runOnceBindRefusal(b, refs);
    if (why) return why;
  }
  return null;
}
