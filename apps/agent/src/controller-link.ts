/**
 * Where to dial the controller when this agent is NOT on the private overlay
 * (QA-066 e).
 *
 * Node #1's container agent used to run with `--network swarmy-control` so it
 * could dial `ws://swarmy_controller:3021`. After a reboot on a multi-manager
 * swarm, dockerd cannot attach a container to an overlay until the managers
 * answer, the managers need the mesh, and the mesh control plane on this node
 * needs the agent. The agent exited with "Could not attach to network …
 * context deadline exceeded" and the node never came back. The agent now runs
 * on the host network, like a systemd agent: it starts with dockerd alone.
 *
 * On the host network the overlay name does not resolve. The controller
 * publishes its port in host mode on whichever node runs it, so a manager asks
 * swarm where the controller task runs and dials that node's swarm address
 * (its mesh IP) on the published port. If swarm can't answer, it tries this
 * host's published port, where the controller runs on a single-node swarm.
 * Any other URL (a public https one, localhost in dev) is used as given.
 */
import { lookup } from 'node:dns/promises';
import type { DockerClient } from '@swarmy/core/docker';

/** The stack-prefixed controller service the installer deploys (`swarmy_controller`). */
export const CONTROLLER_SERVICE = 'swarmy_controller';

let lastResolved: string | undefined;
/** The URL the last dial actually used (for the recovery beacon's HTTP base). */
export function lastResolvedControllerUrl(fallback: string): string {
  return lastResolved ?? fallback;
}

interface SwarmFacts {
  /** Swarm addresses of nodes running a controller task. */
  taskNodeAddrs: string[];
  /** Host-mode published port for the controller's target port, if any. */
  publishedPort?: number;
}

/** Pure: the URL to dial for `configured` given what swarm said. */
export function controllerDialUrl(configured: string, facts: SwarmFacts | null): string {
  let u: URL;
  try {
    u = new URL(configured);
  } catch {
    return configured;
  }
  const target = Number(u.port || (u.protocol === 'wss:' ? 443 : 80));
  const port = facts?.publishedPort ?? target;
  const host = facts?.taskNodeAddrs.find((a) => /^[\d.]+$/.test(a)) ?? '127.0.0.1';
  const out = new URL(configured);
  out.hostname = host;
  out.port = String(port);
  return out.toString();
}

async function swarmFacts(docker: DockerClient, targetPort: number): Promise<SwarmFacts | null> {
  const d = docker.docker;
  const svc = (await d
    .getService(CONTROLLER_SERVICE)
    .inspect()
    .catch(() => null)) as { Endpoint?: { Ports?: { TargetPort?: number; PublishedPort?: number; PublishMode?: string }[] } } | null;
  if (!svc) return null;
  const published = svc.Endpoint?.Ports?.find((p) => p.TargetPort === targetPort)?.PublishedPort;
  const tasks = (await d
    .listTasks({ filters: { service: [CONTROLLER_SERVICE], 'desired-state': ['running'] } })
    .catch(() => [])) as { NodeID?: string; Status?: { State?: string } }[];
  const addrs: string[] = [];
  for (const t of tasks.filter((x) => x.Status?.State === 'running' && x.NodeID)) {
    const n = (await d
      .getNode(t.NodeID!)
      .inspect()
      .catch(() => null)) as { Status?: { Addr?: string } } | null;
    if (n?.Status?.Addr) addrs.push(n.Status.Addr);
  }
  return { taskNodeAddrs: addrs, ...(published ? { publishedPort: published } : {}) };
}

/**
 * Resolve `configured` for this dial. Only the overlay name is rewritten, and
 * only when it does not resolve here (a container still on the overlay keeps
 * dialing it as before). Never throws.
 */
export async function resolveControllerUrl(configured: string, docker: DockerClient): Promise<string> {
  let u: URL;
  try {
    u = new URL(configured);
  } catch {
    return configured;
  }
  if (u.hostname !== CONTROLLER_SERVICE) {
    lastResolved = configured;
    return configured;
  }
  const resolves = await lookup(u.hostname).then(
    () => true,
    () => false,
  );
  if (resolves) {
    lastResolved = configured;
    return configured;
  }
  const facts = await swarmFacts(docker, Number(u.port || 80)).catch(() => null);
  lastResolved = controllerDialUrl(configured, facts);
  return lastResolved;
}
