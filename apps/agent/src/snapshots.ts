import type { DockerClient } from '@swarmy/core/docker';
import type { AgentConnection } from './connection';

export async function sendContainerList(docker: DockerClient, conn: AgentConnection): Promise<void> {
  try {
    const containers = await docker.listContainers(true);
    conn.send('containerList', { snapshotAt: Date.now(), containers });
  } catch {
    // docker unavailable
  }
}

export async function sendServiceState(docker: DockerClient, conn: AgentConnection): Promise<void> {
  try {
    // swarmState is Docker-truth for "is this node a working swarm member"; the
    // controller uses it to avoid showing a connected-but-swarm-left node as a
    // healthy manager. isManager only holds when swarmState is active.
    const swarmState = await docker.swarmState();
    const isManager = swarmState === 'active' && (await docker.isManager());
    const services = isManager ? await docker.listServices() : [];
    conn.send('serviceState', { snapshotAt: Date.now(), isManager, swarmState, services });
  } catch {
    // worker / docker unavailable
  }
}

/** Live swarm node inventory (manager-only) — Docker-truth for node role/status/labels. */
export async function sendNodeList(docker: DockerClient, conn: AgentConnection): Promise<void> {
  try {
    if (!(await docker.isManager())) {
      // Not a manager (worker, or the swarm was left): send an EMPTY inventory
      // so the controller drops any stale self-view of this node — otherwise a
      // node that just left the swarm keeps showing its old `ready` manager row.
      conn.send('nodeList', { snapshotAt: Date.now(), nodes: [] });
      return;
    }
    const nodes = await docker.listNodes();
    conn.send('nodeList', { snapshotAt: Date.now(), nodes });
  } catch {
    // docker unavailable
  }
}

/** Push a fresh containers + services + nodes snapshot now (e.g. right after a deploy/scale). */
export function pushInventory(docker: DockerClient, conn: AgentConnection): void {
  void sendContainerList(docker, conn);
  void sendServiceState(docker, conn);
  void sendNodeList(docker, conn);
}
