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
