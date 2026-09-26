/**
 * Binds the pure deploy watch (./deploy-watch) to the local Docker socket
 * and the agent's connection. Fire-and-forget from the `deployService` case:
 * the command has already answered; this never throws.
 */
import type { DockerClient } from '@swarmy/core/docker';
import type { DeployWatch, RegistryAuth, ServiceSpec } from '@swarmy/core/protocol';
import type { AgentConnection } from '../connection';
import { watchDeploy, type WatchTask } from './deploy-watch';

interface RawTask {
  NodeID?: string;
  DesiredState?: string;
  CreatedAt?: string;
  Status?: { State?: string; Err?: string };
}

/** Docker's task list → the slice the watch reads. PURE — exported for tests. */
export function toWatchTasks(raw: RawTask[]): WatchTask[] {
  return raw.map((t) => ({
    nodeId: t.NodeID ?? '',
    state: t.Status?.State ?? 'new',
    desired: t.DesiredState ?? '',
    createdAt: Date.parse(t.CreatedAt ?? '') || 0,
    ...(t.Status?.Err ? { err: t.Status.Err } : {}),
  }));
}

/** The replicas a spec asks for (null = global). */
export function desiredOf(spec: Pick<ServiceSpec, 'mode'>): number | null {
  if (spec.mode?.global) return null;
  return spec.mode?.replicated?.replicas ?? 1;
}

export function startDeployWatch(
  docker: DockerClient,
  conn: AgentConnection,
  x: { watch: DeployWatch; spec: ServiceSpec; since: number; registryAuth?: RegistryAuth },
): void {
  const auth = x.registryAuth
    ? { username: x.registryAuth.username, password: x.registryAuth.password, serveraddress: x.registryAuth.server }
    : undefined;
  void watchDeploy(
    {
      tasks: async (service) => toWatchTasks((await docker.docker.listTasks({ filters: { service: [service] } })) as RawTask[]),
      localNodeId: async () => ((await docker.info()) as { Swarm?: { NodeID?: string } }).Swarm?.NodeID ?? '',
      nodeName: async (id) => {
        const n = (await docker.docker.getNode(id).inspect()) as { Description?: { Hostname?: string } };
        return n.Description?.Hostname || id.slice(0, 12);
      },
      pull: (image, onEvent) => docker.pullImage(image, auth, (_line, e) => onEvent(e)),
      send: (p) => conn.send('deployProgress', p),
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    {
      watch: x.watch,
      since: x.since,
      service: x.spec.name,
      image: x.spec.image,
      desired: desiredOf(x.spec),
      volumes: (x.spec.mounts ?? []).filter((m) => m.type === 'volume' && m.source).map((m) => m.source as string),
    },
  ).catch(() => undefined);
}
