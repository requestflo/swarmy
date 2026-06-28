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
    const isManager = await docker.isManager();
    const services = isManager ? await docker.listServices() : [];
    conn.send('serviceState', { snapshotAt: Date.now(), isManager, services });
  } catch {
    // worker / docker unavailable
  }
}

/** Live swarm node inventory (manager-only) — Docker-truth for node role/status/labels. */
export async function sendNodeList(docker: DockerClient, conn: AgentConnection): Promise<void> {
  try {
    if (!(await docker.isManager())) return;
    const nodes = await docker.listNodes();
    conn.send('nodeList', { snapshotAt: Date.now(), nodes });
  } catch {
    // worker / docker unavailable
  }
}

/** Push a fresh containers + services + nodes snapshot now (e.g. right after a deploy/scale). */
export function pushInventory(docker: DockerClient, conn: AgentConnection): void {
  void sendContainerList(docker, conn);
  void sendServiceState(docker, conn);
  void sendNodeList(docker, conn);
}
