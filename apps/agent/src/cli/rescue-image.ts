/**
 * The image a controller-dark rescue sidecar runs (`swarmy-agent backup …`).
 *
 * With the controller down nothing sends the CLI an image, so it takes the
 * compiled BOM's entry (by digest where the BOM pins one) and goes by what
 * this node can see on its own:
 *
 *   1. that image already here, as the in-cluster mirror's copy or upstream:
 *      run it with no network at all (an air-gapped node);
 *   2. the mirror's copy, when the registry's `swarmy.mirror.*` labels trust
 *      one. They are read over the local Docker socket, which answers on a
 *      manager without the controller (a worker can't read services, so it
 *      skips this). The registry needs its login: SWARMY_REGISTRY_PASSWORD
 *      (SWARMY_REGISTRY_USERNAME, default `swarmy`) from the environment,
 *      never argv;
 *   3. upstream.
 *
 * Nothing pulled and nothing here is an error that says so, not a Docker
 * "no such image" from deep inside a sidecar.
 */
import type { DockerClient } from '@swarmy/core/docker';
import { dataDeployRef, isDataImage } from '@swarmy/core/data-images';
import { REGISTRY_FORWARDS, REGISTRY_SERVICE } from '@swarmy/core/registry-forwarder';
import { mirroredRefFor, mirrorRepoFor, pinnedTaggedRef, systemImage, type SystemImageKey } from '@swarmy/core/system-images';

/** Where every node reaches the built-in registry (its loopback forwarder). */
export const MIRROR_HOST = `localhost:${REGISTRY_FORWARDS[0].port}`;

/** The registry's mirror index and the swarm node its task runs on, as this node sees them. */
export interface LocalMirror {
  labels: Record<string, string>;
  registryNodeId: string | null;
}

export interface RescueLogin {
  username: string;
  password: string;
  serveraddress: string;
}

export type RescueSource = 'node' | 'mirror' | 'upstream';

/** Just what resolving needs: a pull and an image inspect. */
interface Docker {
  pullImage(ref: string, auth?: RescueLogin): Promise<unknown>;
  docker: { getImage(ref: string): { inspect(): Promise<unknown> } };
}

/** Pure: the upstream ref, and the mirror's copy (`trusted` = the labels vouch for it, so it may be pulled). */
export function rescueCandidates(key: SystemImageKey, mirror: LocalMirror | null): { upstream: string; copy: string | null; trusted: boolean } {
  const img = systemImage(key);
  const keepTag = (ref: string) => (isDataImage(img) ? dataDeployRef(ref, img) : ref);
  const trusted = mirror ? mirroredRefFor(img.ref, MIRROR_HOST, mirror.labels, mirror.registryNodeId) : null;
  // A copy pulled at the BOM's digest is the same bytes, labels or not.
  const byDigest = img.digest ? `${mirrorRepoFor(img.ref, MIRROR_HOST)}@${img.digest}` : null;
  const copy = trusted ?? byDigest;
  return { upstream: pinnedTaggedRef(key), copy: copy ? keepTag(copy) : null, trusted: trusted !== null };
}

/** The mirror login from the environment (never argv), if the operator gave one. */
export function rescueLogin(env: Record<string, string | undefined> = process.env): RescueLogin | undefined {
  const password = env.SWARMY_REGISTRY_PASSWORD;
  if (!password) return undefined;
  return { username: env.SWARMY_REGISTRY_USERNAME || 'swarmy', password, serveraddress: MIRROR_HOST };
}

/** The registry's labels + running task node over the local socket; null off a manager or without a registry. */
export async function readLocalMirror(docker: Pick<DockerClient, 'docker'>): Promise<LocalMirror | null> {
  const d = docker.docker;
  const svc = (await d.getService(REGISTRY_SERVICE).inspect().catch(() => null)) as { Spec?: { Labels?: Record<string, string> } } | null;
  if (!svc) return null;
  const tasks = (await d
    .listTasks({ filters: { service: [REGISTRY_SERVICE], 'desired-state': ['running'] } })
    .catch(() => [])) as { NodeID?: string; Status?: { State?: string } }[];
  const running = tasks.find((t) => t.Status?.State === 'running' && t.NodeID);
  return { labels: svc.Spec?.Labels ?? {}, registryNodeId: running?.NodeID ?? null };
}

async function onNode(docker: Docker, ref: string): Promise<boolean> {
  try {
    await docker.docker.getImage(ref).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function resolveRescueImage(
  docker: Docker,
  key: SystemImageKey,
  mirror: LocalMirror | null,
  login: RescueLogin | undefined,
): Promise<{ image: string; source: RescueSource }> {
  const c = rescueCandidates(key, mirror);
  for (const ref of [c.copy, c.upstream]) if (ref && (await onNode(docker, ref))) return { image: ref, source: 'node' };
  if (c.copy && c.trusted && login) {
    const pulled = await docker.pullImage(c.copy, login).then(() => true, () => false);
    if (pulled) return { image: c.copy, source: 'mirror' };
  }
  await docker.pullImage(c.upstream).catch(() => undefined);
  if (await onNode(docker, c.upstream)) return { image: c.upstream, source: 'upstream' };
  const how = c.trusted && !login ? 'set SWARMY_REGISTRY_PASSWORD to pull it from the cluster registry, or load it' : 'load it';
  throw new Error(`${c.upstream} is not on this node and could not be pulled: ${how} with \`docker load\` first`);
}
