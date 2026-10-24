/**
 * Supervise this node's loopback registry forwarder (security review M16;
 * the spec and the why live in `@swarmy/core/registry-forwarder`).
 *
 * The agent keeps `swarmy-registry-forwarder` created, current and running,
 * at start and on a short timer, whether or not the controller is connected:
 * dockerd pulls `localhost:5000` / `localhost:5001` through it, and pulls must
 * not depend on the controller. dockerd itself restarts it after a reboot
 * (restart `always`; swarm-attached containers start once the node rejoins).
 *
 * While the cluster still publishes the registry on the routing mesh, the
 * mesh holds :5000/:5001 and the start fails with "port is already
 * allocated". That is `waiting`, not an error: the container stays created and
 * the next tick starts it once the controller has moved the registry off the
 * mesh (it only does so when every node's agent reports `registryForwarder: on`).
 *
 * `SWARMY_REGISTRY_FORWARDER=false` opts the node out (and removes it).
 */
import { createHash } from 'node:crypto';
import { DockerClient, defaultContainerLogConfig } from '@swarmy/core/docker';
import { loadImageFromController } from './controller-image';
import {
  REGISTRY_FORWARDER_CONTAINER,
  REGISTRY_FORWARDER_NETWORK,
  REGISTRY_FORWARDER_SPEC_LABEL,
  forwarderStartIssue,
  registryForwarderContainer,
} from '@swarmy/core/registry-forwarder';

export const REGISTRY_FORWARDER_INTERVAL_MS = 15_000;

export type ForwarderStatus = 'running' | 'started' | 'waiting' | 'skipped' | 'removed' | 'failed';

export interface ForwarderResult {
  status: ForwarderStatus;
  detail?: string;
  /** Whether the overlay it rides is IPsec-encrypted (known once it is attached). */
  encrypted?: boolean;
}

type Inspect = { Config?: { Labels?: Record<string, string> | null }; State?: { Running?: boolean } } | null;

/** Pure: the create options, with the log config and a spec hash label (any change re-creates it). */
export function forwarderCreateOptions(image?: string) {
  const base = registryForwarderContainer(image);
  const opts = { ...base, HostConfig: { ...base.HostConfig, LogConfig: defaultContainerLogConfig() } };
  const hash = createHash('sha256').update(JSON.stringify(opts)).digest('hex').slice(0, 16);
  return { ...opts, Labels: { ...opts.Labels, [REGISTRY_FORWARDER_SPEC_LABEL]: hash } };
}

/** Pure: what a tick must do with the container it found. */
export function forwarderAction(cur: Inspect, wantHash: string): 'create' | 'recreate' | 'start' | 'none' {
  if (!cur) return 'create';
  if (cur.Config?.Labels?.[REGISTRY_FORWARDER_SPEC_LABEL] !== wantHash) return 'recreate';
  return cur.State?.Running ? 'none' : 'start';
}

/** Pure: a start error → the tick's status. */
export function forwarderStartResult(message: string): ForwarderResult {
  switch (forwarderStartIssue(message)) {
    case 'port-held':
      return { status: 'waiting', detail: ':5000/:5001 still held (the registry is on the routing mesh until every node can forward)' };
    case 'no-network':
      return { status: 'waiting', detail: `the ${REGISTRY_FORWARDER_NETWORK} overlay is not on this node yet` };
    case 'not-attachable':
      return { status: 'failed', detail: `the ${REGISTRY_FORWARDER_NETWORK} overlay is not attachable; recreate it with --attachable --opt encrypted` };
    default:
      return { status: 'failed', detail: message.slice(0, 300) };
  }
}

async function overlayEncrypted(docker: DockerClient): Promise<boolean | undefined> {
  const n = (await docker.docker
    .getNetwork(REGISTRY_FORWARDER_NETWORK)
    .inspect()
    .catch(() => null)) as { Options?: Record<string, string> | null } | null;
  return n ? Boolean(n.Options && 'encrypted' in n.Options) : undefined;
}

/**
 * The image to create the forwarder from: on the node already, else the
 * controller's verified archive (a new node can't reach Docker Hub through a
 * forwarder it hasn't got yet; it runs by id), else pulled.
 */
async function ensureImage(docker: DockerClient, image: string): Promise<string> {
  const have = await docker.docker
    .getImage(image)
    .inspect()
    .then(() => true, () => false);
  if (have) return image;
  const loaded = await loadImageFromController(docker, image, { log: (...a) => console.log('[swarmy-agent]', ...a) });
  if (loaded) return loaded;
  await docker.pullImage(image);
  return image;
}

/** Converge the forwarder on this node. Never throws. */
export async function superviseRegistryForwarder(
  docker: DockerClient,
  opts: { enabled: boolean; image?: string },
): Promise<ForwarderResult> {
  const d = docker.docker;
  try {
    const cur = (await d.getContainer(REGISTRY_FORWARDER_CONTAINER).inspect().catch(() => null)) as Inspect;
    if (!opts.enabled) {
      if (!cur) return { status: 'skipped', detail: 'SWARMY_REGISTRY_FORWARDER=false' };
      await d.getContainer(REGISTRY_FORWARDER_CONTAINER).remove({ force: true });
      return { status: 'removed' };
    }
    if ((await docker.swarmState()) !== 'active') return { status: 'skipped', detail: 'not in a swarm yet' };
    const want = forwarderCreateOptions(opts.image);
    const action = forwarderAction(cur, want.Labels[REGISTRY_FORWARDER_SPEC_LABEL]!);
    if (action === 'none') return { status: 'running', encrypted: await overlayEncrypted(docker) };
    if (action === 'recreate') await d.getContainer(REGISTRY_FORWARDER_CONTAINER).remove({ force: true });
    if (action !== 'start') {
      // The spec label hashes the pinned ref, so running a loaded copy by id never re-creates it.
      await d.createContainer({ ...want, Image: await ensureImage(docker, want.Image) });
    }
    try {
      await d.getContainer(REGISTRY_FORWARDER_CONTAINER).start();
    } catch (e) {
      return forwarderStartResult(e instanceof Error ? e.message : String(e));
    }
    return { status: 'started', encrypted: await overlayEncrypted(docker) };
  } catch (e) {
    // A create can fail on the network too (an overlay a worker can't attach yet).
    return forwarderStartResult(e instanceof Error ? e.message : String(e));
  }
}

/** The register fact (NodeFacts.registryForwarder). */
export function registryForwarderFact(enabled: boolean): 'on' | 'off' {
  return enabled ? 'on' : 'off';
}
